import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config';
import { loadCorpus } from '../knowledge-tools';
import { loadNotes, noteFileFor, checkBestByInput, NOTE_TEXT_MAX, type NoteMode } from '../notes';
import {
  createArtifact, updateArtifact, deleteArtifact, patchArtifact, readArtifact,
  undoEvent, planRestore, restoreVersion, createCheckpoint, listCheckpoints,
  listEvents, getEventFull, docSummary, noteSummary, wirePoint, TrainerError,
  type KbEvent, type RestorePoint, type WirePoint,
} from './store';
import { listUploads, getUpload, ingestUpload } from './ingest';
import { findConversations, readConversation, listReports, setReportStatus } from './lookup';
import type { TrainerIdentity } from './auth';

/**
 * The trainer AI's ENTIRE capability surface. Every write goes through store.ts, so every write
 * is one ledger event with the complete before/after text — the AI applies changes directly, and
 * the ledger (undo, restore-to-point) is the safety net rather than a review queue.
 *
 * Absent on purpose:
 *   - no file read/write — every path is derived from a validated id, never supplied
 *   - no Bash, no SQL     — no general execution or query tool of any kind
 *   - no persona access   — the advisor's prompt is not addressable from here
 *   - conversation lookup is HERE and only here; the client-facing advisor has no such tool
 */

function J(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}
function fail(e: unknown) {
  return J({ ok: false, problem: e instanceof Error ? e.message : String(e) });
}

export interface ChangeCard {
  event_id: number; op: string; kind: string; doc_id: string; summary: string; batch_id?: number | null;
}

/**
 * A whole-knowledge-base restore the AI proposed; the person clicks it through in the UI. `point`
 * is the WIRE shape (snake_case — what POST /restore reads back verbatim); `head` is the ledger's
 * newest event id when the plan was made, which the click sends back so a restore whose preview
 * has gone stale (the ledger moved) is refused rather than applied blind.
 */
export interface RestoreRequest {
  point: WirePoint; label: string; head: number;
  changes: { doc_id: string; kind: string; action: string }[];
}

export interface TrainerToolCtx extends TrainerIdentity {
  /** Uploads this chat session has been shown by the SERVER (attached to a message). */
  sessionUploadIds: number[];
  /** Filled by write tools; the chat runner drains it into `change` events for the UI. */
  changes: ChangeCard[];
  /** Filled by restore_to; the chat runner emits them as `restore` events (a card with the button). */
  restoreRequests: RestoreRequest[];
}

export const TRAINER_TOOL_NAMES = [
  'list_documents', 'get_document', 'search_documents',
  'list_notes', 'get_note',
  'list_uploads', 'get_upload_text',
  'list_reports', 'set_report_status',
  'find_conversations', 'get_conversation',
  'get_history', 'get_change', 'list_checkpoints', 'preview_restore',
  'create_document', 'update_document', 'edit_document', 'delete_document', 'add_upload_to_library',
  'create_note', 'update_note', 'delete_note',
  'undo_change', 'restore_to', 'restore_document_version', 'create_checkpoint',
] as const;

const WHY = z.string().describe('one sentence for the change log: what changed and why');

function card(ctx: TrainerToolCtx, ev: KbEvent): ChangeCard {
  const c: ChangeCard = { event_id: Number(ev.id), op: ev.op, kind: ev.kind, doc_id: ev.doc_id, summary: ev.summary, batch_id: ev.batch_id ?? null };
  ctx.changes.push(c);
  return c;
}

const APPLIED = 'This is applied immediately and recorded as a numbered change; tell the staff member the change number so they can undo it if needed.';

