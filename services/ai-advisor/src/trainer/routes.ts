import { Router, type Response, type NextFunction } from 'express';
import express from 'express';
import { config } from '../config';
import { query } from '../db';
import { loadCorpus } from '../knowledge-tools';
import { loadNotes, noteFileFor, checkBestByInput, type NoteMode } from '../notes';
import { requireTrainer, roleLabel, type TrainerRequest } from './auth';
import {
  createArtifact, updateArtifact, deleteArtifact, readArtifact,
  undoEvent, undoBatch, restoreTo, planRestore, restoreVersion,
  createCheckpoint, listCheckpoints, deleteCheckpoint,
  listEvents, getEventFull, actorNames, docSummary, noteSummary, slugify,
  pointFromWire, externalChangeCount, uncommittedCount, SYSTEM_ACTOR_ID,
  TrainerError, type KbEvent,
} from './store';
import { storeUpload, listUploads, getUpload, ingestUpload, dismissUpload, readUploadBytes, uploadFilePresent, liveDocIdFor, fileKind } from './ingest';
import { findConversations, readConversation, listReports, setReportStatus } from './lookup';
import {
  getQuestionSet, saveQuestionSet, cleanQuestionList, QUESTION_AUDIENCES,
  type QuestionAudience, type QuestionSet,
} from '../default-questions';
import { runTrainer } from './agent';
import { startTrainerMaintenance, maintenanceStatus } from './maintenance';
import { kbRefreshStatus } from './refresh/scheduler';
import { listRefreshRuns } from './refresh/worker';
import { recordSpend, spendSummary } from '../spend';
import { callNotesConfig } from '../call-notes/config';
import { transcribeEnabled } from '../transcribe';
import { synthesizeSpeech, ttsEnabled, TtsError } from '../tts';
import { readerRouter, readerInfo, readerEnabled } from '../voice/reader';
import {
  validateUpload, attachmentBlocks,
  MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_BINARY_BYTES, MAX_MESSAGE_TEXT_BYTES,
  type AttachmentMeta, type PromptBlock,
} from '../attachments';

/**
 * AI Trainer HTTP surface. Mounted AFTER requireAuth but BEFORE the client-facing advisor kill
 * switch, so staff access is not coupled to `waterfind_user.ai_advisor`.
 *
 * Everything the trainer AI can do through its tools, a person can do here directly (the Trainer
 * page's forms call these). Both paths end in store.ts, so both are ledgered identically —
 * `via` says which.
 */

export const trainerRouter = Router();

// Startup: record changes made on disk while the process was down, sweep uncommitted changes into
// git (when commits are on). The router module is the trainer's one guaranteed load point.
startTrainerMaintenance();

function h(fn: (req: TrainerRequest, res: Response) => Promise<void>) {
  return (req: TrainerRequest, res: Response) => {
    fn(req, res).catch((e: any) => {
      const status = e instanceof TrainerError ? e.status : 500;
      if (status >= 500) console.error('trainer route error:', e);
      if (!res.headersSent) res.status(status).json({ error: e?.message ?? 'internal error' });
    });
  };
}
const str = (v: unknown, max = 4000) => String(v ?? '').slice(0, max);
/** A document body: refused outright when over the cap, never silently truncated (a cut file would pass validation and lose its tail). */
const DOC_CONTENT_MAX = 2_000_000;
function docContent(v: unknown): string {
  const s = String(v ?? '');
  if (s.length > DOC_CONTENT_MAX) throw new TrainerError(`the document is ${s.length.toLocaleString()} characters; the limit is ${DOC_CONTENT_MAX.toLocaleString()}`, 413);
  return s;
}
/** Positive integer route param, or 404 (never a bigint cast error out of Postgres). */
function pid(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new TrainerError('not found', 404);
  return n;
}
/** Optional integer query param: the default when absent or not a finite number. */
function qint(v: unknown, def: number | undefined): number | undefined {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}
const why = (v: unknown, fallback: string) => str(v, 1000).trim() || fallback;

