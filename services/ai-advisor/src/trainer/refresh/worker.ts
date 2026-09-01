import { relative, sep } from 'node:path';
import { pool, query } from '../../db';
import { config } from '../../config';
import { sydneyToday } from '../../au-dates';
import { loadCorpus } from '../../knowledge-tools';
import { loadNotes } from '../../notes';
import {
  readArtifact, updateArtifact, createArtifact, deleteArtifact, SYSTEM_ACTOR_ID, SERVICE_ROOT_DIR, TrainerError, type Kind,
} from '../store';
import type { NewItemSpec } from './agent';
import type { TrainerIdentity } from '../auth';
import {
  effectiveBestBy, isDue, clampNextBestBy, splitVerbatim, stampFreshness, frontmatterBlock, underBackoff,
  type RefreshOutcome, type LastAttempt,
} from './policy';
import { runRefreshAgent, type RefreshRunner, type RefreshInput } from './agent';
import { refreshRecipients, renderDigest, type DigestItem } from './notify';
import { sendMail } from '../../mailer';
import { recordSpend } from '../../spend';

/**
 * The refresh sweep: find every document/note whose best-by has passed, re-verify each with the
 * refresh agent, apply what it found THROUGH THE STORE (validated, serialised, ledgered as
 * via='refresh' — undoable from History like any human change), record the run, and email the
 * digest to everyone holding the AI Trainer role.
 *
 * Concurrency: one sweep per process (inFlight) AND one sweep per database (a Postgres advisory
 * lock) — two sidecars sharing a DB (dev + laptop replica, a rolling deploy) must not both run the
 * agent and both send the digest. The lock is held on one pooled connection for the whole sweep.
 */

const EDIT_CAP = 60_000;              // chars of editable content shown to the agent
export const ADVISORY_LOCK_KEY = 0x6b_62_72_66;   // arbitrary constant: "kbrf"

const REFRESH_ACTOR: TrainerIdentity = { userId: SYSTEM_ACTOR_ID, name: 'Auto-refresh' };

export interface DueItem {
  kind: Kind;
  docId: string;
  title: string;
  relPath: string;
  asAt: string;
  sourceUrls: string[];
  effective: string;          // the date it became due
}

const toRel = (abs: string) => relative(SERVICE_ROOT_DIR, abs).split(sep).join('/');

/** Every eligible item currently due, most overdue first. Reads the files, never the DB. */
export function findDueItems(today = sydneyToday()): DueItem[] {
  const out: DueItem[] = [];
  for (const d of loadCorpus(true)) {
    const eff = effectiveBestBy(d.meta.best_by, d.as_at);
    if (isDue(eff, today)) {
      out.push({ kind: 'doc', docId: d.id, title: d.title, relPath: toRel(d.path), asAt: d.as_at, sourceUrls: d.source_urls, effective: eff! });
    }
  }
  for (const n of loadNotes(true)) {
    const eff = effectiveBestBy(n.bestBy, n.asAt);
    if (isDue(eff, today)) {
      out.push({ kind: 'note', docId: n.id, title: n.title, relPath: toRel(n.path), asAt: n.asAt, sourceUrls: n.sourceUrls, effective: eff! });
    }
  }
  return out.sort((a, b) => a.effective.localeCompare(b.effective) || a.relPath.localeCompare(b.relPath));
}

/** Latest attempt per path, for backoff. */
async function lastAttempts(): Promise<Map<string, LastAttempt>> {
  const r = await query<{ path: string; outcome: RefreshOutcome; at: string }>(
    `SELECT DISTINCT ON (path) path, outcome, at FROM kb_refresh_item ORDER BY path, at DESC`);
  const m = new Map<string, LastAttempt>();
  for (const row of r.rows) m.set(row.path, { outcome: row.outcome, at: new Date(row.at).toISOString() });
  return m;
}

export interface ItemResult {
  item: DueItem;
  outcome: RefreshOutcome;
  detail: string;
  sources: string[];
  eventId: number | null;
  nextBestBy: string | null;
  costUsd: number | null;
}

