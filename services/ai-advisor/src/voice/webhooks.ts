// Retell webhooks: call_started / call_ended / call_analyzed. These close the voice_call record with
// the authoritative transcript, recording URL, disconnection reason and cost, classify the outcome,
// and settle the outbound request the call belonged to (retry busy/no-answer within limits).
import { voiceConfig } from './config';
import type { RetellWebhookEvent, RetellCall } from './protocol';
import * as store from './store';
import { getSession, dropSession } from './session';
import { isOutboundFlow } from './flows';
import { nextCallingWindow } from './hours';
import { retell } from './retell';
import { recordSpend } from '../spend';
import { handleReaderEvent } from './reader';

/** Retell disconnection_reason → our outcome (session-set outcomes such as order_placed win, see store.closeCall). */
export function outcomeFromReason(reason: string | undefined, inVoicemail = false): store.CallOutcome {
  const r = String(reason ?? '');
  if (inVoicemail || r === 'voicemail_reached' || r === 'machine_detected') return 'voicemail';
  if (r === 'call_transfer') return 'transferred';
  if (r === 'dial_busy') return 'busy';
  if (r === 'dial_no_answer' || r === 'user_declined' || r === 'registered_call_timeout' || r === 'error_user_not_joined') return 'no_answer';
  if (r.startsWith('error') || r === 'dial_failed' || r === 'invalid_destination' || r.startsWith('telephony_provider') || r === 'sip_routing_error' || r === 'concurrency_limit_reached' || r === 'no_valid_payment') return 'failed';
  if (r === 'marked_as_spam' || r === 'scam_detected') return 'failed';
  return 'completed';
}

function durationSeconds(call: RetellCall): number | null {
  if (typeof call.duration_ms === 'number') return Math.round(call.duration_ms / 1000);
  if (call.start_timestamp && call.end_timestamp) return Math.max(0, Math.round((call.end_timestamp - call.start_timestamp) / 1000));
  return call.call_cost?.total_duration_seconds ?? null;
}

async function settleOutbound(callRow: store.VoiceCallRow | null, outcome: store.CallOutcome, reason: string | undefined): Promise<void> {
  const reqId = callRow?.outbound_request_id;
  if (!reqId) return;
  const req = await store.getOutbound(reqId);
  if (!req || req.status !== 'dialing') return;
  // A late event for an EARLIER attempt must not settle the current one.
  if (req.retell_call_id && callRow && req.retell_call_id !== callRow.retell_call_id) return;
  if (outcome === 'busy' || outcome === 'no_answer') {
    if (req.attempts < voiceConfig.outboundMaxAttempts) {
      const when = nextCallingWindow(new Date(Date.now() + 30 * 60_000));
      await store.setOutboundStatus(req.id, 'queued', `${outcome}; retry ${req.attempts}/${voiceConfig.outboundMaxAttempts}`, null, when);
      return;
    }
    await store.setOutboundStatus(req.id, 'failed', `${outcome} after ${req.attempts} attempts`);
    return;
  }
  if (outcome === 'failed') { await store.setOutboundStatus(req.id, 'failed', reason ?? 'call failed'); return; }
  await store.setOutboundStatus(req.id, 'completed', outcome);
}

/**
 * Fallback when the end webhook never lands (wrong signing key, tunnel blip, sidecar restart): fetch the
 * call from Retell and apply the same close logic. Called a little after the websocket closes; a no-op
 * if the webhook already closed the row or the call is still live.
 */
export async function reconcileCallFromRetell(retellCallId: string): Promise<'closed' | 'still_active' | 'already_closed' | 'unavailable'> {
  const row = await store.getCallByRetellId(retellCallId);
  if (!row) return 'unavailable';
  if (row.status === 'ended' || row.status === 'failed') return 'already_closed';
  let call: RetellCall;
  try { call = await retell.getCall(retellCallId); } catch { return 'unavailable'; }
  if (call.call_status !== 'ended' && call.call_status !== 'error') return 'still_active';
  await handleRetellEvent({ event: 'call_ended', call });
  if (call.call_analysis || call.call_cost) await handleRetellEvent({ event: 'call_analyzed', call });
  console.log(`[voice] call ${retellCallId} closed from get-call (webhook did not arrive or was rejected)`);
  return 'closed';
}

