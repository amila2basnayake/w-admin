/**
 * Live dictation: a websocket relay from the browser's microphone to OpenAI's realtime
 * transcription API, so words land in the composer while the user is still talking instead of
 * after they stop a recording and upload it (the older POST /transcribe clip path, still used by
 * call-notes uploads).
 *
 *   browser  --ws /transcribe/stream-->  sidecar  --wss realtime?intent=transcription-->  OpenAI
 *
 * Protocol (browser side):
 *   -> {type:'start', token, silence_ms?, language?}
 *                                           first message, within AUTH_DEADLINE_MS; the same
 *                                           short-lived CRM-minted bearer token the HTTP routes use;
 *                                           language = ISO-639-1 code or 'auto' (default: the
 *                                           sidecar's AIADVISOR_TRANSCRIBE_LANGUAGE, 'en')
 *   -> binary frames                        PCM16 little-endian, mono, 24 kHz
 *   -> {type:'commit'}                      flush the utterance in flight NOW (the user pressed Send)
 *   -> {type:'stop'}                        done (or just close)
 *   <- {type:'ready'}                       upstream session configured — audio is being heard
 *   <- {type:'speech_started', item}        server VAD: an utterance began
 *   <- {type:'speech_stopped', item}        server VAD: it ended (transcription follows)
 *   <- {type:'delta', item, text}           streamed transcript tokens for that utterance
 *   <- {type:'final', item, text}           the utterance's final transcript
 *   <- {type:'error', message}              fatal; the socket closes after it
 *
 * The OpenAI key never leaves the sidecar. Voice activity detection runs upstream (server_vad), so
 * the browser does no audio analysis beyond a level meter. Everything upstream-shaped is isolated
 * in buildSessionUpdate()/mapUpstreamEvent() (pure, unit-tested offline); the upstream socket
 * factory is a test seam so the relay itself is exercisable against a fake without a key.
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { config, normaliseTranscribeLanguage } from './config';
import { verifyToken } from './auth';
import { transcribeEnabled } from './transcribe';
import { recordSpend, priceOpenAiAudio } from './spend';
import { registerWsRoute, attachWsDispatcher } from './ws-routes';

export const STREAM_PATH = /^\/transcribe\/stream\/?(?:\?.*)?$/;

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

const REALTIME_URL = process.env.AIADVISOR_TRANSCRIBE_REALTIME_URL
  || 'wss://api.openai.com/v1/realtime?intent=transcription';
/** The first client message must be the authenticated `start` within this window. */
export const AUTH_DEADLINE_MS = intEnv('AIADVISOR_TRANSCRIBE_STREAM_AUTH_MS', 5_000);
/** Hard ceiling on one dictation session (a mic left open is closed, not billed forever). */
export const MAX_SESSION_MS = intEnv('AIADVISOR_TRANSCRIBE_STREAM_MAX_MS', 10 * 60_000);
/** Close when no audio frame has arrived for this long (tab backgrounded, capture died). */
export const IDLE_MS = intEnv('AIADVISOR_TRANSCRIBE_STREAM_IDLE_MS', 60_000);
/** One binary frame is ~100 ms of 24 kHz PCM16 (4.8 KB); anything near this cap is not audio. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** Audio buffered while the upstream socket is still opening (so the first words are not lost). */
const PREOPEN_BUFFER_BYTES = 1024 * 1024;
/** A user can have at most this many live dictation sockets (two tabs; a third is refused). */
export const MAX_STREAMS_PER_USER = intEnv('AIADVISOR_TRANSCRIBE_STREAM_PER_USER', 2);
/** Server-VAD end-of-utterance silence. Short = words land sooner; long = fewer mid-sentence splits. */
export const SILENCE_DEFAULT_MS = 700, SILENCE_MIN_MS = 300, SILENCE_MAX_MS = 2000;
/**
 * Live dictation uses whisper-1, NOT the gpt-4o transcribe family. The 4o models follow
 * instructions heard in the audio: measured 2026-08-19, quiet speech saying "give me a summary of
 * my account" + our vocabulary prompt made gpt-4o-mini-transcribe return a ~1000-char essay
 * ABOUT the vocabulary (2/6 runs) instead of the transcript — straight into the user's composer.
 * whisper-1 is a plain ASR decoder: its prompt only biases spelling, it cannot "answer", and it
 * ran 10/10 clean on the same clips. The clip path (transcribe.ts) keeps its own model config.
 */
export const STREAM_MODEL = process.env.AIADVISOR_TRANSCRIBE_STREAM_MODEL || 'whisper-1';

// ---- pure protocol helpers (unit-tested) ----------------------------------

export function clampSilence(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : SILENCE_DEFAULT_MS;
  return Math.min(SILENCE_MAX_MS, Math.max(SILENCE_MIN_MS, n));
}

