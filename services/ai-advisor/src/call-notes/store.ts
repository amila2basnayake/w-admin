/**
 * Persistence for call notes + the CRM-side call listing. Every popup-facing query is pinned to
 * ONE client (the token-bound `client_uid` / their registry account) — a broker can only ever get
 * a draft for the client whose page they are on. The sidecar never writes to public.contact.
 */
import { query } from '../db';
import { callNotesConfig as C } from './config';
import type { Transcript } from './transcript';
import type { CallNoteDraft } from './summarize';

export type CallNoteStatus = 'queued' | 'fetching' | 'transcribing' | 'drafting' | 'ready' | 'failed';

export interface CallNoteRow {
  id: number;
  phonecall_id: string | null;
  source: 'pbx' | 'dictation' | 'upload';
  contact_id: number | null;
  client_uid: number;
  registry_user_id: number | null;
  staff_user_id: number;
  staff_name: string | null;
  status: CallNoteStatus;
  stage_detail: string | null;
  error: string | null;
  error_code: string | null;
  audio_seconds: number | null;
  audio_bytes: number | null;
  audio_channels: number | null;
  direction: string | null;
  call_started_at: Date | null;
  transcript: Transcript | null;
  summary: CallNoteDraft | null;
  models: { stt?: string[]; note?: string } | null;
  cost_usd: number | null;
  created_at: Date;
  updated_at: Date;
  ready_at: Date | null;
  /** The broker asked the rail to open the CRM comment box with this draft (a hand-off, not a save). */
  handed_off_at: Date | null;
  handed_off_by: number | null;
  handed_off_note: string | null;
  /** "Ask advisor" pasted the transcript into this assist conversation / user message. */
  ask_conversation_id: number | null;
  ask_message_id: number | null;
  ask_scrubbed_at: Date | null;
  /** Created by the pre-drafting worker (call-notes/auto.ts) rather than on demand by the popup. */
  auto: boolean;
  draft_attempts: number;
}

/** The client's registry account id (public.contact rows hang off registry_user, not the uid). */
export async function registryUserFor(clientUid: number): Promise<number | null> {
  const r = await query(`SELECT registry_user FROM public.waterfind_user WHERE id = $1`, [clientUid]);
  const v = r.rows[0]?.registry_user;
  return v == null ? null : Number(v);
}

/**
 * Visibility scope for note rows. A CRM account (registry_user) can have several logins
 * (waterfind_user rows), and the client page can be opened on any of them; call notes belong to
 * the ACCOUNT like the CRM's own comments do, so a row is visible when it matches either the
 * token's client uid or that client's registry account.
 */
export interface NoteScope { clientUid: number; registryUserId: number | null; }
export async function scopeFor(clientUid: number): Promise<NoteScope> {
  return { clientUid, registryUserId: await registryUserFor(clientUid) };
}
const SCOPE_SQL = `(client_uid = $1 OR (registry_user_id IS NOT NULL AND registry_user_id = $2))`;
const scopeParams = (s: NoteScope) => [s.clientUid, s.registryUserId ?? -1];

// ---- CRM call listing ---------------------------------------------------------------------

export interface CrmCall {
  contact_id: number;
  phonecall_id: string | null;
  /** Call start as the CRM wrote it: a NAIVE local timestamp string (no zone) — the browser
   *  displays it as wall-clock time in the CRM's own zone, whatever zone the sidecar runs in. */
  at: string;
  /** Seconds since the call ended (start + duration), computed in SQL; null while in progress. */
  ended_ago_seconds: number | null;
  duration_seconds: number | null;
  incoming: boolean | null;
  phone_number: string | null;
  staff_user_id: number | null;
  staff_name: string | null;
  client_service: boolean | null;
  note_prefix: string | null;    // the CRM's own auto text ("Outgoing Phone Call / Service (…)")
  mine: boolean;
  /** Recording old enough that the PBX/CRM will no longer hand it out. */
  expired: boolean;
  /** No duration yet and recent -> probably still on the line. */
  in_progress: boolean;
}

/**
 * Auto-logged phone calls on this client's account in the window, newest first, plus the
 * one-line "manual note already exists" hint (a human comment by the same staff member within
 * 2 h after the call — the broker has already written it up).
 */
