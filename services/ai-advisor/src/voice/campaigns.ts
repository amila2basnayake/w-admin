// Outbound call campaigns: a brief + a call list that staff build on the CRM "Call Campaigns" page.
//
// A campaign never dials by itself. Launching flips it to `running`; the feeder tick then paces its
// members into the ordinary outbound queue (requestOutboundCall → voice_outbound_request) a few at a
// time — `max_concurrent` in flight per campaign, only inside calling hours, only once `scheduled_for`
// has passed — and the existing dialer, guards (suppression, advisor flag, daily cap, hours) and
// busy/no-answer retries do the rest untouched. What happened to each member is DERIVED from its
// request and that request's latest call (memberStateSql), never copied back, so the campaign page and
// the call log can never disagree.
//
// Schema: db/campaigns.sql. Routes: campaign-routes.ts (staff token, BROKER/SU). Tests: test-campaigns.ts.
import { query } from '../db';
import { voiceConfig } from './config';
import { isOutboundFlow, callbackNumberAllowedForBrief, type OutboundFlow, outboundOpening } from './flows';
import { requestOutboundCall, OutboundError, briefText } from './outbound';
import { toE164, normalizeDigits } from './phone';
import { withinHours, nextCallingWindow } from './hours';
import * as store from './store';

export class CampaignError extends Error {
  constructor(public status: number, msg: string) { super(msg); this.name = 'CampaignError'; }
}

/** Flows a campaign may use. order_confirmation is event-driven (the order poller), never a list. */
export const CAMPAIGN_FLOWS = ['trade_opportunity', 'market_alert', 'broker_followup'] as const;
export type CampaignFlow = typeof CAMPAIGN_FLOWS[number];
export function isCampaignFlow(s: unknown): s is CampaignFlow { return isOutboundFlow(s) && (CAMPAIGN_FLOWS as readonly string[]).includes(s); }

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';
export type MemberStatus = 'pending' | 'queued' | 'skipped' | 'cancelled';
/** The live state of a member as the page shows it (derived; see memberStateSql). */
export type MemberState = 'pending' | 'queued' | 'dialing' | 'called' | 'voicemail' | 'failed' | 'suppressed' | 'skipped' | 'cancelled';

export interface CampaignRow {
  id: number; name: string; flow: string; payload: Record<string, unknown>; filter: any; status: CampaignStatus;
  scheduled_for: string | null; max_concurrent: number; created_by: number; created_by_name: string | null;
  launched_at: string | null; launched_by: number | null; finished_at: string | null; created_at: string; updated_at: string;
}
export interface MemberRow {
  id: number; campaign_id: number; client_uid: number; client_name: string | null; company: string | null; to_number: string | null;
  status: MemberStatus; skip_reason: string | null; outbound_request_id: number | null; feed_count: number;
  added_by: number | null; added_at: string; updated_at: string;
}
/** A member joined to its request + latest call. */
export interface MemberView extends MemberRow {
  state: MemberState;
  req_status: string | null; req_detail: string | null; attempts: number | null; scheduled_for: string | null;
  call_id: number | null; outcome: string | null; duration_seconds: number | null; summary: string | null; recording_url: string | null;
  started_at: string | null; ended_at: string | null;
  zone: string | null; licences: number | null;   // the client's largest market zone + active licence count
}
export type Counts = Record<MemberState, number> & { total: number };

/** ONE definition of a member's live state, shared by the detail and the list queries. `m` = member,
 *  `r` = its outbound request, `c` = the latest voice_call of that request. */
const memberStateSql = `CASE
    WHEN m.status <> 'queued' THEN m.status
    WHEN r.id IS NULL OR r.status = 'queued' THEN 'queued'
    WHEN r.status = 'dialing' THEN 'dialing'
    WHEN r.status = 'completed' THEN CASE WHEN c.outcome = 'voicemail' THEN 'voicemail' ELSE 'called' END
    ELSE r.status END`;
const memberJoins = `LEFT JOIN voice_outbound_request r ON r.id = m.outbound_request_id
   LEFT JOIN LATERAL (SELECT c.id, c.outcome, c.duration_seconds, c.summary, c.recording_url, c.started_at, c.ended_at
                        FROM voice_call c WHERE c.outbound_request_id = r.id ORDER BY c.started_at DESC LIMIT 1) c ON true`;

export const MEMBER_STATES: MemberState[] = ['pending', 'queued', 'dialing', 'called', 'voicemail', 'failed', 'suppressed', 'skipped', 'cancelled'];
function emptyCounts(): Counts { const c: any = { total: 0 }; for (const s of MEMBER_STATES) c[s] = 0; return c; }

// ---- brief validation --------------------------------------------------------------------------

const PAYLOAD_KEYS = ['message', 'broker_name', 'region', 'callback_number'] as const;