/** Create one new document the agent proposed. Never throws — a bad spec becomes a 'flagged' result. */
async function createNewItem(spec: NewItemSpec, today: string, nextBestBy: string): Promise<ItemResult> {
  const title = /(^|\n)title:\s*(.+)/.exec(spec.content)?.[2]?.trim() || spec.id;
  const synthetic: DueItem = { kind: 'doc', docId: spec.id, title, relPath: `knowledge/${spec.collection}/${spec.id}.md`, asAt: '', sourceUrls: [], effective: '' };
  const base = { item: synthetic, sources: [] as string[], eventId: null, nextBestBy, costUsd: null };
  try {
    if (!frontmatterBlock(spec.content)) return { ...base, outcome: 'flagged', detail: `Proposed a new document "${spec.id}" but it had no frontmatter block; not added.` };
    const stamped = stampFreshness(spec.content, { asAt: today, bestBy: nextBestBy }) ?? spec.content;
    const ev = await createArtifact({ kind: 'doc', id: spec.id, content: stamped, actor: REFRESH_ACTOR, via: 'refresh',
      collection: spec.collection, jurisdiction: spec.jurisdiction, summary: `Auto-refresh: added "${title}" (${spec.collection})` });
    synthetic.relPath = ev.path;
    return { ...base, outcome: 'created', detail: `Added a new ${spec.collection} document "${title}".`, eventId: ev.id };
  } catch (e: any) {
    const msg = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 300);
    return { ...base, outcome: 'flagged', detail: `Wanted to add a new document "${spec.id}" but could not: ${msg}` };
  }
}

/**
 * Run the agent on one due item and apply its verdict. Never throws. Returns the primary result for
 * the due item PLUS one result per new document the agent added (outcome 'created'). A 'delete'
 * verdict removes the due item; new documents may accompany a confirm/update/delete (e.g. a
 * superseding instrument replacing a repealed one).
 */
async function processItem(item: DueItem, today: string, runner: RefreshRunner): Promise<ItemResult[]> {
  const base = { item, sources: [] as string[], eventId: null, nextBestBy: null, costUsd: null };
  try {
    const raw = readArtifact(item.kind, item.docId);
    if (!raw) return [{ ...base, outcome: 'error', detail: 'the item disappeared before it could be checked' }];
    const { head, verbatimTail } = item.kind === 'doc' ? splitVerbatim(raw.content) : { head: raw.content, verbatimTail: '' };
    const truncated = head.length > EDIT_CAP;
    const input: RefreshInput = {
      kind: item.kind, docId: item.docId, title: item.title, today, asAt: item.asAt,
      sourceUrls: item.sourceUrls, truncated,
      content: truncated ? head.slice(0, EDIT_CAP) + '\n\n[cut here — the item continues]' : head,
    };
    const v = await runner(input);
    const nextBestBy = clampNextBestBy(v.nextBestBy ?? undefined, today);
    const stampAndWrite = async (editable: string, summary: string): Promise<{ eventId: number | null; note: string }> => {
      const stamped = stampFreshness(editable + verbatimTail, { asAt: today, bestBy: nextBestBy });
      if (stamped === null) throw new TrainerError('the file has no frontmatter as_at to stamp');
      try {
        const ev = await updateArtifact({
          kind: item.kind, id: item.docId, content: stamped, actor: REFRESH_ACTOR, via: 'refresh',
          summary, expectedHash: raw.hash,
        });
        return { eventId: ev.id, note: '' };
      } catch (e) {
        if (e instanceof TrainerError && e.status === 409 && /identical/.test(e.message)) {
          return { eventId: null, note: ' (no file change was needed)' };
        }
        throw e;
      }
    };

    // The primary result for the due item. new_items are added afterwards, only on a successful
    // confirm / update / delete (not on flag or error — the agent should not spawn documents when
    // it could not even verify what it was looking at).
    let primary: ItemResult;
    let applied = false;
    if (v.outcome === 'delete') {
      const ev = await deleteArtifact({ kind: item.kind, id: item.docId, actor: REFRESH_ACTOR, via: 'refresh',
        summary: `Auto-refresh: removed "${item.title}" — ${v.detail}`, expectedHash: raw.hash });
      primary = { ...base, outcome: 'deleted', detail: v.detail, sources: v.sources, eventId: ev.id, nextBestBy: null, costUsd: v.costUsd };
      applied = true;
    } else if (v.outcome === 'confirmed') {
      const w = await stampAndWrite(head, `Auto-refresh: confirmed "${item.title}" is still current — ${v.detail}`);
      primary = { ...base, outcome: 'confirmed', detail: v.detail + w.note, sources: v.sources, eventId: w.eventId, nextBestBy, costUsd: v.costUsd };
      applied = true;
    } else if (v.outcome === 'updated' && truncated) {
      primary = { ...base, outcome: 'flagged', sources: v.sources, costUsd: v.costUsd,
        detail: `Needs an update but is too long to change automatically. ${v.detail}` };
    } else if (v.outcome === 'updated' && !v.updatedContent) {
      primary = { ...base, outcome: 'flagged', sources: v.sources, costUsd: v.costUsd,
        detail: `Marked as needing an update but no corrected content was produced. ${v.detail}` };
    } else if (v.outcome === 'updated' && v.updatedContent!.trim() === head.trim()) {
      const w = await stampAndWrite(head, `Auto-refresh: confirmed "${item.title}" is still current — ${v.detail}`);
      primary = { ...base, outcome: 'confirmed', detail: v.detail + w.note, sources: v.sources, eventId: w.eventId, nextBestBy, costUsd: v.costUsd };
      applied = true;
    } else if (v.outcome === 'updated') {
      // The agent is asked to echo the whole item (frontmatter included). When it returns only the
      // corrected BODY, reattach the original frontmatter so the metadata (id/title/summary/sources)
      // is preserved and the file is stampable — a formatting slip must not discard a real correction.
      let updated = v.updatedContent!;
      if (!frontmatterBlock(updated)) {
        const origFm = frontmatterBlock(head);
        if (!origFm) {
          primary = { ...base, outcome: 'flagged', sources: v.sources, costUsd: v.costUsd,
            detail: `Correction produced but could not be applied (no frontmatter to anchor it). ${v.detail}` };
          return [primary];
        }
        updated = origFm + '\n' + updated.replace(/^\s+/, '');
      }
      const w = await stampAndWrite(updated, `Auto-refresh: updated "${item.title}" — ${v.detail}`);
      primary = { ...base, outcome: 'updated', detail: v.detail + w.note, sources: v.sources, eventId: w.eventId, nextBestBy, costUsd: v.costUsd };
      applied = true;
    } else {
      primary = { ...base, outcome: 'flagged', detail: v.detail, sources: v.sources, costUsd: v.costUsd };
    }

    const results = [primary];
    if (applied) {
      for (const spec of (v.newItems ?? []).slice(0, 2)) results.push(await createNewItem(spec, today, nextBestBy));
    }
    return results;
  } catch (e: any) {
    const msg = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 400);
    console.error(`[kb-refresh] ${item.relPath}: ${msg}`);
    return [{ ...base, outcome: 'error', detail: msg }];
  }
}