export async function listCrmCalls(clientUid: number, staffUid: number, hours: number, opts: { now?: Date } = {}): Promise<{ registryUserId: number | null; calls: (CrmCall & { has_manual_note: boolean })[] }> {
  const registryUserId = await registryUserFor(clientUid);
  if (registryUserId == null) return { registryUserId: null, calls: [] };
  const h = Math.max(1, Math.min(C.callsMaxHours, Math.floor(hours) || C.callsDefaultHours));
  // contact.date_edited is a NAIVE timestamp in the CRM JVM's zone (C.crmTz). `AT TIME ZONE $3`
  // turns it into an instant for the age; the window bound is converted the other way
  // (timestamptz -> naive in that zone) so the bare column stays index-friendly. $4 = "now"
  // (tests pin it; production passes null -> now()).
  const r = await query(
    `SELECT c.id AS contact_id, c.phonecall_id, c.call_duration_seconds, c.incoming_phone_call AS incoming,
            to_char(c.date_edited, 'YYYY-MM-DD"T"HH24:MI:SS') AS at_local,
            extract(epoch from (coalesce($4::timestamptz, now()) - (c.date_edited AT TIME ZONE $3)))::bigint AS age_seconds,
            c.phone_number, c.added_by AS staff_user_id, c.client_service, c.note,
            trim(coalesce(wu.first_name, '') || ' ' || coalesce(wu.last_name, '')) AS staff_name,
            EXISTS (
              SELECT 1 FROM public.contact m
               WHERE m.registry_user = c.registry_user AND m.subclass = 'C'
                 AND coalesce(m.phone_record, false) = false
                 AND m.added_by = c.added_by
                 AND m.date_edited > c.date_edited
                 AND m.date_edited < c.date_edited + interval '2 hours'
                 AND m.note IS NOT NULL AND length(m.note) >= 20
                 AND m.note NOT ILIKE 'SMS %' AND m.note NOT ILIKE 'Contract (%' AND m.note NOT ILIKE 'AI Advisor:%'
            ) AS has_manual_note
       FROM public.contact c
       LEFT JOIN public.waterfind_user wu ON wu.id = c.added_by
      WHERE c.registry_user = $1 AND coalesce(c.phone_record, false) = true
        AND c.date_edited > (coalesce($4::timestamptz, now()) - ($2::text || ' hours')::interval) AT TIME ZONE $3
      ORDER BY c.date_edited DESC
      LIMIT 40`,
    [registryUserId, String(h), C.crmTz, opts.now ?? null],
  );
  const calls = r.rows.map((row: any) => {
    // Ages are computed in SQL against the CRM's zone (above): the sidecar host's zone and the PG
    // session's zone never enter into it, and the browser gets seconds, not instants.
    const ageMs = Number(row.age_seconds) * 1000;
    const dur = row.call_duration_seconds == null ? null : Number(row.call_duration_seconds);
    return {
      contact_id: Number(row.contact_id),
      phonecall_id: row.phonecall_id ? String(row.phonecall_id) : null,
      at: String(row.at_local),
      ended_ago_seconds: dur == null ? null : Math.max(0, Math.round(ageMs / 1000) - dur),
      duration_seconds: dur,
      incoming: row.incoming == null ? null : !!row.incoming,
      phone_number: row.phone_number ? String(row.phone_number) : null,
      staff_user_id: row.staff_user_id == null ? null : Number(row.staff_user_id),
      staff_name: row.staff_name ? String(row.staff_name) : null,
      client_service: row.client_service == null ? null : !!row.client_service,
      note_prefix: row.note ? String(row.note).replace(/\s+/g, ' ').trim().slice(0, 120) : null,
      mine: Number(row.staff_user_id) === staffUid,
      expired: ageMs > C.recordingMaxAgeDays * 86400_000,
      in_progress: dur == null && ageMs < 2 * 3600_000,
      has_manual_note: !!row.has_manual_note,
    };
  });
  return { registryUserId, calls };
}

export interface CrmCallLookup {
  contact_id: number;
  /** Call start as an instant (date_edited read in the CRM's zone). */
  started_at: Date;
  /** Seconds since the call STARTED, per the CRM's zone; null-safe. */
  age_seconds: number;
  duration_seconds: number | null;
  incoming: boolean | null;
}

/**
 * One auto-logged call by PBX id, pinned to the client's account — the id alone is never enough.
 * The age and the start instant come from SQL through the CRM zone (see listCrmCalls).
 */
