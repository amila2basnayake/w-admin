import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync, unlinkSync, readdirSync, statSync,
} from 'node:fs';
import { dirname, join, resolve, relative, sep, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '../db';
import { config } from '../config';
import {
  loadCorpus, parseFrontmatter, validateDoc, KNOWLEDGE_DIR,
  REGULATORY_SPEC, LIBRARY_SPEC, JURISDICTION_SET,
  type Collection, type KnowledgeDoc,
} from '../knowledge-tools';
import { NOTES_SPEC, loadNotes, toNote, type Note } from '../notes';
import { effectiveBestBy } from './refresh/policy';
import type { TrainerIdentity } from './auth';

/**
 * The knowledge store: every write to the knowledge base goes through here, and every write is
 * one row in kb_event with the complete before and after text. That single invariant is what makes
 * "undo this", "put this document back to how it was on Tuesday" and "put EVERYTHING back to
 * before the August update" all derivable — none of them needs anything the ledger does not hold.
 *
 * Two structural rules carry over from the previous design because they are still right:
 *
 *  1. TARGET PATHS ARE DERIVED, NEVER SUPPLIED. Callers pass a kind + id (+ collection /
 *     jurisdiction); this module builds the path and re-checks containment before any write.
 *  2. WRITES ARE SERIALISED and atomic (stage + rename), so a reader — the advisor is serving
 *     clients off these files while they change — never sees a half-written file, and two
 *     concurrent edits cannot interleave their validate-then-write sequences.
 *
 * Git is the durable trail (best effort, never blocks a change); the ledger row + the file on disk
 * are the operative record.
 *
 * The ledger cannot see a change made OUTSIDE this module (a deploy / git pull, a developer editing
 * a file, a replica synced from elsewhere). reconcileExternal() — run at startup — compares every
 * managed file with the last ledgered content and records the difference as via='external' rows
 * (actor 0), so restore-to-point and undo reason over the real history rather than a partial one.
 */

const execFileP = promisify(execFile);

const KNOWLEDGE = KNOWLEDGE_DIR;
const SERVICE_ROOT = resolve(KNOWLEDGE, '..');
const REG_ROOT = join(KNOWLEDGE, 'regulatory');
const LIB_ROOT = join(KNOWLEDGE, 'library');
const NOTES_ROOT = join(KNOWLEDGE, 'notes');
// Dot-prefixed so walkMarkdown never loads from it; renaming from here into place is atomic.
const STAGING = join(KNOWLEDGE, '.staging');

/** Actor id recorded on ledger rows the system writes itself (startup reconcile). Not a CRM user. */
export const SYSTEM_ACTOR_ID = 0;

export type Kind = 'doc' | 'note';
/** 'snapshot' = baseline row (before == after) for a file that predates the ledger; see reconcileExternal. */
export type Op = 'create' | 'update' | 'delete' | 'snapshot';
export type RestoreAction = 'create' | 'update' | 'delete';
export type Via = 'chat' | 'manual' | 'ingest' | 'undo' | 'restore' | 'external' | 'refresh';

export class TrainerError extends Error {
  constructor(msg: string, readonly status = 400) { super(msg); }
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// An id becomes "<id>.md" on disk; CON / NUL / COM1… cannot be files on a Windows host.
const RESERVED_DEVICE_ID = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function slugify(s: string): string {
  const slug = String(s ?? '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    || 'document';
  return RESERVED_DEVICE_ID.test(slug) ? `doc-${slug}` : slug;
}

// --- targets -------------------------------------------------------------------------------------

export interface Target { kind: Kind; id: string; absPath: string; relPath: string; collection?: Collection }

function toRel(abs: string): string { return relative(SERVICE_ROOT, abs).split(sep).join('/'); }

function contain(root: string, abs: string): void {
  const rel = relative(root, abs);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) throw new TrainerError('resolved path escapes the knowledge root');
}

/** Build the on-disk path for a NEW artifact. */
export function targetForNew(kind: Kind, id: string, opts: { collection?: Collection; jurisdiction?: string } = {}): Target {
  if (!ID_RE.test(id)) throw new TrainerError(`id "${id}" must be kebab-case (lower-case letters, digits and hyphens)`);
  if (RESERVED_DEVICE_ID.test(id)) throw new TrainerError(`id "${id}" is a reserved device name on Windows and cannot be a file — use "doc-${id}"`);
  if (kind === 'note') {
    const absPath = join(NOTES_ROOT, `${id}.md`);
    contain(NOTES_ROOT, absPath);
    return { kind, id, absPath, relPath: toRel(absPath) };
  }
  const collection: Collection = opts.collection ?? 'library';
  if (collection === 'regulatory') {
    const j = (opts.jurisdiction ?? '').toUpperCase();
    if (!JURISDICTION_SET.has(j)) throw new TrainerError(`a regulatory document needs a jurisdiction: one of ${[...JURISDICTION_SET].join(', ')}`);
    const absPath = join(REG_ROOT, j.toLowerCase(), `${id}.md`);
    contain(REG_ROOT, absPath);
    return { kind, id, absPath, relPath: toRel(absPath), collection };
  }
  const absPath = join(LIB_ROOT, `${id}.md`);
  contain(LIB_ROOT, absPath);
  return { kind, id, absPath, relPath: toRel(absPath), collection };
}

/** Locate an EXISTING artifact by id (as the loaders see it). */
export function findExisting(kind: Kind, id: string): Target | null {
  if (kind === 'note') {
    const n = loadNotes(true).find((x) => x.id === id);
    if (!n) {
      // A note file that fails validation is dropped by loadNotes; still let it be found by path
      // so a broken note can be repaired or deleted from the Trainer.
      const abs = join(NOTES_ROOT, `${id}.md`);
      return ID_RE.test(id) && existsSync(abs) ? { kind, id, absPath: abs, relPath: toRel(abs) } : null;
    }
    return { kind, id, absPath: n.path, relPath: toRel(n.path) };
  }
  const d = loadCorpus(true).find((x) => x.id === id);
  if (!d) return null;
  return { kind, id, absPath: d.path, relPath: toRel(d.path), collection: d.collection };
}

function targetFromRel(kind: Kind, relPath: string, docId: string): Target {
  const absPath = resolve(SERVICE_ROOT, relPath);
  contain(KNOWLEDGE, absPath);
  const collection: Collection | undefined = kind === 'note' ? undefined
    : relPath.startsWith('knowledge/regulatory/') ? 'regulatory' : 'library';
  return { kind, id: docId, absPath, relPath, collection };
}

// --- validation ----------------------------------------------------------------------------------

/** Validate proposed file content for its destination. Returns human-readable problems. */
export function validateContent(target: Target, content: string): string[] {
  const spec = target.kind === 'note' ? NOTES_SPEC
    : target.collection === 'regulatory' ? REGULATORY_SPEC : LIBRARY_SPEC;
  const parsed = parseFrontmatter(content, target.absPath, spec.collection);
  if (!parsed) return ['the frontmatter block is missing or its --- fences do not match'];
  const problems = validateDoc(parsed, spec);
  if (parsed.id !== target.id) problems.push(`the id in the file ("${parsed.id}") does not match "${target.id}"`);
  if ((parsed.meta.status ?? '').toLowerCase() === 'archived') {
    problems.push('"status: archived" is not used any more — delete the document instead (it can be undone)');
  }
  if (target.kind === 'doc' && target.collection === 'regulatory') {
    const dirJ = target.relPath.split('/')[2]?.toUpperCase();
    if (parsed.jurisdiction && dirJ && parsed.jurisdiction !== dirJ) {
      problems.push(`jurisdiction "${parsed.jurisdiction}" does not match the document's ${dirJ} folder`);
    }
  }
  if (target.kind === 'note') {
    const n = toNote(parsed);
    if (!n) problems.push('the note is empty or too long once flattened to a paragraph (see the server log for detail)');
  }
  return problems;
}

/** Duplicate-id guard: ids are the advisor's lookup key, and a duplicate silently shadows. */
function assertIdFree(kind: Kind, id: string): void {
  const dup = kind === 'note' ? loadNotes(true).some((n) => n.id === id) : loadCorpus(true).some((d) => d.id === id);
  if (dup) throw new TrainerError(`a ${kind === 'note' ? 'note' : 'document'} with id "${id}" already exists — ids must be unique`, 409);
}

// --- serialisation + git -------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

// Every git call: bounded (a hung credential helper or lock must not wedge the write chain), never
// prompts, never runs hooks or signing (a developer's global config must not be able to block or
// alter a trainer commit).
const GIT_OPTS = { cwd: SERVICE_ROOT, timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } } as const;
const git = (args: string[]) => execFileP('git', ['-c', 'commit.gpgsign=false', ...args], GIT_OPTS);

/**
 * Why the checkout must not receive a trainer commit right now, or null when it may. The commit
 * lands on whatever branch is checked out, so: never main/master (release branches only), never a
 * detached HEAD (the commit would be orphaned), never mid-merge/rebase/cherry-pick (it would be
 * folded into someone else's operation).
 */
export async function gitCommitRefusal(): Promise<string | null> {
  try {
    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = stdout.trim();
    if (branch === 'HEAD') return 'HEAD is detached';
    if (branch === 'main' || branch === 'master') return `checkout is on ${branch}`;
    for (const ref of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
      const r = await git(['rev-parse', '-q', '--verify', ref]).catch(() => null);
      if (r && r.stdout.trim()) return `a ${ref.replace('_HEAD', '').toLowerCase()} is in progress`;
    }
    return null;
  } catch (e: any) {
    return `git state could not be read (${String(e?.stderr || e?.message || e).trim().split('\n')[0]})`;
  }
}

async function gitCommit(absPath: string, relPath: string, op: Op, eventId: number, actorUserId: number): Promise<string | null> {
  if (!config.trainerGitCommit) return null;
  const refusal = await gitCommitRefusal();
  if (refusal) {
    console.error(`trainer: event ${eventId} is LIVE but was NOT git-committed (${refusal}) — it will be retried at the next startup sweep once the checkout is on a branch`);
    return null;
  }
  try {
    if (op === 'delete') await git(['rm', '-q', '--cached', '--ignore-unmatch', '--', absPath]);
    else await git(['add', '--', absPath]);
    const msg = `chore(ai-advisor): trainer ${op} ${relPath} (event #${eventId}, uid ${actorUserId})`;
    await git(['commit', '-q', '--no-verify', '-m', msg, '--', absPath]);
    const { stdout } = await git(['rev-parse', '--short', 'HEAD']);
    return stdout.trim();
  } catch (e: any) {
    const detail = e?.stderr || e?.stdout || e?.message || String(e);
    console.error(`trainer: event ${eventId} is LIVE but was NOT git-committed — commit ${relPath} by hand. ${String(detail).trim()}`);
    return null;
  }
}

/**
 * Startup sweep: commit what earlier runs could not (commits off at the time, a refusal, a git
 * error). Only the LATEST event per path can still be committed — an older event's content is no
 * longer what is on disk — so those are what the sweep tries; the rest stay NULL (the ledger is
 * the record either way). Returns how many it committed.
 */
export function sweepUncommitted(): Promise<number> {
  if (!config.trainerGitCommit) return Promise.resolve(0);
  return serialise(async () => {
    const refusal = await gitCommitRefusal();
    if (refusal) { console.error(`trainer: git sweep skipped — ${refusal}`); return 0; }
    const r = await query<{ id: number; path: string; op: Op; actor_user_id: number; after_content: string | null }>(
      `SELECT id, path, op, actor_user_id, after_content FROM kb_event e
        WHERE git_commit IS NULL AND id = (SELECT max(id) FROM kb_event WHERE path = e.path)
        ORDER BY id`);
    let n = 0;
    for (const ev of r.rows) {
      const abs = resolve(SERVICE_ROOT, ev.path);
      const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      if (current !== ev.after_content) continue;           // disk moved on without a ledger row — leave it
      const sha = await gitCommit(abs, ev.path, ev.op, Number(ev.id), Number(ev.actor_user_id));
      if (!sha) break;                                       // one failure is enough: the same cause hits the rest
      await query(`UPDATE kb_event SET git_commit = $2 WHERE id = $1`, [ev.id, sha]);
      n++;
    }
    if (n) console.log(`trainer: git sweep committed ${n} earlier change${n === 1 ? '' : 's'}`);
    return n;
  });
}

/** Live changes git does not hold: latest-per-path events with no commit sha. */
export async function uncommittedCount(): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM kb_event e
      WHERE git_commit IS NULL AND id = (SELECT max(id) FROM kb_event WHERE path = e.path)`);
  return Number(r.rows[0]?.n ?? 0);
}

// --- the write primitive -------------------------------------------------------------------------

export interface KbEvent {
  id: number; at: string; actor_user_id: number; via: Via; batch_id: number | null;
  kind: Kind; path: string; doc_id: string; op: Op;
  before_content: string | null; after_content: string | null; summary: string;
  undoes_event_id: number | null; restore_target: string | null; source_upload_id: number | null;
  git_commit: string | null;
}

interface WriteInput {
  target: Target;
  content: string | null;              // null = delete
  actor: TrainerIdentity;
  via: Via;
  summary: string;
  batchId?: number | null;
  undoesEventId?: number | null;
  restoreTarget?: string | null;
  sourceUploadId?: number | null;
  /** sha256 the caller's copy was based on; refused (409) if the file moved on. */
  expectedHash?: string | null;
  /** skip content validation (only for restores of ledger content that was valid when written) */
  trusted?: boolean;
  /** restore batches: a file that already matches is skipped (returns null) rather than refused */
  skipIfSame?: boolean;
}

interface EventInsert {
  actorUserId: number; via: Via; batchId: number | null; kind: Kind; path: string; docId: string; op: Op;
  before: string | null; after: string | null; summary: string;
  undoesEventId?: number | null; restoreTarget?: string | null; sourceUploadId?: number | null;
}

/** The one INSERT into kb_event. */
async function insertEvent(e: EventInsert): Promise<KbEvent> {
  const r = await query<KbEvent>(
    `INSERT INTO kb_event (actor_user_id, via, batch_id, kind, path, doc_id, op, before_content,
                           after_content, summary, undoes_event_id, restore_target, source_upload_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [e.actorUserId, e.via, e.batchId, e.kind, e.path, e.docId, e.op, e.before, e.after,
     e.summary.slice(0, 1000), e.undoesEventId ?? null, e.restoreTarget ?? null, e.sourceUploadId ?? null]);
  return r.rows[0];
}

