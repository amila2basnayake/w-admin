/**
 * Protocol test: a fake Retell drives the REAL websocket endpoint + webhook route end to end, with a
 * scripted model (no Anthropic calls, no Retell account). Exercises: token/call-id gating, opening
 * with caller-ID candidate, tier gate → OTP → account tool, prepare → read-back (no interruption)
 * → refused confirmation on an amended "yes" → placed on a clean "yes" (via the CRM seam when it is
 * up), escalation → transfer_number, the signed call_ended webhook closing the record, and an
 * outbound-flow opening.
 *   npm run test:voice-protocol
 * Needs the local DB. Order placement needs the CRM on :81 (skipped, not failed, when it is down).
 */

import './test/voice-test-env';
import express from 'express';
import http from 'node:http';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import { mountVoiceRoutes } from './src/voice';
import { voiceConfig } from './src/voice/config';
import { config } from './src/config';
import { attachVoiceWebSocket, _setCallVerifier } from './src/voice/ws';
import { _setAnthropicClient } from './src/voice/agent';
import { signRetellBody } from './src/voice/retell';
import * as store from './src/voice/store';
import { withdrawOrdersPlacedOnCall } from './test/voice-cleanup';
import { pool } from './src/db';

const UID = 119063;       // Stuart (test client used by test-broker.ts)
const REGION = 311325;    // 1A Central Goulburn
let pass = 0, fail = 0;
function ok(cond: boolean, msg: string) { if (cond) pass++; else { fail++; console.error('FAIL:', msg); } }

// ---- scripted model: `plan(lastToolResult, userText)` returns the next step -----------------------
type Step = { text?: string; tool?: { name: string; input: any } };
let planner: (ctx: { lastTool: { name: string; result: any } | null; userText: string; turn: number }) => Step = () => ({ text: 'Okay.' });
let turnNo = 0;
const seenToolResults: Array<{ name: string; result: any }> = [];
function scriptedClient() {
  return {
    messages: {
      stream(params: any) {
        const msgs = params.messages as any[];
        // Find the last tool_use/tool_result pair to hand the planner.
        let lastTool: { name: string; result: any } | null = null;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m.role === 'user' && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result')) {
            const tr = m.content.find((b: any) => b.type === 'tool_result');
            const prev = msgs[i - 1];
            const tu = Array.isArray(prev?.content) ? prev.content.find((b: any) => b.type === 'tool_use' && b.id === tr.tool_use_id) : null;
            let parsed: any = tr.content;
            try { parsed = JSON.parse(tr.content); } catch { /* keep text */ }
            lastTool = { name: tu?.name ?? '?', result: parsed };
            break;
          }
          if (m.role === 'user' && typeof m.content === 'string') break; // reached the user turn: no tool yet
        }
        if (lastTool) seenToolResults.push(lastTool);
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
        const step = planner({ lastTool, userText: String(lastUser?.content ?? ''), turn: turnNo });
        const handlers: Record<string, Function[]> = {};
        const content: any[] = [];
        if (step.text) content.push({ type: 'text', text: step.text });
        if (step.tool) content.push({ type: 'tool_use', id: 'tu_' + Math.random().toString(36).slice(2), name: step.tool.name, input: step.tool.input });
        const obj = {
          on(ev: string, fn: Function) { (handlers[ev] ??= []).push(fn); return obj; },
          async finalMessage() {
            await new Promise((r) => setTimeout(r, 2));
            if (step.tool) for (const fn of handlers.streamEvent ?? []) fn({ type: 'content_block_start', content_block: { type: 'tool_use' } });
            if (step.text) for (const fn of handlers.text ?? []) fn(step.text);
            return { content, stop_reason: step.tool ? 'tool_use' : 'end_turn' };
          },
        };
        return obj;
      },
    },
  };
}

// ---- capture the console OTP -----------------------------------------------------------------
let otpCode: string | null = null;
const origLog = console.log;
console.log = (...a: any[]) => {
  const s = a.map(String).join(' ');
  const m = /\[voice\] OTP for call \d+ → \w+ [^:]+: (\d{6})/.exec(s);
  if (m) otpCode = m[1];
  origLog(...a);
};

