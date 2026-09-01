/**
 * Web reader (Retell read-aloud) tests — offline: a fake Retell drives the REAL reader websocket and
 * the REAL session routes, with the create-web-call seam stubbed. No Retell account, no network.
 *   1. Switch: AIADVISOR_WEB_READER unset/openai -> routes 503, ws 404, readerInfo().mode 'openai'.
 *   2. Session lifecycle: create -> say (queued before the socket exists) -> Retell connects with
 *      call_details -> queued text streams as response_id 0 chunks (markdown stripped, units
 *      expanded) -> further says stream live -> close -> content_complete + end_call.
 *   3. Guards: owner-only sessions, per-user cap abandons the oldest, response_required answered
 *      empty, unknown call socket rejected, wrong token 404, DELETE hangs up, TTL sweep.
 *   4. Webhooks for reader calls: call_analyzed records tts/retell spend (ledger off here), no
 *      voice_call row is created.
 *   npx tsx test-reader.ts
 */
// Env BEFORE the config modules load (imports are hoisted): voice-test-env.ts is the first import.
import './test/voice-test-env';
process.env.AIADVISOR_SPEND_LEDGER = '0';
process.env.AIADVISOR_VOICE_READER_AGENT_ID = 'agent_reader_test';   // read lazily by readerConfig
process.env.AIADVISOR_WEB_READER = 'retell';                         // read lazily by readerConfig
process.env.AIADVISOR_READER_MAX_PER_USER = '2';                     // likewise (getter)

import express from 'express';
import http from 'node:http';
import WebSocket from 'ws';
import { voiceConfig } from './src/voice/config';
import { readerConfig, readerRouter, readerInfo, readerEnabled, attachReaderWebSocket, _setWebCallFactory, _setCallFetcher, _setReconcileDelay, _readerSessionCount, sweepReaderSessions, readerText, handleReaderEvent } from './src/voice/reader';
import { handleRetellEvent } from './src/voice/webhooks';
import * as store from './src/voice/store';
import { pool } from './src/db';

const TOKEN = voiceConfig.wsToken;   // whatever the loaded env says; the route compares against this
if (!TOKEN || !voiceConfig.publicBase) { console.error('AIADVISOR_VOICE_WS_TOKEN / _PUBLIC_BASE must be set (test/voice-test-env.ts sets them)'); process.exit(2); }

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }
process.on('uncaughtException', (e) => { console.error('UNCAUGHT at section', section, e); process.exit(1); });
let section = 'setup';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- stand-in auth: the real routers mount this behind requireAuth / requireAssist / requireTrainer ----
let uid = 10;
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.userId = uid; next(); });
app.use('/reader', readerRouter);
const server = http.createServer(app);
attachReaderWebSocket(server);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as any).port;
const BASE = `http://127.0.0.1:${port}`;

let callSeq = 0;
const created: any[] = [];
_setWebCallFactory(async (input) => { created.push(input); const id = 'call_reader_' + (++callSeq); return { call_id: id, access_token: 'tok_' + id }; });