// --- the sweep -----------------------------------------------------------------------------------

export interface SweepResult {
  runId: number;
  due: number;
  processed: ItemResult[];
  deferred: number;
  emailStatus: 'none' | 'sent' | 'console' | 'failed';
  recipients: string[];
}

export interface SweepOpts {
  today?: string;
  now?: Date;
  runner?: RefreshRunner;
  maxItems?: number;
  /** send the digest even to zero processed items? never — kept for symmetry; unused */
}

let inFlight = false;

export interface KbRefreshLastRun { at: string; run_id: number; processed: number; confirmed: number; updated: number; flagged: number; errors: number; deleted: number; created: number; email: string }
export const kbRefreshState: { running: boolean; lastRun: KbRefreshLastRun | null; lastError: string | null } = {
  running: false, lastRun: null, lastError: null,
};

/**
 * One sweep. Returns null when nothing was due (or another sweep holds the lock) — in which case
 * nothing is written and no email is sent. Never throws.
 */
export async function sweepKbRefresh(opts: SweepOpts = {}): Promise<SweepResult | null> {
  if (inFlight) return null;
  inFlight = true;
  kbRefreshState.running = true;
  const client = await pool.connect().catch((e) => { console.error('[kb-refresh] no DB connection', e); return null; });
  if (!client) { inFlight = false; kbRefreshState.running = false; return null; }
  try {
    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [ADVISORY_LOCK_KEY]);
    if (!lock.rows[0]?.ok) {
      console.log('[kb-refresh] another process is sweeping — skipped');
      return null;
    }
    try {
      return await sweepLocked(opts);
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } catch (e: any) {
    kbRefreshState.lastError = String(e?.message ?? e).slice(0, 400);
    console.error('[kb-refresh] sweep failed', e);
    return null;
  } finally {
    client.release();
    inFlight = false;
    kbRefreshState.running = false;
  }
}