/** The upstream `session.update` for a transcription-only realtime session (GA event shape).
 *  `language`: an ISO-639-1 code pins recognition; 'auto' omits the field so the model detects it per
 *  utterance (the vocabulary prompt is English, so it is dropped too — a prompt in another language than
 *  the speech biases whisper toward the prompt's language). */
export function buildSessionUpdate(silenceMs: number, language: string = config.transcribeLanguage): Record<string, unknown> {
  const auto = language === 'auto';
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          noise_reduction: { type: 'near_field' },
          transcription: {
            model: STREAM_MODEL,
            ...(auto ? {} : { language }),
            ...(config.transcribeVocabulary && (auto || language === 'en') ? { prompt: config.transcribeVocabulary } : {}),
          },
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: clampSilence(silenceMs) },
        },
      },
    },
  };
}

export type ServerEvent =
  | { type: 'ready' }
  | { type: 'speech_started'; item: string }
  | { type: 'speech_stopped'; item: string }
  | { type: 'delta'; item: string; text: string }
  | { type: 'final'; item: string; text: string }
  | { type: 'error'; message: string };

export type Mapped = { kind: 'send'; event: ServerEvent } | { kind: 'fatal'; message: string } | { kind: 'ignore' };

/** Translate one upstream event into what the browser gets (or nothing). */
export function mapUpstreamEvent(j: any): Mapped {
  const t = typeof j?.type === 'string' ? j.type : '';
  switch (t) {
    case 'session.updated': return { kind: 'send', event: { type: 'ready' } };
    case 'input_audio_buffer.speech_started': return { kind: 'send', event: { type: 'speech_started', item: String(j.item_id ?? '') } };
    case 'input_audio_buffer.speech_stopped': return { kind: 'send', event: { type: 'speech_stopped', item: String(j.item_id ?? '') } };
    case 'conversation.item.input_audio_transcription.delta':
      return { kind: 'send', event: { type: 'delta', item: String(j.item_id ?? ''), text: String(j.delta ?? '') } };
    case 'conversation.item.input_audio_transcription.completed':
      return { kind: 'send', event: { type: 'final', item: String(j.item_id ?? ''), text: String(j.transcript ?? '').trim() } };
    case 'conversation.item.input_audio_transcription.failed':
      // One utterance failed upstream; the session is still good. Surface it as an empty final so
      // the client closes out that item (and keeps its live text, if any).
      return { kind: 'send', event: { type: 'final', item: String(j.item_id ?? ''), text: '' } };
    case 'error': {
      const code = String(j?.error?.code ?? '');
      // A manual commit that raced the server VAD (nothing buffered) is harmless — the VAD's own
      // commit already happened and its transcript is on the way.
      if (code === 'input_audio_buffer_commit_empty') return { kind: 'ignore' };
      // Never surface provider internals to the browser; the detail goes to our log.
      console.error(`[stt] upstream error ${code || '?'}: ${String(j?.error?.message ?? '').slice(0, 300)}`);
      return { kind: 'fatal', message: 'transcription failed' };
    }
    default: return { kind: 'ignore' };
  }
}

// ---- relay -----------------------------------------------------------------

/** Test seam: how the upstream realtime socket is opened. */
let openUpstream: () => WebSocket = () =>
  new WebSocket(REALTIME_URL, { headers: { Authorization: `Bearer ${config.openaiApiKey}` } });
export function _setUpstreamFactory(fn: typeof openUpstream): void { openUpstream = fn; }

const liveByUser = new Map<number, number>();
export function _liveStreams(uid: number): number { return liveByUser.get(uid) ?? 0; }