export async function lookupCrmCall(phonecallId: string, registryUserId: number, opts: { now?: Date } = {}): Promise<CrmCallLookup | null> {
  const r = await query(
    `SELECT id, call_duration_seconds, incoming_phone_call,
            (date_edited AT TIME ZONE $3) AS started_at,
            extract(epoch from (coalesce($4::timestamptz, now()) - (date_edited AT TIME ZONE $3)))::bigint AS age_seconds
       FROM public.contact
      WHERE phonecall_id = $1 AND registry_user = $2 AND coalesce(phone_record, false) = true
      ORDER BY date_edited DESC LIMIT 1`, [phonecallId, registryUserId, C.crmTz, opts.now ?? null]);
  const c = r.rows[0];
  if (!c) return null;
  return {
    contact_id: Number(c.id),
    started_at: c.started_at instanceof Date ? c.started_at : new Date(c.started_at),
    age_seconds: Number(c.age_seconds),
    duration_seconds: c.call_duration_seconds == null ? null : Number(c.call_duration_seconds),
    incoming: c.incoming_phone_call == null ? null : !!c.incoming_phone_call,
  };
}

// ---- automatic worker (call-notes/auto.ts) ------------------------------------------------

export interface AutoCandidate {
  contact_id: number;
  phonecall_id: string;
  registry_user_id: number;
  client_uid: number;
  client_name: string;
  staff_user_id: number;
  staff_name: string | null;
  direction: 'incoming' | 'outgoing' | null;
  started_at: Date;
  duration_seconds: number;
  /** Seconds since the call ended — fresh calls get the PBX fetch retry. */
  ended_ago_seconds: number;
}

/**
 * Ended, logged, recorded calls across ALL clients that have no note row yet and no manual
 * write-up. The client uid is the account's primary contact login (registry_user.primary_contact_user
 * — the same user the CRM client page acts as); accounts without one are skipped. Window/ages go
 * through the CRM's zone exactly like listCrmCalls.
 */
export async function listAutoCandidates(opts: { now?: Date; limit?: number } = {}): Promise<AutoCandidate[]> {
  const r = await query(
    `SELECT c.id AS contact_id, c.phonecall_id, c.registry_user AS registry_user_id,
            c.call_duration_seconds, c.incoming_phone_call AS incoming, c.added_by AS staff_user_id,
            (c.date_edited AT TIME ZONE $1) AS started_at,
            extract(epoch from (coalesce($2::timestamptz, now()) - (c.date_edited AT TIME ZONE $1)))::bigint AS age_seconds,
            trim(coalesce(wu.first_name, '') || ' ' || coalesce(wu.last_name, '')) AS staff_name,
            cu.id AS client_uid,
            trim(coalesce(cu.first_name, '') || ' ' || coalesce(cu.last_name, '')) AS client_name
       FROM public.contact c
       JOIN public.registry_user ru ON ru.id = c.registry_user
       JOIN public.waterfind_user cu ON cu.id = ru.primary_contact_user
       LEFT JOIN public.waterfind_user wu ON wu.id = c.added_by
      WHERE coalesce(c.phone_record, false) = true
        AND c.phonecall_id IS NOT NULL
        AND c.added_by IS NOT NULL
        AND c.call_duration_seconds IS NOT NULL
        AND c.call_duration_seconds >= $3
        AND c.date_edited > (coalesce($2::timestamptz, now()) - ($4::text || ' minutes')::interval) AT TIME ZONE $1
        AND NOT EXISTS (SELECT 1 FROM call_note n WHERE n.phonecall_id = c.phonecall_id)
        AND NOT EXISTS (
          SELECT 1 FROM public.contact m
           WHERE m.registry_user = c.registry_user AND m.subclass = 'C'
             AND coalesce(m.phone_record, false) = false
             AND m.added_by = c.added_by
             AND m.date_edited > c.date_edited
             AND m.date_edited < c.date_edited + interval '2 hours'
             AND m.note IS NOT NULL AND length(m.note) >= 20
             AND m.note NOT ILIKE 'SMS %' AND m.note NOT ILIKE 'Contract (%' AND m.note NOT ILIKE 'AI Advisor:%'
        )
      ORDER BY c.date_edited ASC
      LIMIT $5`,
    [C.crmTz, opts.now ?? null, C.autoMinCallSeconds, String(C.autoLookbackMinutes), opts.limit ?? 10]);
  return r.rows.map((row: any) => {
    const dur = Number(row.call_duration_seconds);
    return {
      contact_id: Number(row.contact_id),
      phonecall_id: String(row.phonecall_id),
      registry_user_id: Number(row.registry_user_id),
      client_uid: Number(row.client_uid),
      client_name: String(row.client_name || '').trim() || 'the client',
      staff_user_id: Number(row.staff_user_id),
      staff_name: row.staff_name ? String(row.staff_name) : null,
      direction: row.incoming == null ? null : (row.incoming ? 'incoming' : 'outgoing') as 'incoming' | 'outgoing',
      started_at: row.started_at instanceof Date ? row.started_at : new Date(row.started_at),
      duration_seconds: dur,
      ended_ago_seconds: Math.max(0, Number(row.age_seconds) - dur),
    };
  });
}

