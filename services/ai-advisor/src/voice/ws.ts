// Retell Custom-LLM WebSocket endpoint: wss://<public>/voice/llm/<WS_TOKEN>/<call_id>. Retell opens
// one socket per call, streams the transcript to us, and speaks whatever we send back. This file is
// transport only — the conversation lives in agent.ts, the identity/tools in tools.ts.
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { voiceConfig } from './config';
import type { RetellInbound, RetellOutbound, RetellCall } from './protocol';
import { retell } from './retell';
import { VoiceSession, getSession, putSession, type OutboundBrief } from './session';
import * as store from './store';
import { candidateByPhone, candidateByUid } from './identity';
import { buildVoiceTools, type VoiceTool } from './tools';
import { reconcile, noteSpoken } from './agent';
import { runVoiceTurn } from './backend';
import { inboundOpening, outboundOpening, isOutboundFlow } from './flows';
import { stringsFor } from './languages';
import { reconcileCallFromRetell } from './webhooks';
import { registerWsRoute, attachWsDispatcher } from '../ws-routes';

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const WS_PATH = /\/voice\/llm\/([^/]+)\/([^/?#]+)\/?(?:\?.*)?$/;

/** Test seam: how a call id is validated on connect (default: Retell get-call). */
let verifyCall: (callId: string) => Promise<RetellCall | null> = async (callId) => {
  if (!voiceConfig.retellApiKey) return null;
  try { return await retell.getCall(callId); } catch (e: any) {
    console.warn(`[voice] get-call ${callId} failed: ${e?.message ?? e}`);
    return null;
  }
};
export function _setCallVerifier(fn: typeof verifyCall): void { verifyCall = fn; }

function send(ws: WebSocket, msg: RetellOutbound): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

interface Conn {
  ws: WebSocket;
  callId: string;
  session: VoiceSession | null;
  tools: VoiceTool[];
  toolsForUid: number | null | undefined; // undefined = never built
  opened: boolean;
}

/**
 * Build the session for a call once its details are known (call_details, or a verified get-call). `prior`
 * is the existing voice_call row, if any (the caller has already checked it is still 'active' and, when
 * it carries verification, re-confirmed the call with Retell).
 */
async function openSession(conn: Conn, call: RetellCall, prior: store.VoiceCallRow | null): Promise<VoiceSession> {
  const existing = getSession(call.call_id);
  if (existing) { conn.session = existing; return existing; }

  const meta = (call.metadata ?? {}) as Record<string, any>;
  const direction: store.CallDirection = call.call_type === 'web_call' ? 'web' : call.direction === 'outbound' ? 'outbound' : 'inbound';
  const flow = isOutboundFlow(meta.flow) ? meta.flow : (direction === 'outbound' ? 'outbound' : 'inbound');
  const outboundRequestId = Number(meta.outbound_request_id) || null;
  const row = await store.upsertCallStart({
    retellCallId: call.call_id, direction, flow, agentId: call.agent_id ?? null,
    fromNumber: call.from_number ?? null, toNumber: call.to_number ?? null, metadata: meta, outboundRequestId,
  });
  const session = new VoiceSession(row, direction, call);

  // Rehydration (sidecar restarted mid-call, or a reconnect after the in-memory session was swept): the
  // DB row already knows who this is and how far they were verified on THIS call id — restore that, and
  // do not speak the opening again. The transcript comes back from Retell on the next turn.
  if (prior && (prior.client_uid || prior.auth_level > 0)) {
    const events = await store.listCallEvents(prior.id);
    if (events.some((e) => e.type === 'consent_disclosed')) {
      session.disclosureDone = true;
      session.history.push({ role: 'assistant', content: '(opening already spoken before a reconnect)' });
    }
    if (prior.client_uid) {
      const cand = await candidateByUid(prior.client_uid, (prior.identified_by as any) ?? 'caller_id');
      if (cand) { await session.setCandidate(cand); session.authLevel = Math.max(0, Math.min(2, prior.auth_level)) as 0 | 1 | 2; await store.setCallAuthLevel(session.id, session.authLevel); }
    }
    if (isOutboundFlow(meta.flow)) {
      const req = outboundRequestId ? await store.getOutbound(outboundRequestId) : null;
      session.outbound = { requestId: outboundRequestId, flow: meta.flow, payload: (req?.payload ?? meta.payload ?? {}) as Record<string, unknown>, clientUid: session.candidate?.uid ?? null, clientFirstName: session.candidate?.firstName ?? null } as OutboundBrief;
    }
    putSession(session);
    conn.session = session;
    conn.opened = session.disclosureDone;
    return session;
  }

  // Outbound (or a web-call simulating one): the request names the client and the flow.
  if (isOutboundFlow(meta.flow)) {
    const req = outboundRequestId ? await store.getOutbound(outboundRequestId) : null;
    const clientUid = Number(req?.client_uid ?? meta.client_uid) || null;
    const cand = clientUid ? await candidateByUid(clientUid, 'request') : null;
    session.outbound = { requestId: outboundRequestId, flow: meta.flow, payload: (req?.payload ?? meta.payload ?? {}) as Record<string, unknown>, clientUid, clientFirstName: cand?.firstName ?? null } as OutboundBrief;
    if (cand) await session.setCandidate(cand);
  } else {
    // Inbound: caller-ID nominates a candidate (dev map first), or a demo web-call names one.
    const demoUid = Number(meta.client_uid) || null;
    const cand = demoUid && voiceConfig.demoEnabled ? await candidateByUid(demoUid, 'test_map') : await candidateByPhone(call.from_number);
    if (cand) await session.setCandidate(cand);
  }
  putSession(session);
  conn.session = session;
  return session;
}

function toolsFor(conn: Conn): VoiceTool[] {
  const s = conn.session!;
  const uid = s.candidate?.uid ?? null;
  if (conn.toolsForUid === undefined || conn.toolsForUid !== uid) {
    conn.tools = buildVoiceTools(s);
    conn.toolsForUid = uid;
  }
  return conn.tools;
}

async function speakOpening(conn: Conn): Promise<void> {
  const s = conn.session!;
  if (conn.opened || s.turnCount > 0 || s.history.length > 0) { conn.opened = true; return; }
  conn.opened = true;
  const text = s.outbound ? outboundOpening(s.outbound) : inboundOpening(s.candidate?.by === 'caller_id' || s.candidate?.by === 'test_map' ? s.candidate.firstName : null);
  noteSpoken(s, text);
  s.disclosureDone = true;
  await s.event('consent_disclosed', { direction: s.direction, opening: text.slice(0, 200) });
  send(conn.ws, { response_type: 'response', response_id: 0, content: text, content_complete: true, no_interruption_allowed: true });
}

async function handleTurn(conn: Conn, msg: Extract<RetellInbound, { interaction_type: 'response_required' | 'reminder_required' }>): Promise<void> {
  const s = conn.session!;
  // A newer request supersedes the in-flight one (barge-in / fast follow-up): abort it, then WAIT for
  // it to settle before touching history — an in-flight tool round must close its tool_use/tool_result
  // pair first, or the next request is invalid.
  if (s.currentAbort) s.currentAbort.abort();
  s.currentResponseId = msg.response_id;
  const prev = s.turnChain;
  let release!: () => void;
  s.turnChain = new Promise<void>((r) => { release = r; });
  try {
    await prev.catch(() => {});
    if (s.currentResponseId !== msg.response_id) return;   // an even newer turn arrived while we waited
    await runOneTurn(conn, msg);
  } finally {
    release();
  }
}

async function runOneTurn(conn: Conn, msg: Extract<RetellInbound, { interaction_type: 'response_required' | 'reminder_required' }>): Promise<void> {
  const s = conn.session!;
  const ac = new AbortController();
  s.currentAbort = ac;
  reconcile(s, msg.transcript ?? []);
  // Dead line: the second silence reminder on a call where the caller has never said a word is not
  // answered with another "are you still there?" — say goodbye (in the session language) and hang up,
  // instead of holding the line for Retell's own inactivity timeout. A caller who HAS spoken and then
  // goes quiet gets the persona's check-in / wrap-up; Retell's end_call_after_silence still backstops.
  if (msg.interaction_type === 'reminder_required') {
    s.reminders++;
    if (s.reminders >= 2 && !s.lastUserUtterance) {
      const line = stringsFor(s.language).deadLine;
      noteSpoken(s, line);
      send(conn.ws, { response_type: 'response', response_id: msg.response_id, content: line, content_complete: true, end_call: true });
      await s.event('ended', { by: 'agent', reason: 'dead_line', reminders: s.reminders });
      if (s.currentAbort === ac) s.currentAbort = null;
      return;
    }
  }
  // The client's AI-advisor flag is re-checked every turn (as the chat surface does per request): if staff
  // flipped it mid-call the candidate — and everything earned — is dropped before the model runs.
  await s.recheckAdvisorFlag();
  const tools = toolsFor(conn);
  const t0 = Date.now();
  let spokeChars = 0, firstAt = 0;
  await runVoiceTurn(s, {
    kind: msg.interaction_type === 'reminder_required' ? 'reminder' : 'response',
    tools,
    signal: ac.signal,
    emit: (text, done, flags) => {
      if (ac.signal.aborted || s.currentResponseId !== msg.response_id) return;
      if (text) { spokeChars += text.length; if (!firstAt) firstAt = Date.now() - t0; }
      const out: RetellOutbound = {
        // Retell concatenates chunk contents verbatim in its transcript; a trailing space keeps sentences apart.
        response_type: 'response', response_id: msg.response_id, content: done ? text : (text ? text + ' ' : text), content_complete: done,
        ...(flags?.noInterrupt ? { no_interruption_allowed: true } : {}),
        ...(done && flags?.endCall ? { end_call: true } : {}),
        ...(done && flags?.transferNumber ? { transfer_number: flags.transferNumber } : {}),
      };
      send(conn.ws, out);
      // 'transfer_requested' here; 'transferred' only when Retell confirms (call_ended: call_transfer).
      if (done && flags?.transferNumber) void s.event('transfer_requested', { to_masked: '…' + flags.transferNumber.slice(-3) });
      if (done && flags?.endCall) void s.event('ended', { by: 'agent' });
    },
  });
  // One line per turn: what it was, how long to first audio and overall, how much was said, and whether a
  // newer turn superseded it — the sidecar log is the only view of a live call.
  console.log(`[voice] call ${s.id} turn #${msg.response_id} ${msg.interaction_type === 'reminder_required' ? 'reminder' : 'response'} lang=${s.language} first=${firstAt || '-'}ms total=${Date.now() - t0}ms spoke=${spokeChars}ch${ac.signal.aborted ? ' superseded' : ''}`);
  // Identity may have changed during the turn (identify/verify tools) → tools rebuild lazily next turn.
  if (s.currentAbort === ac) s.currentAbort = null;
}

export function attachVoiceWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  // Registered with the sidecar's shared upgrade dispatcher (ws-routes.ts) so this and the
  // dictation stream can coexist; anything matching no route is 404'd there.
  attachWsDispatcher(server);
  registerWsRoute(WS_PATH, (req: IncomingMessage, socket, head, m) => {
    if (!voiceConfig.enabled || !voiceConfig.wsToken || !tokenMatches(m[1], voiceConfig.wsToken)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, decodeURIComponent(m[2])));
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, callId: string) => {
    const conn: Conn = { ws, callId, session: getSession(callId) ?? null, tools: [], toolsForUid: undefined, opened: false };
    if (conn.session) conn.opened = conn.session.history.length > 0; // reconnect: opening already spoken
    send(ws, { response_type: 'config', config: { auto_reconnect: true, call_details: true } });
    // Silence handling for custom-LLM agents is set per connection: after 12 s of no caller speech Retell
    // sends reminder_required ("are you still there?"), at most twice, before its own inactivity hang-up.
    send(ws, { response_type: 'update_agent', agent_config: { reminder_trigger_ms: 12_000, reminder_max_count: 2 } });
    /**
     * Admit the call on this socket, or close it. `details` is the call_details message (if Retell sent
     * one); the URL's call id is authoritative and must match it. A call we already know (our own row):
     * must still be 'active', and if it carries any verification (auth_level > 0) it is re-confirmed with
     * Retell get-call (call ongoing, same from_number) before that level is rehydrated. Retell-verified
     * fields always win over anything in the message.
     */
    const admit = async (details: RetellCall | null): Promise<boolean> => {
      if (conn.session) return true;
      const reject = (why: string) => { console.warn(`[voice] rejecting call ${callId}: ${why}`); ws.close(1008, 'unknown call'); return false; };
      if (details && details.call_id !== callId) return reject(`call_details id ${details.call_id} does not match the socket's`);
      const known = await store.getCallByRetellId(callId);
      if (known && known.status !== 'active' && known.status !== 'connecting') return reject(`call row is ${known.status}`);
      const needsRetell = !details || !known || known.auth_level > 0;
      let verified: RetellCall | null = details;
      if (needsRetell) {
        verified = await verifyCall(callId);
        if (!verified) return reject('not verifiable with Retell');
        if (verified.call_id && verified.call_id !== callId) return reject('Retell returned a different call id');
        if (verified.call_status && verified.call_status !== 'ongoing' && verified.call_status !== 'registered') return reject(`Retell call_status is ${verified.call_status}`);
        if (known?.from_number && verified.from_number && known.from_number !== verified.from_number) return reject('from_number differs from the recorded call');
      }
      // Message fields fill gaps only; Retell-verified fields override.
      await openSession(conn, { ...(details ?? {}), ...(verified ?? {}), call_id: callId } as RetellCall, known);
      return true;
    };

    ws.on('message', async (data) => {
      let msg: RetellInbound;
      try { msg = JSON.parse(String(data)); } catch { return; }
      try {
        switch (msg.interaction_type) {
          case 'ping_pong':
            send(ws, { response_type: 'ping_pong', timestamp: Date.now() });
            break;
          case 'call_details': {
            if (!(await admit(msg.call ?? null))) return;
            await speakOpening(conn);
            break;
          }
          case 'update_only':
            if (conn.session) reconcile(conn.session, msg.transcript ?? []);
            break;
          case 'response_required':
          case 'reminder_required': {
            // Retell never sent call_details (older agents): admit via get-call on the first turn.
            if (!(await admit(null))) return;
            if (!conn.opened) await speakOpening(conn);
            await handleTurn(conn, msg);
            break;
          }
          default:
            break;
        }
      } catch (e: any) {
        console.error(`[voice] ws handler error on call ${callId}:`, e?.message ?? e);
        if ('response_id' in (msg as any)) {
          send(ws, { response_type: 'response', response_id: (msg as any).response_id, content: stringsFor(conn.session?.language).wrong, content_complete: true });
        }
      }
    });

    ws.on('close', () => {
      const s = conn.session;
      if (s?.currentAbort) s.currentAbort.abort();
      // The call may reconnect (auto_reconnect) — the session stays registered until the webhook closes it.
      // Belt and braces: if no end webhook has closed the row within a short grace period, ask Retell.
      const id = conn.callId;
      const t = setTimeout(() => { reconcileCallFromRetell(id).catch((e) => console.warn(`[voice] reconcile ${id} failed:`, e?.message ?? e)); }, 20_000);
      t.unref?.();
    });
    ws.on('error', (e) => console.error(`[voice] ws error on call ${callId}:`, e?.message ?? e));
  });

  return wss;
}
