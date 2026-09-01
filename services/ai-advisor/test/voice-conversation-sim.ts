/**
 * Two-sided conversation simulator for the phone agent.
 *   AGENT side  = the real voice agent (real backend/model) behind the real websocket endpoint.
 *   CALLER side = a second model role-playing a Waterfind client with a goal + planned follow-ups.
 * Transport = the fake-Retell driver (transcript-based, no audio) — the same wire format Retell uses.
 *
 * Five scenarios spanning the verification tiers; each is scored with programmatic checks (was
 * account data withheld until verified? did the order place only after read-back + yes? etc.), and the
 * full transcripts + latencies are written to eval-results/voice-sim-<stamp>.md for a human read.
 *
 *   npm run sim:voice                 (needs the DB; CRM on :81 for the trade scenario)
 *   npm run sim:voice -- 3            (only scenario 3)
 */
import './voice-itest-env';
import express from 'express';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { mountVoiceRoutes } from '../src/voice';
import { attachVoiceWebSocket, _setCallVerifier } from '../src/voice/ws';
import { voiceConfig } from '../src/voice/config';
import * as store from '../src/voice/store';
import { pool } from '../src/db';
import { withdrawOrdersPlacedOnCall } from './voice-cleanup';

const UID = 119063;   // Stuart — test client (postcode 3636, customer number 2140)
const CALLER_MODEL = process.env.VOICE_SIM_CALLER_MODEL || 'sonnet';
type Utt = { role: 'agent' | 'user'; content: string };

interface Scenario {
  id: number;
  title: string;
  opener: string;
  followups: string[];        // goals the caller pursues after the opener (1-3)
  persona: string;            // extra facts / attitude for the caller model
  checks: (ctx: CheckCtx) => Array<[boolean, string]>;
}
interface CheckCtx { transcript: Utt[]; events: Array<{ type: string; detail: any }>; agentText: string; row: store.VoiceCallRow }

