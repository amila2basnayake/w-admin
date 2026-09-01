/**
 * Web reader: the phone channel's Retell voice, spoken in the browser.
 *
 * Retell has no text-to-speech API — its only product is a call — but a custom-LLM agent speaks
 * whatever text its websocket hands it. So a "reader" session is a Retell WEB CALL to a dedicated
 * reader agent (same voice as the phone agents, un-interruptible, no backchannel): the sidecar
 * creates the call, the browser joins it with Retell's client SDK (microphone muted), Retell opens
 * its custom-LLM socket to us, and we feed the reply text down that socket as it arrives. Retell
 * synthesises and streams the audio into the page; when the text is complete we end the call.
 *
 *   browser ──POST /reader/sessions──▶ sidecar ──create-web-call──▶ Retell
 *   browser ◀─{call_id, access_token}─ sidecar
 *   browser ──Retell SDK startCall──────────────────────────────────▶ Retell (audio, mic muted)
 *   Retell  ──ws /voice/reader/<token>/<call_id>──▶ sidecar          (custom-LLM socket)
 *   browser ──POST /reader/sessions/:id/say {text}─▶ sidecar ──response(id 0, streamed)──▶ Retell
 *   browser ──POST /reader/sessions/:id/close─────▶ sidecar ──content_complete + end_call──▶ Retell
 *
 * Switch: AIADVISOR_WEB_READER=retell turns it on (plus a reader agent id from `voice:setup --reader`);
 * anything else and every surface keeps the OpenAI reader — nothing CRM-side changes either way,
 * the browser engine asks /me which reader is in effect. Sessions are per user, capped, and time
 * out; the text spoken is never stored here (Retell's own call storage is opted out for the agent).
 */
import { Router, type Response, type NextFunction } from 'express';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { voiceConfig } from './config';
import { retellAt } from './retell';
import type { RetellInbound, RetellOutbound, RetellCall, RetellWebhookEvent } from './protocol';
import { registerWsRoute, attachWsDispatcher } from '../ws-routes';
import { markdownToSpeech, expandUnitsForSpeech } from '../tts';
import { recordSpend } from '../spend';
import type { AuthedRequest } from '../auth';

