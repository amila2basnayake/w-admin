/**
 * Live multilingual test for the phone agent: the fake-Retell driver (see test-voice-protocol.ts)
 * against the REAL model, with the caller speaking Vietnamese then switching to English (call 1), and
 * Italian through verification, a read-back and a confirmation (call 2, caller-ID candidate). Checks are
 * behavioural: the reply language follows the caller, the recording disclosure is restated once in the
 * caller's language, no English unit-rewriting is spliced into a non-English reply, the tier gate and
 * the read-back gate behave the same in Italian, the Italian "sì, ma…" is refused and the clean "sì,
 * confermo" places (CRM seam up), and language changes are logged as call events.
 *   npm run itest:voice-language     (needs ANTHROPIC_API_KEY, the DB; CRM on :81 for placement)
 */
import './test/voice-language-env';
import express from 'express';
import http from 'node:http';
import WebSocket from 'ws';
import { mountVoiceRoutes } from './src/voice';
import { attachVoiceWebSocket, _setCallVerifier } from './src/voice/ws';
import { voiceConfig } from './src/voice/config';
import { detectLanguage } from './src/voice/languages';
import * as store from './src/voice/store';
import { withdrawOrdersPlacedOnCall } from './test/voice-cleanup';
import { pool } from './src/db';

const UID = 119063;   // Stuart (caller-ID test map)
const ALL = ['en', 'vi', 'it', 'el', 'hi', 'zh', 'tr', 'ar'];
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
const lang = (text: string) => detectLanguage(text, ALL).lang;
const eventsOf = async (callId: string) => store.listCallEvents((await store.getCallByRetellId(callId))!.id);

async function openCall(port: number, callId: string, from: string) {
  const ws = await connect(port, callId);
  const inbox = inboxes.get(ws)!;
  await waitFor(inbox, (m) => m.response_type === 'config');
  ws.send(JSON.stringify({ interaction_type: 'call_details', call: { call_id: callId, call_type: 'phone_call', direction: 'inbound', from_number: from, to_number: '+61800000000', agent_id: 'agent_test' } }));
  const opening = await waitFor(inbox, (m) => m.response_type === 'response' && m.response_id === 0);
  origLog(`\n  AGENT: ${opening.content}`);
  const t: Utt[] = [{ role: 'agent', content: opening.content }];
  const say = (s: string) => { t.push({ role: 'user', content: s }); origLog(`  CALLER: ${s}`); };
  const heard = (s: string) => t.push({ role: 'agent', content: s });
  const nextId = () => t.filter((u) => u.role === 'user').length;
  return { ws, t, say, heard, nextId, opening: String(opening.content) };
}

