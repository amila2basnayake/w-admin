/**
 * Fake Retell — the ONLY thing faked in the campaign demo. Stands in for Retell's telephony so the real
 * sidecar (dialer, guards, feeder, voice agent, webhooks, campaign page) runs exactly as in production,
 * text-to-text instead of audio:
 *   POST /v2/create-phone-call  → what the dialer calls; "rings", then plays the client
 *   GET  /v2/get-call/:id       → what the sidecar's admission / reconcile checks call
 *   GET  /recording/:id         → the call's transcript (stands in for Retell's recording URL)
 * Per call it does what Retell does on the wire: signed call_started webhook → Custom-LLM websocket to
 * the sidecar (call_details → opening → response_required turns) → signed call_ended + call_analyzed
 * (transcript, disconnection reason, duration, cost, a model-written summary — Retell's analysis is
 * model-written too). The CLIENT on each call is a Sonnet agent playing the persona for that client uid
 * (personas below); unknown uids get a generic interested client.
 *   npm run demo:fake-retell         (reads the sidecar .env for RETELL_API_KEY / WS token / PORT)
 * Point the sidecar at it with RETELL_API_BASE=http://127.0.0.1:7870.
 */
import 'dotenv/config';
import express from 'express';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { signRetellBody } from '../src/voice/retell';

const PORT = Number(process.env.FAKE_RETELL_PORT || 7870);
const SIDECAR = `http://127.0.0.1:${process.env.PORT || 3100}`;
const API_KEY = process.env.RETELL_API_KEY || '';
const SIGN_KEY = process.env.RETELL_WEBHOOK_KEY || API_KEY;
const WS_TOKEN = process.env.AIADVISOR_VOICE_WS_TOKEN || '';
const CALLER_MODEL = process.env.VOICE_SIM_CALLER_MODEL || 'sonnet';
const RING_MS = Number(process.env.FAKE_RETELL_RING_MS || 3000);

type Utt = { role: 'agent' | 'user'; content: string };
interface Persona { kind: 'talk' | 'voicemail'; who: string; facts: string; attitude: string; goals: string[] }

/** Personas keyed by waterfind_user.id — the demo clients. Facts are the real CRM values (dev DB). */
const PERSONAS: Record<number, Persona> = {
  1684153: { kind: 'talk', who: 'Ben Fessey, a Victorian irrigator with high-reliability Murray water shares (Barmah to SA, Lower Murray Water)',
    facts: 'Your postcode is 3004 and your Waterfind customer number is 8166. You do not have your phone handy for a code; offer the postcode and customer number instead if asked to verify.',
    attitude: 'Interested and friendly. You have been thinking about selling some allocation this season.',
    goals: ['Say now is fine and ask what the market update is.', 'Ask what allocation is currently trading at in your zone.', 'Ask what water you are currently holding with Waterfind (verify with postcode + customer number when asked).', 'Say you will think about it and ask your broker to call you next week, then say goodbye.'] },
  1611863: { kind: 'talk', who: 'Cindy Kozel, who holds Murray high-reliability water shares but lives in Melbourne',
    facts: 'Your postcode is 3132 and your customer number is 8094.',
    attitude: 'Polite but genuinely busy — you are in a meeting.',
    goals: ['Say this is not a good time and ask them to have someone call you back tomorrow morning around 9.', 'If asked to confirm the number to call, say the mobile they called is fine.', 'Say thanks and goodbye.'] },
  2735: { kind: 'talk', who: 'Robert McGavin, a long-standing Waterfind client with Loddon Valley high-reliability water',
    facts: 'Your postcode is 5276 and your customer number is 21.',
    attitude: 'Direct. You do not want to deal with an automated system for a decision this size.',
    goals: ['Say it is fine to talk briefly, then say you actually want to sell about 200 megalitres this season and would rather talk to your broker about it — ask to be put through to a person now.', 'If offered a transfer, accept it; if offered a callback instead, accept that.'] },
  269714: { kind: 'voicemail', who: 'Lewis Campbell', facts: '', attitude: '', goals: [] },
  87467: { kind: 'talk', who: 'Rex Booker, a Waterfind client with Murray high-reliability water',
    facts: 'Your postcode is 3207 and your customer number is 1490.',
    attitude: 'Irritated at getting an automated call.',
    goals: ['Say you do not want automated calls — tell them clearly not to call this number again.', 'If they confirm they will not call again, say goodbye curtly.'] },
};
const DEFAULT_PERSONA: Persona = { kind: 'talk', who: 'a Waterfind client', facts: 'You do not have your account details handy.', attitude: 'Neutral, mildly interested.', goals: ['Say now is fine and ask what this is about.', 'Ask one follow-up question about what they told you.', 'Say thanks and goodbye.'] };

