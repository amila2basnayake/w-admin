// Outbound calling: a queue with guards, a dialer, and the two contracted triggers (agnostic webhook →
// requestOutboundCall; integrated platform event → the order-placed poller). Every dial passes the
// same gate: dialer kill switch, a from-number, suppression list, calling hours, the client's advisor
// flag, per-client daily cap. The consent basis is stored on every request.
import { query } from '../db';
import { isAdvisorEnabled } from '../data-db';
import { voiceConfig } from './config';
import { isOutboundFlow, callbackNumberAllowedForBrief, type OutboundFlow } from './flows';
import { toE164, normalizeDigits } from './phone';
import { retell } from './retell';
import * as store from './store';
import { withinHours, nextCallingWindow } from './hours';

export class OutboundError extends Error {
  constructor(public status: number, msg: string) { super(msg); this.name = 'OutboundError'; }
}

/** The client's best number for an outbound call: mobile, then business, then home. */
export async function clientPhone(uid: number): Promise<string | null> {
  const r = await query(`SELECT company_mobile, businessphone, homephone FROM waterfind_user WHERE id=$1`, [uid]);
  const row = r.rows[0];
  if (!row) return null;
  return toE164(row.company_mobile) ?? toE164(row.businessphone) ?? toE164(row.homephone) ?? null;
}

export interface OutboundInput {
  flow: string;
  client_uid?: number | null;
  to_number?: string | null;
  payload?: Record<string, unknown> | null;
  idempotency_key?: string | null;
  consent_basis?: string | null;
  scheduled_for?: string | null;   // ISO
  source: string;
  source_ref?: string | null;
}

/** True when the E.164 number's country code is one the dialer may call (AU by default). */
export function destinationAllowed(e164: string, codes: readonly string[] = voiceConfig.outboundAllowedCountryCodes): boolean {
  const d = normalizeDigits(e164);
  return !!d && codes.some((c) => d.startsWith(c));
}

/** Payload string fields that reach the model's brief, each length-capped and flattened to one line. */
export const PAYLOAD_TEXT_FIELDS = ['message', 'brief', 'broker_name', 'region', 'description', 'order_number'] as const;
const PAYLOAD_TEXT_MAX = 500;