function int(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

export const readerConfig = {
  /** The switch. 'retell' = Retell web calls read the replies; anything else = the OpenAI reader. */
  get mode(): 'retell' | 'openai' { return (process.env.AIADVISOR_WEB_READER ?? '').trim().toLowerCase() === 'retell' ? 'retell' : 'openai'; },
  get agentId(): string | undefined { return (process.env.AIADVISOR_VOICE_READER_AGENT_ID ?? '').trim() || undefined; },
  /** Retell base for the READER's calls. Defaults to the phone channel's; set it when the phone side is
   *  pointed at a local fake Retell (campaign demos) but the browser reader must use the real one. */
  get retellBase(): string { return (process.env.AIADVISOR_READER_RETELL_BASE ?? '').trim().replace(/\/$/, '') || voiceConfig.retellBase; },
  // Limits are read per use (not at import) so the suites — and an operator's .env edit — apply without a reload dance.
  get maxPerUser(): number { return int('AIADVISOR_READER_MAX_PER_USER', 3); },
  get maxTotal(): number { return int('AIADVISOR_READER_MAX_TOTAL', 40); },
  /** A session that has not ended by then is abandoned (call closed, entry dropped). */
  get sessionTtlMs(): number { return int('AIADVISOR_READER_SESSION_TTL_MS', 10 * 60_000); },
  get maxCharsPerSession(): number { return int('AIADVISOR_READER_MAX_CHARS', 12_000); },
  maxCharsPerSay: 4_000,
  get websocketUrl(): string | null {
    if (!voiceConfig.publicBase || !voiceConfig.wsToken) return null;
    return `${voiceConfig.publicBase.replace(/^http/, 'ws')}${voiceConfig.publicPrefix}/voice/reader/${voiceConfig.wsToken}`;
  },
};

/** True when the Retell reader is switched on AND everything it needs exists. */
export function readerEnabled(): boolean {
  return readerConfig.mode === 'retell' && voiceConfig.enabled && !!voiceConfig.retellApiKey && !!readerConfig.agentId && !!readerConfig.websocketUrl;
}
/** What is in effect, for /health, /me and the boot log. */
export function readerInfo() {
  const enabled = readerEnabled();
  return {
    mode: enabled ? 'retell' as const : 'openai' as const,
    requested: readerConfig.mode,
    agent: !!readerConfig.agentId,
    voice: enabled ? voiceConfig.voiceId : null,
    live_sessions: sessions.size,
  };
}

// ---- sessions ----------------------------------------------------------------

interface ReaderSession {
  id: string;
  uid: number;
  callId: string;
  createdAt: number;
  lastActivity: number;
  ws: WebSocket | null;
  admitted: boolean;
  queue: string[];       // speech-ready text not yet sent to Retell
  responseId: number;    // the response id the stream rides on: 0 until Retell raises its own turn, then that
  chars: number;         // total accepted text
  closed: boolean;       // the browser said "that is all"
  endSent: boolean;      // the final content_complete + end_call went out
  sentAny: boolean;
  ended: boolean;        // Retell told us (webhook / socket close after end)
  billed: boolean;       // a cost record was made (or scheduled) for this call
}

const sessions = new Map<string, ReaderSession>();
const byCall = new Map<string, ReaderSession>();

export function _readerSessionCount(): number { return sessions.size; }

/** Test seam: how a Retell web call is created. */
const liveCreate = (input: { agent_id: string; metadata: Record<string, unknown> }) => retellAt(readerConfig.retellBase).createWebCall(input);
const liveFetch = async (callId: string): Promise<RetellCall | null> => { try { return await retellAt(readerConfig.retellBase).getCall(callId); } catch { return null; } };
let createWebCall: (input: { agent_id: string; metadata: Record<string, unknown> }) => Promise<{ call_id: string; access_token: string }> = liveCreate;
export function _setWebCallFactory(fn: typeof createWebCall | null): void { createWebCall = fn ?? liveCreate; }
/** Test seam: how a finished call is fetched back for its cost (the webhook path is primary). */
let fetchCall: (callId: string) => Promise<RetellCall | null> = liveFetch;
export function _setCallFetcher(fn: typeof fetchCall | null): void { fetchCall = fn ?? liveFetch; }
/** Test seam: the delay before a closed socket's call is fetched for its cost. */
let reconcileDelayMs = 60_000;
export function _setReconcileDelay(ms: number): void { reconcileDelayMs = ms; }

/** Cost of a reader call into the ledger (idempotent on `ref`). Called from the webhook, or from the
 *  socket-close fallback when the webhook never arrives (wrong signing key, tunnel blip). */
function recordReaderCost(call: RetellCall, uidHint: number | null): boolean {
  const cost = call.call_cost?.combined_cost;
  if (typeof cost !== 'number') return false;
  const meta = (call.metadata ?? {}) as Record<string, any>;
  const secs = typeof call.duration_ms === 'number' ? Math.round(call.duration_ms / 1000) : call.call_cost?.total_duration_seconds ?? null;
  void recordSpend({ source: 'tts', vendor: 'retell', model: `reader:${call.agent_id ?? readerConfig.agentId ?? '?'}`, costUsd: cost / 100, quantity: secs, unit: 'seconds', ref: `reader:${call.call_id}`, userId: Number(meta.uid) || uidHint, at: call.end_timestamp ? new Date(call.end_timestamp) : null });
  return true;
}

/** Socket-close fallback: a little after Retell hangs up, fetch the call and bill it if the webhook did not. */
function scheduleReconcile(callId: string, uid: number): void {
  const t = setTimeout(async () => {
    const call = await fetchCall(callId);
    if (!call) return;
    if (call.call_status !== 'ended' && call.call_status !== 'error') return;
    if (recordReaderCost(call, uid)) console.log(`[reader] call ${callId} billed from get-call (no webhook)`);
  }, reconcileDelayMs);
  t.unref?.();
}

function send(ws: WebSocket | null, msg: RetellOutbound): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function drop(s: ReaderSession): void {
  sessions.delete(s.id);
  if (s.callId) byCall.delete(s.callId);
  if (s.ws) { try { s.ws.close(); } catch { /* closing */ } s.ws = null; }
}

/** Push everything queued down the socket; once the browser has closed the session, finish the
 *  response and end the call. All text rides ONE streamed response — id 0 (the agent speaking
 *  first), or whichever id Retell last raised itself (see the socket handler): Retell speaks a
 *  streamed response sentence by sentence as it arrives, exactly as it does for an LLM's tokens. */
function flush(s: ReaderSession): void {
  if (!s.ws || !s.admitted || s.endSent) return;
  while (s.queue.length) {
    const chunk = s.queue.shift()!;
    // Retell concatenates chunk contents verbatim; a trailing space keeps sentences apart.
    send(s.ws, { response_type: 'response', response_id: s.responseId, content: chunk + ' ', content_complete: false, no_interruption_allowed: true });
    s.sentAny = true;
  }
  if (s.closed) {
    send(s.ws, { response_type: 'response', response_id: s.responseId, content: '', content_complete: true, no_interruption_allowed: true, end_call: true });
    s.endSent = true;
  }
}

/** Abandon a session now: whatever Retell has not spoken yet is dropped and the call ends. */
function abandon(s: ReaderSession, why: string): void {
  if (s.ws && s.admitted && !s.endSent) {
    send(s.ws, { response_type: 'response', response_id: s.responseId, content: '', content_complete: true, end_call: true });
    s.endSent = true;
  }
  s.queue.length = 0;
  s.closed = true;
  console.log(`[reader] session ${s.id} (${s.callId}) abandoned: ${why}`);
  drop(s);
}

export function sweepReaderSessions(now = Date.now()): number {
  let n = 0;
  for (const s of [...sessions.values()]) {
    if (now - s.createdAt > readerConfig.sessionTtlMs) { abandon(s, 'ttl'); n++; }
  }
  return n;
}
// The TTL is enforced on its own minute tick (the voice module's half-hourly sweep is too coarse for
// a 10-minute limit); unref'd so it never keeps a test process alive.
const ttlTimer = setInterval(() => { try { sweepReaderSessions(); } catch { /* never throws */ } }, 60_000);
ttlTimer.unref?.();

/** Chat markdown → what the reader should say (same shaping as the OpenAI path). */
export function readerText(raw: string): string {
  return expandUnitsForSpeech(markdownToSpeech(raw));
}

// ---- HTTP (mounted per surface behind that surface's admission; needs req.userId) ------------

export class ReaderError extends Error { constructor(public status: number, msg: string) { super(msg); this.name = 'ReaderError'; } }

const jh = (fn: (req: AuthedRequest, res: Response) => Promise<void>) =>
  (req: AuthedRequest, res: Response, _next: NextFunction) => {
    fn(req, res).catch((e: any) => {
      if (e instanceof ReaderError) { res.status(e.status).json({ error: e.message }); return; }
      console.error('[reader] route error:', e?.message ?? e);
      if (!res.headersSent) res.status(e?.status === 402 ? 503 : 500).json({ error: 'reader unavailable' });
    });
  };

function owned(req: AuthedRequest): ReaderSession {
  const s = sessions.get(String(req.params.id ?? ''));
  if (!s || s.uid !== req.userId) throw new ReaderError(404, 'no such session');
  s.lastActivity = Date.now();
  return s;
}

export const readerRouter = Router();

readerRouter.post('/sessions', jh(async (req, res) => {
  if (!readerEnabled()) throw new ReaderError(503, 'reader not enabled');
  const uid = req.userId!;
  sweepReaderSessions();
  const mine = [...sessions.values()].filter((s) => s.uid === uid);
  if (sessions.size >= readerConfig.maxTotal) throw new ReaderError(429, 'too many readers in use');
  const id = crypto.randomBytes(12).toString('base64url');
  // Reserve the slot BEFORE the awaited create, so concurrent requests cannot over-admit past the cap.
  const placeholder: ReaderSession = {
    id, uid, callId: '', createdAt: Date.now(), lastActivity: Date.now(), ws: null, admitted: false,
    queue: [], responseId: 0, chars: 0, closed: false, endSent: false, sentAny: false, ended: false, billed: false,
  };
  sessions.set(id, placeholder);
  let call: { call_id: string; access_token: string };
  try {
    call = await createWebCall({ agent_id: readerConfig.agentId!, metadata: { reader: true, reader_session: id, uid } });
  } catch (e: any) {
    sessions.delete(id);
    console.error('[reader] create-web-call failed:', e?.message ?? e, e?.body ? JSON.stringify(e.body).slice(0, 300) : '');
    throw new ReaderError(502, 'could not start the reader');
  }
  const s = placeholder;
  s.callId = call.call_id;
  byCall.set(s.callId, s);
  // Per-user cap, applied once the new call exists: the newest wins (a client tapping Listen twice
  // must not be refused for the earlier tap), and a failed create leaves the older ones alone.
  const others = mine.filter((m) => sessions.has(m.id)).sort((a, b) => a.createdAt - b.createdAt);
  while (others.length >= readerConfig.maxPerUser) abandon(others.shift()!, 'per-user cap');
  res.json({ session_id: id, call_id: call.call_id, access_token: call.access_token, voice: voiceConfig.voiceId });
}));

// Never a 4xx for text that merely cannot be spoken: the browser must not treat a capped or
// already-closed session as a reader failure (that would hand the reply to the other reader).
readerRouter.post('/sessions/:id/say', jh(async (req, res) => {
  const s = owned(req);
  if (s.closed) { res.json({ queued: false, closed: true, capped: s.chars >= readerConfig.maxCharsPerSession }); return; }
  // Caps apply to what would be SPOKEN: a 6k-char markdown table strips to "See the table on screen."
  const text = readerText(String(req.body?.text ?? '').slice(0, 200_000));
  if (text.length > readerConfig.maxCharsPerSay) { res.json({ queued: false, too_long: true }); return; }
  if (text) {
    if (s.chars + text.length > readerConfig.maxCharsPerSession) {
      // Past the cap: say so once and close the session; later says answer closed/capped.
      s.queue.push('The rest of this response is on screen.'); s.closed = true; flush(s);
      res.json({ queued: false, capped: true, closed: true }); return;
    }
    s.chars += text.length;
    s.queue.push(text);
    flush(s);
  }
  res.json({ queued: !!text });
}));

readerRouter.post('/sessions/:id/close', jh(async (req, res) => {
  const s = owned(req);
  s.closed = true;
  flush(s);
  res.status(204).end();
}));

readerRouter.delete('/sessions/:id', jh(async (req, res) => {
  const s = owned(req);
  abandon(s, 'stopped by the browser');
  res.status(204).end();
}));

// ---- Retell's custom-LLM socket for the reader agent -------------------------------------------

const WS_PATH = /\/voice\/reader\/([^/]+)\/([^/?#]+)\/?(?:\?.*)?$/;

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function attachReaderWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  attachWsDispatcher(server);
  registerWsRoute(WS_PATH, (req: IncomingMessage, socket, head, m) => {
    if (!readerEnabled() || !tokenMatches(m[1], voiceConfig.wsToken)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, decodeURIComponent(m[2])));
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, callId: string) => {
    send(ws, { response_type: 'config', config: { auto_reconnect: true, call_details: true } });
    // Belt and braces on top of the agent's own settings: never interrupted, no "are you there?" nudges.
    send(ws, { response_type: 'update_agent', agent_config: { interruption_sensitivity: 0, reminder_trigger_ms: 600_000, reminder_max_count: 1 } });
    let s: ReaderSession | null = null;

    const admit = (details: RetellCall | null): boolean => {
      if (s) return true;
      const found = byCall.get(callId) ?? null;
      const meta = (details?.metadata ?? {}) as Record<string, unknown>;
      if (!found || !sessions.has(found.id) || (details && details.call_id !== callId) || (meta.reader_session && meta.reader_session !== found.id)) {
        console.warn(`[reader] rejecting socket for ${callId}: ${found ? 'metadata mismatch' : 'unknown session'}`);
        ws.close(1008, 'unknown call');
        return false;
      }
      s = found;
      s.ws = ws; s.admitted = true; s.lastActivity = Date.now();
      flush(s);
      return true;
    };

    ws.on('message', (data) => {
      let msg: RetellInbound;
      try { msg = JSON.parse(String(data)); } catch { return; }
      switch (msg.interaction_type) {
        case 'ping_pong': send(ws, { response_type: 'ping_pong', timestamp: Date.now() }); break;
        case 'call_details': admit(msg.call ?? null); break;
        case 'response_required':
        case 'reminder_required':
          // The reader only ever speaks what the browser queued; the "user" side is a muted mic.
          // Retell still wants a reply to every response_id it raises — an empty, COMPLETE one; the
          // stream itself stays on id 0. Verified live 2026-08-27: Retell keeps speaking id-0 chunks
          // after such a turn, whereas answering with an empty INCOMPLETE reply (to "move" the stream
          // to the raised id) made Retell end the call before a word was spoken.
          if (!admit(null)) return;
          send(ws, { response_type: 'response', response_id: msg.response_id, content: '', content_complete: true, no_interruption_allowed: true });
          break;
        default: break;
      }
    });
    ws.on('close', () => {
      if (!s || s.ws !== ws) return;
      s.ws = null;
      // Retell closes this socket when the call ends. Its webhook is the primary close signal, but it
      // may never come (badge-key signing, tunnel blip): give a reconnect a moment, then drop the
      // session ourselves and bill the call from get-call.
      const sess = s;
      const t = setTimeout(() => {
        if (sess.ws || !sessions.has(sess.id)) return;   // reconnected, or the webhook already dropped it
        sess.ended = true;
        drop(sess);
        if (!sess.billed) { sess.billed = true; scheduleReconcile(sess.callId, sess.uid); }
      }, 5_000);
      t.unref?.();
    });
    ws.on('error', (e) => console.error(`[reader] ws error on ${callId}:`, e?.message ?? e));
  });
  return wss;
}

// ---- Retell webhooks for reader calls (routed here by webhooks.ts on metadata.reader) -----------

export async function handleReaderEvent(ev: RetellWebhookEvent): Promise<void> {
  const call = ev.call;
  const s = byCall.get(call.call_id) ?? null;
  switch (ev.event) {
    case 'call_ended':
      if (s) { s.ended = true; s.lastActivity = Date.now(); drop(s); }
      break;
    case 'call_analyzed':
      if (s) s.billed = true;
      recordReaderCost(call, s?.uid ?? null);   // `ref` makes a replay, or the socket-close fallback, a no-op
      break;
    default: break;
  }
}