async function sonnet(prompt: string): Promise<string> {
  let out = '';
  const q = sdkQuery({ prompt, options: { model: CALLER_MODEL, permissionMode: 'dontAsk', allowedTools: [], settingSources: [], maxTurns: 1, cwd: process.cwd() } as any });
  for await (const m of q as AsyncIterable<any>) {
    if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'text') out = b.text;
    if (m.type === 'result' && typeof m.result === 'string' && m.result) out = m.result;
  }
  return out.trim();
}

async function callerLine(p: Persona, transcript: Utt[], turnNo: number): Promise<string> {
  const plan = p.goals.map((g, i) => `${i + 1}. ${g}`).join('\n');
  const out = await sonnet(`You are role-playing a Waterfind client who has just ANSWERED a phone call from Waterfind's automated assistant. Reply with ONLY your next spoken line - one or two natural sentences, no stage directions, no quotes.

Who you are: ${p.who}. ${p.facts} You do NOT know your ABN, date of birth or the email on the account - if asked for those, say you do not have them handy. NEVER invent details. ${p.attitude}
Goals to pursue in order (one per turn, only when the previous is done):
${plan}
Rules: answer the assistant's questions plainly; if it asks whether it is speaking with you, say yes. Keep to the goals. When all goals are done (or turn ${p.goals.length + 4} is reached), say a short goodbye. If the assistant has already said goodbye, said it is transferring you, or the call is clearly over, output exactly [END].
This is turn ${turnNo}.

Transcript so far:
${transcript.map((u) => `${u.role === 'agent' ? 'ASSISTANT' : 'YOU'}: ${u.content}`).join('\n')}

Your next line:`);
  return out.replace(/^["']|["']$/g, '').split('\n')[0].trim();
}

/** Retell's post-call analysis is model-written; so is this one. */
async function analyse(transcript: Utt[]): Promise<{ summary: string; sentiment: string; successful: boolean }> {
  const out = await sonnet(`Summarise this phone call between Waterfind's automated assistant and a client in 2-3 plain sentences for the client's file (what was discussed, what the client wants, any follow-up). Then on a new line write SENTIMENT: Positive|Neutral|Negative and on another line SUCCESSFUL: yes|no. Output nothing else.

${transcript.map((u) => `${u.role === 'agent' ? 'Assistant' : 'Client'}: ${u.content}`).join('\n')}`);
  const sentiment = /SENTIMENT:\s*(\w+)/i.exec(out)?.[1] ?? 'Neutral';
  const successful = /SUCCESSFUL:\s*(yes|no)/i.exec(out)?.[1]?.toLowerCase() !== 'no';
  const summary = out.replace(/SENTIMENT:.*$/im, '').replace(/SUCCESSFUL:.*$/im, '').trim();
  return { summary, sentiment, successful };
}

// ---- webhooks (signed exactly as Retell signs them) ----------------------------------------------
async function webhook(event: string, call: any): Promise<void> {
  const body = JSON.stringify({ event, call });
  const res = await fetch(`${SIDECAR}/voice/webhooks/retell`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-retell-signature': signRetellBody(body, SIGN_KEY) }, body });
  log(call.call_id, `webhook ${event} -> ${res.status}`);
}

// ---- the call --------------------------------------------------------------------------------------
const calls = new Map<string, any>();
function log(id: string, msg: string) { console.log(`[fake-retell] ${id.slice(-6)} ${msg}`); }

async function runCall(call: any): Promise<void> {
  const uid = Number(call.metadata?.client_uid) || 0;
  const p = PERSONAS[uid] ?? DEFAULT_PERSONA;
  log(call.call_id, `ringing ${call.to_number} (${p.who.split(',')[0]})`);
  await new Promise((r) => setTimeout(r, RING_MS));
  call.call_status = 'ongoing'; call.start_timestamp = Date.now();
  await webhook('call_started', call);
  const transcript: Utt[] = [];
  let reason = 'user_hangup';
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT || 3100}/voice/llm/${WS_TOKEN}/${call.call_id}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    const waitFor = async (pred: (m: any) => boolean, ms = 180_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = inbox.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 30)); } throw new Error('agent timeout'); };
    await waitFor((m) => m.response_type === 'config');
    ws.send(JSON.stringify({ interaction_type: 'call_details', call }));
    const opening = await waitFor((m) => m.response_type === 'response' && m.response_id === 0);
    transcript.push({ role: 'agent', content: opening.content });
    log(call.call_id, `AGENT: ${opening.content}`);
    if (p.kind === 'voicemail') {
      // Retell's machine detection: the opening plays to a voicemail box, Retell leaves the configured message and ends.
      await new Promise((r) => setTimeout(r, 6000));
      reason = 'voicemail_reached';
    } else {
      let ended = false;
      for (let turn = 1; turn <= p.goals.length + 5 && !ended; turn++) {
        const line = await callerLine(p, transcript, turn);
        if (/^\[END\]$/i.test(line)) break;
        transcript.push({ role: 'user', content: line });
        log(call.call_id, `CALLER: ${line}`);
        ws.send(JSON.stringify({ interaction_type: 'response_required', response_id: turn, transcript }));
        const done = await waitFor((m) => m.response_type === 'response' && m.response_id === turn && m.content_complete === true);
        const text = inbox.filter((m) => m.response_type === 'response' && m.response_id === turn).map((m) => m.content).join(' ').replace(/\s+/g, ' ').trim();
        transcript.push({ role: 'agent', content: text });
        log(call.call_id, `AGENT: ${text}`);
        if (done.transfer_number) { reason = 'call_transfer'; call.transfer_destination = done.transfer_number; ended = true; }
        else if (done.end_call) { reason = 'agent_hangup'; ended = true; }
      }
    }
    ws.close();
  } catch (e: any) {
    log(call.call_id, `error: ${e?.message ?? e}`);
    if (reason === 'user_hangup') reason = 'error_llm_websocket_lost';
  }
  call.end_timestamp = Date.now(); call.duration_ms = call.end_timestamp - call.start_timestamp;
  call.call_status = 'ended'; call.disconnection_reason = reason; call.transcript_object = transcript;
  call.transcript = transcript.map((u) => `${u.role === 'agent' ? 'Agent' : 'User'}: ${u.content}`).join('\n');
  call.recording_url = `http://127.0.0.1:${PORT}/recording/${call.call_id}`;
  log(call.call_id, `ended (${reason}, ${Math.round(call.duration_ms / 1000)} s)`);
  await webhook('call_ended', call);
  const secs = Math.round(call.duration_ms / 1000);
  const analysis = p.kind === 'voicemail' ? { summary: 'The call reached voicemail; the assistant left the standard message.', sentiment: 'Neutral', successful: false } : await analyse(transcript);
  call.call_analysis = { call_summary: analysis.summary, user_sentiment: analysis.sentiment, call_successful: analysis.successful, in_voicemail: p.kind === 'voicemail' };
  call.call_cost = { combined_cost: Math.round(secs / 60 * 9.5 * 100) / 100, total_duration_seconds: secs };   // cents; ~Retell 0.055 + 11labs 0.04 per minute
  await webhook('call_analyzed', call);
}