export function buildTrainerToolDefs(ctx: TrainerToolCtx) {
  return [
    // ---------- documents: read -----------------------------------------------------------------
    tool('list_documents',
      'Catalogue of the advisor\'s knowledge documents: id, title, collection ("regulatory" = public '
      + 'instruments; "library" = material Waterfind added, e.g. uploaded reports and internal '
      + 'procedures), jurisdiction, instrument/type, one-line summary, tags, as-at date, size.',
      { collection: z.enum(['regulatory', 'library']).optional(), jurisdiction: z.string().optional().describe('e.g. NSW, VIC, CTH, CROSS') },
      async (a) => {
        const j = a.jurisdiction?.toUpperCase();
        const docs = loadCorpus(true).filter((d) => (!a.collection || d.collection === a.collection) && (!j || d.jurisdiction === j));
        return J({ count: docs.length, documents: docs.map(docSummary) });
      }),

    tool('get_document',
      'The complete file (frontmatter + body) of one document, plus its metadata. update_document '
      + 'replaces the whole file, so fetch it first; edit_document changes just a quoted passage.',
      { id: z.string(), offset: z.number().int().min(0).default(0), length: z.number().int().min(1000).max(60000).default(60000).describe('long files are paged') },
      async (a) => {
        const raw = readArtifact('doc', a.id);
        if (!raw) return J({ error: 'NOT_FOUND', id: a.id, available_ids: loadCorpus(true).map((d) => d.id) });
        const d = loadCorpus(true).find((x) => x.id === a.id)!;
        const more = a.offset + a.length < raw.content.length;
        return J({ ...docSummary(d), chars: raw.content.length, offset: a.offset,
          ...(more ? { more: true, next_offset: a.offset + a.length, note: 'the file continues; for a small fix use edit_document rather than rewriting the whole file' } : {}),
          full_file: raw.content.slice(a.offset, a.offset + a.length) });
      }),

    tool('search_documents',
      'Keyword search across all documents (title, summary, tags, body). Returns ranked matches with '
      + 'short excerpts. Use it to check whether a topic is already covered before adding anything.',
      { query: z.string(), limit: z.number().int().min(1).max(20).default(8) },
      async (a) => {
        const terms = a.query.toLowerCase().split(/[^a-z0-9%]+/i).filter((t) => t.length >= 2);
        const ranked = loadCorpus(true).map((d) => {
          const head = `${d.title} ${d.summary} ${d.meta.tags ?? ''} ${d.instrument}`.toLowerCase();
          const body = d.body.toLowerCase();
          let score = 0;
          const excerpts: string[] = [];
          for (const t of terms) {
            if (head.includes(t)) score += 6;
            const i = body.indexOf(t);
            if (i !== -1) { score += Math.min(body.split(t).length - 1, 8); if (excerpts.length < 2) excerpts.push(d.body.slice(Math.max(0, i - 80), i + 140).replace(/\s+/g, ' ')); }
          }
          return { d, score, excerpts };
        }).filter((s) => s.score > 0).sort((x, y) => y.score - x.score).slice(0, a.limit);
        return J({ matches: ranked.map((s) => ({ ...docSummary(s.d), score: s.score, excerpts: s.excerpts })) });
      }),

    // ---------- notes: read ---------------------------------------------------------------------
    tool('list_notes',
      'Every staff note. Notes are short pieces of guidance staff wrote directly for the advisor — a '
      + 'correction, a rule, a house position. mode "pin" = in the advisor\'s standing instructions '
      + 'on every conversation (no fixed cap; each pin costs tokens on every turn); "retrieve" = '
      + 'surfaces when the topic comes up. Includes how many are pinned.',
      {},
      async () => {
        const notes = loadNotes(true);
        return J({ count: notes.length, pinned: notes.filter((n) => n.mode === 'pin').length, notes: notes.map(noteSummary) });
      }),

    tool('get_note', 'One note in full, including its raw file.', { id: z.string() },
      async (a) => {
        const n = loadNotes(true).find((x) => x.id === a.id);
        const raw = readArtifact('note', a.id);
        if (!n || !raw) return J({ error: 'NOT_FOUND', id: a.id });
        return J({ ...noteSummary(n), full_file: raw.content });
      }),

    // ---------- uploads -------------------------------------------------------------------------
    tool('list_uploads',
      'Files Waterfind staff uploaded: id, filename, size, whether text could be extracted, and — once '
      + 'one has been added to the library — the document id it became. get_upload_text reads the '
      + 'extracted text; add_upload_to_library turns an upload into a library document.',
      {},
      async () => J({ uploads: await listUploads(), attached_to_this_chat: ctx.sessionUploadIds })),

    tool('get_upload_text',
      'The extracted plain text of an upload, in pages of up to 30,000 characters (offset/length). '
      + 'Uploads with no extractable text (scanned PDFs, images) report that instead.',
      { upload_id: z.number().int(), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(30000).default(30000) },
      async (a) => {
        try {
          const u = await getUpload(a.upload_id);
          if (!u.text) return J({ upload_id: u.id, filename: u.filename, text: null, text_status: u.text_status, note: u.text_note });
          return J({ upload_id: u.id, filename: u.filename, total_chars: u.text.length, offset: a.offset,
            text: u.text.slice(a.offset, a.offset + a.length), more: a.offset + a.length < u.text.length });
        } catch (e) { return fail(e); }
      }),

    // ---------- reports + conversations ---------------------------------------------------------
    tool('list_reports',
      'Inaccuracy reports advisor users filed ("this answer was wrong"), newest first, with status '
      + '(open / resolved / dismissed), the reporter, and the conversation and message they point at. '
      + 'get_conversation with around_message_id shows the disputed exchange.',
      { status: z.enum(['open', 'resolved', 'dismissed']).optional(), limit: z.number().int().min(1).max(200).default(50) },
      async (a) => J({ reports: await listReports(a.status, a.limit) })),

    tool('set_report_status',
      'Mark an inaccuracy report resolved (a fix was made — say which change), dismissed (no change '
      + 'warranted — say why), or open again.',
      { report_id: z.number().int(), status: z.enum(['open', 'resolved', 'dismissed']), note: z.string().optional() },
      async (a) => {
        try { await setReportStatus(a.report_id, a.status, a.note ?? null, ctx, true); return J({ ok: true }); }
        catch (e) { return fail(e); }
      }),

    tool('find_conversations',
      'Find advisor conversations: by client name (or username/email), by the client\'s user id, by '
      + 'words that appear in the messages, and/or by date range. Covers clients\' own chats and '
      + 'brokers\' chats about a client. Returns ids, who, when, message count, the first question and '
      + 'a matched excerpt. Reads are logged; client details must never be copied into documents or notes.',
      {
        client_name: z.string().optional(), user_id: z.number().int().optional(), text: z.string().optional(),
        from: z.string().optional().describe('ISO date, inclusive'), to: z.string().optional().describe('ISO date, inclusive'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      async (a) => {
        try {
          if (!a.client_name && !a.user_id && !a.text && !a.from && !a.to) return J({ problem: 'give at least one of client_name, user_id, text, from, to' });
          return J({ conversations: await findConversations({ clientName: a.client_name, userId: a.user_id, text: a.text, from: a.from, to: a.to, limit: a.limit }, { reader: ctx, byAgent: true }) });
        } catch (e) { return fail(e); }
      }),

    tool('get_conversation',
      'The transcript of one advisor conversation (user / advisor turns, newest window by default; '
      + 'around_message_id centres it on a message, e.g. a reported one), plus any inaccuracy reports '
      + 'on it. Every read is logged. Use it to see exactly what the advisor said and why, then fix '
      + 'the RULE (document or note) — never write client names, holdings or figures into the knowledge base.',
      { conversation_id: z.number().int(), around_message_id: z.number().int().optional(), limit: z.number().int().min(1).max(200).default(60) },
      async (a) => {
        try { return J(await readConversation(a.conversation_id, ctx, 'chat-tool', true, { limit: a.limit, aroundMessageId: a.around_message_id })); }
        catch (e) { return fail(e); }
      }),

    // ---------- history ------------------------------------------------------------------------
    tool('get_history',
      'The change log, newest first: numbered changes with who/how/when, what document, the '
      + 'operation and a one-line summary. Filter by doc_id for one document\'s versions. Every '
      + 'change can be undone (undo_change) and any earlier state restored (restore_to).',
      { doc_id: z.string().optional(), limit: z.number().int().min(1).max(200).default(30) },
      async (a) => J({ changes: (await listEvents({ docId: a.doc_id, limit: a.limit })).map(evLite) })),

    tool('get_change',
      'One change in full: its before and after text (each capped at 20,000 characters).',
      { event_id: z.number().int() },
      async (a) => {
        try {
          const ev = await getEventFull(a.event_id);
          const cap = (s: string | null) => s === null ? null : s.length > 20000 ? s.slice(0, 20000) + ' […]' : s;
          return J({ ...evLite(ev), before: cap(ev.before_content), after: cap(ev.after_content) });
        } catch (e) { return fail(e); }
      }),

    tool('list_checkpoints',
      'Named restore points ("before the August WSP update"). restore_to a checkpoint puts the whole '
      + 'knowledge base back to how it was when the checkpoint was made.',
      {},
      async () => J({ checkpoints: await listCheckpoints() })),

    tool('preview_restore',
      'What restoring the whole knowledge base to a point would change — WITHOUT changing anything. '
      + 'Give ONE of: event_id (state right after that change; 0 = before any recorded change), '
      + 'checkpoint_id, or at (an ISO date-time). Always show the staff member this list and get '
      + 'their go-ahead before restore_to.',
      { event_id: z.number().int().optional(), checkpoint_id: z.number().int().optional(), at: z.string().optional() },
      async (a) => {
        try {
          const plan = await planRestore(pointOf(a));
          return J({ restore_to: plan.label, changes: plan.changes.map((c) => ({ doc_id: c.doc_id, kind: c.kind, action: c.action })), count: plan.changes.length });
        } catch (e) { return fail(e); }
      }),

    // ---------- documents: write ----------------------------------------------------------------
    tool('create_document',
      'Add a new document. Submit the COMPLETE file: a --- frontmatter block then the markdown body. '
      + 'Regulatory documents (collection "regulatory") need id, title, jurisdiction, instrument, '
      + 'source_urls, as_at, summary and a body of at least 200 characters. Library documents '
      + '(collection "library") need id, title, as_at, summary; add tags, source_file, instrument, '
      + 'source_urls where known. Optional frontmatter best_by (YYYY-MM-DD or "never"): the date '
      + 'after which the auto-refresh re-verifies the document against its sources ("never" = never '
      + 'goes stale; unset = re-verified once it is 6 months past as_at). ' + APPLIED,
      {
        id: z.string().describe('kebab-case, unique'),
        collection: z.enum(['regulatory', 'library']),
        jurisdiction: z.string().optional().describe('required for regulatory: CTH, NSW, VIC, SA, QLD, WA, TAS or CROSS'),
        content: z.string(), why: WHY,
      },
      async (a) => {
        try {
          const ev = await createArtifact({ kind: 'doc', id: a.id, content: a.content, actor: ctx, via: 'chat', summary: a.why,
            collection: a.collection, jurisdiction: a.jurisdiction, sourceUploadId: lastUpload(ctx) });
          return J({ ok: true, change: card(ctx, ev) });
        } catch (e) { return fail(e); }
      }),

    tool('update_document',
      'Replace a document with a complete new version of the file (frontmatter + body). Keep the id. '
      + 'Update as_at when you re-verified the content. Frontmatter best_by (YYYY-MM-DD or "never") '
      + 'sets when the auto-refresh next re-verifies it. ' + APPLIED,
      { id: z.string(), content: z.string(), why: WHY },
      async (a) => {
        try {
          const ev = await updateArtifact({ kind: 'doc', id: a.id, content: a.content, actor: ctx, via: 'chat', summary: a.why, sourceUploadId: lastUpload(ctx) });
          return J({ ok: true, change: card(ctx, ev) });
        } catch (e) { return fail(e); }
      }),

    tool('edit_document',
      'Change one passage of a document: quote the exact current text (it must occur exactly once) '
      + 'and the replacement. Best for long documents and small fixes. ' + APPLIED,
      { id: z.string(), find: z.string(), replace: z.string(), why: WHY },
      async (a) => {
        try {
          const ev = await patchArtifact({ kind: 'doc', id: a.id, find: a.find, replace: a.replace, actor: ctx, via: 'chat', summary: a.why });
          return J({ ok: true, change: card(ctx, ev) });
        } catch (e) { return fail(e); }
      }),

    tool('delete_document',
      'Remove a document from the knowledge base. The advisor stops seeing it at once; the change '
      + 'log keeps its text so undo_change brings it back. ' + APPLIED,
      { id: z.string(), why: WHY },
      async (a) => {
        try {
          const ev = await deleteArtifact({ kind: 'doc', id: a.id, actor: ctx, via: 'chat', summary: a.why });
          return J({ ok: true, change: card(ctx, ev) });
        } catch (e) { return fail(e); }
      }),

    tool('add_upload_to_library',
      'Turn an uploaded file into a library document: the file is annotated (title, summary, type, '
      + 'jurisdiction, tags, key points) and written as a document that carries the annotation on top '
      + 'and the full original text underneath, so the advisor can find and quote it. Optional hints '
      + 'steer the annotation ("this is our internal carryover procedure, NSW only"). Takes a minute '
      + 'for a long file. ' + APPLIED,
      { upload_id: z.number().int(), hints: z.string().optional(), id: z.string().optional().describe('document id to use; default derived from the title'),
        best_by: z.string().optional().describe('YYYY-MM-DD after which the auto-refresh re-verifies the document, or "never"; unset = 6 months past today') },
      async (a) => {
        try {
          const r = await ingestUpload(a.upload_id, ctx, 'chat', { hints: a.hints, id: a.id, bestBy: a.best_by });
          return J({ ok: true, document_id: r.docId, title: r.annotation.title, summary: r.annotation.summary,
            key_points: r.annotation.key_points, change: card(ctx, r.event) });
        } catch (e) { return fail(e); }
      }),

    // ---------- notes: write --------------------------------------------------------------------
    tool('create_note',
      `Write a note for the advisor: a short paragraph (max ${NOTE_TEXT_MAX} characters) of guidance — a `
      + 'correction, a rule, a position, a reminder. mode "retrieve" (default) surfaces it when the '
      + 'topic comes up; "pin" puts it in every conversation (costs tokens on every turn; use for things '
      + 'the advisor gets wrong without being asked). triggers = phrases that should surface it. ' + APPLIED,
      {
        id: z.string().describe('kebab-case, unique'), title: z.string(), text: z.string().max(NOTE_TEXT_MAX * 2),
        mode: z.enum(['pin', 'retrieve']).default('retrieve'), scope: z.string().optional().describe('jurisdiction or topic, e.g. "NSW", "Basin-wide"'),
        triggers: z.array(z.string()).optional(), source_urls: z.array(z.string()).optional(),
        best_by: z.string().optional().describe('YYYY-MM-DD after which the auto-refresh re-verifies the note against its sources, or "never" for a note that never goes stale; unset = re-verified once it is 6 months past as_at'),
        why: WHY,
      },
      async (a) => {
        try {
          const content = noteFileFor({ id: a.id, title: a.title, text: a.text, mode: a.mode as NoteMode, scope: a.scope, triggers: a.triggers, sourceUrls: a.source_urls, bestBy: checkBestByInput(a.best_by) });
          const ev = await createArtifact({ kind: 'note', id: a.id, content, actor: ctx, via: 'chat', summary: a.why });
          return J({ ok: true, change: card(ctx, ev) });
        } catch (e) { return fail(e); }
      }),

    tool('update_note',
      'Change a note. Only the fields given change; the rest keep their current values. ' + APPLIED,
      {
        id: z.string(), title: z.string().optional(), text: z.string().max(NOTE_TEXT_MAX * 2).optional(),
        mode: z.enum(['pin', 'retrieve']).optional(), scope: z.string().optional(),
        triggers: z.array(z.string()).optional(), source_urls: z.array(z.string()).optional(),
        best_by: z.string().optional().describe('YYYY-MM-DD after which the auto-refresh re-verifies the note, "never" for never goes stale, or "" to clear back to the default (6 months past as_at)'),
        why: WHY,
      },
      async (a) => {
        try {
          const cur = loadNotes(true).find((n) => n.id === a.id);
          if (!cur) return J({ ok: false, problem: `no note with id "${a.id}"` });
          const mode = (a.mode ?? cur.mode) as NoteMode;
          const title = a.title ?? cur.title, text = a.text ?? cur.text;
          // "Verified as at" moves only when the substance (title/text) changes — a pin toggle or a
          // trigger edit keeps it (same rule as the Notes tab's form).
          const substanceChanged = title !== cur.title || text !== cur.text;
          const content = noteFileFor({ id: a.id, title, text, mode,
            scope: a.scope ?? cur.scope, triggers: a.triggers ?? cur.triggers, sourceUrls: a.source_urls ?? cur.sourceUrls,
            asAt: substanceChanged ? undefined : cur.asAt, bestBy: a.best_by === undefined ? cur.bestBy : checkBestByInput(a.best_by) });
          const ev = await updateArtifact({ kind: 'note', id: a.id, content, actor: ctx, via: 'chat', summary: a.why });
          return J({ ok: true, change: card(ctx, ev) });
        } catch (e) { return fail(e); }
      }),

    tool('delete_note', 'Remove a note. undo_change brings it back. ' + APPLIED, { id: z.string(), why: WHY },
      async (a) => {
        try {
          const ev = await deleteArtifact({ kind: 'note', id: a.id, actor: ctx, via: 'chat', summary: a.why });
          return J({ ok: true, change: card(ctx, ev) });
        } catch (e) { return fail(e); }
      }),

    // ---------- undo / restore ------------------------------------------------------------------
    tool('undo_change',
      'Put back what a numbered change replaced (a deleted document returns; an edit is reverted; a '
      + 'new document is removed). If later changes touched the same document they are discarded too — '
      + 'the result lists them. Itself recorded as a change, so it can be undone.',
      { event_id: z.number().int() },
      async (a) => {
        try {
          const r = await undoEvent(a.event_id, ctx);
          if (r.alreadyThere) return J({ ok: true, nothing_to_do: true, note: `change #${a.event_id} is already undone — the document is as it was before it` });
          return J({ ok: true, change: card(ctx, r.event!), also_discarded_changes: r.discards });
        } catch (e) { return fail(e); }
      }),

    tool('restore_to',
      'Ask for the WHOLE knowledge base to be restored to an earlier point: ONE of event_id (state right '
      + 'after that change; 0 = before any recorded change), checkpoint_id, or at (ISO date-time). This '
      + 'tool does NOT perform the restore: it works out what would change and puts a restore card with a '
      + 'button in front of the staff member — the restore only happens when they click it (it then '
      + 'lands in the change log as one undoable batch). Tell them what the card will do and that the '
      + 'button is theirs to press.',
      { event_id: z.number().int().optional(), checkpoint_id: z.number().int().optional(), at: z.string().optional() },
      async (a) => {
        try {
          const point = pointOf(a);
          const plan = await planRestore(point);
          if (!plan.changes.length) return J({ ok: true, nothing_to_do: true, note: `the knowledge base already matches ${plan.label}` });
          const req: RestoreRequest = { point: wirePoint(point), label: plan.label, head: plan.head,
            changes: plan.changes.map((c) => ({ doc_id: c.doc_id, kind: c.kind, action: c.action })) };
          ctx.restoreRequests.push(req);
          return J({ ok: true, awaiting_click: true, restore_to: plan.label, would_change: req.changes,
            note: 'A restore card with a "Restore now" button is now showing to the staff member. Nothing has changed yet; it changes when they click.' });
        } catch (e) { return fail(e); }
      }),

    tool('restore_document_version',
      'Put ONE document or note back to the version a given change produced (see get_history with '
      + 'doc_id for its versions). Recorded as a new change.',
      { event_id: z.number().int() },
      async (a) => {
        try { const ev = await restoreVersion(a.event_id, ctx); return J({ ok: true, change: card(ctx, ev) }); }
        catch (e) { return fail(e); }
      }),

    tool('create_checkpoint',
      'Name the current state of the knowledge base so it can be restored later ("before August WSP update").',
      { label: z.string() },
      async (a) => {
        try { return J({ ok: true, checkpoint: await createCheckpoint(a.label, ctx) }); }
        catch (e) { return fail(e); }
      }),
  ];
}

function evLite(ev: KbEvent) {
  return {
    event_id: Number(ev.id), at: ev.at, by_user_id: Number(ev.actor_user_id), via: ev.via, batch_id: ev.batch_id ?? null,
    kind: ev.kind, doc_id: ev.doc_id, op: ev.op, summary: ev.summary, undoes: ev.undoes_event_id ?? null,
    restore_target: ev.restore_target ?? null,
  };
}

function pointOf(a: { event_id?: number; checkpoint_id?: number; at?: string }): RestorePoint {
  if (typeof a.checkpoint_id === 'number') return { checkpointId: a.checkpoint_id };
  if (a.at) return { at: a.at };
  if (typeof a.event_id === 'number') return { eventId: a.event_id };
  throw new TrainerError('give one of event_id, checkpoint_id or at');
}

function lastUpload(ctx: TrainerToolCtx): number | null {
  return ctx.sessionUploadIds.length ? ctx.sessionUploadIds[ctx.sessionUploadIds.length - 1] : null;
}