/** One-line, control-character-free, capped text for interpolation into the call brief. */
export function briefText(v: unknown, max = PAYLOAD_TEXT_MAX): string {
  return String(v ?? '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Validate and sanitise a request payload: unknown keys are kept (flow-specific data) but every
 *  string the brief interpolates is capped/flattened, and callback_number must be on the allowlist. */
export function sanitisePayload(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const p: Record<string, unknown> = { ...(payload ?? {}) };
  for (const k of PAYLOAD_TEXT_FIELDS) if (p[k] != null) p[k] = briefText(p[k]);
  if (p.callback_number != null) {
    const n = briefText(p.callback_number, 40);
    if (!n || !callbackNumberAllowedForBrief(n)) throw new OutboundError(400, 'callback_number is not an allowed Waterfind number');
    p.callback_number = n;
  }
  return p;
}

/** Validate + enqueue. Does not dial; the dialer job does, inside the guards. */
export async function requestOutboundCall(input: OutboundInput): Promise<{ request: store.OutboundRequestRow; created: boolean }> {
  if (!isOutboundFlow(input.flow)) throw new OutboundError(400, `unknown flow "${input.flow}"`);
  const key = String(input.idempotency_key ?? '').trim().slice(0, 200);
  if (!key) throw new OutboundError(400, 'idempotency_key is required');
  const clientUid = input.client_uid ? Number(input.client_uid) : null;
  if (clientUid != null && (!Number.isInteger(clientUid) || clientUid <= 0)) throw new OutboundError(400, 'client_uid must be a positive integer');
  let to = input.to_number ? toE164(input.to_number) : null;
  if (input.to_number && !to) throw new OutboundError(400, 'to_number is not a valid phone number');
  if (!to && clientUid) to = await clientPhone(clientUid);
  if (!to) throw new OutboundError(400, clientUid ? 'no phone number on file for that client' : 'to_number or client_uid is required');
  if (!destinationAllowed(to)) throw new OutboundError(400, 'destination country is not enabled for outbound calls');
  const payload = sanitisePayload(input.payload);
  const scheduled = input.scheduled_for ? new Date(input.scheduled_for) : null;
  if (scheduled && Number.isNaN(scheduled.getTime())) throw new OutboundError(400, 'scheduled_for is not a valid date');
  const { row, created } = await store.enqueueOutbound({
    idempotencyKey: key, flow: input.flow, clientUid, toNumber: to, payload,
    consentBasis: briefText(input.consent_basis, 100) || 'existing_client_relationship', source: input.source, sourceRef: input.source_ref ? briefText(input.source_ref, 200) : null,
    scheduledFor: scheduled,
  });
  return { request: row, created };
}

export type GuardVerdict = { ok: true } | { ok: false; action: 'skip' | 'suppress' | 'reschedule' | 'hold'; reason: string; until?: Date };

/** Every reason we would NOT dial a queued request right now. Pure given its inputs (tested offline). */
export async function guardOutbound(req: store.OutboundRequestRow, now = new Date(), cfg = voiceConfig): Promise<GuardVerdict> {
  if (!cfg.outboundEnabled) return { ok: false, action: 'hold', reason: 'outbound dialer disabled (AIADVISOR_VOICE_OUTBOUND_ENABLED=0)' };
  if (!cfg.fromNumber) return { ok: false, action: 'hold', reason: 'no from-number configured (AIADVISOR_VOICE_FROM_NUMBER)' };
  if (!cfg.outboundAgentId) return { ok: false, action: 'hold', reason: 'no outbound agent configured' };
  const digits = normalizeDigits(req.to_number);
  const sup = await store.isSuppressed(digits);
  if (sup.suppressed) return { ok: false, action: 'suppress', reason: `number suppressed (${sup.reason})` };
  if (!destinationAllowed(req.to_number, cfg.outboundAllowedCountryCodes)) return { ok: false, action: 'skip', reason: 'destination country not enabled' };
  if (req.client_uid) {
    const flag = await isAdvisorEnabled(req.client_uid);
    if (flag === 'disabled') return { ok: false, action: 'skip', reason: 'client has the AI advisor disabled' };
    if (flag === 'unknown') return { ok: false, action: 'hold', reason: 'advisor flag could not be verified' };
    const n = await store.outboundCountToday(req.client_uid, cfg.timezone, req.id);
    if (n >= cfg.outboundDailyCapPerClient) return { ok: false, action: 'reschedule', reason: 'daily call cap for this client reached', until: nextCallingWindow(new Date(now.getTime() + 24 * 60 * 60_000), cfg) };
  } else {
    // No client on the request: the same daily cap applies per destination number.
    const n = await store.outboundCountTodayForNumber(req.to_number, cfg.timezone, req.id);
    if (n >= cfg.outboundDailyCapPerClient) return { ok: false, action: 'reschedule', reason: 'daily call cap for this number reached', until: nextCallingWindow(new Date(now.getTime() + 24 * 60 * 60_000), cfg) };
  }
  if (!withinHours(now, cfg)) return { ok: false, action: 'reschedule', reason: 'outside calling hours', until: nextCallingWindow(now, cfg) };
  if (req.attempts > cfg.outboundMaxAttempts) return { ok: false, action: 'skip', reason: 'max attempts exceeded' };
  // A request that has been waiting more than a week (rescheduled around caps/hours, or the dialer was
  // off) is stale: an "order confirmation" a week late is noise, not service.
  if (req.created_at && now.getTime() - new Date(req.created_at).getTime() > 7 * 24 * 60 * 60_000) return { ok: false, action: 'skip', reason: 'request older than 7 days' };
  return { ok: true };
}

/** Test seam for the dialer. */
let placeCall = async (req: store.OutboundRequestRow) => retell.createPhoneCall({
  from_number: voiceConfig.fromNumber!,
  to_number: req.to_number,
  override_agent_id: voiceConfig.outboundAgentId,
  metadata: { flow: req.flow, outbound_request_id: req.id, client_uid: req.client_uid, source: req.source },
});
export function _setPlaceCall(fn: typeof placeCall): void { placeCall = fn; }

/** Claim due requests and dial the ones that pass the guards. Returns what happened, for logs/tests. */
export async function dialDue(limit = 5, now = new Date()): Promise<Array<{ id: number; result: string }>> {
  const out: Array<{ id: number; result: string }> = [];
  const due = await store.claimDueOutbound(limit);
  for (const req of due) {
    const g = await guardOutbound(req, now);
    if (!g.ok) {
      if (g.action === 'hold') { await store.setOutboundStatus(req.id, 'queued', g.reason, null, new Date(now.getTime() + 5 * 60_000)); }
      else if (g.action === 'reschedule') { await store.setOutboundStatus(req.id, 'queued', g.reason, null, g.until ?? nextCallingWindow(now)); }
      else if (g.action === 'suppress') { await store.setOutboundStatus(req.id, 'suppressed', g.reason); }
      else { await store.setOutboundStatus(req.id, 'skipped', g.reason); }
      // A hold/reschedule did not consume an attempt.
      if (g.action === 'hold' || g.action === 'reschedule') await query(`UPDATE voice_outbound_request SET attempts = GREATEST(attempts - 1, 0) WHERE id=$1`, [req.id]);
      out.push({ id: req.id, result: `${g.action}: ${g.reason}` });
      continue;
    }
    let call: { call_id: string; agent_id?: string } | null = null;
    try {
      call = await placeCall(req);
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      console.error(`[voice] outbound dial failed for request ${req.id}:`, msg);
      if (req.attempts < voiceConfig.outboundMaxAttempts) await store.setOutboundStatus(req.id, 'queued', `dial error: ${msg}`, null, new Date(now.getTime() + 15 * 60_000));
      else await store.setOutboundStatus(req.id, 'failed', `dial error: ${msg}`);
      out.push({ id: req.id, result: `error: ${msg}` });
      continue;
    }
    // From here the call EXISTS at Retell: bookkeeping failures must never requeue (that would dial twice).
    try {
      await store.upsertCallStart({
        retellCallId: call.call_id, direction: 'outbound', flow: req.flow, agentId: call.agent_id ?? voiceConfig.outboundAgentId ?? null,
        fromNumber: voiceConfig.fromNumber ?? null, toNumber: req.to_number, metadata: { flow: req.flow, outbound_request_id: req.id, client_uid: req.client_uid },
        outboundRequestId: req.id,
      });
      await store.setOutboundStatus(req.id, 'dialing', 'call created', call.call_id);
    } catch (e: any) {
      console.error(`[voice] outbound request ${req.id}: call ${call.call_id} placed but bookkeeping failed:`, e?.message ?? e);
      try { await store.setOutboundStatus(req.id, 'dialing', 'call created (bookkeeping retry)', call.call_id); } catch { /* row stays 'dialing' from the claim */ }
    }
    out.push({ id: req.id, result: `dialing ${call.call_id}` });
  }
  return out;
}

/** Integrated trigger: an order placed through the advisor → an order_confirmation courtesy call. */
export async function enqueueOrderConfirmations(): Promise<number> {
  if (!voiceConfig.outboundOnOrder) return 0;
  const rows = await store.placedOrdersWithoutRequest();
  let n = 0;
  for (const po of rows) {
    const to = await clientPhone(po.user_id);
    const desc = po.side === 'WITHDRAW' ? `withdrawal of order ${po.crm_order_id ?? ''}`.trim()
      : `${po.side.toLowerCase()} ${po.volume_ml} ML in ${po.region_name ?? 'their region'} at $${po.price_per_ml}/ML`;
    try {
      // No phone on file → a 'skipped' tombstone (so the poller does not re-find the order), never 'queued'.
      const { row, created } = await store.enqueueOutbound({
        idempotencyKey: `pending_order:${po.id}`, flow: 'order_confirmation' as OutboundFlow, clientUid: po.user_id,
        toNumber: to ?? 'unknown', payload: { pending_order_id: po.id, order_number: po.crm_order_id, description: desc },
        source: 'order_event', sourceRef: `pending_order:${po.id}`,
        scheduledFor: to ? null : new Date('2999-01-01T00:00:00Z'),
      });
      if (!to && created) await store.setOutboundStatus(row.id, 'skipped', 'no phone number on file');
      n++;
    } catch (e: any) {
      console.error(`[voice] order trigger enqueue failed for pending_order ${po.id}:`, e?.message ?? e);
    }
  }
  return n;
}

let timers: NodeJS.Timeout[] = [];
export function startOutboundJobs(): void {
  stopOutboundJobs();
  const tick = async () => {
    try { await enqueueOrderConfirmations(); } catch (e: any) { console.error('[voice] order trigger tick failed:', e?.message ?? e); }
    try { await dialDue(); } catch (e: any) { console.error('[voice] dialer tick failed:', e?.message ?? e); }
  };
  timers.push(setInterval(tick, voiceConfig.outboundPollMs));
  timers[timers.length - 1].unref?.();
}
export function stopOutboundJobs(): void { for (const t of timers) clearInterval(t); timers = []; }