function sendJson(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function relay(client: WebSocket, uid: number, silenceMs: number, language: string): void {
  const startedAt = Date.now();
  liveByUser.set(uid, (liveByUser.get(uid) ?? 0) + 1);
  let up: WebSocket | null = null;
  let upOpen = false, ready = false, closed = false, speechOpen = false;
  let finals = 0, audioBytes = 0;
  const preopen: Buffer[] = []; let preopenBytes = 0;
  let idleTimer: NodeJS.Timeout | null = null;

  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    liveByUser.set(uid, Math.max(0, (liveByUser.get(uid) ?? 1) - 1));
    if (up && (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING)) { try { up.close(); } catch { /* closing */ } }
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) { try { client.close(code, reason); } catch { /* closing */ } }
    console.log(`[stt] uid=${uid} ended (${reason || 'ok'}) ${Math.round((Date.now() - startedAt) / 1000)}s audio=${Math.round(audioBytes / 1024)}KB utterances=${finals}`);
    // 24 kHz 16-bit mono PCM: 48,000 bytes per second of audio sent upstream.
    if (audioBytes > 0) {
      const secs = audioBytes / 48_000;
      void recordSpend({ source: 'dictation', vendor: 'openai', model: STREAM_MODEL, quantity: secs, unit: 'seconds', costUsd: priceOpenAiAudio(STREAM_MODEL, secs), estimated: true, userId: uid });
    }
  };
  const fail = (message: string, code = 1011) => { sendJson(client, { type: 'error', message }); finish(code, message); };
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish(4002, 'idle'), IDLE_MS);
  };
  const maxTimer = setTimeout(() => finish(4003, 'session limit'), MAX_SESSION_MS);
  bumpIdle();

  try { up = openUpstream(); } catch (e: any) {
    console.error('[stt] upstream open failed:', e?.message ?? e);
    fail('transcription upstream unreachable');
    return;
  }

  const appendAudio = (buf: Buffer) => {
    sendJson(up!, { type: 'input_audio_buffer.append', audio: buf.toString('base64') });
  };

  up.on('open', () => {
    upOpen = true;
    sendJson(up!, buildSessionUpdate(silenceMs, language));
    for (const b of preopen) appendAudio(b);
    preopen.length = 0; preopenBytes = 0;
  });
  up.on('message', (data: RawData) => {
    let j: any;
    try { j = JSON.parse(String(data)); } catch { return; }
    const m = mapUpstreamEvent(j);
    if (m.kind === 'ignore') return;
    if (m.kind === 'fatal') { fail(m.message); return; }
    if (m.event.type === 'ready') ready = true;
    else if (m.event.type === 'speech_started') speechOpen = true;
    else if (m.event.type === 'speech_stopped') speechOpen = false;
    else if (m.event.type === 'final') finals++;
    sendJson(client, m.event);
  });
  up.on('error', (e) => {
    console.error('[stt] upstream socket error:', (e as any)?.message ?? e);
    fail(ready ? 'transcription failed' : 'transcription upstream unreachable');
  });
  // We always close upstream AFTER marking ourselves closed, so an upstream close we did not
  // initiate is a failure the browser must hear about (session expiry, provider hiccup).
  up.on('close', () => { if (!closed) fail(ready ? 'transcription ended' : 'transcription upstream unreachable'); });

  client.on('message', (data: RawData, isBinary: boolean) => {
    if (closed) return;
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!buf.length || buf.length > MAX_FRAME_BYTES) return;
      audioBytes += buf.length;
      bumpIdle();
      if (upOpen) appendAudio(buf);
      else if (preopenBytes + buf.length <= PREOPEN_BUFFER_BYTES) { preopen.push(buf); preopenBytes += buf.length; }
      return;
    }
    let msg: any;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg?.type === 'commit') {
      // Only meaningful while an utterance is open — otherwise the VAD already committed it and
      // the transcript is in flight (a bare commit would just error upstream).
      if (upOpen && speechOpen) { speechOpen = false; sendJson(up!, { type: 'input_audio_buffer.commit' }); }
    } else if (msg?.type === 'stop') {
      finish(1000, '');
    }
  });
  client.on('close', () => finish(1000, ''));
  client.on('error', () => finish(1011, 'client error'));
}

/**
 * Mount the dictation stream on the HTTP server. Cheap when transcription is unconfigured: the
 * route still answers (so a stale client gets a clean error instead of a hung socket) but closes
 * immediately with `transcription not configured`.
 */
export function attachTranscribeStream(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  attachWsDispatcher(server);
  registerWsRoute(STREAM_PATH, (req: IncomingMessage, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    if (!transcribeEnabled()) { sendJson(ws, { type: 'error', message: 'transcription not configured' }); ws.close(1011, 'not configured'); return; }
    // First message must be the authenticated start; until then nothing else is accepted.
    const deadline = setTimeout(() => { ws.close(4001, 'auth timeout'); }, AUTH_DEADLINE_MS);
    ws.once('message', (data: RawData, isBinary: boolean) => {
      clearTimeout(deadline);
      let msg: any = null;
      if (!isBinary) { try { msg = JSON.parse(String(data)); } catch { /* not json */ } }
      if (!msg || msg.type !== 'start' || typeof msg.token !== 'string') { ws.close(4001, 'start expected'); return; }
      let uid: number;
      try { uid = verifyToken(msg.token).uid; }
      catch { sendJson(ws, { type: 'error', message: 'invalid token' }); ws.close(4001, 'invalid token'); return; }
      if ((liveByUser.get(uid) ?? 0) >= MAX_STREAMS_PER_USER) { sendJson(ws, { type: 'error', message: 'too many dictation sessions' }); ws.close(4029, 'too many'); return; }
      relay(ws, uid, clampSilence(msg.silence_ms), normaliseTranscribeLanguage(msg.language) ?? config.transcribeLanguage);
    });
  });
  return wss;
}
