/**
 * GET /assist/call-note/prefill — what the CRM's Add Comment popup asks when it opens.
 *
 * Mounted under the broker-assist surface, so the request already carries a verified staff
 * identity (req.userId; staff usertype + an assist role checked fresh in the DB by server.ts
 * requireAssist) bound to ONE client (req.assistClientUid) by the signed act claim. The popup's
 * own script (crm-seam/registry-add-comment-prefill.jspf) fills its textarea with the answer; the
 * broker edits and saves in the CRM's form as always. Nothing here writes to the CRM.
 *
 * Which call: the staff member's most recent ended, recorded call on this client's account within
 * the prefill window that they have not written up yet (store.latestCallForPrefill). Normally the
 * pre-drafting worker (auto.ts) has the note ready before the popup opens; if not (worker off, a
 * call outside its lookback, a transient failure) the draft is started here and the popup polls
 * until it is ready. A call the worker could never draft (no recording, expired) answers `failed`
 * and the popup stays empty.
 */
import { Router, type Response } from 'express';
import type { AuthedRequest } from '../auth';
import { callNotesConfig as C, callNotesEnabled } from './config';
import { CallNoteError } from './transcript';
import { asciiPunctuation, type CallNoteDraft } from './summarize';
import {
  scopeFor, latestCallForPrefill, getNoteByCall, getNoteById, createNote, resetNote, markHandedOff,
  isStale, spendLast24h, isPermanentDraftFailure, countDraftAttempt,
  type CallNoteRow, type NoteScope,
} from './store';
import { runNote, isRunning } from './jobs';

interface AssistReq extends AuthedRequest { assistClientUid?: number; assistClientName?: string; }

export type PrefillResult =
  | { status: 'none' }
  | { status: 'drafting'; phonecall_id: string; stage: string; detail: string | null }
  | { status: 'ready'; phonecall_id: string; note_id: number; text: string; check: string[] }
  | { status: 'failed'; phonecall_id: string; error: string };

/**
 * The textarea text: the note as drafted, ending with "Call back dd/mm" when a call-back was
 * agreed and the note does not already say so (house style — see summarize.ts STYLE_EXAMPLES).
 * ASCII punctuation only: the popup form is ISO-8859-1.
 */
export function composePrefillText(s: CallNoteDraft, now = new Date()): string {
  let text = String(s.note ?? '').trim();
  if (s.callBack?.date && !/call\s*back/i.test(text)) {
    const [dd, mm, yyyy] = s.callBack.date.split('/');
    const when = yyyy && Number(yyyy) !== now.getFullYear() ? `${dd}/${mm}/${yyyy}` : `${dd}/${mm}`;
    text += `${text ? ' ' : ''}Call back ${when}`;
  }
  return asciiPunctuation(text).replace(/[ \t]+/g, ' ').trim();
}

/** What the broker should double-check, shown under the textarea (never part of the comment). */
export function composePrefillChecks(s: CallNoteDraft): string[] {
  return [...(s.flags ?? []), ...(s.unclear ?? [])].map((x) => asciiPunctuation(String(x)).trim()).filter(Boolean).slice(0, 8);
}

function drafting(row: CallNoteRow): PrefillResult {
  return { status: 'drafting', phonecall_id: row.phonecall_id!, stage: row.status, detail: row.stage_detail };
}

let budgetLoggedAt = 0;
async function overBudget(): Promise<boolean> {
  if (!(C.dailyBudgetUsd > 0)) return false;
  const usd = await spendLast24h();
  if (usd < C.dailyBudgetUsd) return false;
  if (Date.now() - budgetLoggedAt > 3600_000) {
    budgetLoggedAt = Date.now();
    console.warn(`[call-notes] prefill: daily drafting budget reached ($${usd.toFixed(2)} of $${C.dailyBudgetUsd.toFixed(0)}) — popups stay empty until it rolls off`);
  }
  return true;
}

/**
 * The decision for one popup open. Exported for tests (the route is a thin wrapper). Idempotent
 * per poll: a second call while a draft runs reports the stage; once ready it records the hand-off
 * (first time only) and returns the text.
 */
export async function prefillFor(clientUid: number, clientName: string, staffUid: number, staffName: string | null, opts: { now?: Date } = {}): Promise<PrefillResult> {
  const scope: NoteScope = await scopeFor(clientUid);
  if (scope.registryUserId == null) return { status: 'none' };
  const call = await latestCallForPrefill(scope.registryUserId, staffUid, C.prefillWindowMinutes, opts);
  if (!call) return { status: 'none' };

  let row = await getNoteByCall(call.phonecall_id, scope);

  if (row && row.status === 'ready' && row.summary) {
    const text = composePrefillText(row.summary);
    if (!text) return { status: 'failed', phonecall_id: call.phonecall_id, error: 'empty draft' };
    await markHandedOff(row.id, scope, staffUid, text);
    return { status: 'ready', phonecall_id: call.phonecall_id, note_id: row.id, text, check: composePrefillChecks(row.summary) };
  }
  if (row && row.status !== 'failed' && row.status !== 'ready' && (isRunning(row.id) || !isStale(row))) return drafting(row);

  // Nothing usable yet: start (or restart) the draft unless it can never succeed.
  if (row && row.status === 'failed' && (isPermanentDraftFailure(row.error_code) || row.draft_attempts >= C.autoDraftMaxAttempts)) {
    return { status: 'failed', phonecall_id: call.phonecall_id, error: row.error || row.error_code || 'could not draft' };
  }
  if (row && row.status === 'ready') {   // ready but no summary (retention-blanked): nothing to fill
    return { status: 'failed', phonecall_id: call.phonecall_id, error: 'draft no longer held' };
  }
  if (C.pbxSource === 'off') return { status: 'none' };
  if (await overBudget()) return { status: 'none' };

  if (!row) {
    const { row: created, created: mine } = await createNote({
      phonecallId: call.phonecall_id, source: 'pbx', contactId: call.contact_id, clientUid, registryUserId: scope.registryUserId,
      staffUid, staffName, direction: call.direction, callStartedAt: call.started_at, auto: false,
    });
    row = created;
    if (!mine) return drafting(row);   // the worker (or another popup) started it a moment ago
  } else if (!isRunning(row.id)) {
    // failed transiently, or left in flight by a process that died: run again, keeping a transcript
    // that was already paid for.
    await resetNote(row.id, staffUid, staffName, { keepTranscript: row.transcript != null });
    await countDraftAttempt(row.id);
    row = (await getNoteById(row.id, scope))!;
  }
  const fresh = call.ended_ago_seconds < 10 * 60;
  void runNote({ row, clientName, staffName: staffName || 'the broker', fresh });
  return drafting(row);
}

function sendErr(res: Response, e: any): void {
  if (e instanceof CallNoteError) { res.status(e.status >= 400 && e.status < 600 ? e.status : 500).json({ error: e.code, message: e.message }); return; }
  console.error('[call-notes] prefill error:', e);
  res.status(500).json({ error: 'internal error' });
}

export const callNotesRouter = Router();

// Feature switch: 404 (not advertised) when off, matching how the assist surface hides itself.
// Scoped to THIS feature's path only — the router is mounted at /assist.
callNotesRouter.get('/call-note/prefill', (req: AssistReq, res: Response) => {
  if (!callNotesEnabled()) { res.status(404).json({ error: 'not found' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  prefillFor(req.assistClientUid!, req.assistClientName || 'the client', req.userId!, req.userName || null)
    .then((r) => res.json(r), (e) => sendErr(res, e));
});