/** Failure codes that can never succeed on a re-run — everything else is worth retrying. */
const PERMANENT_DRAFT_FAILURES = ['recording_expired', 'recording_too_large', 'too_large', 'no_audio'];
export function isPermanentDraftFailure(code: string | null | undefined): boolean {
  return !!code && PERMANENT_DRAFT_FAILURES.includes(code);
}

/** An on-demand re-run (the popup asked again after a transient failure) counts against the same cap the worker uses. */
export async function countDraftAttempt(id: number): Promise<void> {
  await query(`UPDATE call_note SET draft_attempts = draft_attempts + 1, updated_at = now() WHERE id = $1`, [id]);
}

/**
 * Failed auto rows worth another go: transient failure code, under the attempt cap, not too old,
 * and quiet for the backoff window. The claim is atomic (status flips failed -> queued in the same
 * statement), so two sidecars on one DB can never both re-run the same row.
 */
export async function claimRetryableAutoFailures(opts: { maxAttempts: number; backoffMinutes: number; limit?: number } = { maxAttempts: 3, backoffMinutes: 5 }): Promise<CallNoteRow[]> {
  const r = await query<CallNoteRow>(
    `UPDATE call_note SET status = 'queued', stage_detail = NULL, error = NULL, error_code = NULL,
            summary = NULL, models = NULL, ready_at = NULL,
            draft_attempts = draft_attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM call_note
         WHERE auto = true AND status = 'failed' AND phonecall_id IS NOT NULL
           AND (error_code IS NULL OR error_code <> ALL($1::text[]))
           AND draft_attempts < $2
           AND created_at > now() - interval '24 hours'
           AND updated_at < now() - ($3::text || ' minutes')::interval
         ORDER BY created_at ASC LIMIT $4
      )
      RETURNING *`,
    [PERMANENT_DRAFT_FAILURES, opts.maxAttempts, String(opts.backoffMinutes), opts.limit ?? 5]);
  return r.rows;
}

// ---- Add Comment prefill (call-notes/routes.ts) ---------------------------------------------

export interface PrefillCall {
  contact_id: number;
  phonecall_id: string;
  started_at: Date;
  /** Seconds since the call ended, through the CRM's zone. */
  ended_ago_seconds: number;
  duration_seconds: number;
  direction: 'incoming' | 'outgoing' | null;
}

/**
 * The call the popup is being opened for: THIS staff member's most recent ended, recorded call on
 * the client's account that ended within `windowMinutes` and has no write-up yet (no human comment
 * by them since it). Either direction. Calls under the minimum length are ring-outs. Null = the
 * popup is for something else and must stay empty.
 */