async function main() {
  origLog(`backend=${voiceConfig.effectiveBackend} model=${voiceConfig.effectiveBackend === 'api' ? voiceConfig.model : voiceConfig.sdkModel} languages=${voiceConfig.languages.join(',')}`);
  ok(voiceConfig.languages.length > 1, 'multilingual language set configured for the test');
  // Call 1 is an unknown caller; call 2 is the caller-ID test candidate.
  _setCallVerifier(async (callId) => ({ call_id: callId, call_type: 'phone_call', direction: 'inbound', from_number: callId.includes('_vi_') ? '+61400999888' : '+61400111222', to_number: '+61800000000', agent_id: 'agent_test' }));
  const app = express();
  mountVoiceRoutes(app);
  const server = http.createServer(app);
  attachVoiceWebSocket(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;

  // ---- call 1: unknown caller, Vietnamese market question, then a switch to English -------------
  origLog('\n=== call 1: Vietnamese, unknown caller ===');
  const c1 = 'itest_lang_vi_' + Date.now();
  const a = await openCall(port, c1, '+61400999888');
  ok(lang(a.opening) === 'en', 'opening is spoken in English (before anyone has spoken)');

  a.say('Xin chào, tôi muốn biết giá nước tưới ở vùng Goulburn hiện nay là bao nhiêu?');
  let r = await turn(a.ws, a.nextId(), a.t); a.heard(r.text);
  let evs = await eventsOf(c1);
  ok(evs.some((e) => e.type === 'language_detected' && e.detail?.to === 'vi'), 'Vietnamese detected and logged as a call event');
  ok(lang(r.text) === 'vi', 'reply is in Vietnamese: ' + r.text.slice(0, 160));
  ok(/ghi âm|tự động|trợ lý/i.test(r.text), 'recording disclosure restated in Vietnamese on the first reply: ' + r.text.slice(0, 160));
  ok(!/dollars a megalitre|megalitres/.test(r.text), 'no English unit rewriting spliced into the Vietnamese reply');
  ok(evs.some((e) => e.type === 'tool_call' && /get_price_band|get_market_liquidity|get_market_reference|find_region|get_price_history|get_matchable_orders/.test(e.detail?.tool ?? '')), 'a market tool was used for the price question');
  ok(!evs.some((e) => e.type === 'otp_sent'), 'no code sent for a general market question');

  a.say('Cảm ơn. Còn vùng Murray thì sao?');
  r = await turn(a.ws, a.nextId(), a.t); a.heard(r.text);
  ok(lang(r.text) === 'vi', 'second reply still Vietnamese: ' + r.text.slice(0, 120));
  ok(!/ghi âm/i.test(r.text), 'disclosure not repeated on the second turn');

  a.say('Sorry, can we continue in English please? What is the price in the Murrumbidgee at the moment?');
  r = await turn(a.ws, a.nextId(), a.t); a.heard(r.text);
  evs = await eventsOf(c1);
  ok(evs.some((e) => e.type === 'language_detected' && e.detail?.from === 'vi' && e.detail?.to === 'en'), 'switch back to English logged');
  const en = detectLanguage(r.text, ALL);
  ok(en.lang === 'en' && en.confident, 'reply follows the switch to English: ' + r.text.slice(0, 120));
  a.ws.close();

  // ---- call 2: caller-ID candidate, Italian through verification, read-back and confirmation ------
  origLog('\n=== call 2: Italian, caller-ID candidate (Stuart) ===');
  otpCode = null;
  const c2 = 'itest_lang_it_' + Date.now();
  const b = await openCall(port, c2, '+61400111222');
  ok(/Stuart/.test(b.opening), 'caller-ID candidate asked for by first name');

  b.say('Sì, sono Stuart. Vorrei sapere quanta acqua possiedo al momento.');
  r = await turn(b.ws, b.nextId(), b.t); b.heard(r.text);
  evs = await eventsOf(c2);
  ok(evs.some((e) => e.type === 'language_detected' && e.detail?.to === 'it'), 'Italian detected');
  ok(lang(r.text) === 'it', 'reply in Italian: ' + r.text.slice(0, 160));
  ok(/registrat|assistente automatic/i.test(r.text), 'disclosure restated in Italian: ' + r.text.slice(0, 160));
  const holdingsBeforeVerify = evs.some((e) => e.type === 'tool_call' && e.detail?.tool === 'get_my_holdings') && !evs.some((e) => e.type === 'tool_refused_tier');
  ok(!holdingsBeforeVerify, 'no successful holdings call before verification');
  ok(/codice|verific|conferm|cellulare|dettagli|numero cliente|codice postale/i.test(r.text), 'agent moves to verification in Italian: ' + r.text.slice(0, 160));
  if (!otpCode) { b.say('Va bene, mandami il codice.'); r = await turn(b.ws, b.nextId(), b.t); b.heard(r.text); }
  ok(!!otpCode, 'a one-time code was sent (console transport)');

  b.say(`Il codice è ${otpCode!.split('').join(' ')}.`);
  r = await turn(b.ws, b.nextId(), b.t); b.heard(r.text);
  const row2 = await store.getCallByRetellId(c2);
  ok(row2?.auth_level === 2, `verified to tier 2 after the code (auth_level=${row2?.auth_level})`);
  if (!/megalitr|zona|allocazion|goulburn|murray|possied|hai /i.test(r.text)) { b.say('Perfetto. Allora, cosa possiedo?'); r = await turn(b.ws, b.nextId(), b.t); b.heard(r.text); }
  ok(/megalitr|zona|allocazion|goulburn|murray/i.test(r.text), 'holdings spoken in Italian after verification: ' + r.text.slice(0, 160));
  ok(lang(r.text) === 'it', 'holdings reply is Italian');
  ok(!/region_id|\bmcp__|get_my_/i.test(r.text), 'no internal identifiers spoken');

  b.say('Vorrei vendere 1 megalitro di allocazione nella zona Central Goulburn uno A a 9990 dollari al megalitro.');
  r = await turn(b.ws, b.nextId(), b.t); b.heard(r.text);
  evs = await eventsOf(c2);
  let prepared = evs.some((e) => e.type === 'order_prepared');
  for (let i = 0; i < 2 && !prepared; i++) {
    b.say('Capisco che è sopra il mercato. Preparalo comunque a 9990 dollari al megalitro.');
    r = await turn(b.ws, b.nextId(), b.t); b.heard(r.text);
    evs = await eventsOf(c2);
    prepared = evs.some((e) => e.type === 'order_prepared');
  }
  ok(prepared, 'order prepared (after insisting past the price warning if needed)');
  ok(lang(r.text) === 'it', 'read-back is in Italian: ' + r.text.slice(0, 200));
  ok(/\b1\b|un megalitro|1 megalitro/i.test(r.text) && /goulburn/i.test(r.text) && /9[.,]?990/.test(r.text), 'read-back states volume, zone and price as digits: ' + r.text.slice(0, 220));
  ok(/conferm/i.test(r.text) && /termini|condizioni/i.test(r.text), 'read-back asks to confirm and accept the terms, in Italian');

  b.say('Sì, ma cambia il prezzo a 9500 dollari.');
  r = await turn(b.ws, b.nextId(), b.t); b.heard(r.text);
  evs = await eventsOf(c2);
  ok(!evs.some((e) => e.type === 'order_confirmed'), 'Italian amended yes did not place the order');
  for (let i = 0; i < 2; i++) {
    evs = await eventsOf(c2);
    if (evs.filter((e) => e.type === 'order_prepared').length >= 2) break;
    b.say('Sì, 9500 dollari al megalitro, 1 megalitro, stessa zona. Preparalo.'); r = await turn(b.ws, b.nextId(), b.t); b.heard(r.text);
  }
  evs = await eventsOf(c2);
  ok(evs.filter((e) => e.type === 'order_prepared').length >= 2, 'a new order was prepared at the amended price');
  ok(/9[.,]?500/.test(r.text) && /conferm/i.test(r.text), 'second read-back at the new price asks for confirmation: ' + r.text.slice(0, 200));

  b.say("Sì, confermo l'ordine e accetto i termini e le condizioni.");
  r = await turn(b.ws, b.nextId(), b.t); b.heard(r.text);
  evs = await eventsOf(c2);
  const confirmed = evs.find((e) => e.type === 'order_confirmed');
  const refused = evs.filter((e) => e.type === 'order_confirm_refused').map((e) => e.detail?.verdict);
  if (confirmed) ok(/\d{5,}/.test(r.text) || /numero d'ordine|numero dell'ordine|inserito|piazzato|eseguito/i.test(r.text), 'placement reported in Italian with an order number: ' + r.text.slice(0, 200));
  else { origLog('  (no order_confirmed event — seam down or agent hesitated; refusals: ' + JSON.stringify(refused) + ')'); ok(!/numero d'ordine è/i.test(r.text), 'no false claim of placement'); }
  ok(!refused.includes('unclear') || !!confirmed, 'the Italian "sì, confermo" was not classified as unclear');
  ok(lang(r.text) === 'it', 'outcome spoken in Italian');

  b.say('Grazie, è tutto. Arrivederci.');
  r = await turn(b.ws, b.nextId(), b.t); b.heard(r.text);
  ok(lang(r.text) === 'it', 'goodbye in Italian: ' + r.text.slice(0, 120));
  b.ws.close();

  server.close();
  console.log = origLog;
  const finalRow = await store.getCallByRetellId(c2);
  const withdrawn = await withdrawOrdersPlacedOnCall(UID, finalRow!.id);
  if (withdrawn) origLog(`  cleanup: withdrew ${withdrawn} test order(s)`);
  for (const id of [c1, c2]) {
    const row = await store.getCallByRetellId(id);
    origLog(`\n  call ${row?.id}: outcome=${row?.outcome} auth_level=${row?.auth_level} events=${(await store.listCallEvents(row!.id)).map((e) => e.type + (e.type === 'language_detected' ? `(${e.detail?.from}→${e.detail?.to})` : '')).join(',')}`);
  }
  console.log(`\nitest-voice-language: ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log = origLog; console.error(e); process.exit(1); });