/** Perform one file write (or delete) and record it. Not exported: callers use the ops below. */
async function write(input: WriteInput & { skipIfSame: true }): Promise<KbEvent | null>;
async function write(input: WriteInput): Promise<KbEvent>;
async function write(input: WriteInput): Promise<KbEvent | null> {
  const { target } = input;
  const exists = existsSync(target.absPath);
  const before = exists ? readFileSync(target.absPath, 'utf8') : null;
  if (input.expectedHash && (before === null || sha256(before) !== input.expectedHash)) {
    throw new TrainerError(before === null
      ? 'this document was removed since you opened it — reload the Library'
      : 'this document changed since you opened it — reload it and apply your edit again', 409);
  }
  const op: Op = input.content === null ? 'delete' : exists ? 'update' : 'create';
  if (op === 'delete' && !exists) throw new TrainerError(`${target.relPath} does not exist`, 404);
  if (input.content !== null && !input.trusted) {
    const problems = validateContent(target, input.content);
    if (problems.length) throw new TrainerError(problems.join('; '));
  }
  if (input.content !== null && before === input.content) {
    if (input.skipIfSame) return null;
    throw new TrainerError('nothing to change — the new content is identical to the current file', 409);
  }

  // --- disk (stage + rename; delete = unlink) ------------------------------------------------
  if (input.content === null) {
    unlinkSync(target.absPath);
  } else {
    mkdirSync(dirname(target.absPath), { recursive: true });
    mkdirSync(STAGING, { recursive: true });
    const tmp = join(STAGING, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    try {
      writeFileSync(tmp, input.content, 'utf8');
      renameSync(tmp, target.absPath);
    } catch (e) {
      try { if (existsSync(tmp)) rmSync(tmp); } catch { /* best effort */ }
      throw new TrainerError(`could not write the document: ${(e as Error).message}`, 500);
    }
  }

  // --- ledger --------------------------------------------------------------------------------
  // The row IS the record. If it cannot be written, put the disk back the way it was and fail: a
  // live change with no ledger row would be invisible to undo/restore (and for a delete, the
  // only copy of the text would be in this call's memory).
  let ev: KbEvent;
  try {
    ev = await insertEvent({
      actorUserId: input.actor.userId, via: input.via, batchId: input.batchId ?? null, kind: target.kind,
      path: target.relPath, docId: target.id, op, before, after: input.content, summary: input.summary,
      undoesEventId: input.undoesEventId ?? null, restoreTarget: input.restoreTarget ?? null,
      sourceUploadId: input.sourceUploadId ?? null,
    });
  } catch (e) {
    try {
      if (before === null) unlinkSync(target.absPath);
      else { mkdirSync(dirname(target.absPath), { recursive: true }); writeFileSync(target.absPath, before, 'utf8'); }
      console.error(`trainer: ledger insert failed for ${target.relPath}; disk change rolled back`, e);
    } catch (e2) {
      console.error(`trainer: ledger insert failed for ${target.relPath} AND the disk rollback failed — the file on disk is unrecorded`, e, e2);
    }
    throw new TrainerError('the change could not be recorded (database error) and was not applied', 503);
  }
  const sha = await gitCommit(target.absPath, target.relPath, op, ev.id, input.actor.userId);
  if (sha) {
    await query(`UPDATE kb_event SET git_commit = $2 WHERE id = $1`, [ev.id, sha]).catch(() => {});
    ev.git_commit = sha;
  }
  console.log(`trainer: ${op} ${target.relPath} (event ${ev.id}, via ${input.via}, uid ${input.actor.userId})`);
  return ev;
}

// --- public operations ---------------------------------------------------------------------------

export interface CreateInput {
  kind: Kind; id: string; content: string; actor: TrainerIdentity; via: Via; summary: string;
  collection?: Collection; jurisdiction?: string; sourceUploadId?: number | null;
}
export function createArtifact(i: CreateInput): Promise<KbEvent> {
  return serialise(async () => {
    const target = targetForNew(i.kind, i.id, { collection: i.collection, jurisdiction: i.jurisdiction });
    if (existsSync(target.absPath)) throw new TrainerError(`${target.relPath} already exists — edit it instead`, 409);
    assertIdFree(i.kind, i.id);
    return write({ target, content: i.content, actor: i.actor, via: i.via, summary: i.summary, sourceUploadId: i.sourceUploadId });
  });
}

export interface UpdateInput {
  kind: Kind; id: string; content: string; actor: TrainerIdentity; via: Via; summary: string;
  expectedHash?: string | null; sourceUploadId?: number | null;
}
export function updateArtifact(i: UpdateInput): Promise<KbEvent> {
  return serialise(async () => {
    const target = findExisting(i.kind, i.id);
    if (!target) throw new TrainerError(`no ${i.kind === 'note' ? 'note' : 'document'} with id "${i.id}"`, 404);
    return write({ target, content: i.content, actor: i.actor, via: i.via, summary: i.summary,
      expectedHash: i.expectedHash, sourceUploadId: i.sourceUploadId });
  });
}

export function deleteArtifact(i: { kind: Kind; id: string; actor: TrainerIdentity; via: Via; summary: string; expectedHash?: string | null }): Promise<KbEvent> {
  return serialise(async () => {
    const target = findExisting(i.kind, i.id);
    if (!target) throw new TrainerError(`no ${i.kind === 'note' ? 'note' : 'document'} with id "${i.id}"`, 404);
    return write({ target, content: null, actor: i.actor, via: i.via, summary: i.summary, expectedHash: i.expectedHash });
  });
}

/** Exact-match text replacement inside an existing artifact (for surgical edits to long docs). */
export function patchArtifact(i: { kind: Kind; id: string; find: string; replace: string; actor: TrainerIdentity; via: Via; summary: string }): Promise<KbEvent> {
  return serialise(async () => {
    const target = findExisting(i.kind, i.id);
    if (!target) throw new TrainerError(`no ${i.kind === 'note' ? 'note' : 'document'} with id "${i.id}"`, 404);
    const cur = readFileSync(target.absPath, 'utf8');
    if (!i.find) throw new TrainerError('find text is empty');
    const first = cur.indexOf(i.find);
    if (first === -1) throw new TrainerError('the text to replace was not found in the document — quote it exactly as it appears');
    if (cur.indexOf(i.find, first + i.find.length) !== -1) {
      throw new TrainerError('the text to replace appears more than once — include more surrounding text so it is unique');
    }
    const next = cur.slice(0, first) + i.replace + cur.slice(first + i.find.length);
    return write({ target, content: next, actor: i.actor, via: i.via, summary: i.summary });
  });
}

// --- undo / restore ------------------------------------------------------------------------------

async function getEvent(id: number): Promise<KbEvent> {
  const r = await query<KbEvent>(`SELECT * FROM kb_event WHERE id = $1`, [id]);
  if (!r.rowCount) throw new TrainerError(`no change #${id}`, 404);
  return r.rows[0];
}

export interface UndoResult { event: KbEvent | null; alreadyThere: boolean; discards: number[] }

/**
 * Put back what a change replaced. Writes the event's before_content as the new current content
 * (or removes the file if there was none). If later changes touched the same file, they are
 * discarded by this — the result lists them so the caller can say so.
 */
export function undoEvent(eventId: number, actor: TrainerIdentity, batchId?: number | null): Promise<UndoResult> {
  return serialise(async () => {
    const ev = await getEvent(eventId);
    const target = targetFromRel(ev.kind, ev.path, ev.doc_id);
    const current = existsSync(target.absPath) ? readFileSync(target.absPath, 'utf8') : null;
    const later = await query<{ id: number }>(
      `SELECT id FROM kb_event WHERE path = $1 AND id > $2 ORDER BY id`, [ev.path, eventId]);
    const discards = later.rows.map((r) => Number(r.id));
    if (current === ev.before_content) return { event: null, alreadyThere: true, discards: [] };
    if (ev.before_content !== null && ev.kind === 'doc') {
      // A file coming back must not collide with a doc that has since taken its id.
      const clash = loadCorpus(true).find((d) => d.id === ev.doc_id && toRel(d.path) !== ev.path);
      if (clash) throw new TrainerError(`another document now uses the id "${ev.doc_id}" (${toRel(clash.path)}); remove or rename it first`, 409);
    }
    const summary = `Undid change #${ev.id} (${ev.summary})`;
    const out = await write({ target, content: ev.before_content, actor, via: 'undo', summary,
      undoesEventId: ev.id, batchId: batchId ?? null, trusted: true });
    return { event: out, alreadyThere: false, discards };
  });
}

/** Undo every change in a batch (a restore, typically), latest first, as one new batch. */
export async function undoBatch(batchId: number, actor: TrainerIdentity): Promise<KbEvent[]> {
  const r = await query<{ id: number }>(`SELECT id FROM kb_event WHERE batch_id = $1 ORDER BY id DESC`, [batchId]);
  if (!r.rowCount) throw new TrainerError(`no batch #${batchId}`, 404);
  const newBatch = await nextBatchId();
  const out: KbEvent[] = [];
  for (const row of r.rows) {
    const u = await undoEvent(Number(row.id), actor, newBatch);
    if (u.event) out.push(u.event);
  }
  return out;
}

async function nextBatchId(): Promise<number> {
  const r = await query<{ n: string }>(`SELECT nextval('ai_advisor.kb_batch_seq') AS n`);
  return Number(r.rows[0].n);
}

export type RestorePoint =
  | { eventId: number }          // state AFTER this event (0 = before any recorded change)
  | { checkpointId: number }
  | { at: string };              // ISO timestamp: state as of that moment

/**
 * The ONE wire shape for a restore point — what the SSE restore card carries, what the History tab
 * posts, what POST /restore(/preview) reads. snake_case like every other field on the wire.
 */
export type WirePoint = { event_id?: number; checkpoint_id?: number; at?: string };

export function wirePoint(p: RestorePoint): WirePoint {
  if ('checkpointId' in p) return { checkpoint_id: p.checkpointId };
  if ('at' in p) return { at: p.at };
  return { event_id: p.eventId };
}

/** Parse a wire point. Accepts the snake_case shape and, defensively, the internal camelCase one. */
export function pointFromWire(b: unknown): RestorePoint {
  const o = (b ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => {
    const n = typeof v === 'string' ? Number(v.trim()) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new TrainerError('restore point must be a whole number');
    return n;
  };
  const cp = o.checkpoint_id ?? o.checkpointId;
  if (cp != null && cp !== '') return { checkpointId: num(cp) };
  if (o.at != null && o.at !== '') return { at: String(o.at) };
  const ev = o.event_id ?? o.eventId;
  if (ev != null && ev !== '') return { eventId: num(ev) };
  throw new TrainerError('give one of event_id, checkpoint_id or at');
}

export interface RestorePlanItem { path: string; kind: Kind; doc_id: string; action: RestoreAction; content: string | null }
/** `head` = the newest event id when the plan was made; a restore bound to a plan refuses if it moved. */
export interface RestorePlan { label: string; lastEventId: number; head: number; changes: RestorePlanItem[] }

async function ledgerHead(): Promise<number> {
  const r = await query<{ m: number | null }>(`SELECT max(id) AS m FROM kb_event`);
  return Number(r.rows[0].m ?? 0);
}

/** What restoring to a point would change, computed from the ledger alone. */
export async function planRestore(point: RestorePoint): Promise<RestorePlan> {
  let lastEventId: number;
  let label: string;
  if ('checkpointId' in point) {
    const r = await query<{ label: string; last_event_id: number }>(
      `SELECT label, last_event_id FROM kb_checkpoint WHERE id = $1`, [point.checkpointId]);
    if (!r.rowCount) throw new TrainerError(`no checkpoint #${point.checkpointId}`, 404);
    lastEventId = Number(r.rows[0].last_event_id);
    label = `checkpoint "${r.rows[0].label}"`;
  } else if ('at' in point) {
    const t = new Date(point.at);
    if (Number.isNaN(t.getTime())) throw new TrainerError('not a valid date/time');
    const r = await query<{ m: number | null }>(`SELECT max(id) AS m FROM kb_event WHERE at <= $1`, [t.toISOString()]);
    lastEventId = Number(r.rows[0].m ?? 0);
    label = t.toISOString();
  } else {
    if (!Number.isInteger(point.eventId) || point.eventId < 0) throw new TrainerError('bad change number');
    lastEventId = point.eventId;
    label = point.eventId === 0 ? 'before any recorded change' : `after change #${point.eventId}`;
  }
  // For every path touched after the point, the EARLIEST later event holds the content at the point.
  // (A 'snapshot' baseline has before == after, so a file first seen after the point comes out as
  // "already there" — the baseline is a floor, not a creation.)
  const head = await ledgerHead();
  const r = await query<{ path: string; kind: Kind; doc_id: string; before_content: string | null }>(
    `SELECT DISTINCT ON (path) path, kind, doc_id, before_content
       FROM kb_event WHERE id > $1 ORDER BY path, id ASC`, [lastEventId]);
  const changes: RestorePlanItem[] = [];
  for (const row of r.rows) {
    const abs = resolve(SERVICE_ROOT, row.path);
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    if (current === row.before_content) continue;
    const action: RestoreAction = row.before_content === null ? 'delete' : current === null ? 'create' : 'update';
    changes.push({ path: row.path, kind: row.kind, doc_id: row.doc_id, action, content: row.before_content });
  }
  return { label, lastEventId, head, changes };
}

/**
 * Binding between a previewed plan and the restore that follows it: the preview's ledger head and
 * change count. If the ledger moved in between (another change landed, the assistant kept working),
 * the person is looking at a stale list — refuse, and let them preview again.
 */
export interface RestoreGuard { expectHead?: number | null; expectChanges?: number | null }

/** Restore the whole knowledge base to a point. Returns the events written (one batch). */
export function restoreTo(point: RestorePoint, actor: TrainerIdentity, guard: RestoreGuard = {}): Promise<{ plan: RestorePlan; batchId: number | null; events: KbEvent[] }> {
  // Plan and write under ONE serialise slot so nothing can slip in between.
  return serialise(async () => {
    const plan = await planRestore(point);
    if (guard.expectHead != null && Number(guard.expectHead) !== plan.head) {
      throw new TrainerError(`the change log has moved since this restore was previewed (now at № ${plan.head}) — preview it again`, 409);
    }
    if (guard.expectChanges != null && Number(guard.expectChanges) !== plan.changes.length) {
      throw new TrainerError(`the restore would now change ${plan.changes.length} file${plan.changes.length === 1 ? '' : 's'}, not ${guard.expectChanges} — preview it again`, 409);
    }
    if (!plan.changes.length) return { plan, batchId: null, events: [] };
    const batchId = await nextBatchId();
    const events: KbEvent[] = [];
    for (const c of plan.changes) {
      const target = targetFromRel(c.kind, c.path, c.doc_id);
      const ev = await write({
        target, content: c.content, actor, via: 'restore', batchId, restoreTarget: plan.label, trusted: true,
        skipIfSame: true, summary: `Restored ${c.doc_id} to ${plan.label}`,
      });
      if (ev) events.push(ev);
    }
    return { plan, batchId, events };
  });
}

/** Put one artifact back to the version a given event produced (its after_content). */
export function restoreVersion(eventId: number, actor: TrainerIdentity): Promise<KbEvent> {
  return serialise(async () => {
    const ev = await getEvent(eventId);
    if (ev.after_content === null) throw new TrainerError(`change #${eventId} removed the document; undo it instead to bring the file back`);
    const target = targetFromRel(ev.kind, ev.path, ev.doc_id);
    if (ev.kind === 'doc') {
      const clash = loadCorpus(true).find((d) => d.id === ev.doc_id && toRel(d.path) !== ev.path);
      if (clash) throw new TrainerError(`another document now uses the id "${ev.doc_id}" (${toRel(clash.path)}); remove or rename it first`, 409);
    }
    return write({ target, content: ev.after_content, actor, via: 'restore', trusted: true,
      restoreTarget: `version from change #${ev.id}`,
      summary: `Restored ${ev.doc_id} to its version from change #${ev.id}` });
  });
}

// --- reconcile: changes made outside the Trainer --------------------------------------------------

const MANAGED_ROOTS = [REG_ROOT, LIB_ROOT, NOTES_ROOT];

/** Every .md under the managed collections (same rules as the corpus walker: no dot-dirs, no README). */
function walkManaged(dir: string, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const full = join(dir, name);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) { if (!name.startsWith('.')) walkManaged(full, out); }
    else if (name.toLowerCase().endsWith('.md') && name.toLowerCase() !== 'readme.md') out.push(full);
  }
  return out;
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

export interface ReconcileOpts {
  actorUserId?: number;
  /** Restrict to some service-relative paths (tests); default = every managed path, disk and ledger. */
  filter?: (relPath: string) => boolean;
  /**
   * What to do with a file the ledger has never seen. 'snapshot' (the first run ever): a baseline
   * row with before == after — the file predates the ledger, and restore/undo must treat it as the
   * floor, not delete it. 'create': every file is already ledgered after the first run, so an
   * unknown file is one that arrived since — an external create, restorable like any other.
   */
  unledgered: 'snapshot' | 'create';
}

export interface ReconcileResult { files: number; events: KbEvent[]; batchId: number | null }

/**
 * Compare disk with the ledger and record the difference as via='external' events (one batch).
 * Cheap: one md5 per file, one DISTINCT ON over the ledger; full text is fetched only for the paths
 * that actually drifted. Serialised with every other write so nothing lands between compare and record.
 */
export function reconcileExternal(opts: ReconcileOpts): Promise<ReconcileResult> {
  return serialise(async () => {
    const actor = opts.actorUserId ?? SYSTEM_ACTOR_ID;
    const keep = opts.filter ?? (() => true);
    const onDisk = new Map<string, string>();   // rel -> abs
    for (const root of MANAGED_ROOTS) for (const abs of walkManaged(root)) { const rel = toRel(abs); if (keep(rel)) onDisk.set(rel, abs); }
    // Hash in Postgres over the UTF-8 bytes so it matches Node's md5 whatever the server encoding.
    const led = await query<{ path: string; kind: Kind; doc_id: string; h: string | null }>(
      `SELECT path, kind, doc_id, md5(convert_to(after_content, 'UTF8')) AS h
         FROM (SELECT DISTINCT ON (path) path, kind, doc_id, after_content FROM kb_event ORDER BY path, id DESC) latest`);
    const ledger = new Map<string, { kind: Kind; doc_id: string; h: string | null }>();
    for (const r of led.rows) if (keep(r.path)) ledger.set(r.path, { kind: r.kind, doc_id: r.doc_id, h: r.h });

    type Drift = { rel: string; kind: Kind; docId: string; op: Op; after: string | null; needBefore: boolean };
    const drift: Drift[] = [];
    for (const [rel, abs] of onDisk) {
      let content: string; try { content = readFileSync(abs, 'utf8'); } catch { continue; }
      const kind: Kind = rel.startsWith('knowledge/notes/') ? 'note' : 'doc';
      const l = ledger.get(rel);
      const docId = parseFrontmatter(content, abs, kind === 'doc' && rel.startsWith('knowledge/regulatory/') ? 'regulatory' : 'library')?.id
        || l?.doc_id || basename(rel, '.md');
      if (!l) drift.push({ rel, kind, docId, op: opts.unledgered === 'snapshot' ? 'snapshot' : 'create', after: content, needBefore: false });
      else if (l.h === null) drift.push({ rel, kind, docId, op: 'create', after: content, needBefore: false });      // ledger says deleted; it is back
      else if (l.h !== md5(content)) drift.push({ rel, kind, docId, op: 'update', after: content, needBefore: true });
    }
    for (const [rel, l] of ledger) {
      if (l.h !== null && !onDisk.has(rel)) drift.push({ rel, kind: l.kind, docId: l.doc_id, op: 'delete', after: null, needBefore: true });
    }
    if (!drift.length) return { files: onDisk.size, events: [], batchId: null };

    const befores = new Map<string, string | null>();
    const needs = drift.filter((d) => d.needBefore).map((d) => d.rel);
    if (needs.length) {
      const r = await query<{ path: string; after_content: string | null }>(
        `SELECT DISTINCT ON (path) path, after_content FROM kb_event WHERE path = ANY($1::text[]) ORDER BY path, id DESC`, [needs]);
      for (const row of r.rows) befores.set(row.path, row.after_content);
    }
    const batchId = await nextBatchId();
    const events: KbEvent[] = [];
    for (const d of drift.sort((a, b) => a.rel.localeCompare(b.rel))) {
      const before = d.op === 'snapshot' ? d.after : d.needBefore ? (befores.get(d.rel) ?? null) : null;
      const summary = d.op === 'snapshot' ? `Baseline: ${d.docId} was on disk before the change log tracked it`
        : d.op === 'create' ? `${d.docId} appeared on disk outside the Trainer (deploy or edit)`
        : d.op === 'update' ? `${d.docId} was changed on disk outside the Trainer (deploy or edit)`
        : `${d.docId} was removed from disk outside the Trainer (deploy or edit)`;
      const ev = await insertEvent({ actorUserId: actor, via: 'external', batchId, kind: d.kind, path: d.rel, docId: d.docId, op: d.op, before, after: d.after, summary });
      events.push(ev);
      console.log(`trainer: reconcile ${d.op} ${d.rel} (event ${ev.id}, via external)`);
    }
    return { files: onDisk.size, events, batchId };
  });
}

/** Events the startup reconcile has recorded (changes made outside the Trainer), for /overview. */
export async function externalChangeCount(): Promise<number> {
  const r = await query<{ n: number }>(`SELECT count(*)::int AS n FROM kb_event WHERE via = 'external' AND op <> 'snapshot'`);
  return Number(r.rows[0]?.n ?? 0);
}

// --- reads ---------------------------------------------------------------------------------------

export interface RawArtifact { kind: Kind; id: string; path: string; collection?: Collection; content: string; hash: string }

export function readArtifact(kind: Kind, id: string): RawArtifact | null {
  const t = findExisting(kind, id);
  if (!t) return null;
  const content = readFileSync(t.absPath, 'utf8');
  return { kind, id, path: t.relPath, collection: t.collection, content, hash: sha256(content) };
}

export interface EventListOpts { limit?: number; beforeId?: number; path?: string; docId?: string; kind?: Kind }

export async function listEvents(o: EventListOpts = {}): Promise<KbEvent[]> {
  const where: string[] = []; const args: unknown[] = [];
  if (o.beforeId) { args.push(o.beforeId); where.push(`id < $${args.length}`); }
  if (o.path) { args.push(o.path); where.push(`path = $${args.length}`); }
  if (o.docId) { args.push(o.docId); where.push(`doc_id = $${args.length}`); }
  if (o.kind) { args.push(o.kind); where.push(`kind = $${args.length}`); }
  args.push(Math.min(Math.max(o.limit ?? 50, 1), 500));
  const r = await query<KbEvent>(
    `SELECT id, at, actor_user_id, via, batch_id, kind, path, doc_id, op, summary, undoes_event_id,
            restore_target, source_upload_id, git_commit,
            length(before_content) AS before_len, length(after_content) AS after_len
       FROM kb_event ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT $${args.length}`, args);
  return r.rows;
}

export function getEventFull(id: number): Promise<KbEvent> { return getEvent(id); }

/** Names for actor ids, from the CRM user table. Decoration: falls back to "user #N". */
export async function actorNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const uniq = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (!uniq.length) return out;
  try {
    const r = await query(
      `SELECT id, COALESCE(NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), ''), username) AS name
         FROM waterfind_user WHERE id = ANY($1::bigint[])`, [uniq]);
    for (const row of r.rows as any[]) out.set(Number(row.id), String(row.name ?? ''));
  } catch (e) {
    console.error('trainer: staff name lookup failed', e);
  }
  return out;
}

