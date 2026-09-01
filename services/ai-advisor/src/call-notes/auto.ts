/**
 * Pre-drafting worker: when a broker's logged desk-phone call ends, draft the file note from the
 * recording in the background (fetch -> transcribe -> ground -> draft, jobs.ts) so it is READY by
 * the time the broker opens the CRM's Add Comment popup — which asks the sidecar for it
 * (routes.ts) and fills its textarea. Nothing here writes to the CRM: the broker reviews, edits
 * and saves the comment in the CRM's own form, exactly as they do today.
 *
 * Runs only when call notes are enabled AND a PBX source is configured (setting pbxSource is the
 * opt-in to contacting the phone portal and paying STT per logged call) AND
 * AIADVISOR_CALL_NOTES_AUTO is not 0. Spend is bounded by the rolling-24 h drafting budget
 * (AIADVISOR_CALL_NOTE_DAILY_BUDGET_USD), a per-tick candidate cap, a small in-flight concurrency
 * cap, and the lookback window (a long outage is not backfilled — a missed call is still drafted
 * on demand, with a short wait in the popup, when the broker opens it).
 */
import { callNotesConfig as C, callNotesEnabled } from './config';
import { runNote } from './jobs';
import {
  listAutoCandidates, createNote, spendLast24h, claimRetryableAutoFailures, type CallNoteRow,
} from './store';
import { query } from '../db';

export function autoCallNotesEnabled(): boolean {
  return callNotesEnabled() && C.pbxSource !== 'off' && C.autoEnabled;
}

const runningCalls = new Set<string>();   // phonecall_ids with a job in flight in THIS process
let ticking = false;
let budgetLoggedAt = 0;

async function overBudget(): Promise<boolean> {
  if (!(C.dailyBudgetUsd > 0)) return false;
  const usd = await spendLast24h();
  if (usd < C.dailyBudgetUsd) return false;
  if (Date.now() - budgetLoggedAt > 3600_000) {
    budgetLoggedAt = Date.now();
    console.warn(`[call-notes] auto: daily drafting budget reached ($${usd.toFixed(2)} of $${C.dailyBudgetUsd.toFixed(0)}) — pausing until it rolls off`);
  }
  return true;
}

function startDraft(row: CallNoteRow, clientName: string, fresh: boolean): void {
  runningCalls.add(row.phonecall_id!);
  void runNote({
    row, clientName, staffName: row.staff_name || 'the broker', fresh,
  }).finally(() => { runningCalls.delete(row.phonecall_id!); });
}

async function draftNewCalls(now?: Date): Promise<void> {
  if (runningCalls.size >= C.autoConcurrency) return;
  if (await overBudget()) return;
  const candidates = await listAutoCandidates({ now });
  for (const c of candidates) {
    if (runningCalls.size >= C.autoConcurrency) break;
    if (runningCalls.has(c.phonecall_id)) continue;
    const { row, created } = await createNote({
      phonecallId: c.phonecall_id, source: 'pbx', contactId: c.contact_id,
      clientUid: c.client_uid, registryUserId: c.registry_user_id,
      staffUid: c.staff_user_id, staffName: c.staff_name,
      direction: c.direction, callStartedAt: c.started_at, auto: true,
    });
    if (!created) continue;   // another process (or the popup) got there first
    console.log(`[call-notes] auto: drafting call ${c.phonecall_id} (${c.staff_name ?? c.staff_user_id} x ${c.client_name}, ${c.duration_seconds}s)`);
    startDraft(row, c.client_name, c.ended_ago_seconds < 10 * 60);
  }
}

/** Transiently-failed auto notes (PBX lag/outage, STT/model hiccup): re-draft with backoff up to
 *  the cap. The claim is atomic in SQL, so a second sidecar on the same DB never doubles up. */
async function retryFailedDrafts(): Promise<void> {
  if (runningCalls.size >= C.autoConcurrency) return;
  if (await overBudget()) return;
  const rows = await claimRetryableAutoFailures({ maxAttempts: C.autoDraftMaxAttempts, backoffMinutes: C.autoRetryBackoffMinutes });
  for (const row of rows) {
    if (runningCalls.size >= C.autoConcurrency || runningCalls.has(row.phonecall_id!)) {
      // claimed but no slot this tick: put it back as failed so a later tick reclaims it
      await query(`UPDATE call_note SET status = 'failed', error_code = 'retry_deferred', error = 'waiting for a drafting slot', draft_attempts = draft_attempts - 1 WHERE id = $1`, [row.id]).catch(() => undefined);
      continue;
    }
    const clientName = String((await query(`SELECT trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) AS n FROM public.waterfind_user WHERE id = $1`, [row.client_uid])).rows[0]?.n || '').trim() || 'the client';
    console.log(`[call-notes] auto: re-drafting call ${row.phonecall_id} (attempt ${row.draft_attempts + 1})`);
    startDraft(row, clientName, false);
  }
}

/** One poll: start drafts for newly-ended calls, then retry transient failures. Exported for tests. */
export async function autoTick(now?: Date): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await draftNewCalls(now);
    await retryFailedDrafts();
  } finally {
    ticking = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startAutoCallNotes(): void {
  if (!autoCallNotesEnabled()) return;
  if (timer) return;
  console.log(`[call-notes] auto: pre-drafting ended calls (poll ${C.autoPollSeconds}s, lookback ${C.autoLookbackMinutes}m, min ${C.autoMinCallSeconds}s, pbx=${C.pbxSource})`);
  const tick = () => void autoTick().catch((e) => console.warn('[call-notes] auto tick failed:', e?.message ?? e));
  timer = setInterval(tick, Math.max(10, C.autoPollSeconds) * 1000);
  timer.unref?.();
  setTimeout(tick, 5000).unref?.();
}

export function stopAutoCallNotes(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