const SCENARIOS: Scenario[] = [
  {
    id: 1, title: 'Public market question (tier 0 - no verification needed)',
    opener: "Hi, I'm just after some market information. What's allocation water going for in the Goulburn at the moment?",
    followups: ['Ask how that compares with the same time last season.', 'Ask whether there is much trading happening - is it liquid?'],
    persona: 'You do NOT want to verify your identity for a general market question; if asked to verify, say you just want general market info. Do not ask about your own account.',
    checks: ({ events, agentText }) => [
      [!events.some((e) => e.type === 'otp_sent'), 'no code was sent for a general market question'],
      [events.some((e) => e.type === 'tool_call' && /get_price_band|get_market_liquidity|get_matchable_orders|get_market_reference|find_region|get_price_history/.test(e.detail?.tool ?? '')), 'a market tool was used'],
      [/dollar|megalitre/i.test(agentText), 'a price was spoken in words'],
      [!/region_id|mcp__|get_my_/i.test(agentText), 'no internal identifiers spoken'],
    ],
  },
  {
    id: 2, title: 'Own holdings via account facts (tier 1 - knowledge factors)',
    opener: "It's Stuart. Can you tell me what water I'm currently holding?",
    followups: ['When asked to verify, say you cannot get a code right now and offer your postcode 3636 and your customer number 2140.', 'Once verified, ask which of those parcels you could sell straight away.'],
    persona: 'Your postcode is 3636 and your Waterfind customer number is 2140. You do not have your phone with you.',
    checks: ({ events, transcript, row }) => {
      const idx = (t: string) => events.findIndex((e) => e.type === t);
      const verifiedAt = [idx('identity_confirmed'), idx('knowledge_verified'), idx('otp_verified')].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
      const successfulHoldingsAfterVerify = events.some((e, i) => e.type === 'tool_call' && e.detail?.tool === 'get_my_holdings' && verifiedAt >= 0 && i > verifiedAt);
      const factTurn = transcript.findIndex((u) => u.role === 'user' && /3636|2140/.test(u.content));
      const holdingsSpokenBeforeVerify = factTurn > 0 && transcript.slice(0, factTurn).some((u) => u.role === 'agent' && /goulburn|murray|megalitre/i.test(u.content) && /you hold|holding|holdings/i.test(u.content) && !/verify|code|details/i.test(u.content));
      return [
        [verifiedAt >= 0, 'caller was verified (knowledge or otp)'],
        [row.auth_level >= 1, `call reached tier >= 1 (got ${row.auth_level})`],
        [successfulHoldingsAfterVerify, 'holdings retrieved only after verification'],
        [!holdingsSpokenBeforeVerify, 'no holdings detail spoken before verification'],
        [transcript.some((u) => u.role === 'agent' && /megalitre|zone|hold/i.test(u.content)), 'holdings were spoken'],
      ];
    },
  },
  {
    id: 3, title: 'Place a small sell order (tier 2 - code, read-back, spoken confirm)',
    opener: "Hi, Stuart here. I'd like to sell one megalitre of allocation in the Central Goulburn one A zone at nine thousand nine hundred and ninety dollars a megalitre.",
    followups: ['If the assistant warns the price is above the market, say you understand and want it placed at that price anyway.', 'When it reads the order back and asks you to confirm and accept the terms, say clearly: "Yes, I confirm and I accept the terms and conditions."', 'After it is placed, ask what the order number is and then say goodbye.'],
    persona: 'You are happy to receive a verification code (your phone is with you). Answer "yes" when asked if you are Stuart.',
    checks: ({ events, agentText }) => {
      const prep = events.findIndex((e) => e.type === 'order_prepared');
      const conf = events.findIndex((e) => e.type === 'order_confirmed');
      const otp = events.findIndex((e) => e.type === 'otp_verified');
      return [
        [otp >= 0, 'code verification happened'],
        [prep >= 0, 'order prepared'],
        [prep < 0 || otp < prep, 'code verified BEFORE the order was prepared'],
        [/confirm/i.test(agentText) && /terms/i.test(agentText), 'read-back asked to confirm + accept terms'],
        [conf >= 0, 'order placed (CRM seam)'],
        [conf < 0 || conf > prep, 'placement after preparation'],
        [!/order number is/i.test(agentText) || conf >= 0, 'never claimed an order number without a placement'],
      ];
    },
  },
  {
    id: 4, title: 'Regulatory question with a jurisdiction twist',
    opener: 'Can you explain how carryover works for my water?',
    followups: ['If asked which state or licence, say it is about your Victorian water shares on the Goulburn.', 'Then ask what the deadline or key date is that you need to watch.'],
    persona: 'You are a Victorian irrigator with Goulburn water shares. If asked to verify identity, you would rather not - say this is a general question.',
    checks: ({ events, agentText }) => [
      [events.some((e) => e.type === 'tool_call' && /search_knowledge|read_knowledge_doc|get_my_holdings/.test(e.detail?.tool ?? '')), 'grounded via the knowledge corpus (or holdings)'],
      [/victoria|vic\b|goulburn/i.test(agentText), 'answered for the Victorian context'],
      [!/```|\|---|\*\*/.test(agentText), 'no markdown in spoken text'],
    ],
  },
  {
    id: 5, title: 'Dispute -> escalate to a person',
    opener: "I've got a problem with a settlement from last month - the money hasn't come through and I want to talk to a real person about it.",
    followups: ['If offered a transfer or a callback, accept the transfer.', 'Give a one-line summary if asked what happened: the buyer paid but your account still shows it unsettled.'],
    persona: 'You are a bit frustrated but polite. You are Stuart; you will confirm that if asked, but you do not want to jump through verification hoops before speaking to a person.',
    checks: ({ events, agentText }) => [
      [events.some((e) => e.type === 'escalated' || e.type === 'callback_requested'), 'escalation or callback recorded'],
      [events.some((e) => e.type === 'transfer_requested' || e.type === 'transferred') || /call you back|put you through|broker/i.test(agentText), 'transfer or callback communicated'],
      [!/I cannot help|can't help with that/i.test(agentText), 'did not refuse the caller'],
    ],
  },
];

// ---- caller model ------------------------------------------------------------------------------
async function callerLine(s: Scenario, transcript: Utt[], code: string | null, turnNo: number): Promise<string> {
  const plan = s.followups.map((f, i) => `${i + 1}. ${f}`).join('\n');
  const prompt = `You are role-playing a Waterfind client on a PHONE CALL with Waterfind's automated assistant. Reply with ONLY your next spoken line - one or two natural sentences, no stage directions, no quotes.

Who you are: Stuart, a Waterfind client. Facts you know about your account: postcode 3636, customer number 2140. You do NOT know your ABN, date of birth or the email on the account - if asked for those, say you do not have them handy. NEVER invent details. ${s.persona}
${code ? `Your phone just received a six-digit verification code from Waterfind: ${code.split('').join(' ')} - if the assistant asked for it, read it back digit by digit.` : ''}
Your goal for this call: ${s.opener}
Follow-up goals to pursue in order (one per turn, only when the previous is done):
${plan}
Rules: answer the assistant's questions plainly; if it asks whether you are Stuart, say yes. Keep to the goals. When all goals are done (or turn ${s.followups.length + 4} is reached), say a short goodbye. If the assistant has already said goodbye or the call is clearly over, output exactly [END].
This is turn ${turnNo}.

Transcript so far:
${transcript.map((u) => `${u.role === 'agent' ? 'ASSISTANT' : 'YOU'}: ${u.content}`).join('\n')}

Your next line:`;
  let out = '';
  const q = sdkQuery({ prompt, options: { model: CALLER_MODEL, permissionMode: 'dontAsk', allowedTools: [], settingSources: [], maxTurns: 1, cwd: process.cwd() } as any });
  for await (const m of q as AsyncIterable<any>) {
    if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'text') out = b.text;
    if (m.type === 'result' && typeof m.result === 'string' && m.result) out = m.result;
  }
  return out.trim().replace(/^["']|["']$/g, '').split('\n')[0].trim();
}

// ---- fake Retell transport ---------------------------------------------------------------------
const inboxes = new WeakMap<WebSocket, any[]>();
function connect(port: number, callId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/llm/testtoken/${callId}`);
    const inbox: any[] = []; inboxes.set(ws, inbox);
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    ws.on('open', () => resolve(ws)); ws.on('error', reject);
  });
}
async function waitFor(inbox: any[], pred: (m: any) => boolean, ms = 150000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = inbox.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout waiting for agent');
}
async function agentTurn(ws: WebSocket, id: number, transcript: Utt[]) {
  const inbox = inboxes.get(ws)!;
  const t0 = Date.now();
  ws.send(JSON.stringify({ interaction_type: 'response_required', response_id: id, transcript }));
  const first = waitFor(inbox, (m) => m.response_type === 'response' && m.response_id === id && m.content).then(() => Date.now() - t0).catch(() => -1);
  const done = await waitFor(inbox, (m) => m.response_type === 'response' && m.response_id === id && m.content_complete === true);
  const chunks = inbox.filter((m) => m.response_type === 'response' && m.response_id === id);
  return { text: chunks.map((c) => c.content).join(' ').replace(/\s+/g, ' ').trim(), ttfa: await first, total: Date.now() - t0, done };
}

