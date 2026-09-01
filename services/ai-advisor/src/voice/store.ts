// Persistence for the voice module (schema: db/voice.sql). Plain SQL over the sidecar's primary pool.
import { query } from '../db';
import { voiceConfig } from './config';

export type CallDirection = 'inbound' | 'outbound' | 'web';
export type CallStatus = 'connecting' | 'active' | 'ended' | 'failed';
export type CallOutcome =
  | 'completed' | 'transfer_requested' | 'transferred' | 'callback_requested' | 'opted_out' | 'voicemail'
  | 'no_answer' | 'busy' | 'failed' | 'abandoned' | 'order_placed';

export interface VoiceCallRow {
  id: number;
  retell_call_id: string;
  direction: CallDirection;
  flow: string | null;
  agent_id: string | null;
  from_number: string | null;
  to_number: string | null;
  client_uid: number | null;
  account_id: number | null;
  identified_by: string | null;
  auth_level: number;
  conversation_id: number | null;
  status: CallStatus;
  outcome: CallOutcome | null;
  disconnection_reason: string | null;
  outbound_request_id: number | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  transcript: any;
  summary: string | null;
  recording_url: string | null;
  metadata: any;
  cost_usd: number | null;
}

export async function upsertCallStart(input: {
  retellCallId: string; direction: CallDirection; flow: string | null; agentId: string | null;
  fromNumber: string | null; toNumber: string | null; metadata: any; outboundRequestId?: number | null;
}): Promise<VoiceCallRow> {
  const r = await query<VoiceCallRow>(
    `INSERT INTO voice_call (retell_call_id, direction, flow, agent_id, from_number, to_number, metadata, outbound_request_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
     ON CONFLICT (retell_call_id) DO UPDATE SET
       status = CASE WHEN voice_call.status IN ('ended','failed') THEN voice_call.status ELSE 'active' END,
       agent_id = COALESCE(EXCLUDED.agent_id, voice_call.agent_id),
       from_number = COALESCE(EXCLUDED.from_number, voice_call.from_number),
       to_number = COALESCE(EXCLUDED.to_number, voice_call.to_number),
       metadata = COALESCE(EXCLUDED.metadata, voice_call.metadata),
       flow = COALESCE(EXCLUDED.flow, voice_call.flow),
       direction = COALESCE(EXCLUDED.direction, voice_call.direction),
       outbound_request_id = COALESCE(EXCLUDED.outbound_request_id, voice_call.outbound_request_id),
       updated_at = now()
     RETURNING *`,
    [input.retellCallId, input.direction, input.flow, input.agentId, input.fromNumber, input.toNumber,
     input.metadata == null ? null : JSON.stringify(input.metadata), input.outboundRequestId ?? null]);
  return r.rows[0];
}

export async function getCallByRetellId(retellCallId: string): Promise<VoiceCallRow | null> {
  const r = await query<VoiceCallRow>(`SELECT * FROM voice_call WHERE retell_call_id = $1`, [retellCallId]);
  return r.rows[0] ?? null;
}