export async function latestCallForPrefill(registryUserId: number, staffUid: number, windowMinutes: number, opts: { now?: Date } = {}): Promise<PrefillCall | null> {
  const r = await query(
    `SELECT c.id AS contact_id, c.phonecall_id, c.call_duration_seconds, c.incoming_phone_call AS incoming,
            (c.date_edited AT TIME ZONE $3) AS started_at,
            extract(epoch from (coalesce($4::timestamptz, now()) - (c.date_edited AT TIME ZONE $3)))::bigint AS age_seconds
       FROM public.contact c
      WHERE c.registry_user = $1 AND c.added_by = $2
        AND coalesce(c.phone_record, false) = true
        AND c.phonecall_id IS NOT NULL
        AND c.call_duration_seconds IS NOT NULL
        AND c.call_duration_seconds >= $5
        AND c.date_edited > (coalesce($4::timestamptz, now()) - ($6::text || ' minutes')::interval) AT TIME ZONE $3
        AND NOT EXISTS (
          SELECT 1 FROM public.contact m
           WHERE m.registry_user = c.registry_user AND m.subclass = 'C'
             AND coalesce(m.phone_record, false) = false
             AND m.added_by = c.added_by
             AND m.date_edited > c.date_edited
             AND m.note IS NOT NULL AND length(m.note) >= 20
             AND m.note NOT ILIKE 'SMS %' AND m.note NOT ILIKE 'Contract (%' AND m.note NOT ILIKE 'AI Advisor:%'
        )
      ORDER BY c.date_edited DESC
      LIMIT 1`,
    [registryUserId, staffUid, C.crmTz, opts.now ?? null, C.autoMinCallSeconds, String(Math.max(1, windowMinutes))]);
  const c = r.rows[0];
  if (!c) return null;
  const dur = Number(c.call_duration_seconds);
  const startedAt = c.started_at instanceof Date ? c.started_at : new Date(c.started_at);
  const endedAgo = Math.max(0, Number(c.age_seconds) - dur);
  if (endedAgo > windowMinutes * 60) return null;
  return {
    contact_id: Number(c.contact_id),
    phonecall_id: String(c.phonecall_id),
    started_at: startedAt,
    ended_ago_seconds: endedAgo,
    duration_seconds: dur,
    direction: c.incoming == null ? null : (c.incoming ? 'incoming' : 'outgoing'),
  };
}

// ---- call_note rows -----------------------------------------------------------------------

export async function getNoteById(id: number, scope: NoteScope): Promise<CallNoteRow | null> {
  const r = await query<CallNoteRow>(`SELECT * FROM call_note WHERE id = $3 AND ${SCOPE_SQL}`, [...scopeParams(scope), id]);
  return r.rows[0] ?? null;
}

export async function getNoteByCall(phonecallId: string, scope: NoteScope): Promise<CallNoteRow | null> {
  const r = await query<CallNoteRow>(`SELECT * FROM call_note WHERE phonecall_id = $3 AND ${SCOPE_SQL}`, [...scopeParams(scope), phonecallId]);
  return r.rows[0] ?? null;
}

/** Notes for the calls listed (any staff), keyed by phonecall_id — for the listing's status column. */
export async function notesForCalls(scope: NoteScope, phonecallIds: string[]): Promise<Map<string, CallNoteRow>> {
  const out = new Map<string, CallNoteRow>();
  if (!phonecallIds.length) return out;
  const r = await query<CallNoteRow>(
    `SELECT * FROM call_note WHERE ${SCOPE_SQL} AND phonecall_id = ANY($3::text[])`, [...scopeParams(scope), phonecallIds]);
  for (const row of r.rows) if (row.phonecall_id) out.set(row.phonecall_id, row);
  return out;
}

/** Recent non-PBX notes (dictation/upload) so the rail can show them after a page postback. */
export async function listRecentAdhocNotes(scope: NoteScope, hours: number): Promise<CallNoteRow[]> {
  const r = await query<CallNoteRow>(
    `SELECT * FROM call_note WHERE ${SCOPE_SQL} AND phonecall_id IS NULL
        AND created_at > now() - ($3::text || ' hours')::interval
      ORDER BY created_at DESC LIMIT 10`, [...scopeParams(scope), String(Math.max(1, hours))]);
  return r.rows;
}

export interface NewNote {
  phonecallId: string | null;
  source: 'pbx' | 'dictation' | 'upload';
  contactId: number | null;
  clientUid: number;
  registryUserId: number | null;
  staffUid: number;
  staffName: string | null;
  direction: 'incoming' | 'outgoing' | null;
  callStartedAt: Date | null;
  /** Created by the pre-drafting worker (as opposed to on demand when the popup asked). */
  auto?: boolean;
}

/**
 * Create the row in `queued`. For PBX calls the unique index makes this idempotent: a concurrent
 * second requester gets `created: false` and the existing row.
 */