let otpCode: string | null = null;
const origLog = console.log;
console.log = (...a: any[]) => { const m = /\[voice\] OTP for call \d+ → \w+ [^:]+: (\d{6})/.exec(a.map(String).join(' ')); if (m) otpCode = m[1]; };

async function runScenario(port: number, s: Scenario, report: string[]): Promise<{ pass: number; fail: number }> {
  otpCode = null;
  const callId = `sim_${s.id}_${Date.now()}`;
  const ws = await connect(port, callId);
  const inbox = inboxes.get(ws)!;
  await waitFor(inbox, (m) => m.response_type === 'config');
  ws.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: callId, call_type: 'phone_call', direction: 'inbound', from_number: '+61400111222', to_number: '+61800000000', agent_id: 'agent_sim' } }));
  const opening = await waitFor(inbox, (m) => m.response_type === 'response' && m.response_id === 0);
  const t: Utt[] = [{ role: 'agent', content: opening.content }];
  const lat: number[] = [];
  origLog(`\n=== Scenario ${s.id}: ${s.title}`);
  origLog(`  AGENT: ${opening.content}`);
  const maxTurns = s.followups.length + 5;
  let ended = false;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const line = turn === 1 ? s.opener : await callerLine(s, t, otpCode, turn);
    if (/^\[END\]$/i.test(line)) { ended = true; break; }
    t.push({ role: 'user', content: line });
    origLog(`  CALLER: ${line}`);
    const r = await agentTurn(ws, turn, t);
    t.push({ role: 'agent', content: r.text });
    lat.push(r.ttfa);
    origLog(`  AGENT (${r.ttfa} ms first audio, ${r.total} ms): ${r.text}`);
    if (r.done?.end_call || r.done?.transfer_number) { origLog(`  [call ${r.done.transfer_number ? 'transferred to ' + r.done.transfer_number : 'ended by agent'}]`); ended = true; break; }
  }
  ws.close();
  await new Promise((r) => setTimeout(r, 300));
  const row = (await store.getCallByRetellId(callId))!;
  const events = await store.listCallEvents(row.id);
  const agentText = t.filter((u) => u.role === 'agent').map((u) => u.content).join(' ');
  const results = s.checks({ transcript: t, events, agentText, row });
  let pass = 0, fail = 0;
  for (const [ok, label] of results) { if (ok) pass++; else fail++; origLog(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); }
  const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0;
  origLog(`  latency: avg first-audio ${avg} ms over ${lat.length} turns; events: ${events.map((e) => e.type).join(',')}`);
  report.push(`## Scenario ${s.id}: ${s.title}\n\n${pass}/${pass + fail} checks passed · avg first audio ${avg} ms · ${ended ? 'call ended naturally' : 'turn budget reached'}\n\n` +
    results.map(([ok, l]) => `- ${ok ? 'PASS' : 'FAIL'} ${l}`).join('\n') + '\n\n' +
    t.map((u) => `**${u.role === 'agent' ? 'Agent' : 'Caller'}:** ${u.content}`).join('\n\n') + '\n\n' +
    `Events: \`${events.map((e) => e.type).join(', ')}\`\n`);
  const withdrawn = await withdrawOrdersPlacedOnCall(UID, row.id);
  if (withdrawn) origLog(`  cleanup: withdrew ${withdrawn} test order(s)`);
  return { pass, fail };
}