export async function getCallById(id: number): Promise<VoiceCallRow | null> {
  const r = await query<VoiceCallRow>(`SELECT * FROM voice_call WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function setCallIdentity(id: number, clientUid: number | null, accountId: number | null, identifiedBy: string | null): Promise<void> {
  await query(`UPDATE voice_call SET client_uid=$2, account_id=$3, identified_by=$4, updated_at=now() WHERE id=$1`,
    [id, clientUid, accountId, identifiedBy]);
}

export async function setCallAuthLevel(id: number, level: number): Promise<void> {
  await query(`UPDATE voice_call SET auth_level = GREATEST(auth_level, $2), updated_at=now() WHERE id=$1`, [id, level]);
}
/** Candidate switch: the audit row must not carry the previous candidate's level. */
export async function resetCallAuthLevel(id: number): Promise<void> {
  await query(`UPDATE voice_call SET auth_level = 0, updated_at=now() WHERE id=$1`, [id]);
}

export async function setCallOutcome(id: number, outcome: CallOutcome | null): Promise<void> {
  // Later outcomes do not overwrite terminal, more specific ones set during the call (order_placed,
  // transferred, opted_out) with a generic 'completed' from the webhook. 'transfer_requested' is NOT
  // protected: if the call then ends without Retell reporting call_transfer, 'completed' is the truth.
  await query(
    `UPDATE voice_call SET outcome = CASE
        WHEN outcome IN ('order_placed','transferred','opted_out','callback_requested') AND $2 = 'completed' THEN outcome
        ELSE $2 END, updated_at=now()
      WHERE id=$1`, [id, outcome]);
}

export async function closeCall(retellCallId: string, input: {
  status: CallStatus; disconnectionReason?: string | null; endedAtMs?: number | null; durationSeconds?: number | null;
  transcript?: any; recordingUrl?: string | null; summary?: string | null; costUsd?: number | null; outcome?: CallOutcome | null;
}): Promise<VoiceCallRow | null> {
  const r = await query<VoiceCallRow>(
    `UPDATE voice_call SET
        status = $2,
        disconnection_reason = COALESCE($3, disconnection_reason),
        ended_at = COALESCE(to_timestamp($4::double precision / 1000.0), ended_at, now()),
        duration_seconds = COALESCE($5, duration_seconds),
        transcript = COALESCE($6::jsonb, transcript),
        recording_url = COALESCE($7, recording_url),
        summary = COALESCE($8, summary),
        cost_usd = COALESCE($9, cost_usd),
        outcome = CASE
          WHEN $10::text IS NULL THEN outcome
          WHEN outcome IN ('order_placed','transferred','opted_out','callback_requested') AND $10 = 'completed' THEN outcome
          ELSE $10 END,
        updated_at = now()
      WHERE retell_call_id = $1 RETURNING *`,
    [retellCallId, input.status, input.disconnectionReason ?? null, input.endedAtMs ?? null, input.durationSeconds ?? null,
     input.transcript == null ? null : JSON.stringify(input.transcript), input.recordingUrl ?? null, input.summary ?? null,
     input.costUsd ?? null, input.outcome ?? null]);
  return r.rows[0] ?? null;
}

export async function addCallEvent(callId: number, type: string, detail?: Record<string, unknown> | null): Promise<void> {
  await query(`INSERT INTO voice_call_event (call_id, type, detail) VALUES ($1,$2,$3)`,
    [callId, type, detail == null ? null : JSON.stringify(detail)]);
}

export async function listCallEvents(callId: number): Promise<Array<{ id: number; at: string; type: string; detail: any }>> {
  const r = await query(`SELECT id, at, type, detail FROM voice_call_event WHERE call_id=$1 ORDER BY at, id`, [callId]);
  return r.rows;
}

export async function listCalls(opts: { clientUid?: number | null; limit?: number } = {}): Promise<VoiceCallRow[]> {
  const params: any[] = [];
  const cond: string[] = [];
  if (opts.clientUid) { params.push(opts.clientUid); cond.push(`client_uid = $${params.length}`); }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  const r = await query<VoiceCallRow>(
    `SELECT * FROM voice_call ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY started_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

// ---- OTP ------------------------------------------------------------------------------------

export interface OtpRow { id: number; call_id: number; client_uid: number; code_hash: string; channel: string; sent_to: string | null; expires_at: string; attempts: number; verified_at: string | null; created_at: string }

export async function insertOtp(callId: number, clientUid: number, codeHash: string, channel: string, sentTo: string | null, ttlSeconds: number): Promise<OtpRow> {
  const r = await query<OtpRow>(
    `INSERT INTO voice_otp (call_id, client_uid, code_hash, channel, sent_to, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6::int * interval '1 second')) RETURNING *`,
    [callId, clientUid, codeHash, channel, sentTo, ttlSeconds]);
  return r.rows[0];
}
export async function countOtpSends(callId: number): Promise<number> {
  const r = await query<{ n: number }>(`SELECT count(*)::int AS n FROM voice_otp WHERE call_id=$1`, [callId]);
  return r.rows[0]?.n ?? 0;
}
/** The latest UNCONSUMED code for this call AND this candidate (a code sent for another candidate never counts). */
export async function latestOtp(callId: number, clientUid: number): Promise<OtpRow | null> {
  const r = await query<OtpRow>(`SELECT * FROM voice_otp WHERE call_id=$1 AND client_uid=$2 AND verified_at IS NULL ORDER BY created_at DESC LIMIT 1`, [callId, clientUid]);
  return r.rows[0] ?? null;
}
/** Candidate changed mid-call: every outstanding code for the call is void. */
export async function expireOtpsForCall(callId: number): Promise<void> {
  await query(`UPDATE voice_otp SET expires_at = now() WHERE call_id=$1 AND verified_at IS NULL AND expires_at > now()`, [callId]);
}
/** Cross-call abuse guard: codes sent to this client in the last N minutes, from any call. */
export async function countOtpSendsForClient(clientUid: number, windowMinutes = 60): Promise<number> {
  const r = await query<{ n: number }>(`SELECT count(*)::int AS n FROM voice_otp WHERE client_uid=$1 AND created_at > now() - ($2::int * interval '1 minute')`, [clientUid, windowMinutes]);
  return r.rows[0]?.n ?? 0;
}
/** Knowledge-factor (verify_caller_details) attempts against this client in the last N minutes, from any call. */
export async function countKnowledgeAttemptsForClient(clientUid: number, windowMinutes = 60): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM voice_call_event
      WHERE type = 'knowledge_checked' AND detail->>'uid' = $1::text AND at > now() - ($2::int * interval '1 minute')`,
    [String(clientUid), windowMinutes]);
  return r.rows[0]?.n ?? 0;
}
export async function bumpOtpAttempt(id: number): Promise<number> {
  const r = await query<{ attempts: number }>(`UPDATE voice_otp SET attempts = attempts + 1 WHERE id=$1 RETURNING attempts`, [id]);
  return r.rows[0]?.attempts ?? 0;
}
export async function markOtpVerified(id: number): Promise<void> {
  await query(`UPDATE voice_otp SET verified_at = now() WHERE id=$1`, [id]);
}

// ---- Suppression --------------------------------------------------------------------------

export async function isSuppressed(phoneDigits: string): Promise<{ suppressed: boolean; reason?: string }> {
  if (!phoneDigits) return { suppressed: false };
  const r = await query<{ reason: string }>(`SELECT reason FROM voice_suppression WHERE phone_digits=$1`, [phoneDigits]);
  return r.rows[0] ? { suppressed: true, reason: r.rows[0].reason } : { suppressed: false };
}
export async function addSuppression(phoneDigits: string, reason: string, source: string, createdBy: number | null = null): Promise<void> {
  if (!phoneDigits) return;
  await query(
    `INSERT INTO voice_suppression (phone_digits, reason, source, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (phone_digits) DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source, created_at = now()`,
    [phoneDigits, reason, source, createdBy]);
}
export async function removeSuppression(phoneDigits: string): Promise<boolean> {
  const r = await query(`DELETE FROM voice_suppression WHERE phone_digits=$1`, [phoneDigits]);
  return (r.rowCount ?? 0) > 0;
}
export async function listSuppressions(limit = 200): Promise<Array<{ phone_digits: string; reason: string; source: string; created_at: string }>> {
  const r = await query(`SELECT phone_digits, reason, source, created_at FROM voice_suppression ORDER BY created_at DESC LIMIT $1`, [limit]);
  return r.rows;
}

// ---- Outbound queue --------------------------------------------------------------------------

export type OutboundStatus = 'queued' | 'dialing' | 'completed' | 'failed' | 'suppressed' | 'skipped' | 'cancelled';
export interface OutboundRequestRow {
  id: number; idempotency_key: string; flow: string; client_uid: number | null; to_number: string; payload: any;
  consent_basis: string; source: string; source_ref: string | null; status: OutboundStatus; status_detail: string | null;
  scheduled_for: string; attempts: number; retell_call_id: string | null; created_at: string; updated_at: string;
}

export async function enqueueOutbound(input: {
  idempotencyKey: string; flow: string; clientUid: number | null; toNumber: string; payload: any;
  consentBasis?: string; source: string; sourceRef?: string | null; scheduledFor?: Date | null;
}): Promise<{ row: OutboundRequestRow; created: boolean }> {
  // A duplicate source_ref (same platform event, different key) is the same request: return it.
  if (input.sourceRef) {
    const dup = await query<OutboundRequestRow>(`SELECT * FROM voice_outbound_request WHERE source_ref=$1`, [input.sourceRef]);
    if (dup.rows[0]) return { row: dup.rows[0], created: false };
  }
  const ins = await query<OutboundRequestRow>(
    `INSERT INTO voice_outbound_request (idempotency_key, flow, client_uid, to_number, payload, consent_basis, source, source_ref, scheduled_for)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, now()))
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [input.idempotencyKey, input.flow, input.clientUid, input.toNumber, JSON.stringify(input.payload ?? {}),
     input.consentBasis ?? 'existing_client_relationship', input.source, input.sourceRef ?? null, input.scheduledFor ?? null]);
  if (ins.rows[0]) return { row: ins.rows[0], created: true };
  const ex = await query<OutboundRequestRow>(`SELECT * FROM voice_outbound_request WHERE idempotency_key=$1`, [input.idempotencyKey]);
  return { row: ex.rows[0], created: false };
}