async function withNames<T extends { actor_user_id?: number; created_by?: number; uploaded_by?: number; reporter_uid?: number; via?: string }>(rows: T[]): Promise<(T & { by_name: string })[]> {
  const ids = rows.map((r) => Number(r.actor_user_id ?? r.created_by ?? r.uploaded_by ?? r.reporter_uid)).filter(Number.isFinite);
  const names = await actorNames(ids);
  return rows.map((r) => {
    const id = Number(r.actor_user_id ?? r.created_by ?? r.uploaded_by ?? r.reporter_uid);
    // Actor 0 is the system: the startup reconcile (via 'external') or the best-by auto-refresh.
    const name = id === SYSTEM_ACTOR_ID ? (r.via === 'refresh' ? 'Auto-refresh' : 'outside the Trainer')
      : names.get(id) || (Number.isFinite(id) ? `user #${id}` : '');
    return { ...r, by_name: name };
  });
}

trainerRouter.use(requireTrainer());
// JSON bodies for everything except the raw-body upload route. Larger than the app default: a
// library document carries a whole uploaded report (up to VERBATIM_CAP), and the editor PUTs it back.
const trainerJson = express.json({ limit: '6mb' });
trainerRouter.use((req, res, next) => (req.method === 'POST' && req.path === '/uploads' ? next() : trainerJson(req, res, next)));

// ---- identity + overview ---------------------------------------------------------------------
trainerRouter.get('/me', h(async (req, res) => {
  res.json({
    userId: req.trainer!.userId, name: req.userName,
    role: req.trainer!.role ?? null,
    role_label: req.trainer!.role ? roleLabel(req.trainer!.role) : null,
    notes_enabled: config.notesEnabled,
    // the implied best_by horizon for items without one (the UI pre-fills pickers with today + this)
    refresh_ttl_days: config.kbRefreshTtlDays,
    // Same capability flags as the advisor's /me: the Trainer hides its mic / Listen controls
    // when speech is unconfigured.
    transcribe: transcribeEnabled(),
    tts: ttsEnabled() || readerEnabled(),   // some reader can speak (OpenAI, or the Retell web reader)
    reader: readerInfo().mode,
  });
}));

// The Retell web reader's sessions for the Trainer (same admission as everything here).
trainerRouter.use('/reader', readerRouter);