// ---- fake Retell client helpers ------------------------------------------------------------------
type Utt = { role: 'agent' | 'user'; content: string };
const inboxes = new WeakMap<WebSocket, any[]>();
function connect(port: number, token: string, callId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/llm/${token}/${callId}`);
    const inbox: any[] = [];
    inboxes.set(ws, inbox);
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));   // attached before 'open' so the first frame is never missed
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function collect(ws: WebSocket) { return inboxes.get(ws)!; }
async function waitFor(inbox: any[], pred: (m: any) => boolean, ms = 8000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = inbox.find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timeout waiting for message');
}
/** Send response_required and gather the streamed response for that id until content_complete. */
async function turn(ws: WebSocket, inbox: any[], id: number, transcript: Utt[], kind: 'response_required' | 'reminder_required' = 'response_required') {
  turnNo = id;
  ws.send(JSON.stringify({ interaction_type: kind, response_id: id, transcript }));
  const done = await waitFor(inbox, (m) => m.response_type === 'response' && m.response_id === id && m.content_complete === true, 15000);
  const chunks = inbox.filter((m) => m.response_type === 'response' && m.response_id === id);
  return { text: chunks.map((c) => c.content).join(' ').replace(/\s+/g, ' ').trim(), chunks, done };
}

async function main() {
  _setAnthropicClient(scriptedClient());
  // Stand-in for Retell get-call: it knows the call (web calls created with metadata keep it; phone calls
  // carry the caller's number) or it does not. Retell's fields are authoritative over call_details.
  const webCalls = new Map<string, any>();
  _setCallVerifier(async (callId) => {
    if (webCalls.has(callId)) return { call_id: callId, call_type: 'web_call', agent_id: 'agent_test', call_status: 'ongoing', metadata: webCalls.get(callId) };
    return callId.startsWith('call_ok_') ? {
      call_id: callId, call_type: 'phone_call', direction: 'inbound', from_number: '+61400111222', to_number: '+61800000000', agent_id: 'agent_test', call_status: 'ongoing',
    } : null;
  });

  const app = express();
  app.use((req, res, next) => (req.path === '/voice/webhooks/retell' ? next() : express.json({ limit: '1mb' })(req, res, next)));
  mountVoiceRoutes(app);
  const server = http.createServer(app);
  attachVoiceWebSocket(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;

  // ---- 1. gating ------------------------------------------------------------------------------
  {
    const bad = await connect(port, 'wrongtoken', 'call_ok_1').then(() => 'open').catch(() => 'refused');
    ok(bad === 'refused', 'wrong ws token is refused at upgrade');
    const ws = await connect(port, 'testtoken', 'call_bogus_1');
    const inbox = collect(ws);
    await waitFor(inbox, (m) => m.response_type === 'config');
    ws.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: 'call_bogus_1', from_number: '+61400111222' } }));
    const closed = await new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ok(closed === 1008, `unverifiable call id is closed with 1008 (got ${closed})`);
  }

  // ---- 2. inbound call: opening → verify → holdings → order → transfer ---------------------
  const callId = 'call_ok_' + Date.now();
  const ws = await connect(port, 'testtoken', callId);
  const inbox = collect(ws);
  const cfg = await waitFor(inbox, (m) => m.response_type === 'config');
  ok(cfg.config.call_details === true && cfg.config.auto_reconnect === true, 'config asks for call_details + auto_reconnect');
  ws.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: callId, call_type: 'phone_call', direction: 'inbound', from_number: '+61400111222', to_number: '+61800000000', agent_id: 'agent_test' } }));
  const opening = await waitFor(inbox, (m) => m.response_type === 'response' && m.response_id === 0);
  ok(/automated assistant/.test(opening.content) && /recorded/.test(opening.content), 'opening discloses AI + recording');
  ok(/Am I speaking with Stuart\?/.test(opening.content), 'caller-ID candidate → first-name check: ' + opening.content);
  ok(opening.no_interruption_allowed === true, 'opening not interruptible');
  ws.send(JSON.stringify({ interaction_type: 'ping_pong', timestamp: Date.now() }));
  await waitFor(inbox, (m) => m.response_type === 'ping_pong');
  pass++;

  const t: Utt[] = [{ role: 'agent', content: opening.content }];

  // Turn 1: confirm identity → holdings refused → send code → ask for it.
  planner = ({ lastTool }) => {
    if (!lastTool) return { tool: { name: 'confirm_caller_identity', input: { is_that_person: true } } };
    if (lastTool.name === 'confirm_caller_identity') return { tool: { name: 'get_my_holdings', input: {} } };
    if (lastTool.name === 'get_my_holdings') return { tool: { name: 'send_verification_code', input: {} } };
    if (lastTool.name === 'send_verification_code') return { text: `To protect your account I've sent a code to ${lastTool.result.sent_to}. Could you read it back to me?` };
    return { text: 'Okay.' };
  };
  t.push({ role: 'user', content: "Yes it's me. What water do I hold?" });
  let r = await turn(ws, inbox, 1, t);
  ok(/sent a code to the mobile ending in/.test(r.text), 'turn 1: code sent, caller told where: ' + r.text);
  const refused = seenToolResults.find((x) => x.name === 'get_my_holdings');
  ok(refused?.result?.status === 'REFUSED_NOT_VERIFIED', 'holdings refused before verification');
  ok(!!otpCode, 'OTP printed on the console transport');
  t.push({ role: 'agent', content: r.text });

  // Turn 2: caller reads the code → verified → holdings answered.
  planner = ({ lastTool, userText }) => {
    if (!lastTool) return { tool: { name: 'check_verification_code', input: { code: userText } } };
    if (lastTool.name === 'check_verification_code') return lastTool.result.status === 'verified' ? { tool: { name: 'get_my_holdings', input: {} } } : { text: 'That code did not match.' };
    if (lastTool.name === 'get_my_holdings') { const rows = lastTool.result?.rows ?? lastTool.result; return { text: `Thanks Stuart, you're verified. You hold water in ${Array.isArray(rows) ? rows.length : 'several'} zones. What would you like to do?` }; }
    return { text: 'Okay.' };
  };
  t.push({ role: 'user', content: otpCode!.split('').join(' ') });
  r = await turn(ws, inbox, 2, t);
  ok(/verified/.test(r.text) && /zones/.test(r.text), 'turn 2: verified + holdings spoken: ' + r.text);
  const holdings = seenToolResults.filter((x) => x.name === 'get_my_holdings').pop();
  ok(Array.isArray(holdings?.result?.rows ?? holdings?.result) && !(holdings?.result?.status), 'holdings tool returned rows after verification');
  const callRow = await store.getCallByRetellId(callId);
  ok(callRow?.auth_level === 2 && callRow?.client_uid === UID, `voice_call row: auth_level=2, client=${UID}`);
  t.push({ role: 'agent', content: r.text });

  // Turn 3: sell → prepare → read-back (no interruption).
  let pendingId: number | null = null;
  planner = ({ lastTool }) => {
    if (!lastTool) return { tool: { name: 'prepare_sell_order', input: { region_id: REGION, product: 'allocation', volume_ml: 1, price_per_ml: 9990 } } };
    if (lastTool.name === 'prepare_sell_order') {
      pendingId = lastTool.result?.order?.pending_order_id ?? null;
      if (!pendingId) return { text: `I couldn't prepare that: ${lastTool.result?.reason ?? lastTool.result?.status}.` };
      return { text: 'To confirm: selling one megalitre of allocation in the Central Goulburn one A zone at nine thousand nine hundred and ninety dollars a megalitre. Do you confirm this order and accept Waterfind\'s terms and conditions?' };
    }
    return { text: 'Okay.' };
  };
  t.push({ role: 'user', content: 'Sell one megalitre of allocation in Goulburn one A at nine thousand nine hundred and ninety dollars.' });
  r = await turn(ws, inbox, 3, t);
  ok(pendingId != null, 'turn 3: order prepared (pending id ' + pendingId + ')');
  ok(/Do you confirm/.test(r.text), 'turn 3: read-back asked');
  ok(r.chunks.every((c) => c.no_interruption_allowed === true), 'read-back chunks are no_interruption_allowed');
  t.push({ role: 'agent', content: r.text });

  // Turn 4: amended yes → server refuses to place.
  planner = ({ lastTool }) => {
    if (!lastTool) return { tool: { name: 'confirm_prepared_order', input: { pending_order_id: pendingId } } };
    if (lastTool.name === 'confirm_prepared_order') return { text: lastTool.result.status === 'not_confirmed' ? 'No problem — what price would you like instead?' : `Result ${lastTool.result.status}.` };
    return { text: 'Okay.' };
  };
  t.push({ role: 'user', content: 'Yes, but change the price to nine thousand.' });
  r = await turn(ws, inbox, 4, t);
  const refusedConfirm = seenToolResults.filter((x) => x.name === 'confirm_prepared_order').pop();
  ok(refusedConfirm?.result?.status === 'not_confirmed' && refusedConfirm?.result?.verdict === 'no', 'turn 4: amended yes is NOT a confirmation: ' + JSON.stringify(refusedConfirm?.result).slice(0, 120));
  ok(/what price/.test(r.text), 'turn 4: agent goes back to the caller');
  t.push({ role: 'agent', content: r.text });

  // Turn 5: clean yes → placed via the seam (or seam-down: unknown/failed but never "placed").
  planner = ({ lastTool }) => {
    if (!lastTool) return { tool: { name: 'confirm_prepared_order', input: { pending_order_id: pendingId } } };
    if (lastTool.name === 'confirm_prepared_order') return { text: lastTool.result.status === 'placed' ? `Done — your order number is ${lastTool.result.order_number}. Your broker has been notified.` : `The order was not placed: ${lastTool.result.status}.` };
    return { text: 'Okay.' };
  };
  t.push({ role: 'user', content: 'Yes, I confirm and accept the terms.' });
  r = await turn(ws, inbox, 5, t);
  const placed = seenToolResults.filter((x) => x.name === 'confirm_prepared_order').pop();
  if (placed?.result?.status === 'placed') {
    ok(/order number is \d+/.test(r.text), 'turn 5: placed through the CRM seam, order number spoken: ' + r.text);
    const evs = await store.listCallEvents(callRow!.id);
    ok(evs.some((e) => e.type === 'order_confirmed'), 'order_confirmed audited');
  } else {
    origLog(`  (seam result: ${JSON.stringify(placed?.result).slice(0, 160)} — CRM seam not available; placement step skipped)`);
    ok(!/order number is/.test(r.text), 'turn 5: never claims placement when the seam did not place');
  }
  t.push({ role: 'agent', content: r.text });

  // Turn 6: ask for a person → escalate → transfer_number on the final chunk.
  planner = ({ lastTool }) => {
    if (!lastTool) return { tool: { name: 'escalate_to_broker', input: { reason: 'requested a person', summary: 'Stuart, verified, placed a sell order and now wants to discuss strategy with his broker.' } } };
    if (lastTool.name === 'escalate_to_broker') return { text: lastTool.result.status === 'transferring' ? "Of course — I've noted the conversation for your broker and I'll put you through now." : `I've booked a callback: ${lastTool.result.status}.` };
    return { text: 'Okay.' };
  };
  t.push({ role: 'user', content: 'Can I talk to a person please?' });
  r = await turn(ws, inbox, 6, t);
  ok(r.done.transfer_number === '+61812345678', 'turn 6: final chunk carries transfer_number: ' + JSON.stringify(r.done));
  const esc = seenToolResults.filter((x) => x.name === 'escalate_to_broker').pop();
  ok(esc?.result?.crm_task_recorded === true, 'escalation raised a CRM broker task: ' + JSON.stringify(esc?.result).slice(0, 120));

  // Reminder turn (silence) still answers.
  planner = () => ({ text: 'Are you still there?' });
  r = await turn(ws, inbox, 7, t, 'reminder_required');
  ok(/still there/.test(r.text), 'reminder_required produces a short check-in');
  // A second reminder on a call where the caller HAS spoken is still the model's check-in, not a hang-up.
  r = await turn(ws, inbox, 8, t, 'reminder_required');
  ok(/still there/.test(r.text) && !r.done.end_call, 'second reminder after real speech does not hang up');

  // ---- dead line: nobody ever spoke → second reminder says goodbye and ends the call ------------
  {
    const cid = 'call_ok_dead_' + Date.now();
    const wsd = await connect(port, 'testtoken', cid);
    const inboxd = collect(wsd);
    await waitFor(inboxd, (m) => m.response_type === 'config');
    wsd.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: cid, call_type: 'phone_call', direction: 'inbound', from_number: '+61400111222', to_number: '+61800000000', agent_id: 'agent_test' } }));
    const opd = await waitFor(inboxd, (m) => m.response_type === 'response' && m.response_id === 0);
    const td: Utt[] = [{ role: 'agent', content: opd.content }];
    planner = () => ({ text: 'Hello? Are you still there?' });
    let rd = await turn(wsd, inboxd, 1, td, 'reminder_required');
    ok(/still there/.test(rd.text) && !rd.done.end_call, 'dead line: first reminder is a check-in');
    td.push({ role: 'agent', content: rd.text });
    rd = await turn(wsd, inboxd, 2, td, 'reminder_required');
    ok(rd.done.end_call === true, 'dead line: second reminder ends the call');
    ok(/can't hear anything|let you go/.test(rd.text), 'dead line: a spoken goodbye, not silence: ' + rd.text);
    const rowd = await store.getCallByRetellId(cid);
    const evd = await store.listCallEvents(rowd!.id);
    ok(evd.some((e) => e.type === 'ended' && e.detail?.reason === 'dead_line'), 'dead line: ended event carries the reason');
    wsd.close();
    await pool.query('DELETE FROM voice_call WHERE retell_call_id=$1', [cid]);
  }

  // ---- 3. webhook closes the record ------------------------------------------------------------
  {
    const before = await store.getCallByRetellId(callId);
    ok(before?.outcome === 'transfer_requested', `before Retell confirms, outcome is transfer_requested (got ${before?.outcome})`);
    const body = JSON.stringify({ event: 'call_ended', call: { call_id: callId, call_type: 'phone_call', direction: 'inbound', from_number: '+61400111222', to_number: '+61800000000', disconnection_reason: 'call_transfer', start_timestamp: Date.now() - 90_000, end_timestamp: Date.now(), transcript_object: t, recording_url: 'https://example.invalid/rec.wav' } });
    const post = (headers: Record<string, string>, b = body, path = '/voice/webhooks/retell') => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: b });
    ok((await post({ 'x-retell-signature': 'v=1,d=00' })).status === 401, 'invalid-signature webhook rejected');
    ok((await post({})).status === 401, 'unsigned webhook rejected (no trusted IPs by default)');
    // Trusted-IP policy: the test socket IS loopback, so the last X-Forwarded-For hop is the source.
    voiceConfig.webhookTrustedIps.push('100.20.5.228');
    ok((await post({ 'x-retell-signature': 'v=1,d=00', 'x-forwarded-for': '100.20.5.228' })).status === 401, 'invalid signature is rejected even from a trusted IP');
    ok((await post({ 'x-forwarded-for': '100.20.5.228' }, JSON.stringify({ event: 'call_started', call: { call_id: 'call_ok_ip_' + Date.now(), call_type: 'phone_call' } }))).status === 204, 'unsigned webhook from a trusted IP (last XFF hop over the loopback tunnel) accepted');
    ok((await post({ 'x-forwarded-for': '100.20.5.228, 203.0.113.7' })).status === 401, 'a spoofed FIRST X-Forwarded-For value does not count (last hop is the source)');
    voiceConfig.webhookTrustedIps.length = 0;
    let big: number | string;
    try { big = (await post({ 'x-retell-signature': signRetellBody('x'.repeat(10), 'test_retell_key') }, 'x'.repeat(3 * 1024 * 1024))).status; } catch { big = 'reset'; }
    ok(big === 413 || big === 'reset', `oversized webhook body refused (${big})`);
    const good = await post({ 'x-retell-signature': signRetellBody(body, 'test_retell_key') });
    ok(good.status === 204, 'signed webhook accepted');
    const closed = await store.getCallByRetellId(callId);
    ok(closed?.status === 'ended' && closed?.outcome === 'transferred' && !!closed?.recording_url && Array.isArray(closed?.transcript), `call closed: status=${closed?.status} outcome=${closed?.outcome}`);
    ok((closed?.duration_seconds ?? 0) >= 89, 'duration recorded');
    await pool.query(`DELETE FROM voice_call WHERE retell_call_id LIKE 'call_ok_ip_%'`);
  }
  ws.close();

  // ---- 3b. websocket call-id validation + rehydration -------------------------------------------
  {
    // call_details whose call_id differs from the socket's URL id → closed.
    const wsA = await connect(port, 'testtoken', 'call_ok_a_' + Date.now());
    await waitFor(collect(wsA), (m) => m.response_type === 'config');
    wsA.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: 'call_ok_other', from_number: '+61400111222' } }));
    ok((await new Promise<number>((r) => wsA.on('close', (code) => r(code)))) === 1008, 'call_details with a different call id is closed with 1008');
    // A known row carrying verification (auth_level 2) must be re-confirmed with Retell: unknown to Retell → closed.
    const cidB = 'call_known_b_' + Date.now();
    const rowB = await store.upsertCallStart({ retellCallId: cidB, direction: 'inbound', flow: 'inbound', agentId: null, fromNumber: '+61400111222', toNumber: null, metadata: {} });
    await store.setCallIdentity(rowB.id, UID, null, 'caller_id');
    await store.setCallAuthLevel(rowB.id, 2);
    const wsB = await connect(port, 'testtoken', cidB);
    await waitFor(collect(wsB), (m) => m.response_type === 'config');
    wsB.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: cidB, from_number: '+61400111222', client_uid: UID } }));
    ok((await new Promise<number>((r) => wsB.on('close', (code) => r(code)))) === 1008, 'known verified row but Retell does not know the call → closed (no rehydration from message fields)');
    // Retell knows it but with a DIFFERENT from_number → closed.
    const cidC = 'call_ok_c_' + Date.now();
    const rowC = await store.upsertCallStart({ retellCallId: cidC, direction: 'inbound', flow: 'inbound', agentId: null, fromNumber: '+61400999999', toNumber: null, metadata: {} });
    await store.setCallIdentity(rowC.id, UID, null, 'caller_id');
    await store.setCallAuthLevel(rowC.id, 2);
    const wsC = await connect(port, 'testtoken', cidC);
    await waitFor(collect(wsC), (m) => m.response_type === 'config');
    wsC.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: cidC, from_number: '+61400999999' } }));
    ok((await new Promise<number>((r) => wsC.on('close', (code) => r(code)))) === 1008, 'known verified row whose from_number differs from Retell\'s → closed');
    // Retell confirms (same from_number, ongoing) → rehydrated at level 2 without repeating the opening.
    const cidD = 'call_ok_d_' + Date.now();
    const rowD = await store.upsertCallStart({ retellCallId: cidD, direction: 'inbound', flow: 'inbound', agentId: null, fromNumber: '+61400111222', toNumber: null, metadata: {} });
    await store.setCallIdentity(rowD.id, UID, null, 'caller_id');
    await store.setCallAuthLevel(rowD.id, 2);
    await store.addCallEvent(rowD.id, 'consent_disclosed', {});
    const wsD = await connect(port, 'testtoken', cidD);
    const inboxD = collect(wsD);
    await waitFor(inboxD, (m) => m.response_type === 'config');
    wsD.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: cidD, from_number: '+61400111222' } }));
    planner = ({ lastTool }) => (!lastTool ? { tool: { name: 'get_my_holdings', input: {} } } : { text: 'Still verified; holdings read.' });
    wsD.send(JSON.stringify({ interaction_type: 'response_required', response_id: 1, transcript: [{ role: 'agent', content: 'opening' }, { role: 'user', content: 'What do I hold?' }] }));
    const dDone = await waitFor(inboxD, (m) => m.response_type === 'response' && m.response_id === 1 && m.content_complete === true);
    ok(!inboxD.some((m) => m.response_type === 'response' && m.response_id === 0), 'rehydrated call does not repeat the opening');
    const hd = seenToolResults.filter((x) => x.name === 'get_my_holdings').pop();
    ok(!!dDone && !hd?.result?.status, 'rehydrated at level 2: holdings served after Retell re-confirmed the call');
    wsD.close();
    // A row that is already ended cannot be reopened.
    const cidE = 'call_ok_e_' + Date.now();
    await store.upsertCallStart({ retellCallId: cidE, direction: 'inbound', flow: 'inbound', agentId: null, fromNumber: '+61400111222', toNumber: null, metadata: {} });
    await store.closeCall(cidE, { status: 'ended' });
    const wsE = await connect(port, 'testtoken', cidE);
    await waitFor(collect(wsE), (m) => m.response_type === 'config');
    wsE.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: cidE, from_number: '+61400111222' } }));
    ok((await new Promise<number>((r) => wsE.on('close', (code) => r(code)))) === 1008, 'an ended call row cannot be reopened over a new socket');
    await pool.query(`DELETE FROM voice_call WHERE retell_call_id IN ($1,$2,$3,$4)`, [cidB, cidC, cidD, cidE]);
  }

  // ---- 3c. HTTP surface: kill switch, staff-only admin, outbound contract --------------------------
  {
    const base = `http://127.0.0.1:${port}/voice`;
    const mint = (claims: Record<string, unknown>) => {
      const b64 = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const body = b64(Buffer.from(JSON.stringify(claims), 'utf8'));
      return `${body}.${b64(crypto.createHmac('sha256', config.sharedSecret).update(body).digest())}`;
    };
    const now = Math.floor(Date.now() / 1000);
    const staffTok = mint({ uid: 10, name: 'Admin', ut: 3, iat: now, exp: now + 600, nonce: 'n' });       // Administrator Waterfind (SU)
    const clientTok = mint({ uid: UID, name: 'Stuart', ut: 0, iat: now, exp: now + 600, nonce: 'n' });
    const get = (path: string, tok?: string) => fetch(base + path, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    // Kill switch: everything but /health is 404 while voice is off.
    voiceConfig.enabled = false;
    ok((await get('/health')).status === 200, 'GET /voice/health answers while voice is disabled');
    ok((await get('/calls', staffTok)).status === 404, 'GET /voice/calls is 404 while voice is disabled (even with a staff token)');
    ok((await fetch(base + '/outbound', { method: 'POST', headers: { authorization: 'Bearer test_outbound_secret', 'content-type': 'application/json' }, body: '{}' })).status === 404, 'POST /voice/outbound is 404 while voice is disabled');
    voiceConfig.enabled = true;
    const health = await (await get('/health')).json();
    ok(!('webhook_url' in health) && health.webhook_configured !== undefined, 'health does not reveal the webhook URL');
    // Admin routes: staff token only.
    ok((await get('/calls')).status === 401, 'GET /voice/calls without a token → 401');
    ok([401, 403].includes((await get('/calls', 'test_outbound_secret')).status), 'the outbound webhook secret does NOT open the call log');
    ok((await get('/calls', clientTok)).status === 403, 'a client token → 403');
    const calls = await get('/calls', staffTok);
    ok(calls.status === 200 && Array.isArray(await calls.json()), 'a staff (BROKER/SU) token lists calls');
    ok((await get('/suppression', 'test_outbound_secret')).status !== 200, 'suppression list is not open to the outbound secret');
    ok((await get('/suppression', staffTok)).status === 200, 'suppression list open to staff');
    // Outbound trigger: secret only, idempotency key required, AU only, callback allowlist.
    const postOut = (body: any, tok = 'test_outbound_secret') => fetch(base + '/outbound', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    ok((await postOut({ flow: 'market_alert', to_number: '+61400000003', idempotency_key: 'pt-1' }, staffTok)).status === 401, 'a staff token cannot trigger outbound calls (secret only)');
    ok((await postOut({ flow: 'market_alert', to_number: '+61400000003' })).status === 400, 'outbound without idempotency_key → 400');
    ok((await postOut({ flow: 'market_alert', to_number: '+14155550100', idempotency_key: 'pt-us' })).status === 400, 'non-AU destination → 400');
    ok((await postOut({ flow: 'broker_followup', to_number: '+61400000003', idempotency_key: 'pt-cb', payload: { callback_number: '+61499999999' } })).status === 400, 'callback_number off the allowlist → 400');
    const key = 'pt-ok-' + Date.now();
    const created = await postOut({ flow: 'market_alert', to_number: '+61400000003', idempotency_key: key, payload: { message: 'Rain\nexpected ' + 'x'.repeat(600) } });
    ok(created.status === 201, 'valid outbound request queued (201)');
    const req = (await created.json()).request;
    const again = await postOut({ flow: 'market_alert', to_number: '+61400000003', idempotency_key: key });
    ok(again.status === 200 && (await again.json()).request.id === req.id, 'same idempotency_key → same request (200)');
    const stored = await store.getOutbound(req.id);
    ok(String(stored?.payload?.message ?? '').length <= 500 && !/\n/.test(String(stored?.payload?.message)), 'payload message capped + flattened on the stored request');
    ok((await fetch(base + `/outbound/${req.id}/cancel`, { method: 'POST', headers: { authorization: 'Bearer test_outbound_secret' } })).status !== 200, 'cancel is not open to the outbound secret');
    ok((await fetch(base + `/outbound/${req.id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${staffTok}` } })).status === 200, 'staff can cancel the queued request');
    await pool.query('DELETE FROM voice_outbound_request WHERE id=$1', [req.id]);
  }

  // ---- 4. outbound-flow opening (web-call simulating order_confirmation) ----------------------
  {
    const cid = 'call_ok_out_' + Date.now();
    webCalls.set(cid, { flow: 'order_confirmation', client_uid: UID, payload: { order_number: 12345, description: 'sell 1 ML at $9990/ML' } });
    const ws2 = await connect(port, 'testtoken', cid);
    const inbox2 = collect(ws2);
    await waitFor(inbox2, (m) => m.response_type === 'config');
    ws2.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: cid, call_type: 'web_call', agent_id: 'agent_test', metadata: { flow: 'order_confirmation', client_uid: UID, payload: { order_number: 12345, description: 'sell 1 ML at $9990/ML' } } } }));
    const op = await waitFor(inbox2, (m) => m.response_type === 'response' && m.response_id === 0);
    ok(/automated assistant calling on behalf of Waterfind/.test(op.content) && /good time/.test(op.content), 'outbound opening: disclosure + good-time question: ' + op.content);
    ok(/speak with Stuart/.test(op.content) && /order placed/.test(op.content), 'outbound opening names the client and purpose');
    // The brief reaches the model's system prompt.
    let sawBrief = false;
    planner = () => ({ text: 'Great. Before I read the order details, could you confirm the postcode on your account?' });
    const client: any = { messages: { stream(params: any) { sawBrief = JSON.stringify(params.system).includes('order_confirmation'); return scriptedClient().messages.stream(params); } } };
    _setAnthropicClient(client);
    ws2.send(JSON.stringify({ interaction_type: 'response_required', response_id: 1, transcript: [{ role: 'agent', content: op.content }, { role: 'user', content: 'Yes, go ahead.' }] }));
    await waitFor(inbox2, (m) => m.response_type === 'response' && m.response_id === 1 && m.content_complete === true);
    ok(sawBrief, 'outbound brief is in the system prompt');
    const row2 = await store.getCallByRetellId(cid);
    ok(row2?.direction === 'web' && row2?.flow === 'order_confirmation' && row2?.client_uid === UID, 'outbound web-call row recorded with flow + client');
    ws2.close();
    await pool.query('DELETE FROM voice_call WHERE retell_call_id=$1', [cid]);
  }

  const withdrawn = await withdrawOrdersPlacedOnCall(UID, callRow!.id);
  if (withdrawn) origLog(`  cleanup: withdrew ${withdrawn} test order(s)`);
  await pool.query('DELETE FROM voice_call WHERE retell_call_id=$1', [callId]);
  server.close();
  console.log = origLog;
  console.log(`\nvoice-protocol: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log = origLog; console.error(e); process.exit(1); });