// ---- REST ------------------------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.path.startsWith('/recording/')) { next(); return; }
  if (!API_KEY || req.header('authorization') !== `Bearer ${API_KEY}`) { res.status(401).json({ error: 'invalid api key' }); return; }
  next();
});
app.post('/v2/create-phone-call', (req, res) => {
  const b = req.body ?? {};
  if (!b.from_number || !b.to_number) { res.status(400).json({ error: 'from_number and to_number required' }); return; }
  const call = { call_id: 'call_' + crypto.randomBytes(12).toString('hex'), agent_id: b.override_agent_id ?? 'agent_fake', call_type: 'phone_call', call_status: 'registered', direction: 'outbound', from_number: b.from_number, to_number: b.to_number, metadata: b.metadata ?? {} };
  calls.set(call.call_id, call);
  res.status(201).json(call);
  runCall(call).catch((e) => log(call.call_id, `run failed: ${e?.message ?? e}`));
});
app.get('/v2/get-call/:id', (req, res) => { const c = calls.get(req.params.id); if (!c) { res.status(404).json({ error: 'not found' }); return; } res.json(c); });
app.get('/recording/:id', (req, res) => { const c = calls.get(req.params.id); if (!c) { res.status(404).end(); return; } res.type('text/plain').send(`Fake Retell "recording" - transcript of ${c.call_id}\n\n${c.transcript ?? '(call in progress)'}\n`); });
app.listen(PORT, '127.0.0.1', () => console.log(`[fake-retell] listening on http://127.0.0.1:${PORT}  (sidecar ${SIDECAR}; caller model ${CALLER_MODEL}; ws token ${WS_TOKEN ? 'set' : 'MISSING'}; api key ${API_KEY ? 'set' : 'MISSING'})`));
