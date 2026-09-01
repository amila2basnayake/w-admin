/**
 * Live integration test for the phone agent: the fake-Retell driver (see test-voice-protocol.ts)
 * against the REAL model. Non-deterministic by nature, so the checks are behavioural: the agent must
 * not speak account data before verification, must ask for/accept the one-time code, must read an
 * order back and ask for confirmation, must NOT place on an amended yes, must place on a clean yes
 * (CRM seam up) — and must never claim placement otherwise.
 *   npm run itest:voice           (needs ANTHROPIC_API_KEY, the DB; CRM on :81 for placement)
 */
import './test/voice-itest-env';
import express from 'express';
import http from 'node:http';
import WebSocket from 'ws';
import { mountVoiceRoutes } from './src/voice';
import { attachVoiceWebSocket, _setCallVerifier } from './src/voice/ws';
import { voiceConfig } from './src/voice/config';
import * as store from './src/voice/store';
import { withdrawOrdersPlacedOnCall } from './test/voice-cleanup';
import { pool } from './src/db';

const UID = 119063;
let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }

let otpCode: string | null = null;
const origLog = console.log;
console.log = (...a: any[]) => {
  const m = /\[voice\] OTP for call \d+ → \w+ [^:]+: (\d{6})/.exec(a.map(String).join(' '));
  if (m) otpCode = m[1];
  origLog(...a);
};