export async function createNote(n: NewNote): Promise<{ row: CallNoteRow; created: boolean }> {
  if (n.phonecallId) {
    const ins = await query<CallNoteRow>(
      `INSERT INTO call_note (phonecall_id, source, contact_id, client_uid, registry_user_id, staff_user_id, staff_name, status, direction, call_started_at, auto)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $10)
       ON CONFLICT (phonecall_id) WHERE phonecall_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [n.phonecallId, n.source, n.contactId, n.clientUid, n.registryUserId, n.staffUid, n.staffName, n.direction, n.callStartedAt, !!n.auto]);
    if (ins.rows[0]) return { row: ins.rows[0], created: true };
    const existing = await getNoteByCall(n.phonecallId, { clientUid: n.clientUid, registryUserId: n.registryUserId });
    if (!existing) throw new Error('call_note insert conflict but row not visible for this client');
    return { row: existing, created: false };
  }
  const ins = await query<CallNoteRow>(
    `INSERT INTO call_note (phonecall_id, source, contact_id, client_uid, registry_user_id, staff_user_id, staff_name, status, direction, call_started_at, auto)
     VALUES (NULL, $1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9) RETURNING *`,
    [n.source, n.contactId, n.clientUid, n.registryUserId, n.staffUid, n.staffName, n.direction, n.callStartedAt, !!n.auto]);
  return { row: ins.rows[0], created: true };
}

/**
 * Reset a failed (or stale in-flight) row for another run, keeping its identity. `keepTranscript`
 * holds on to a transcript that was already paid for (the failure was downstream of STT — drafting,
 * grounding, a restart mid-draft): the re-run then goes straight to drafting. A forced re-draft
 * from the recording clears it.
 */
export async function resetNote(id: number, staffUid: number, staffName: string | null, opts: { keepTranscript?: boolean } = {}): Promise<void> {
  await query(
    `UPDATE call_note SET status = 'queued', stage_detail = NULL, error = NULL, error_code = NULL,
            transcript = CASE WHEN $4::boolean THEN transcript ELSE NULL END,
            summary = NULL, models = NULL, ready_at = NULL,
            staff_user_id = $2, staff_name = $3, updated_at = now()
      WHERE id = $1`, [id, staffUid, staffName, !!opts.keepTranscript]);
}

export async function setStage(id: number, status: CallNoteStatus, detail: string | null = null): Promise<void> {
  await query(`UPDATE call_note SET status = $2, stage_detail = $3, updated_at = now() WHERE id = $1`, [id, status, detail]);
}

export async function setAudioMeta(id: number, m: { seconds: number | null; bytes: number | null; channels: number | null }): Promise<void> {
  await query(`UPDATE call_note SET audio_seconds = $2, audio_bytes = $3, audio_channels = $4, updated_at = now() WHERE id = $1`,
    [id, m.seconds == null ? null : Math.round(m.seconds), m.bytes, m.channels]);
}

export async function setTranscript(id: number, t: Transcript): Promise<void> {
  await query(`UPDATE call_note SET transcript = $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(t)]);
}

export async function setReady(id: number, draft: CallNoteDraft, models: { stt: string[]; note: string }, costUsd?: number): Promise<void> {
  await query(
    `UPDATE call_note SET status = 'ready', stage_detail = NULL, summary = $2::jsonb, models = $3::jsonb, cost_usd = $4,
            ready_at = now(), updated_at = now(), error = NULL, error_code = NULL
      WHERE id = $1`, [id, JSON.stringify(draft), JSON.stringify(models), costUsd ?? null]);
}

export async function setFailed(id: number, message: string, code: string): Promise<void> {
  await query(`UPDATE call_note SET status = 'failed', stage_detail = NULL, error = $2, error_code = $3, updated_at = now() WHERE id = $1`,
    [id, message.slice(0, 500), code.slice(0, 40)]);
}

/**
 * The draft was placed into the CRM's Add Comment popup for this staff member. A hand-off is
 * recorded, not a save — the CRM never reports back. First hand-off wins (a reopened popup does
 * not overwrite who first saw it); the text recorded is what was filled in.
 */
export async function markHandedOff(id: number, scope: NoteScope, staffUid: number, note: string): Promise<boolean> {
  const r = await query(
    `UPDATE call_note SET handed_off_at = coalesce(handed_off_at, now()), handed_off_by = coalesce(handed_off_by, $4),
            handed_off_note = coalesce(handed_off_note, $5), updated_at = now()
      WHERE id = $3 AND ${SCOPE_SQL} RETURNING id`, [...scopeParams(scope), id, staffUid, note.slice(0, 4000)]);
  return r.rows.length > 0;
}

/**
 * "Ask advisor" dropped the transcript into an assist chat: remember which conversation/message so
 * the retention sweep can blank that copy too. Both ids are checked against THIS client: the
 * conversation must be an assist thread about the token's client and the message a user turn in it.
 */