export async function getOutbound(id: number): Promise<OutboundRequestRow | null> {
  const r = await query<OutboundRequestRow>(`SELECT * FROM voice_outbound_request WHERE id=$1`, [id]);
  return r.rows[0] ?? null;
}

export async function listOutbound(status?: OutboundStatus, limit = 100): Promise<OutboundRequestRow[]> {
  const params: any[] = [];
  let where = '';
  if (status) { params.push(status); where = `WHERE status = $1`; }
  params.push(limit);
  const r = await query<OutboundRequestRow>(`SELECT * FROM voice_outbound_request ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

/** Claim due, queued requests for dialing (single-flight per row via the conditional flip). */
export async function claimDueOutbound(limit = 5): Promise<OutboundRequestRow[]> {
  const r = await query<OutboundRequestRow>(
    `UPDATE voice_outbound_request SET status='dialing', attempts = attempts + 1, updated_at=now()
      WHERE id IN (SELECT id FROM voice_outbound_request WHERE status='queued' AND scheduled_for <= now()
                   ORDER BY scheduled_for LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [limit]);
  return r.rows;
}

export async function setOutboundStatus(id: number, status: OutboundStatus, detail: string | null = null, retellCallId: string | null = null, rescheduleTo: Date | null = null): Promise<void> {
  await query(
    `UPDATE voice_outbound_request SET status=$2, status_detail=$3, retell_call_id=COALESCE($4, retell_call_id),
        scheduled_for = COALESCE($5, scheduled_for), updated_at=now() WHERE id=$1`,
    [id, status, detail, retellCallId, rescheduleTo]);
}

/** Calls dialed/completed for this client today, EXCLUDING the request being guarded (it is already 'dialing'). */
export async function outboundCountToday(clientUid: number, tz = voiceConfig.timezone, excludeRequestId: number | null = null): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM voice_outbound_request
      WHERE client_uid=$1 AND status IN ('dialing','completed') AND ($3::bigint IS NULL OR id <> $3)
        AND (updated_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`, [clientUid, tz, excludeRequestId]);
  return r.rows[0]?.n ?? 0;
}

/** Calls dialed/completed to this NUMBER today (requests with no client uid are capped per number instead). */
export async function outboundCountTodayForNumber(toNumber: string, tz = voiceConfig.timezone, excludeRequestId: number | null = null): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM voice_outbound_request
      WHERE to_number=$1 AND status IN ('dialing','completed') AND ($3::bigint IS NULL OR id <> $3)
        AND (updated_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`, [toNumber, tz, excludeRequestId]);
  return r.rows[0]?.n ?? 0;
}