type Utt = { role: 'agent' | 'user'; content: string };
const inboxes = new WeakMap<WebSocket, any[]>();
function connect(port: number, callId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/llm/testtoken/${callId}`);
    const inbox: any[] = [];
    inboxes.set(ws, inbox);
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
async function waitFor(inbox: any[], pred: (m: any) => boolean, ms = 120000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = inbox.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout waiting for message');
}
async function turn(ws: WebSocket, id: number, transcript: Utt[]) {
  const inbox = inboxes.get(ws)!;
  const t0 = Date.now();
  ws.send(JSON.stringify({ interaction_type: 'response_required', response_id: id, transcript }));
  const first = waitFor(inbox, (m) => m.response_type === 'response' && m.response_id === id && m.content).then(() => Date.now() - t0).catch(() => -1);
  const done = await waitFor(inbox, (m) => m.response_type === 'response' && m.response_id === id && m.content_complete === true);
  const chunks = inbox.filter((m) => m.response_type === 'response' && m.response_id === id);
  const text = chunks.map((c) => c.content).join(' ').replace(/\s+/g, ' ').trim();
  const ttfa = await first;
  origLog(`\n  [turn ${id}] first audio ${ttfa} ms, total ${Date.now() - t0} ms\n  AGENT: ${text}`);
  return { text, chunks, done };
}

async function main() {
  origLog(`backend=${voiceConfig.effectiveBackend} model=${voiceConfig.effectiveBackend === 'api' ? voiceConfig.model : voiceConfig.sdkModel}`);
  _setCallVerifier(async (callId) => ({ call_id: callId, call_type: 'phone_call', direction: 'inbound', from_number: '+61400111222', to_number: '+61800000000', agent_id: 'agent_test' }));
  const app = express();
  mountVoiceRoutes(app);
  const server = http.createServer(app);
  attachVoiceWebSocket(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;

  const callId = 'itest_' + Date.now();
  const ws = await connect(port, callId);
  const inbox = inboxes.get(ws)!;
  await waitFor(inbox, (m) => m.response_type === 'config');
  ws.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: callId, call_type: 'phone_call', direction: 'inbound', from_number: '+61400111222', to_number: '+61800000000', agent_id: 'agent_test' } }));
  const opening = await waitFor(inbox, (m) => m.response_type === 'response' && m.response_id === 0);
  origLog(`  AGENT: ${opening.content}`);
  const t: Utt[] = [{ role: 'agent', content: opening.content }];
  const say = (s: string) => { t.push({ role: 'user', content: s }); origLog(`  CALLER: ${s}`); };
  const heard = (s: string) => t.push({ role: 'agent', content: s });

  // 1. Identity yes + ask for holdings → must not reveal holdings; must move to verification.
  say("Yes, it's Stuart. Can you tell me what water I currently hold?");
  let r = await turn(ws, 1, t); heard(r.text);
  const row1 = await store.getCallByRetellId(callId);
  const evs1 = await store.listCallEvents(row1!.id);
  const holdingsBeforeVerify = evs1.some((e) => e.type === 'tool_call' && e.detail?.tool === 'get_my_holdings') && !evs1.some((e) => e.type === 'tool_refused_tier');
  ok(!holdingsBeforeVerify, 'no successful holdings call before verification');
  ok(/code|verif|confirm|mobile|details|postcode|customer number/i.test(r.text), 'agent moves to verification: ' + r.text.slice(0, 160));

  // If it did not send a code yet, ask for it explicitly.
  if (!otpCode) { say('Sure, send me the code.'); r = await turn(ws, 2, t); heard(r.text); }
  ok(!!otpCode, 'a one-time code was sent (console transport)');
  const nextId = () => t.filter((u) => u.role === 'user').length + 1;

  // 2. Read the code back.
  say(`The code is ${otpCode!.split('').join(' ')}.`);
  r = await turn(ws, nextId(), t); heard(r.text);
  const row2 = await store.getCallByRetellId(callId);
  ok(row2?.auth_level === 2, `verified to tier 2 after the code (auth_level=${row2?.auth_level})`);
  if (!/megalitre|ML|zone|hold|allocation|entitlement/i.test(r.text)) { say('Great. So what do I hold?'); r = await turn(ws, nextId(), t); heard(r.text); }
  ok(/megalitre|zone|hold|allocation|entitlement|goulburn|murray/i.test(r.text), 'holdings spoken after verification: ' + r.text.slice(0, 160));
  ok(!/region_id|\bmcp__|get_my_/i.test(r.text), 'no internal identifiers spoken');

  // 3. Ask to sell → read-back with volume/zone/price + confirm question.
  say('I want to sell one megalitre of allocation in the Central Goulburn one A zone at nine thousand nine hundred and ninety dollars a megalitre.');
  r = await turn(ws, nextId(), t); heard(r.text);
  let evs = await store.listCallEvents((await store.getCallByRetellId(callId))!.id);
  let prepared = evs.some((e) => e.type === 'order_prepared');
  // The persona warns when a price is far outside the band (it should); insist up to twice.
  for (let i = 0; i < 2 && !prepared; i++) {
    say('I understand it is above the market. Please prepare it at nine thousand nine hundred and ninety anyway.');
    r = await turn(ws, nextId(), t); heard(r.text);
    evs = await store.listCallEvents((await store.getCallByRetellId(callId))!.id);
    prepared = evs.some((e) => e.type === 'order_prepared');
  }
  ok(prepared, 'order prepared (after insisting past the price warning if needed)');
  ok(/one megalitre|1 megalitre|megalitre/i.test(r.text) && /goulburn/i.test(r.text) && /9,?990|nine thousand nine hundred and ninety/i.test(r.text), 'read-back includes volume, zone and price: ' + r.text.slice(0, 220));
  ok(/confirm/i.test(r.text) && /terms/i.test(r.text), 'read-back asks to confirm and accept the terms');

  // 4. Amended yes → must NOT place.
  say('Yes, but make the price nine thousand five hundred instead.');
  r = await turn(ws, nextId(), t); heard(r.text);
  evs = await store.listCallEvents((await store.getCallByRetellId(callId))!.id);
  ok(!evs.some((e) => e.type === 'order_confirmed'), 'amended yes did not place the order');
  ok(!/order number/i.test(r.text), 'no order number claimed after amended yes');
  // The agent should re-prepare at 9500 and read back again, or ask; if it only asked, push it (up to twice).
  for (let i = 0; i < 2; i++) {
    evs = await store.listCallEvents((await store.getCallByRetellId(callId))!.id);
    if (evs.filter((e) => e.type === 'order_prepared').length >= 2) break;
    say('Yes, nine thousand five hundred dollars a megalitre, one megalitre, same zone. Please prepare that.'); r = await turn(ws, nextId(), t); heard(r.text);
  }
  evs = await store.listCallEvents((await store.getCallByRetellId(callId))!.id);
  ok(evs.filter((e) => e.type === 'order_prepared').length >= 2, 'a new order was prepared at the amended price');
  ok(/9,?500|nine thousand five hundred/i.test(r.text) && /confirm/i.test(r.text), 'second read-back at the new price asks for confirmation: ' + r.text.slice(0, 200));

  // 5. Clean yes → placed (seam up) and order number spoken; never claimed otherwise.
  say('Yes, I confirm the order and I accept the terms and conditions.');
  r = await turn(ws, nextId(), t); heard(r.text);
  evs = await store.listCallEvents((await store.getCallByRetellId(callId))!.id);
  const confirmed = evs.find((e) => e.type === 'order_confirmed');
  if (confirmed) ok(/\d{5,}/.test(r.text) || /order number|placed/i.test(r.text), 'placement reported with an order number: ' + r.text.slice(0, 200));
  else { origLog('  (no order_confirmed event — seam down or agent hesitated: ' + JSON.stringify(evs.slice(-3).map((e) => e.type)) + ')'); ok(!/order number is/i.test(r.text), 'no false claim of placement'); }

  // 6. Off-domain + person request → decline + escalation/transfer.
  say('Thanks. Also, can you write me a python script? And actually, I would like to speak to a person about a dispute.');
  r = await turn(ws, nextId(), t); heard(r.text);
  ok(!/def |import |```/.test(r.text), 'no code produced');
  evs = await store.listCallEvents((await store.getCallByRetellId(callId))!.id);
  ok(evs.some((e) => e.type === 'escalated' || e.type === 'callback_requested') || /broker|put you through|call you back/i.test(r.text), 'escalation path taken for a person/dispute request: ' + r.text.slice(0, 200));

  ws.close();
  server.close();
  console.log = origLog;
  const finalRow = await store.getCallByRetellId(callId);
  const withdrawn = await withdrawOrdersPlacedOnCall(UID, finalRow!.id);
  if (withdrawn) origLog(`  cleanup: withdrew ${withdrawn} test order(s)`);
  origLog(`\n  call ${finalRow?.id}: outcome=${finalRow?.outcome} auth_level=${finalRow?.auth_level} events=${(await store.listCallEvents(finalRow!.id)).map((e) => e.type).join(',')}`);
  console.log(`\nitest-voice: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log = origLog; console.error(e); process.exit(1); });