const api = (method: string, path: string, body?: unknown) =>
  fetch(BASE + '/reader' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

type Inbox = any[];
function connect(token: string, callId: string): Promise<{ ws: WebSocket; inbox: Inbox }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/reader/${token}/${callId}`);
    const inbox: Inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}
async function waitFor(inbox: Inbox, pred: (m: any) => boolean, ms = 3000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = inbox.find(pred); if (m) return m; await sleep(10); }
  throw new Error('timeout');
}
const responses = (inbox: Inbox) => inbox.filter((m) => m.response_type === 'response');

section = "1 switch";
// ---- 1. the switch ------------------------------------------------------------
{
  ok(readerEnabled() && readerInfo().mode === 'retell', 'reader enabled with the switch + agent + key + ws url');
  process.env.AIADVISOR_WEB_READER = 'openai';
  ok(!readerEnabled() && readerInfo().mode === 'openai' && readerInfo().requested === 'openai', 'AIADVISOR_WEB_READER=openai -> off');
  let r = await api('POST', '/sessions');
  ok(r.status === 503, `session create refused while off (${r.status})`);
  let rejected = false;
  try { await connect(TOKEN,'call_x'); } catch { rejected = true; }
  ok(rejected, 'reader websocket 404s while off');
  process.env.AIADVISOR_WEB_READER = 'retell';
  const saveAgent = process.env.AIADVISOR_VOICE_READER_AGENT_ID;
  delete process.env.AIADVISOR_VOICE_READER_AGENT_ID;
  ok(!readerEnabled() && readerInfo().requested === 'retell' && readerInfo().mode === 'openai', 'switch on but no agent id -> still openai (and says retell was requested)');
  process.env.AIADVISOR_VOICE_READER_AGENT_ID = saveAgent;
  ok(readerEnabled(), 'back on');
}

section = "2 lifecycle";
// ---- 2. lifecycle ----------------------------------------------------------------
{
  let r = await api('POST', '/sessions');
  const s = await r.json();
  ok(r.status === 200 && s.session_id && s.call_id === 'call_reader_1' && s.access_token === 'tok_call_reader_1' && s.voice, 'session created: call + access token + voice');
  ok(created[0].agent_id === 'agent_reader_test' && created[0].metadata.reader === true && created[0].metadata.reader_session === s.session_id && created[0].metadata.uid === 10, 'web call created on the reader agent with reader metadata');

  // Text queued BEFORE Retell has connected must not be lost.
  r = await api('POST', `/sessions/${s.session_id}/say`, { text: 'Bids sit at **$95/ML** this week.\n\n| Zone | Price |\n|---|---|\n| 1A | 95 |' });
  ok(r.status === 200 && (await r.json()).queued === true, 'say queued before the socket exists');
  r = await api('POST', `/sessions/${s.session_id}/say`, { text: '---' });
  ok(r.status === 200 && (await r.json()).queued === false, 'nothing-to-say chunk is accepted and skipped');

  const { ws, inbox } = await connect(TOKEN,s.call_id);
  await waitFor(inbox, (m) => m.response_type === 'update_agent');
  ok(inbox.some((m) => m.response_type === 'config' && m.config.call_details === true), 'config asks for call_details');
  ok(inbox.some((m) => m.response_type === 'update_agent' && m.agent_config.interruption_sensitivity === 0), 'update_agent: never interrupted');
  ws.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: s.call_id, call_type: 'web_call', metadata: { reader: true, reader_session: s.session_id, uid: 10 } } }));
  const first = await waitFor(inbox, (m) => m.response_type === 'response');
  ok(first.response_id === 0 && first.content_complete === false && first.no_interruption_allowed === true, 'queued text streams as response_id 0, incomplete, uninterruptible');
  ok(/95 dollars a megalitre/.test(first.content) && /See the table on screen/.test(first.content) && !/\*\*/.test(first.content), 'markdown stripped + units expanded before Retell hears it');

  // Live: says after the socket is up go straight through, in order.
  await api('POST', `/sessions/${s.session_id}/say`, { text: 'Second sentence here.' });
  await api('POST', `/sessions/${s.session_id}/say`, { text: 'Third one.' });
  await waitFor(inbox, (m) => m.response_type === 'response' && /Third one/.test(m.content));
  const texts = responses(inbox).map((m) => m.content);
  ok(texts.length === 3 && /Second/.test(texts[1]) && /Third/.test(texts[2]) && texts.every((t) => /\s$/.test(t)), 'live chunks in order, each with a trailing space');

  // Retell raising a turn (the muted mic) gets an empty complete answer for that id; the stream stays on 0.
  ws.send(JSON.stringify({ interaction_type: 'response_required', response_id: 7, transcript: [{ role: 'user', content: 'hello?' }] }));
  const empty = await waitFor(inbox, (m) => m.response_type === 'response' && m.response_id === 7);
  ok(empty.content === '' && empty.content_complete === true, 'response_required answered empty + complete');
  ws.send(JSON.stringify({ interaction_type: 'ping_pong', timestamp: 1 }));
  await waitFor(inbox, (m) => m.response_type === 'ping_pong');
  ok(true, 'ping_pong answered');

  // Close: the response completes and the call ends.
  r = await api('POST', `/sessions/${s.session_id}/close`);
  ok(r.status === 204, 'close accepted');
  const done = await waitFor(inbox, (m) => m.response_type === 'response' && m.response_id === 0 && m.content_complete === true);
  ok(done.end_call === true && done.content === '', 'final message: content_complete + end_call');
  r = await api('POST', `/sessions/${s.session_id}/say`, { text: 'too late' });
  ok(r.status === 200 && (await r.json()).closed === true, `say after close -> 200 closed (never a 4xx the browser would treat as a failure) (${r.status})`);

  // Retell's call_ended webhook drops the session; call_analyzed records spend (ledger disabled here) and creates NO voice_call row.
  const before = await store.getCallByRetellId(s.call_id);
  await handleRetellEvent({ event: 'call_started', call: { call_id: s.call_id, call_type: 'web_call', metadata: { reader: true, reader_session: s.session_id, uid: 10 } } });
  await handleRetellEvent({ event: 'call_analyzed', call: { call_id: s.call_id, metadata: { reader: true, uid: 10 }, call_cost: { combined_cost: 12, total_duration_seconds: 9 }, duration_ms: 9000 } });
  await handleRetellEvent({ event: 'call_ended', call: { call_id: s.call_id, metadata: { reader: true, reader_session: s.session_id, uid: 10 } } });
  ok(before === null && (await store.getCallByRetellId(s.call_id)) === null, 'reader calls never become voice_call rows');
  ok(_readerSessionCount() === 0, 'session dropped on call_ended');
  ws.close();
}

section = "3 guards";
// ---- 3. guards -------------------------------------------------------------------
{
  let r = await api('POST', '/sessions'); const a = await r.json();
  uid = 11;
  r = await api('POST', `/sessions/${a.session_id}/say`, { text: 'hi' });
  ok(r.status === 404, `another user's session is invisible (${r.status})`);
  uid = 10;
  r = await api('POST', '/sessions'); const b = await r.json();
  r = await api('POST', '/sessions'); const c = await r.json();
  ok(_readerSessionCount() === 2, 'per-user cap: the oldest session is abandoned for the newest');
  // A failed create must release its reserved slot.
  _setWebCallFactory(async () => { throw new Error('retell down'); });
  r = await api('POST', '/sessions');
  ok(r.status === 502 && _readerSessionCount() === 2, `create failure -> 502 and no slot leaked (${r.status})`);
  _setWebCallFactory(async (input) => { created.push(input); const id = 'call_reader_' + (++callSeq); return { call_id: id, access_token: 'tok_' + id }; });
  r = await api('POST', `/sessions/${a.session_id}/say`, { text: 'hi' });
  ok(r.status === 404, 'abandoned session is gone');

  // Unknown call on the socket -> closed 1008. Wrong token -> 404 handshake.
  const unknown = await connect(TOKEN,'call_nobody');
  unknown.ws.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: 'call_nobody', metadata: {} } }));
  const closeCode = await new Promise<number>((res) => unknown.ws.on('close', (code) => res(code)));
  ok(closeCode === 1008, `unknown call socket closed 1008 (${closeCode})`);
  let bad = false; try { await connect('wrong', c.call_id); } catch { bad = true; }
  ok(bad, 'wrong ws token -> handshake refused');
  // Mismatched metadata (a session id that is not this call's) is refused too.
  const mm = await connect(TOKEN,c.call_id);
  mm.ws.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: c.call_id, metadata: { reader: true, reader_session: b.session_id } } }));
  const mmCode = await new Promise<number>((res) => mm.ws.on('close', (code) => res(code)));
  ok(mmCode === 1008, 'metadata/session mismatch refused');

  // DELETE = hang up now: an admitted socket gets the end_call, the session is dropped.
  const live = await connect(TOKEN,c.call_id);
  live.ws.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: c.call_id, metadata: { reader: true, reader_session: c.session_id } } }));
  await sleep(50);
  await api('POST', `/sessions/${c.session_id}/say`, { text: 'Some text.' });
  await waitFor(live.inbox, (m) => m.response_type === 'response');
  r = await api('DELETE', `/sessions/${c.session_id}`);
  const ended = await waitFor(live.inbox, (m) => m.response_type === 'response' && m.end_call === true);
  ok(r.status === 204 && ended.content_complete === true, 'DELETE ends the call');
  ok(_readerSessionCount() === 1, 'deleted session dropped (one left: b)');

  // Per-say and per-session caps — measured on the SPOKEN text, and never a 4xx.
  r = await api('POST', `/sessions/${b.session_id}/say`, { text: 'x'.repeat(5000) });
  ok(r.status === 200 && (await r.json()).too_long === true, `oversized say -> 200 too_long (${r.status})`);
  const bigTable = '| a | b |\n|---|---|\n' + '| ' + 'x'.repeat(3000) + ' | ' + 'y'.repeat(3000) + ' |\n';
  r = await api('POST', `/sessions/${b.session_id}/say`, { text: bigTable });
  ok(r.status === 200 && (await r.json()).queued === true, 'a 6k-char markdown table is fine: it strips to "See the table on screen."');
  for (let i = 0; i < 3; i++) await api('POST', `/sessions/${b.session_id}/say`, { text: 'Sentence number ' + i + '. ' + 'word '.repeat(700) });
  r = await api('POST', `/sessions/${b.session_id}/say`, { text: 'word '.repeat(700) });
  const capped = await r.json();
  ok(capped.capped === true && capped.closed === true, 'session char cap: closes with an on-screen pointer');
  r = await api('POST', `/sessions/${b.session_id}/say`, { text: 'more' });
  ok(r.status === 200 && (await r.json()).closed === true, 'post-cap say -> 200 closed');

  // Retell raises its own turn mid-stream (the pre-mute window): answered empty + complete, and the
  // stream — later chunks and the final end_call — stays on id 0 (the live-verified behaviour).
  r = await api('POST', '/sessions'); const e2 = await r.json();
  const mid = await connect(TOKEN, e2.call_id);
  mid.ws.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: e2.call_id, metadata: { reader: true, reader_session: e2.session_id } } }));
  await sleep(50);
  await api('POST', `/sessions/${e2.session_id}/say`, { text: 'First part.' });
  await waitFor(mid.inbox, (m) => m.response_type === 'response' && m.response_id === 0);
  mid.ws.send(JSON.stringify({ interaction_type: 'response_required', response_id: 3, transcript: [] }));
  const ans = await waitFor(mid.inbox, (m) => m.response_type === 'response' && m.response_id === 3);
  ok(ans.content === '' && ans.content_complete === true, 'a raised turn mid-stream is answered empty + complete');
  await api('POST', `/sessions/${e2.session_id}/say`, { text: 'Second part.' });
  const after = await waitFor(mid.inbox, (m) => m.response_type === 'response' && /Second part/.test(m.content));
  ok(after.response_id === 0, 'later chunks stay on id 0');
  await api('POST', `/sessions/${e2.session_id}/close`);
  const fin = await waitFor(mid.inbox, (m) => m.response_type === 'response' && m.content_complete === true && m.end_call === true);
  ok(fin.response_id === 0, 'end_call goes out on id 0');
  mid.ws.close();

  // TTL sweep.
  { const before = _readerSessionCount(); const swept = sweepReaderSessions(Date.now() + 11 * 60_000);
    ok(swept === before && _readerSessionCount() === 0, `ttl sweep abandons stale sessions (had ${before}, swept ${swept}, left ${_readerSessionCount()})`); }
  live.ws.close(); mm.ws.close(); unknown.ws.close();

  // Socket-close fallback: Retell hangs up, no webhook arrives -> the session is dropped after the
  // reconnect grace and the call is fetched (get-call seam) for its cost.
  const fetched: string[] = [];
  _setCallFetcher(async (id) => { fetched.push(id); return { call_id: id, call_status: 'ended', call_cost: { combined_cost: 7, total_duration_seconds: 5 }, metadata: { reader: true, uid: 10 } } as any; });
  _setReconcileDelay(50);
  r = await api('POST', '/sessions'); const d = await r.json();
  const sock = await connect(TOKEN, d.call_id);
  sock.ws.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: d.call_id, metadata: { reader: true, reader_session: d.session_id } } }));
  await sleep(50);
  ok(_readerSessionCount() === 1, 'session admitted');
  sock.ws.close();
  await sleep(5_400);
  ok(_readerSessionCount() === 0 && fetched.includes(d.call_id), 'closed socket without a webhook: session dropped + call fetched for billing');
  _setCallFetcher(null);
}

section = "4 readerText";
// ---- 4. readerText -----------------------------------------------------------
ok(readerText('Sell **200 ML** at $95/ML.') === 'Sell 200 megalitres at 95 dollars a megalitre.', 'readerText = strip + expand');
ok(readerText('```chart\n{}\n```') === 'See the chart on screen.', 'chart -> screen pointer (there is a screen)');

server.close();
await pool.end().catch(() => {});
console.log(`\nreader: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