/** Handle one verified webhook event. Idempotent: replays just re-apply the same updates. */
export async function handleRetellEvent(ev: RetellWebhookEvent): Promise<void> {
  const call = ev.call;
  if (!call?.call_id) return;
  const meta = (call.metadata ?? {}) as Record<string, any>;
  // Web-reader calls (the browser read-aloud) are not conversations: no voice_call row, no outcome —
  // just their cost into the ledger and the session cleaned up. See reader.ts.
  if (meta.reader === true) { await handleReaderEvent(ev); return; }
  switch (ev.event) {
    case 'call_started': {
      const direction: store.CallDirection = call.call_type === 'web_call' ? 'web' : call.direction === 'outbound' ? 'outbound' : 'inbound';
      await store.upsertCallStart({
        retellCallId: call.call_id, direction, flow: isOutboundFlow(meta.flow) ? meta.flow : (direction === 'outbound' ? 'outbound' : 'inbound'),
        agentId: call.agent_id ?? null, fromNumber: call.from_number ?? null, toNumber: call.to_number ?? null, metadata: meta,
        outboundRequestId: Number(meta.outbound_request_id) || null,
      });
      break;
    }
    case 'call_ended': {
      const session = getSession(call.call_id);
      // A session outcome wins over the disconnection reason, EXCEPT 'transfer_requested': only Retell's
      // own call_transfer reason confirms the hand-off actually happened ('transferred'); otherwise the
      // reason decides (hang-up before the transfer → 'completed', etc.).
      const fromReason = outcomeFromReason(call.disconnection_reason, call.call_analysis?.in_voicemail);
      const outcome = session?.outcome && session.outcome !== 'transfer_requested' ? session.outcome : fromReason;
      const row = await store.closeCall(call.call_id, {
        status: outcome === 'failed' ? 'failed' : 'ended',
        disconnectionReason: call.disconnection_reason ?? null,
        endedAtMs: call.end_timestamp ?? Date.now(),
        durationSeconds: durationSeconds(call),
        transcript: call.transcript_object ?? null,
        recordingUrl: call.recording_url ?? null,
        outcome,
      });
      if (row) await store.addCallEvent(row.id, 'ended', { reason: call.disconnection_reason ?? null, outcome });
      if (session) { session.ended = true; dropSession(call.call_id); }
      await settleOutbound(row, outcome, call.disconnection_reason);
      break;
    }
    case 'call_analyzed': {
      const summary = call.call_analysis?.call_summary ?? null;
      const cost = call.call_cost?.combined_cost;
      const existing = await store.getCallByRetellId(call.call_id);
      const row = await store.closeCall(call.call_id, {
        status: existing?.status === 'failed' ? 'failed' : 'ended',   // analysis never un-fails a call
        summary, transcript: call.transcript_object ?? null, recordingUrl: call.recording_url ?? null,
        costUsd: typeof cost === 'number' ? cost / 100 : null,   // Retell reports cents
        outcome: call.call_analysis?.in_voicemail ? 'voicemail' : null,
      });
      if (row && typeof cost === 'number') {
        void recordSpend({ source: 'voice_call', vendor: 'retell', costUsd: cost / 100, quantity: row.duration_seconds ?? null, unit: 'seconds', ref: `voice_call:${row.id}`, userId: row.client_uid, at: row.ended_at ?? null });
      }
      if (row && call.call_analysis?.in_voicemail) await settleOutbound(row, 'voicemail', 'voicemail');
      break;
    }
    default:
      break;
  }
}