/**
 * Integrated trigger: pending orders placed through the CHAT advisor since the watermark that have no
 * request yet. Voice-placed orders are excluded twice over: they carry no conversation_id (the chat
 * surface always sets one — server.ts passes convId on every turn; voice builds its broker tools with
 * conversationId null), and their confirmation is on the call's event trail (order_confirmed). A
 * courtesy call minutes after the caller confirmed the same order aloud would be noise.
 */
export async function placedOrdersWithoutRequest(sinceMinutes = 120, limit = 20): Promise<Array<{ id: number; user_id: number; side: string; region_name: string | null; volume_ml: string | null; price_per_ml: string | null; crm_order_id: number | null; decided_at: string }>> {
  const r = await query(
    `SELECT po.id, po.user_id, po.side, po.region_name, po.volume_ml, po.price_per_ml, po.crm_order_id, po.decided_at
       FROM pending_order po
      WHERE po.status = 'placed' AND po.decided_at >= now() - ($1::int * interval '1 minute')
        AND po.conversation_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM voice_outbound_request r WHERE r.source_ref = 'pending_order:' || po.id)
        AND NOT EXISTS (SELECT 1 FROM voice_call_event e WHERE e.type = 'order_confirmed' AND e.detail->>'pending_order_id' = po.id::text)
      ORDER BY po.decided_at LIMIT $2`, [sinceMinutes, limit]);
  return r.rows;
}

// ---- Retention ------------------------------------------------------------------------------

/** Calls still 'active' long after they started (webhook never came / process died): close as abandoned. */
export async function sweepStaleCalls(maxAgeHours = 3): Promise<number> {
  const r = await query(
    `UPDATE voice_call SET status='ended', outcome=COALESCE(outcome,'abandoned'), ended_at=COALESCE(ended_at, now()), updated_at=now()
      WHERE status IN ('connecting','active') AND started_at < now() - ($1::int * interval '1 hour')`, [maxAgeHours]);
  return r.rowCount ?? 0;
}

/**
 * Retention: blank what the caller SAID and where the audio is, keeping the audit row. Transcript,
 * summary and recording URL on voice_call; caller speech captured in events (`said` on
 * order_confirm_refused) on voice_call_event. Returns the number of calls touched.
 */
export async function sweepRetention(days = voiceConfig.retentionDays): Promise<number> {
  if (!days || days <= 0) return 0;
  await query(
    `UPDATE voice_call_event e SET detail = e.detail - 'said'
       FROM voice_call c
      WHERE e.call_id = c.id AND c.started_at < now() - ($1::int * interval '1 day') AND e.detail ? 'said'`, [days]);
  const r = await query(
    `UPDATE voice_call SET transcript = NULL, summary = NULL, recording_url = NULL, updated_at = now()
      WHERE started_at < now() - ($1::int * interval '1 day') AND (transcript IS NOT NULL OR summary IS NOT NULL OR recording_url IS NOT NULL)`, [days]);
  return r.rowCount ?? 0;
}