/** The brief the page edits: only the keys the flow briefs read, each flattened/capped; callback must be allowed. */
export function normalisePayload(input: unknown): Record<string, string> {
  const p = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of PAYLOAD_KEYS) {
    const v = briefText(p[k], k === 'callback_number' ? 40 : 500);
    if (v) out[k] = v;
  }
  if (out.callback_number && !callbackNumberAllowedForBrief(out.callback_number)) throw new CampaignError(400, 'callback_number is not an allowed Waterfind number');
  return out;
}

function parseWhen(v: unknown): Date | null {
  if (v == null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new CampaignError(400, 'scheduled_for is not a valid date');
  return d;
}

// ---- campaigns ---------------------------------------------------------------------------------

export async function createCampaign(input: { name: unknown; flow: unknown; payload?: unknown; scheduled_for?: unknown; max_concurrent?: unknown; filter?: unknown }, staff: { uid: number; name: string }): Promise<CampaignRow> {
  const name = briefText(input.name, 120);
  if (!name) throw new CampaignError(400, 'name is required');
  if (!isCampaignFlow(input.flow)) throw new CampaignError(400, `flow must be one of ${CAMPAIGN_FLOWS.join(', ')}`);
  const payload = normalisePayload(input.payload);
  if (!payload.broker_name && staff.name) payload.broker_name = briefText(staff.name, 120);
  const when = parseWhen(input.scheduled_for);
  const maxc = clampConcurrent(input.max_concurrent);
  const r = await query<CampaignRow>(
    `INSERT INTO voice_campaign (name, flow, payload, filter, scheduled_for, max_concurrent, created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name, input.flow, JSON.stringify(payload), input.filter == null ? null : JSON.stringify(input.filter), when, maxc, staff.uid, staff.name || null]);
  return r.rows[0];
}

function clampConcurrent(v: unknown): number {
  const n = v == null || v === '' ? voiceConfig.campaignMaxConcurrent : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new CampaignError(400, 'max_concurrent must be 1–20');
  return n;
}

export async function getCampaign(id: number): Promise<CampaignRow | null> {
  const r = await query<CampaignRow>(`SELECT * FROM voice_campaign WHERE id=$1`, [id]);
  return r.rows[0] ?? null;
}
async function mustGet(id: number): Promise<CampaignRow> {
  const c = await getCampaign(id);
  if (!c) throw new CampaignError(404, 'campaign not found');
  return c;
}

/** Edit the brief. Allowed while draft, and (name/payload/schedule/concurrency) while running or paused —
 *  members not yet fed pick up the new brief. Finished campaigns are read-only. */
export async function updateCampaign(id: number, input: { name?: unknown; flow?: unknown; payload?: unknown; scheduled_for?: unknown; max_concurrent?: unknown; filter?: unknown }): Promise<CampaignRow> {
  const c = await mustGet(id);
  if (c.status === 'completed' || c.status === 'cancelled') throw new CampaignError(409, `campaign is ${c.status}`);
  const sets: string[] = []; const params: any[] = [id];
  const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (input.name !== undefined) { const n = briefText(input.name, 120); if (!n) throw new CampaignError(400, 'name is required'); set('name', n); }
  if (input.flow !== undefined) {
    if (!isCampaignFlow(input.flow)) throw new CampaignError(400, `flow must be one of ${CAMPAIGN_FLOWS.join(', ')}`);
    if (c.status !== 'draft' && input.flow !== c.flow) throw new CampaignError(409, 'flow cannot change after launch');
    set('flow', input.flow);
  }
  if (input.payload !== undefined) set('payload', JSON.stringify(normalisePayload(input.payload)));
  if (input.scheduled_for !== undefined) set('scheduled_for', parseWhen(input.scheduled_for));
  if (input.max_concurrent !== undefined) set('max_concurrent', clampConcurrent(input.max_concurrent));
  if (input.filter !== undefined) set('filter', input.filter == null ? null : JSON.stringify(input.filter));
  if (!sets.length) return c;
  const r = await query<CampaignRow>(`UPDATE voice_campaign SET ${sets.join(', ')}, updated_at = now() WHERE id=$1 RETURNING *`, params);
  return r.rows[0];
}

export async function deleteCampaign(id: number): Promise<void> {
  const c = await mustGet(id);
  if (c.status !== 'draft') throw new CampaignError(409, 'only a draft can be deleted — cancel it instead');
  await query(`DELETE FROM voice_campaign WHERE id=$1`, [id]);
}

export interface CampaignSummary extends CampaignRow { counts: Counts }

export async function listCampaigns(limit = 100): Promise<CampaignSummary[]> {
  const r = await query<CampaignRow & { states: string[] | null }>(
    `SELECT k.*, s.states FROM voice_campaign k
       LEFT JOIN LATERAL (
         SELECT array_agg(st) AS states FROM (
           SELECT ${memberStateSql} AS st FROM voice_campaign_member m ${memberJoins} WHERE m.campaign_id = k.id
         ) x
       ) s ON true
      ORDER BY (k.status IN ('running','paused')) DESC, k.created_at DESC LIMIT $1`, [limit]);
  return r.rows.map(({ states, ...k }) => ({ ...k, counts: countStates(states ?? []) }));
}

export function countStates(states: string[]): Counts {
  const c = emptyCounts();
  for (const s of states) { if (s in c) (c as any)[s]++; c.total++; }
  return c;
}

export async function listMembers(campaignId: number): Promise<MemberView[]> {
  const r = await query<MemberView>(
    `SELECT m.*, ${memberStateSql} AS state,
            r.status AS req_status, r.status_detail AS req_detail, r.attempts, r.scheduled_for,
            c.id AS call_id, c.outcome, c.duration_seconds, c.summary, c.recording_url, c.started_at, c.ended_at,
            z.zone, z.licences
       FROM voice_campaign_member m ${memberJoins}
       LEFT JOIN LATERAL (
         SELECT (array_agg(rg.name ORDER BY p.quantity DESC NULLS LAST))[1] AS zone, count(*)::int AS licences
           FROM waterfind_user wu JOIN property p ON p.registry_user = wu.registry_user LEFT JOIN region rg ON rg.id = p.region
          WHERE wu.id = m.client_uid AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE AND p.sub_type = 'REG'
       ) z ON true
      WHERE m.campaign_id = $1 ORDER BY m.id`, [campaignId]);
  return r.rows;
}

export async function campaignDetail(id: number): Promise<CampaignSummary & { members: MemberView[]; opening: string }> {
  const c = await mustGet(id);
  const members = await listMembers(id);
  return { ...c, counts: countStates(members.map((m) => m.state)), members, opening: openingFor(c.flow) };
}

/** What the assistant says first on this flow's calls (fixed disclosure + purpose; no account data). */
export function openingFor(flow: string): string {
  return outboundOpening({ requestId: null, flow, payload: {}, clientUid: null, clientFirstName: null } as any);
}

// ---- eligibility -------------------------------------------------------------------------------

export interface Eligibility {
  uid: number; name: string; company: string | null; phone: string | null; ok: boolean; reasons: string[];
}

/** Why a client would NOT be called. The dialer re-checks suppression/flag/cap at dial time; this is the
 *  page's honest preview (and the feeder's pre-check) so a list shows what will actually be called. */
export async function checkEligibility(uids: number[]): Promise<Map<number, Eligibility>> {
  const out = new Map<number, Eligibility>();
  if (!uids.length) return out;
  const r = await query(
    `SELECT wu.id, ${displayNameSql} AS name, NULLIF(trim(wu.company_name), '') AS company,
            wu.company_mobile, wu.businessphone, wu.homephone, wu.banned,
            COALESCE(wu.ai_advisor, true) AS advisor_on, COALESCE(ru.campaign_optin, true) AS campaign_optin,
            wut.type_number
       FROM waterfind_user wu
       LEFT JOIN registry_user ru ON ru.id = wu.registry_user
       LEFT JOIN waterfind_user_type wut ON wut.id = wu.usertype
      WHERE wu.id = ANY($1::bigint[])`, [uids]);
  const phones = r.rows.map((w: any) => toE164(w.company_mobile) ?? toE164(w.businessphone) ?? toE164(w.homephone) ?? null);
  const digits = phones.filter(Boolean).map((p) => normalizeDigits(p));
  const sup = digits.length ? (await query(`SELECT phone_digits, reason FROM voice_suppression WHERE phone_digits = ANY($1::text[])`, [digits])).rows : [];
  const supMap = new Map<string, string>(sup.map((s: any) => [s.phone_digits, s.reason]));
  r.rows.forEach((w: any, i: number) => {
    const reasons: string[] = [];
    const phone = phones[i];
    if (w.type_number != null && ![0, 5, 6].includes(Number(w.type_number))) reasons.push('not a client account');
    if (w.banned === true) reasons.push('account banned');
    if (!phone) reasons.push('no phone number on file');
    else if (supMap.has(normalizeDigits(phone))) reasons.push(`number suppressed (${supMap.get(normalizeDigits(phone))})`);
    if (w.advisor_on !== true) reasons.push('AI advisor switched off for this client');
    if (w.campaign_optin !== true) reasons.push('opted out of campaigns in the CRM');
    out.set(Number(w.id), { uid: Number(w.id), name: w.name, company: w.company, phone, ok: reasons.length === 0, reasons });
  });
  return out;
}

// ---- members -----------------------------------------------------------------------------------

/** Add clients to the list. Ineligible ones are added too, marked skipped with the reason — the list
 *  shows what was asked for and why some of it will not be called. Unknown ids are reported back. */
export async function addMembers(campaignId: number, input: { client_uids?: unknown; crns?: unknown }, staffUid: number): Promise<{ added: number; already: number; unknown: Array<string | number>; skipped: number }> {
  const c = await mustGet(campaignId);
  if (c.status === 'completed' || c.status === 'cancelled') throw new CampaignError(409, `campaign is ${c.status}`);
  const uids = new Set<number>();
  const unknown: Array<string | number> = [];
  for (const v of asArray(input.client_uids)) { const n = Number(v); if (Number.isInteger(n) && n > 0) uids.add(n); else unknown.push(String(v)); }
  const crns = asArray(input.crns).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
  if (crns.length) {
    // The CRM's client reference number lives on waterfind_user.crn (registry_user.crn is unused).
    const r = await query(`SELECT wu.crn, min(wu.id) AS uid FROM waterfind_user wu WHERE wu.crn = ANY($1::bigint[]) GROUP BY wu.crn`, [crns]);
    const found = new Map<number, number>(r.rows.map((x: any) => [Number(x.crn), Number(x.uid)]));
    for (const crn of crns) { const uid = found.get(crn); if (uid) uids.add(uid); else unknown.push(`CRN ${crn}`); }
  }
  if (uids.size > 2000) throw new CampaignError(400, 'a campaign list is capped at 2,000 clients');
  const elig = await checkEligibility([...uids]);
  for (const uid of uids) if (!elig.has(uid)) unknown.push(uid);
  let added = 0, already = 0, skipped = 0;
  for (const e of elig.values()) {
    const r = await query(
      `INSERT INTO voice_campaign_member (campaign_id, client_uid, client_name, company, to_number, status, skip_reason, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (campaign_id, client_uid) DO NOTHING RETURNING id`,
      [campaignId, e.uid, e.name, e.company, e.phone, e.ok ? 'pending' : 'skipped', e.ok ? null : e.reasons.join('; '), staffUid]);
    if (r.rows[0]) { added++; if (!e.ok) skipped++; } else already++;
  }
  await query(`UPDATE voice_campaign SET updated_at = now() WHERE id=$1`, [campaignId]);
  return { added, already, unknown, skipped };
}
function asArray(v: unknown): unknown[] { return Array.isArray(v) ? v : v == null || v === '' ? [] : [v]; }

/** Remove a member. Only ones not yet fed (pending/skipped) — a member whose call is queued or done is history. */
export async function removeMember(campaignId: number, clientUid: number): Promise<boolean> {
  const c = await mustGet(campaignId);
  if (c.status === 'completed' || c.status === 'cancelled') throw new CampaignError(409, `campaign is ${c.status}`);
  const r = await query(`DELETE FROM voice_campaign_member WHERE campaign_id=$1 AND client_uid=$2 AND status IN ('pending','skipped') RETURNING id`, [campaignId, clientUid]);
  if (!r.rows[0]) {
    const m = await query(`SELECT status FROM voice_campaign_member WHERE campaign_id=$1 AND client_uid=$2`, [campaignId, clientUid]);
    if (m.rows[0]) throw new CampaignError(409, 'this client has already been called or is queued');
    return false;
  }
  return true;
}

/** Re-run eligibility on every pending/skipped member (phones and flags change; suppressions get added). */
export async function recheckMembers(campaignId: number): Promise<{ eligible: number; skipped: number }> {
  const rows = (await query<MemberRow>(`SELECT * FROM voice_campaign_member WHERE campaign_id=$1 AND status IN ('pending','skipped')`, [campaignId])).rows;
  const elig = await checkEligibility(rows.map((m) => m.client_uid));
  let eligible = 0, skipped = 0;
  for (const m of rows) {
    const e = elig.get(m.client_uid);
    const ok = !!e?.ok;
    await query(`UPDATE voice_campaign_member SET status=$3, skip_reason=$4, to_number=$5, client_name=COALESCE($6, client_name), updated_at=now() WHERE id=$1 AND campaign_id=$2`,
      [m.id, campaignId, ok ? 'pending' : 'skipped', ok ? null : (e ? e.reasons.join('; ') : 'client no longer exists'), e?.phone ?? m.to_number, e?.name ?? null]);
    if (ok) eligible++; else skipped++;
  }
  return { eligible, skipped };
}

// ---- lifecycle ---------------------------------------------------------------------------------

export async function launchCampaign(id: number, staffUid: number): Promise<CampaignRow> {
  const c = await mustGet(id);
  if (c.status !== 'draft') throw new CampaignError(409, `campaign is ${c.status}`);
  const { eligible } = await recheckMembers(id);
  if (!eligible) throw new CampaignError(400, 'no eligible clients on the list');
  const r = await query<CampaignRow>(`UPDATE voice_campaign SET status='running', launched_at=now(), launched_by=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, staffUid]);
  return r.rows[0];
}

export async function pauseCampaign(id: number): Promise<CampaignRow> {
  const c = await mustGet(id);
  if (c.status !== 'running') throw new CampaignError(409, `campaign is ${c.status}`);
  const r = await query<CampaignRow>(`UPDATE voice_campaign SET status='paused', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
  await withdrawQueued(id, 'campaign paused');
  return r.rows[0];
}

export async function resumeCampaign(id: number): Promise<CampaignRow> {
  const c = await mustGet(id);
  if (c.status !== 'paused') throw new CampaignError(409, `campaign is ${c.status}`);
  const r = await query<CampaignRow>(`UPDATE voice_campaign SET status='running', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
  return r.rows[0];
}

export async function cancelCampaign(id: number): Promise<CampaignRow> {
  const c = await mustGet(id);
  if (c.status === 'completed' || c.status === 'cancelled') throw new CampaignError(409, `campaign is ${c.status}`);
  await withdrawQueued(id, 'campaign cancelled');
  await query(`UPDATE voice_campaign_member SET status='cancelled', updated_at=now() WHERE campaign_id=$1 AND status='pending'`, [id]);
  const r = await query<CampaignRow>(`UPDATE voice_campaign SET status='cancelled', finished_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [id]);
  return r.rows[0];
}

/** A copy of the brief and the list as a new draft (the members are re-checked when it launches). */
export async function duplicateCampaign(id: number, staff: { uid: number; name: string }): Promise<CampaignRow> {
  const c = await mustGet(id);
  const n = await createCampaign({ name: `${c.name} (copy)`, flow: c.flow, payload: c.payload, filter: c.filter, max_concurrent: c.max_concurrent }, staff);
  await query(
    `INSERT INTO voice_campaign_member (campaign_id, client_uid, client_name, company, to_number, status, added_by)
     SELECT $1, client_uid, client_name, company, to_number, 'pending', $3 FROM voice_campaign_member WHERE campaign_id=$2 ORDER BY id`, [n.id, id, staff.uid]);
  return n;
}

/** Cancel this campaign's requests that are still only queued (nothing has been dialed for them) and put
 *  their members back to pending so a resume re-feeds them. Dialing calls are left to finish. */
async function withdrawQueued(campaignId: number, why: string): Promise<number> {
  const rows = (await query<{ id: number; request_id: number }>(
    `SELECT m.id, r.id AS request_id FROM voice_campaign_member m JOIN voice_outbound_request r ON r.id = m.outbound_request_id
      WHERE m.campaign_id=$1 AND m.status='queued' AND r.status='queued'`, [campaignId])).rows;
  for (const row of rows) {
    // Conditional flip: if the dialer claimed it between the SELECT and now, leave it alone.
    const u = await query(`UPDATE voice_outbound_request SET status='cancelled', status_detail=$2, updated_at=now() WHERE id=$1 AND status='queued'`, [row.request_id, why]);
    if (u.rowCount) await query(`UPDATE voice_campaign_member SET status='pending', outbound_request_id=NULL, updated_at=now() WHERE id=$1`, [row.id]);
  }
  return rows.length;
}

// ---- the feeder --------------------------------------------------------------------------------

export interface FeedResult { campaign_id: number; fed: number; skipped: number; inflight: number; completed: boolean; waiting?: string }

/** Requests of this campaign that are queued or dialing (plus members mid-claim with no request yet). */
export async function inflightCount(campaignId: number): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM voice_campaign_member m LEFT JOIN voice_outbound_request r ON r.id = m.outbound_request_id
      WHERE m.campaign_id=$1 AND m.status='queued' AND (r.id IS NULL OR r.status IN ('queued','dialing'))`, [campaignId]);
  return r.rows[0]?.n ?? 0;
}

/** One pass over every running/paused campaign. Pure bookkeeping + requestOutboundCall (no dial). */
export async function campaignTick(now = new Date()): Promise<FeedResult[]> {
  const out: FeedResult[] = [];
  // A member claimed but never given a request (process died mid-feed) goes back to pending after 5 min.
  await query(`UPDATE voice_campaign_member SET status='pending', updated_at=now()
                WHERE status='queued' AND outbound_request_id IS NULL AND updated_at < now() - interval '5 minutes'`);
  const paused = (await query<CampaignRow>(`SELECT * FROM voice_campaign WHERE status='paused'`)).rows;
  for (const c of paused) {
    // busy/no-answer retries re-queue requests behind our back; while paused they are withdrawn again.
    await withdrawQueued(c.id, 'campaign paused');
  }
  const running = (await query<CampaignRow>(`SELECT * FROM voice_campaign WHERE status='running' ORDER BY id`)).rows;
  for (const c of running) {
    try { out.push(await feedCampaign(c, now)); }
    catch (e: any) { console.error(`[voice] campaign ${c.id} feed failed:`, e?.message ?? e); }
  }
  return out;
}

export async function feedCampaign(c: CampaignRow, now = new Date()): Promise<FeedResult> {
  const res: FeedResult = { campaign_id: c.id, fed: 0, skipped: 0, inflight: await inflightCount(c.id), completed: false };
  const pendingLeft = async () => (await query<{ n: number }>(`SELECT count(*)::int AS n FROM voice_campaign_member WHERE campaign_id=$1 AND status='pending'`, [c.id])).rows[0].n;
  if (c.scheduled_for && new Date(c.scheduled_for).getTime() > now.getTime()) { res.waiting = `scheduled for ${new Date(c.scheduled_for).toISOString()}`; return res; }
  if (!withinHours(now)) { res.waiting = `outside calling hours until ${nextCallingWindow(now).toISOString()}`; return res; }
  const room = Math.max(0, c.max_concurrent - res.inflight);
  if (room > 0) {
    const claimed = (await query<MemberRow>(
      `UPDATE voice_campaign_member SET status='queued', feed_count = feed_count + 1, updated_at=now()
        WHERE id IN (SELECT id FROM voice_campaign_member WHERE campaign_id=$1 AND status='pending' ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [c.id, room])).rows;
    if (claimed.length) {
      const elig = await checkEligibility(claimed.map((m) => m.client_uid));
      for (const m of claimed) {
        const e = elig.get(m.client_uid);
        if (!e || !e.ok) {
          await query(`UPDATE voice_campaign_member SET status='skipped', skip_reason=$2, updated_at=now() WHERE id=$1`, [m.id, e ? e.reasons.join('; ') : 'client no longer exists']);
          res.skipped++;
          continue;
        }
        try {
          const { request } = await requestOutboundCall({
            flow: c.flow, client_uid: m.client_uid, payload: c.payload, idempotency_key: `campaign:${c.id}:${m.id}:${m.feed_count}`,
            source: `campaign:${c.id}`, source_ref: null, consent_basis: 'existing_client_relationship',
          });
          await query(`UPDATE voice_campaign_member SET outbound_request_id=$2, to_number=$3, updated_at=now() WHERE id=$1`, [m.id, request.id, request.to_number]);
          res.fed++; res.inflight++;
        } catch (err: any) {
          if (err instanceof OutboundError) {
            await query(`UPDATE voice_campaign_member SET status='skipped', skip_reason=$2, updated_at=now() WHERE id=$1`, [m.id, err.message]);
            res.skipped++;
          } else if (m.feed_count >= 5) {
            await query(`UPDATE voice_campaign_member SET status='skipped', skip_reason=$2, updated_at=now() WHERE id=$1`, [m.id, `could not queue: ${String(err?.message ?? err).slice(0, 200)}`]);
            res.skipped++;
          } else {
            await query(`UPDATE voice_campaign_member SET status='pending', updated_at=now() WHERE id=$1`, [m.id]);
            throw err;
          }
        }
      }
    }
  }
  if (res.inflight === 0 && (await pendingLeft()) === 0) {
    await query(`UPDATE voice_campaign SET status='completed', finished_at=now(), updated_at=now() WHERE id=$1 AND status='running'`, [c.id]);
    res.completed = true;
  }
  return res;
}

let timer: NodeJS.Timeout | null = null;
export function startCampaignJobs(): void {
  stopCampaignJobs();
  timer = setInterval(() => { campaignTick().catch((e: any) => console.error('[voice] campaign tick failed:', e?.message ?? e)); }, voiceConfig.campaignPollMs);
  timer.unref?.();
}
export function stopCampaignJobs(): void { if (timer) clearInterval(timer); timer = null; }

// ---- list builder (client search) --------------------------------------------------------------

const displayNameSql = `COALESCE(NULLIF(trim(regexp_replace(COALESCE(wu.name,''), '\\s+', ' ', 'g')), ''), trim(COALESCE(wu.first_name,'') || ' ' || COALESCE(wu.last_name,'')))`;
/** The account's contact = its primary_contact_user (set on all but a handful of the 86k accounts; the
 *  correlated "earliest login" fallback cost a full scan per account and is not worth it). */
const primaryContactSql = `ru.primary_contact_user`;
const activeLicence = `p.registry_user = ru.id AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE AND p.sub_type = 'REG'`;

export interface ClientFilter { q?: string; state_id?: number; region_id?: number; broker_uid?: number; min_ml?: number; not_contacted_since?: string; limit?: number }
export interface ClientHit {
  uid: number; name: string; company: string | null; crn: number | null; account_id: number; broker: string | null; last_contacted: string | null;
  volume_ml: number | null; licences: number; zones: string[]; phone_tail: string | null; advisor_on: boolean; campaign_optin: boolean; suppressed: boolean;
}

export function parseClientFilter(qs: Record<string, unknown>): ClientFilter {
  const f: ClientFilter = {};
  const s = (k: string) => (typeof qs[k] === 'string' ? (qs[k] as string).trim() : '');
  const n = (k: string) => { const v = s(k); if (!v) return undefined; const x = Number(v); if (!Number.isFinite(x)) throw new CampaignError(400, `${k} must be a number`); return x; };
  if (s('q')) f.q = s('q').slice(0, 80);
  f.state_id = n('state_id'); f.region_id = n('region_id'); f.broker_uid = n('broker_uid'); f.min_ml = n('min_ml');
  if (s('not_contacted_since')) { const d = new Date(s('not_contacted_since')); if (Number.isNaN(d.getTime())) throw new CampaignError(400, 'not_contacted_since must be a date'); f.not_contacted_since = d.toISOString(); }
  f.limit = Math.min(Math.max(n('limit') ?? 300, 1), 1000);
  return f;
}

/** One account = one row (its primary contact). Requires at least one narrowing filter — the base is ~86k
 *  accounts. Index needs (db/campaigns.sql): property(registry_user); the CRM already has region(state),
 *  property(region), registry_user(primary_contact_user/_sales). */
export async function searchClients(f: ClientFilter): Promise<ClientHit[]> {
  if (!f.q && f.state_id == null && f.region_id == null && f.broker_uid == null && f.min_ml == null && !f.not_contacted_since) throw new CampaignError(400, 'add at least one filter');
  const params: any[] = []; const cond: string[] = [];
  const P = (v: any) => { params.push(v); return `$${params.length}`; };
  if (f.q) {
    const like = P(`%${f.q.replace(/[%_\\]/g, (ch) => '\\' + ch)}%`);
    const num = /^\d+$/.test(f.q) ? P(Number(f.q)) : null;
    cond.push(`(${displayNameSql} ILIKE ${like} OR wu.company_name ILIKE ${like} OR wu.email ILIKE ${like}${num ? ` OR wu.id = ${num} OR wu.crn = ${num}` : ''})`);
  }
  if (f.state_id != null) cond.push(`EXISTS (SELECT 1 FROM property p JOIN region r ON r.id = p.region WHERE ${activeLicence} AND r.state = ${P(f.state_id)})`);
  if (f.region_id != null) cond.push(`EXISTS (SELECT 1 FROM property p WHERE ${activeLicence} AND p.region = ${P(f.region_id)})`);
  if (f.broker_uid != null) { const b = P(f.broker_uid); cond.push(`(ru.primary_contact_sales = ${b} OR ru.secondary_contact_sales = ${b})`); }
  if (f.not_contacted_since) cond.push(`(ru.last_contacted IS NULL OR ru.last_contacted < ${P(f.not_contacted_since)})`);
  if (f.min_ml != null) cond.push(`lic.volume_ml >= ${P(f.min_ml)}`);
  const limit = P(f.limit ?? 300);
  const r = await query(
    `SELECT wu.id AS uid, ${displayNameSql} AS name, NULLIF(trim(wu.company_name), '') AS company, wu.crn, ru.id AS account_id,
            b.name AS broker, ru.last_contacted, lic.volume_ml, COALESCE(lic.licences, 0)::int AS licences, COALESCE(lic.zones, '{}') AS zones,
            wu.company_mobile, wu.businessphone, wu.homephone,
            COALESCE(wu.ai_advisor, true) AS advisor_on, COALESCE(ru.campaign_optin, true) AS campaign_optin
       FROM registry_user ru
       JOIN waterfind_user wu ON wu.id = ${primaryContactSql}
       LEFT JOIN waterfind_user_type wut ON wut.id = wu.usertype
       LEFT JOIN waterfind_user b ON b.id = ru.primary_contact_sales
       LEFT JOIN LATERAL (
         SELECT round(sum(p.quantity)::numeric, 1) AS volume_ml, count(*) AS licences,
                (array_agg(DISTINCT r.name))[1:3] AS zones
           FROM property p LEFT JOIN region r ON r.id = p.region WHERE ${activeLicence}
       ) lic ON true
      WHERE ru.deleted IS NOT TRUE AND wu.banned IS NOT TRUE
        AND (wut.type_number IS NULL OR wut.type_number IN (0,5,6))
        AND (COALESCE(wu.company_mobile,'') <> '' OR COALESCE(wu.businessphone,'') <> '' OR COALESCE(wu.homephone,'') <> '')
        ${cond.map((c) => 'AND ' + c).join('\n        ')}
      ORDER BY lic.volume_ml DESC NULLS LAST, name LIMIT ${limit}`, params);
  const hits: ClientHit[] = r.rows.map((w: any) => {
    const phone = toE164(w.company_mobile) ?? toE164(w.businessphone) ?? toE164(w.homephone) ?? null;
    return {
      uid: Number(w.uid), name: w.name, company: w.company, crn: w.crn == null ? null : Number(w.crn), account_id: Number(w.account_id),
      broker: w.broker ? String(w.broker).replace(/\s+/g, ' ').trim() : null, last_contacted: w.last_contacted, volume_ml: w.volume_ml == null ? null : Number(w.volume_ml),
      licences: Number(w.licences), zones: (w.zones ?? []).filter(Boolean), phone_tail: phone ? '…' + normalizeDigits(phone).slice(-3) : null,
      advisor_on: w.advisor_on === true, campaign_optin: w.campaign_optin === true, suppressed: false, _phone: phone,
    } as ClientHit & { _phone: string | null };
  });
  const digits = hits.map((h: any) => h._phone ? normalizeDigits(h._phone) : '').filter(Boolean);
  if (digits.length) {
    const sup = new Set((await query(`SELECT phone_digits FROM voice_suppression WHERE phone_digits = ANY($1::text[])`, [digits])).rows.map((s: any) => s.phone_digits));
    for (const h of hits as any[]) h.suppressed = !!h._phone && sup.has(normalizeDigits(h._phone));
  }
  for (const h of hits as any[]) delete h._phone;
  return hits;
}

/** Dropdown data for the list builder + brief: states with active licences, brokers with assigned accounts, flows, callback numbers. */
export async function campaignOptions(): Promise<{
  flows: Array<{ id: CampaignFlow; label: string; opening: string }>;
  states: Array<{ id: number; name: string; licences: number }>;
  brokers: Array<{ uid: number; name: string; accounts: number }>;
  callback_numbers: string[]; calling_hours: string; timezone: string; max_concurrent_default: number;
}> {
  const [states, brokers] = await Promise.all([
    query(`SELECT s.id, s.name, count(p.id)::int AS licences
             FROM state s JOIN region r ON r.state = s.id JOIN property p ON p.region = r.id
            WHERE s.deleted IS NOT TRUE AND r.deleted IS NOT TRUE AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE AND p.sub_type = 'REG'
            GROUP BY s.id, s.name HAVING count(p.id) >= 5 ORDER BY s.name`),
    query(`SELECT b.id AS uid, trim(regexp_replace(COALESCE(b.name,''), '\\s+', ' ', 'g')) AS name, count(*)::int AS accounts
             FROM registry_user ru JOIN waterfind_user b ON b.id = ru.primary_contact_sales
            WHERE ru.deleted IS NOT TRUE GROUP BY b.id, b.name HAVING count(*) >= 5 ORDER BY count(*) DESC, b.name`),
  ]);
  const labels: Record<CampaignFlow, string> = { trade_opportunity: 'Trade opportunity', market_alert: 'Market alert', broker_followup: 'Broker follow-up' };
  const cb = [voiceConfig.fromNumber, voiceConfig.transferNumber, voiceConfig.companyPhoneSpoken, ...voiceConfig.callbackNumberAllowlist].filter(Boolean) as string[];
  const h = voiceConfig.callingHours;
  const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return {
    flows: CAMPAIGN_FLOWS.map((id) => ({ id, label: labels[id], opening: openingFor(id) })),
    states: states.rows.map((s: any) => ({ id: Number(s.id), name: String(s.name).trim(), licences: Number(s.licences) })),
    brokers: brokers.rows.map((b: any) => ({ uid: Number(b.uid), name: b.name, accounts: Number(b.accounts) })),
    callback_numbers: [...new Set(cb)], calling_hours: `${hh(h.start)}–${hh(h.end)}${voiceConfig.callingWeekdaysOnly ? ' weekdays' : ''}`, timezone: voiceConfig.timezone,
    max_concurrent_default: voiceConfig.campaignMaxConcurrent,
  };
}

/** Market zones of one state (for the region dropdown; loaded when a state is picked). */
export async function regionsOfState(stateId: number): Promise<Array<{ id: number; name: string; licences: number }>> {
  const r = await query(
    `SELECT r.id, r.name, count(p.id)::int AS licences FROM region r JOIN property p ON p.region = r.id
      WHERE r.state = $1 AND r.deleted IS NOT TRUE AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE AND p.sub_type = 'REG'
      GROUP BY r.id, r.name ORDER BY count(p.id) DESC, r.name`, [stateId]);
  return r.rows.map((x: any) => ({ id: Number(x.id), name: String(x.name).trim(), licences: Number(x.licences) }));
}

/** For tests/ops: every request row this campaign created. */
export async function campaignRequests(campaignId: number): Promise<store.OutboundRequestRow[]> {
  const r = await query<store.OutboundRequestRow>(`SELECT * FROM voice_outbound_request WHERE source = $1 ORDER BY id`, [`campaign:${campaignId}`]);
  return r.rows;
}