// --- checkpoints ---------------------------------------------------------------------------------

export interface Checkpoint { id: number; label: string; last_event_id: number; created_by: number; created_at: string }

export async function createCheckpoint(label: string, actor: TrainerIdentity): Promise<Checkpoint> {
  const clean = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!clean) throw new TrainerError('a checkpoint needs a label');
  const m = await query<{ m: number | null }>(`SELECT max(id) AS m FROM kb_event`);
  const r = await query<Checkpoint>(
    `INSERT INTO kb_checkpoint (label, last_event_id, created_by) VALUES ($1,$2,$3) RETURNING *`,
    [clean, Number(m.rows[0].m ?? 0), actor.userId]);
  return r.rows[0];
}

export async function listCheckpoints(): Promise<Checkpoint[]> {
  const r = await query<Checkpoint>(`SELECT * FROM kb_checkpoint ORDER BY id DESC LIMIT 100`);
  return r.rows;
}

export async function deleteCheckpoint(id: number): Promise<void> {
  const r = await query(`DELETE FROM kb_checkpoint WHERE id = $1`, [id]);
  if (!r.rowCount) throw new TrainerError(`no checkpoint #${id}`, 404);
}

// --- catalogue helpers shared by tools + routes ---------------------------------------------------

export function docSummary(d: KnowledgeDoc) {
  return {
    id: d.id, title: d.title, collection: d.collection, jurisdiction: d.jurisdiction,
    instrument: d.instrument, summary: d.summary, as_at: d.as_at, best_by: d.meta.best_by ?? '',
    // what the auto-refresh will actually act on: the explicit date, the implied as_at + TTL, or 'never'
    best_by_effective: bestByEffective(d.meta.best_by, d.as_at),
    source_urls: d.source_urls,
    tags: d.meta.tags ?? '', source_file: d.meta.source_file ?? '', path: toRel(d.path),
    chars: d.body.length,
  };
}

export function noteSummary(n: Note) {
  return {
    id: n.id, title: n.title, mode: n.mode, scope: n.scope, triggers: n.triggers, text: n.text,
    source_urls: n.sourceUrls, as_at: n.asAt, best_by: n.bestBy,
    best_by_effective: bestByEffective(n.bestBy, n.asAt), path: toRel(n.path),
  };
}

/** 'never' | YYYY-MM-DD | '' (no usable date). */
function bestByEffective(bestBy: string | undefined, asAt: string | undefined): string {
  if ((bestBy ?? '').trim() === 'never') return 'never';
  return effectiveBestBy(bestBy, asAt) ?? '';
}

export const SERVICE_ROOT_DIR = SERVICE_ROOT;
export const KNOWLEDGE_ROOT_DIR = KNOWLEDGE;