export async function recordAsked(id: number, scope: NoteScope, conversationId: number, messageId: number | null): Promise<boolean> {
  const conv = await query(`SELECT id FROM conversation WHERE id = $1 AND assist_client_uid = $2`, [conversationId, scope.clientUid]);
  if (!conv.rows.length) return false;
  let msgId: number | null = null;
  if (messageId != null) {
    const m = await query(`SELECT id FROM message WHERE id = $1 AND conversation_id = $2 AND role = 'user'`, [messageId, conversationId]);
    if (m.rows.length) msgId = messageId;
  }
  const r = await query(
    `UPDATE call_note SET ask_conversation_id = $4, ask_message_id = coalesce($5, ask_message_id), ask_scrubbed_at = NULL, updated_at = now()
      WHERE id = $3 AND ${SCOPE_SQL} RETURNING id`, [...scopeParams(scope), id, conversationId, msgId]);
  return r.rows.length > 0;
}

/** Audit: a staff member read this note's transcript. */
export async function logTranscriptRead(noteId: number, staffUid: number, clientUid: number): Promise<void> {
  await query(`INSERT INTO call_note_access (call_note_id, staff_user_id, client_uid) VALUES ($1, $2, $3)`, [noteId, staffUid, clientUid]);
}

/** Rows stuck in flight past the stale window (process died mid-job). */
export function isStale(row: CallNoteRow): boolean {
  if (row.status === 'ready' || row.status === 'failed') return false;
  const upd = row.updated_at instanceof Date ? row.updated_at.getTime() : new Date(row.updated_at).getTime();
  return Date.now() - upd > C.staleJobMinutes * 60_000;
}

/**
 * Boot-time: jobs run in-process, so after a restart every non-terminal row is an orphan. Fail
 * them now with error_code 'restarted' (the next POST re-runs at once — reusing the transcript
 * when STT had finished) instead of leaving the rail spinning until the stale window passes.
 */
export async function failOrphanedJobs(): Promise<number> {
  const r = await query(
    `UPDATE call_note SET status = 'failed', stage_detail = NULL, error_code = 'restarted',
            error = 'The service restarted while this note was being drafted. Try again.', updated_at = now()
      WHERE status IN ('queued', 'fetching', 'transcribing', 'drafting')`);
  return r.rowCount ?? 0;
}

/** Rolling-24 h drafting spend (what the model reported per ready note). */
export async function spendLast24h(): Promise<number> {
  const r = await query(`SELECT coalesce(sum(cost_usd), 0)::float8 AS usd FROM call_note WHERE ready_at > now() - interval '24 hours'`);
  return Number(r.rows[0]?.usd ?? 0);
}

const SCRUBBED_MESSAGE = '[Call transcript removed under the retention policy.]';

/**
 * Retention sweep: blank the content, keep the audit row. The copy "Ask advisor" pasted into a chat
 * (ask_message_id) is blanked in the same pass — ONLY that user message, matched by id AND
 * conversation AND role, never the advisor's replies or anything else in the thread.
 */
export async function sweepRetention(): Promise<number> {
  if (!(C.retentionDays > 0)) return 0;
  const cutoff = `now() - ($1::text || ' days')::interval`;
  const asked = await query<{ id: number; ask_conversation_id: number; ask_message_id: number }>(
    `SELECT id, ask_conversation_id, ask_message_id FROM call_note
      WHERE created_at < ${cutoff} AND ask_message_id IS NOT NULL AND ask_scrubbed_at IS NULL`, [String(C.retentionDays)]);
  for (const row of asked.rows) {
    await query(`UPDATE message SET content = $3 WHERE id = $1 AND conversation_id = $2 AND role = 'user'`,
      [row.ask_message_id, row.ask_conversation_id, SCRUBBED_MESSAGE]);
    await query(`UPDATE call_note SET ask_scrubbed_at = now() WHERE id = $1`, [row.id]);
  }
  const r = await query(
    `UPDATE call_note SET transcript = NULL, summary = NULL, handed_off_note = NULL, applied_note = NULL, updated_at = now()
      WHERE created_at < ${cutoff} AND (transcript IS NOT NULL OR summary IS NOT NULL OR handed_off_note IS NOT NULL)`,
    [String(C.retentionDays)]);
  return (r.rowCount ?? 0) + asked.rows.length;
}