// Read-aloud for the Trainer's assistant replies — the same synthesis as the advisor's POST /tts,
// admitted by requireTrainer. Errors carry their own status (400 nothing to speak, 503 unconfigured,
// 502 provider), which h() would flatten to 500.
trainerRouter.post('/tts', (req: TrainerRequest, res: Response) => {
  const text = String(req.body?.text ?? '');
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  synthesizeSpeech(text, { signal: ac.signal, userId: req.userId }).then(({ audio, contentType }) => {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(audio);
  }, (e: any) => {
    if (e instanceof TtsError) { if (!res.headersSent) res.status(e.status).json({ error: e.message }); return; }
    if (e?.name === 'AbortError') return;   // the browser went away mid-synthesis
    console.error('trainer tts error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });
});

trainerRouter.get('/overview', h(async (_req, res) => {
  const docs = loadCorpus(true);
  const notes = loadNotes(true);
  const staleCutoff = new Date(); staleCutoff.setMonth(staleCutoff.getMonth() - 12);
  const stale = docs.filter((d) => d.as_at && new Date(d.as_at) < staleCutoff);
  const [uploads, reports, events, cps, external, uncommitted, refreshRuns] = await Promise.all([
    listUploads(), listReports('open', 200), listEvents({ limit: 12 }), listCheckpoints(),
    externalChangeCount(), uncommittedCount(), listRefreshRuns(5).catch(() => []),
  ]);
  res.json({
    counts: {
      documents: docs.length, regulatory: docs.filter((d) => d.collection === 'regulatory').length,
      library: docs.filter((d) => d.collection === 'library').length, stale: stale.length,
      notes: notes.length, pinned: notes.filter((n) => n.mode === 'pin').length,
      uploads_waiting: uploads.filter((u) => !u.doc_id && !u.dismissed).length, open_reports: reports.length,
      checkpoints: cps.length,
      // changes the startup reconcile found on disk (deploys, edits outside the Trainer), all time
      external_changes: external,
      // live changes git does not hold (only meaningful when TRAINER_GIT_COMMIT=1)
      uncommitted: uncommitted,
    },
    notes_enabled: config.notesEnabled,
    git_commit_enabled: config.trainerGitCommit,
    maintenance: maintenanceStatus,
    refresh: { ...kbRefreshStatus(true), recent_runs: refreshRuns },
    stale_documents: stale.slice(0, 10).map(docSummary),
    recent_changes: await withNames(events),
  });
}));

// ---- costs (the spend ledger, src/spend.ts) --------------------------------------------------
// ?days= sets the window for the per-source and daily figures (default 30, max 366). Days are
// bucketed in the CRM's own zone so "today" is Waterfind's today.
trainerRouter.get('/spend', h(async (req, res) => {
  const summary = await spendSummary({ days: qint(req.query.days, 30), tz: callNotesConfig.crmTz, recent: qint(req.query.recent, 40) });
  const names = await actorNames(summary.recent.map((r) => r.user_id).filter((n): n is number => n != null));
  res.json({
    ...summary,
    recent: summary.recent.map((r) => ({ ...r, by_name: r.user_id == null ? '' : names.get(r.user_id) || `user #${r.user_id}` })),
  });
}));

// ---- documents ------------------------------------------------------------------------------
trainerRouter.get('/documents', h(async (_req, res) => {
  res.json({ documents: loadCorpus(true).map(docSummary) });
}));

trainerRouter.get('/documents/:id', h(async (req, res) => {
  const raw = readArtifact('doc', req.params.id);
  if (!raw) throw new TrainerError('document not found', 404);
  const d = loadCorpus(true).find((x) => x.id === req.params.id)!;
  const versions = await listEvents({ path: raw.path, limit: 100 });
  res.json({ ...docSummary(d), content: raw.content, hash: raw.hash, body: d.body, versions: await withNames(versions) });
}));

trainerRouter.post('/documents', h(async (req, res) => {
  const b = req.body ?? {};
  const ev = await createArtifact({
    kind: 'doc', id: str(b.id, 120), content: docContent(b.content), actor: req.trainer!, via: 'manual',
    collection: b.collection === 'regulatory' ? 'regulatory' : 'library', jurisdiction: b.jurisdiction ? str(b.jurisdiction, 8) : undefined,
    summary: why(b.why, `Added document ${str(b.id, 120)}`),
  });
  res.json({ ok: true, event: ev });
}));

trainerRouter.put('/documents/:id', h(async (req, res) => {
  const b = req.body ?? {};
  const ev = await updateArtifact({
    kind: 'doc', id: req.params.id, content: docContent(b.content), actor: req.trainer!, via: 'manual',
    expectedHash: b.expected_hash ? str(b.expected_hash, 64) : null, summary: why(b.why, `Edited document ${req.params.id}`),
  });
  res.json({ ok: true, event: ev });
}));

trainerRouter.delete('/documents/:id', h(async (req, res) => {
  const b = req.body ?? {};
  const ev = await deleteArtifact({ kind: 'doc', id: req.params.id, actor: req.trainer!, via: 'manual',
    expectedHash: b.expected_hash ? str(b.expected_hash, 64) : null, summary: why(b.why, `Deleted document ${req.params.id}`) });
  res.json({ ok: true, event: ev });
}));

// ---- notes ----------------------------------------------------------------------------------
trainerRouter.get('/notes', h(async (_req, res) => {
  const notes = loadNotes(true);
  res.json({ notes: notes.map(noteSummary), pinned: notes.filter((n) => n.mode === 'pin').length, enabled: config.notesEnabled });
}));

trainerRouter.get('/notes/:id', h(async (req, res) => {
  const n = loadNotes(true).find((x) => x.id === req.params.id);
  const raw = readArtifact('note', req.params.id);
  if (!raw) throw new TrainerError('note not found', 404);
  const versions = await listEvents({ path: raw.path, limit: 100 });
  res.json({ ...(n ? noteSummary(n) : { id: req.params.id, broken: true }), content: raw.content, hash: raw.hash, versions: await withNames(versions) });
}));

function noteFields(b: any, cur?: ReturnType<typeof noteSummary>) {
  const triggers = Array.isArray(b.triggers) ? b.triggers.map((t: unknown) => str(t, 80))
    : typeof b.triggers === 'string' ? b.triggers.split(',').map((t: string) => t.trim()).filter(Boolean) : cur?.triggers ?? [];
  const urls = Array.isArray(b.source_urls) ? b.source_urls.map((u: unknown) => str(u, 500).trim()).filter(Boolean)
    : typeof b.source_urls === 'string' ? b.source_urls.split(/[\s,]+/).filter(Boolean) : cur?.source_urls ?? [];
  const title = str(b.title ?? cur?.title, 200), text = str(b.text ?? cur?.text, 3000);
  // "Verified as at" only moves when the substance (title/text) changes — a pin toggle keeps it.
  const substanceChanged = !cur || title !== cur.title || text !== cur.text;
  // best_by: 'never' | YYYY-MM-DD | '' (clear — the default as_at + TTL rule applies again).
  // Absent from the body = keep the current value; anything else malformed is refused (400).
  let bestBy = cur?.best_by;
  if (b.best_by !== undefined) {
    try { bestBy = checkBestByInput(str(b.best_by, 40)); } catch (e) { throw new TrainerError((e as Error).message); }
  }
  return {
    title, text,
    mode: ((b.mode ?? cur?.mode) === 'pin' ? 'pin' : 'retrieve') as NoteMode,
    scope: str(b.scope ?? cur?.scope, 120), triggers, sourceUrls: urls,
    asAt: substanceChanged || !cur ? undefined : cur.as_at,
    bestBy,
  };
}

trainerRouter.post('/notes', h(async (req, res) => {
  const b = req.body ?? {};
  const f = noteFields(b);
  const id = b.id ? slugify(str(b.id, 120)) : slugify(f.title);
  const ev = await createArtifact({ kind: 'note', id, content: noteFileFor({ id, ...f }), actor: req.trainer!, via: 'manual',
    summary: why(b.why, `Added note "${f.title}"`) });
  res.json({ ok: true, event: ev, id });
}));

trainerRouter.put('/notes/:id', h(async (req, res) => {
  const b = req.body ?? {};
  const cur = loadNotes(true).find((n) => n.id === req.params.id);
  const f = noteFields(b, cur ? noteSummary(cur) : undefined);
  const ev = await updateArtifact({ kind: 'note', id: req.params.id, content: noteFileFor({ id: req.params.id, ...f }), actor: req.trainer!, via: 'manual',
    expectedHash: b.expected_hash ? str(b.expected_hash, 64) : null, summary: why(b.why, `Edited note "${f.title}"`) });
  res.json({ ok: true, event: ev });
}));

trainerRouter.delete('/notes/:id', h(async (req, res) => {
  const ev = await deleteArtifact({ kind: 'note', id: req.params.id, actor: req.trainer!, via: 'manual',
    summary: why(req.body?.why, `Deleted note ${req.params.id}`) });
  res.json({ ok: true, event: ev });
}));

// ---- default questions (the empty-chat suggestions, one list per audience) ------------------
async function questionSetsPayload(): Promise<Record<QuestionAudience, QuestionSet & { by_name: string }>> {
  const out = {} as Record<QuestionAudience, QuestionSet & { by_name: string }>;
  for (const a of QUESTION_AUDIENCES) {
    const s = await getQuestionSet(a);
    const name = s.updated_by == null ? '' : (await actorNames([s.updated_by])).get(s.updated_by) || `user #${s.updated_by}`;
    out[a] = { ...s, by_name: name };
  }
  return out;
}

trainerRouter.get('/default-questions', h(async (_req, res) => {
  res.json(await questionSetsPayload());
}));

// Body: { broker?: { questions, version }, client?: { questions, version } } — `version` is the
// one GET handed out (0 = the built-ins were serving). A list identical to what is stored is left
// untouched; a version mismatch means someone else saved in between → 409, reload and re-apply.
trainerRouter.put('/default-questions', h(async (req, res) => {
  const b = req.body ?? {};
  for (const a of QUESTION_AUDIENCES) {
    const part = b[a];
    if (part == null) continue;
    let qs: string[];
    try { qs = cleanQuestionList(part.questions); } catch (e: any) { throw new TrainerError(`${a}: ${e.message}`); }
    const expect = Number(part.version);
    if (!Number.isInteger(expect) || expect < 0) throw new TrainerError(`${a}: version is required`);
    const cur = await getQuestionSet(a);
    if (cur.version === expect && JSON.stringify(cur.questions) === JSON.stringify(qs)) continue;
    const saved = await saveQuestionSet(a, qs, req.trainer!.userId, expect);
    if (!saved) throw new TrainerError(`the ${a} list changed since you opened it — reload and apply your edit again`, 409);
  }
  res.json({ ok: true, ...(await questionSetsPayload()) });
}));

// ---- uploads --------------------------------------------------------------------------------
trainerRouter.get('/uploads', h(async (req, res) => {
  res.json({ uploads: await withNames(await listUploads(req.query.all === '1')) });
}));

trainerRouter.post('/uploads',
  express.raw({ type: () => true, limit: config.trainerUploadMaxBytes }),
  h(async (req, res) => {
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || !buf.length) throw new TrainerError('no file received');
    let filename = String(req.header('x-filename') ?? 'upload.bin');
    try { filename = decodeURIComponent(filename); } catch { /* keep as sent */ }
    const mime = String(req.header('content-type') ?? 'application/octet-stream');
    const r = await storeUpload(buf, filename, mime, req.trainer!);
    res.json({ ok: true, ...r });
  }));

trainerRouter.get('/uploads/:id', h(async (req, res) => {
  const u = await getUpload(pid(req.params.id));
  const [named] = await withNames([u]);
  res.json({ ...named, doc_id: liveDocIdFor(u), file_present: uploadFilePresent(u),
    text: u.text ? u.text.slice(0, 200_000) : null, text_chars: u.text?.length ?? 0 });
}));

trainerRouter.get('/uploads/:id/file', h(async (req, res) => {
  const u = await getUpload(pid(req.params.id));
  const buf = readUploadBytes(u);
  // Never trust the stored (client-supplied) mime, and never render markup inline: an uploaded
  // .html/.svg opened from the CRM origin would run with the CRM session. Only PDFs and images
  // display inline; everything else downloads.
  const kind = fileKind(u.filename);
  const ext = u.filename.toLowerCase().split('.').pop() ?? '';
  const inlineType = kind === 'pdf' ? 'application/pdf'
    : kind === 'image' ? ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[ext]
    : null;
  const safeName = u.filename.replace(/[^\w.\- ()]+/g, '_');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', inlineType ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inlineType ? 'inline' : 'attachment'}; filename="${safeName}"`);
  res.send(buf);
}));

trainerRouter.post('/uploads/:id/ingest', h(async (req, res) => {
  const b = req.body ?? {};
  const r = await ingestUpload(pid(req.params.id), req.trainer!, 'manual', { hints: b.hints ? str(b.hints, 600) : undefined, id: b.id ? str(b.id, 120) : undefined, bestBy: b.best_by ? str(b.best_by, 12) : undefined });
  res.json({ ok: true, document_id: r.docId, annotation: r.annotation, event: r.event });
}));

trainerRouter.post('/uploads/:id/dismiss', h(async (req, res) => {
  await dismissUpload(pid(req.params.id), req.body?.dismissed !== false);
  res.json({ ok: true });
}));

// ---- reports + conversations ----------------------------------------------------------------
trainerRouter.get('/reports', h(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json({ reports: await listReports(status) });
}));

trainerRouter.post('/reports/:id/status', h(async (req, res) => {
  const s = req.body?.status;
  if (!['open', 'resolved', 'dismissed'].includes(s)) throw new TrainerError('status must be open, resolved or dismissed');
  await setReportStatus(pid(req.params.id), s, req.body?.note ? str(req.body.note, 2000) : null, req.trainer!, false);
  res.json({ ok: true });
}));

trainerRouter.get('/conversations', h(async (req, res) => {
  const q = req.query;
  const opts = {
    clientName: typeof q.client === 'string' ? q.client : undefined,
    userId: qint(q.user_id, undefined),
    text: typeof q.text === 'string' ? q.text : undefined,
    from: typeof q.from === 'string' ? q.from : undefined, to: typeof q.to === 'string' ? q.to : undefined,
    limit: qint(q.limit, 30),
  };
  if (!opts.clientName && !opts.userId && !opts.text && !opts.from && !opts.to) { res.json({ conversations: [] }); return; }
  res.json({ conversations: await findConversations(opts, { reader: req.trainer!, byAgent: false }) });
}));

trainerRouter.get('/conversations/:id', h(async (req, res) => {
  const around = qint(req.query.around, undefined);
  const purpose = typeof req.query.purpose === 'string' ? req.query.purpose : 'manual-view';
  res.json(await readConversation(pid(req.params.id), req.trainer!, purpose, false, { aroundMessageId: around, limit: 80 }));
}));

// ---- history / undo / restore ---------------------------------------------------------------
trainerRouter.get('/history', h(async (req, res) => {
  const q = req.query;
  const events = await listEvents({
    limit: qint(q.limit, 60), beforeId: qint(q.before, undefined),
    docId: typeof q.doc_id === 'string' ? q.doc_id : undefined,
  });
  res.json({ events: await withNames(events) });
}));

trainerRouter.get('/history/:id', h(async (req, res) => {
  const ev = await getEventFull(pid(req.params.id));
  const [named] = await withNames([ev]);
  res.json(named);
}));

trainerRouter.post('/history/:id/undo', h(async (req, res) => {
  const r = await undoEvent(pid(req.params.id), req.trainer!);
  res.json({ ok: true, ...r });
}));

trainerRouter.post('/history/batch/:batchId/undo', h(async (req, res) => {
  const events = await undoBatch(pid(req.params.batchId), req.trainer!);
  res.json({ ok: true, events });
}));

trainerRouter.post('/history/:id/restore-version', h(async (req, res) => {
  const ev = await restoreVersion(pid(req.params.id), req.trainer!);
  res.json({ ok: true, event: ev });
}));

// The body is the wire point (event_id | checkpoint_id | at — the same object the restore card and
// the History tab carry) plus, on POST /restore, the preview it was taken from: expect_head (the
// ledger's newest event id at preview) and expect_changes (how many files it listed). Either
// mismatch = the person is looking at a stale list → 409, preview again.
trainerRouter.post('/restore/preview', h(async (req, res) => {
  const plan = await planRestore(pointFromWire(req.body));
  res.json({ label: plan.label, last_event_id: plan.lastEventId, head: plan.head,
    changes: plan.changes.map((c) => ({ path: c.path, kind: c.kind, doc_id: c.doc_id, action: c.action })) });
}));

trainerRouter.post('/restore', h(async (req, res) => {
  const b = req.body ?? {};
  const r = await restoreTo(pointFromWire(b), req.trainer!, {
    expectHead: qint(b.expect_head, undefined), expectChanges: qint(b.expect_changes, undefined),
  });
  res.json({ ok: true, label: r.plan.label, batch_id: r.batchId, events: r.events.map((e: KbEvent) => ({ id: e.id, doc_id: e.doc_id, op: e.op })) });
}));

trainerRouter.get('/checkpoints', h(async (_req, res) => {
  res.json({ checkpoints: await withNames(await listCheckpoints()) });
}));
trainerRouter.post('/checkpoints', h(async (req, res) => {
  res.json({ ok: true, checkpoint: await createCheckpoint(str(req.body?.label, 120), req.trainer!) });
}));
trainerRouter.delete('/checkpoints/:id', h(async (req, res) => {
  await deleteCheckpoint(pid(req.params.id));
  res.json({ ok: true });
}));

// ---- chat -----------------------------------------------------------------------------------
function sse(res: Response, obj: unknown) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

trainerRouter.post('/chat', h(async (req, res) => {
  const message = String(req.body?.message ?? '').trim();
  if (!message) throw new TrainerError('message is required');
  const rawSession = req.body?.sessionId ? String(req.body.sessionId) : '';
  const resumeSessionId = /^[0-9a-zA-Z_-]{8,80}$/.test(rawSession) ? rawSession : null;

  // Uploads attached to THIS message: re-checked against the uploads table and embedded by the
  // SERVER as content blocks. The model never chooses what it gets shown.
  const claimed: number[] = Array.isArray(req.body?.uploadIds)
    ? req.body.uploadIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [];
  if (claimed.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new TrainerError(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`);
  const fileBlocks: PromptBlock[] = [];
  const sessionUploadIds: number[] = [];
  if (claimed.length) {
    const r = await query(`SELECT id, filename, mime, path, text FROM kb_upload WHERE id = ANY($1::bigint[])`, [claimed]);
    if (r.rowCount !== claimed.length) throw new TrainerError('unknown upload id');
    let binary = 0, text = 0;
    for (const row of r.rows as any[]) {
      // The bytes may be gone on this host (uploads/ is host-local); the extracted text still serves.
      const buf = uploadFilePresent(row) ? readUploadBytes(row) : null;
      let v: { kind: string; mime: string } | null = null;
      try { v = buf ? validateUpload(row.filename, buf) : null; } catch (e) { v = null; }
      if (v && buf) {
        if (v.kind === 'text') text += buf.length; else binary += buf.length;
        if (binary > MAX_MESSAGE_BINARY_BYTES || text > MAX_MESSAGE_TEXT_BYTES) {
          throw new TrainerError('the attached files together exceed the per-message size limit — attach fewer at once');
        }
        fileBlocks.push(...attachmentBlocks({ filename: row.filename, mime: v.mime, kind: v.kind } as AttachmentMeta, buf));
      } else if (row.text) {
        // Not embeddable as-is (e.g. DOCX): show the extracted text instead.
        const body = String(row.text).slice(0, MAX_MESSAGE_TEXT_BYTES).replace(/<(\/?\s*user_uploaded_file)/gi, '&lt;$1');
        fileBlocks.push({ type: 'text', text: `<user_uploaded_file name="${row.filename}" type="text/plain (extracted)">\n${body}\n</user_uploaded_file>` });
      } else if (!buf) {
        throw new TrainerError(`"${row.filename}" cannot be shown in chat: the original file is not on this host and no text was extracted from it`, 404);
      } else {
        throw new TrainerError(`"${row.filename}" cannot be shown in chat (no readable text) — it can still be added to the library if it is a PDF`);
      }
      sessionUploadIds.push(Number(row.id));
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const abort = new AbortController();
  // RESPONSE close, not request close: on Node 22 the IncomingMessage emits 'close' as soon as its
  // body has been consumed, which would abort the agent a few chunks into every reply.
  res.on('close', () => abort.abort());
  const timer = setTimeout(() => abort.abort(), Math.max(config.turnTimeoutMs, 600_000));

  let terminal = false;
  try {
    for await (const ev of runTrainer({
      prompt: fileBlocks.length ? [...fileBlocks, { type: 'text', text: message }] : message,
      resumeSessionId,
      ctx: { ...req.trainer!, sessionUploadIds, changes: [], restoreRequests: [] },
      abortController: abort,
    })) {
      sse(res, ev);
      if (ev.type === 'done' && typeof (ev as any).costUsd === 'number') {
        void recordSpend({ source: 'trainer_chat', vendor: 'anthropic', model: config.model, costUsd: (ev as any).costUsd, userId: req.trainer!.userId });
      }
      if (ev.type === 'done' || ev.type === 'error') { terminal = true; break; }
    }
    // A stream that ends without a result is a failure, not a finished answer — say so.
    if (!terminal && !res.writableEnded) sse(res, { type: 'error', message: 'the assistant stopped before finishing — try again' });
  } finally {
    clearTimeout(timer);
    res.end();
  }
}));

// ---- errors raised BEFORE a handler (body parsers) ------------------------------------------------
// express.raw / express.json reject an oversized or malformed body with an Error carrying `status`
// and render it as an HTML page; the SPA expects JSON on every route, so answer in kind. Registered
// last: Express runs error middleware in order after the route that threw.
trainerRouter.use((err: any, req: TrainerRequest, res: Response, _next: NextFunction) => {
  const status = Number(err?.status ?? err?.statusCode) || 500;
  if (res.headersSent) { res.end(); return; }
  if (err?.type === 'entity.too.large' || status === 413) {
    const limit = req.method === 'POST' && req.path === '/uploads'
      ? `${Math.round(config.trainerUploadMaxBytes / 1048576)} MB per file` : 'the request size limit';
    res.status(413).json({ error: `too large — ${limit}` });
    return;
  }
  if (err?.type === 'entity.parse.failed' || status === 400) { res.status(400).json({ error: 'malformed request body' }); return; }
  if (status >= 500) console.error('trainer middleware error:', err);
  res.status(status).json({ error: status >= 500 ? 'internal error' : String(err?.message ?? 'request failed') });
});