async function sweepLocked(opts: SweepOpts): Promise<SweepResult | null> {
  const today = opts.today ?? sydneyToday();
  const now = opts.now ?? new Date();
  const runner = opts.runner ?? runRefreshAgent;
  const maxItems = opts.maxItems ?? config.kbRefreshMaxPerTick;

  const due = findDueItems(today);
  if (!due.length) return null;
  const attempts = await lastAttempts();
  const ready = due.filter((i) => !underBackoff(attempts.get(i.relPath), now));
  if (!ready.length) return null;
  const batch = ready.slice(0, maxItems);
  const deferred = ready.length - batch.length;
  console.log(`[kb-refresh] ${due.length} due, processing ${batch.length}${deferred ? ` (${deferred} deferred to the next pass)` : ''}`);

  const run = await query<{ id: number }>(
    `INSERT INTO kb_refresh_run (due) VALUES ($1) RETURNING id`, [due.length]);
  const runId = run.rows[0].id;

  const results: ItemResult[] = [];
  for (const item of batch) {
    // processItem returns the due item's result PLUS a result per document it added.
    const rs = await processItem(item, today, runner);
    for (const r of rs) {
      results.push(r);
      await query<{ id: number }>(
        `INSERT INTO kb_refresh_item (run_id, path, doc_id, kind, outcome, detail, sources, event_id, next_best_by, cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [runId, r.item.relPath, r.item.docId, r.item.kind, r.outcome, r.detail.slice(0, 1000),
         r.sources.join(', ').slice(0, 2000) || null, r.eventId, r.nextBestBy, r.costUsd],
      ).then((ins) => {
        const itemId = ins.rows[0]?.id;
        if (itemId != null && r.costUsd != null) void recordSpend({ source: 'kb_refresh', vendor: 'anthropic', model: config.kbRefreshModel, costUsd: r.costUsd, ref: `kb_refresh_item:${itemId}` });
      }).catch((e) => console.error('[kb-refresh] item record failed', e));
      console.log(`[kb-refresh] ${r.outcome} ${r.item.relPath}${r.eventId ? ` (change #${r.eventId})` : ''}: ${r.detail.slice(0, 160)}`);
    }
  }

  const count = (o: RefreshOutcome) => results.filter((r) => r.outcome === o).length;
  const cost = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);

  // --- the digest ------------------------------------------------------------------------------
  const digestItems: DigestItem[] = results.map((r) => ({
    outcome: r.outcome, kind: r.item.kind === 'note' ? 'note' : 'doc', docId: r.item.docId,
    title: r.item.title, detail: r.detail, sources: r.sources, eventId: r.eventId, nextBestBy: r.nextBestBy,
  }));
  const digest = renderDigest(digestItems, { today, deferred });
  const recipients = await refreshRecipients();
  let emailStatus: SweepResult['emailStatus'] = 'none';
  let emailDetail = 'no recipients — no staff account holds the trainer role with a usable email';
  if (recipients.length) {
    const sent = await sendMail({ to: recipients, subject: digest.subject, text: digest.text });
    emailStatus = sent.status;
    emailDetail = sent.detail;
  } else {
    console.warn(`[kb-refresh] digest NOT sent: ${emailDetail}`);
  }

  await query(
    `UPDATE kb_refresh_run
        SET finished_at = now(), processed = $2, confirmed = $3, updated = $4, flagged = $5, errors = $6,
            cost_usd = $7, email_status = $8, email_to = $9, email_subject = $10, email_body = $11, detail = $12,
            deleted = $13, created = $14
      WHERE id = $1`,
    [runId, results.length, count('confirmed'), count('updated'), count('flagged'), count('error'),
     cost.toFixed(4), emailStatus, recipients.join(', ') || null, digest.subject, digest.text, emailDetail,
     count('deleted'), count('created')],
  ).catch((e) => console.error('[kb-refresh] run record failed', e));

  kbRefreshState.lastRun = {
    at: new Date().toISOString(), run_id: runId, processed: results.length,
    confirmed: count('confirmed'), updated: count('updated'), flagged: count('flagged'), errors: count('error'),
    deleted: count('deleted'), created: count('created'),
    email: emailStatus,
  };
  kbRefreshState.lastError = null;
  console.log(`[kb-refresh] run #${runId}: ${digest.subject} — email ${emailStatus} to ${recipients.length} recipient(s)`);
  return { runId, due: due.length, processed: results, deferred, emailStatus, recipients };
}

/** The most recent runs, for the Trainer overview. */
export async function listRefreshRuns(limit = 10) {
  const r = await query(
    `SELECT id, started_at, finished_at, due, processed, confirmed, updated, flagged, errors, deleted, created, email_status, email_to
       FROM kb_refresh_run ORDER BY id DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 100)]);
  return r.rows;
}