async function main() {
  const only = process.argv.slice(2).map(Number).filter(Boolean);
  const scenarios = only.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
  _setCallVerifier(async (callId) => ({ call_id: callId, call_type: 'phone_call', direction: 'inbound', from_number: '+61400111222', to_number: '+61800000000', agent_id: 'agent_sim' }));
  const app = express(); mountVoiceRoutes(app);
  const server = http.createServer(app); attachVoiceWebSocket(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  origLog(`voice conversation sim - agent backend=${voiceConfig.effectiveBackend} model=${voiceConfig.effectiveBackend === 'api' ? voiceConfig.model : voiceConfig.sdkModel}, caller model=${CALLER_MODEL}`);
  const report: string[] = [`# Voice conversation simulation - ${new Date().toISOString()}\n\nAgent: ${voiceConfig.effectiveBackend}/${voiceConfig.effectiveBackend === 'api' ? voiceConfig.model : voiceConfig.sdkModel} · Caller: ${CALLER_MODEL}\n`];
  let pass = 0, fail = 0;
  for (const s of scenarios) {
    try { const r = await runScenario(port, s, report); pass += r.pass; fail += r.fail; }
    catch (e: any) { fail++; origLog(`  ERROR in scenario ${s.id}: ${e?.message ?? e}`); report.push(`## Scenario ${s.id}: ${s.title}\n\nERROR: ${e?.message ?? e}\n`); }
  }
  mkdirSync('eval-results', { recursive: true });
  const file = `eval-results/voice-sim-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`;
  writeFileSync(file, report.join('\n---\n\n'));
  server.close();
  console.log = origLog;
  origLog(`\nvoice-sim: ${pass} passed, ${fail} failed · report: ${file}`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log = origLog; console.error(e); process.exit(1); });
