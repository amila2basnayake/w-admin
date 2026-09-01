import { config } from '../../config';

/**
 * Best-by policy — the pure logic of the knowledge auto-refresh, kept free of I/O so every rule
 * here is unit-testable (test-kb-refresh.ts).
 *
 * The FILES are the schedule. An item is due when today (Sydney — the same calendar the rest of
 * the freshness chain uses, see au-dates.ts) has passed its effective best-by:
 *
 *   best_by: YYYY-MM-DD   due from that date
 *   best_by: never        never due ("never goes stale" — regulatory definitions, house style)
 *   (absent)              due at as_at + KB_REFRESH_TTL_DAYS — so the corpus that predates this
 *                         feature is covered without anyone stamping dates
 *
 * A missed tick therefore cannot lose a fire: however long the sidecar was down, everything whose
 * date passed in the meantime is due the moment it is back. The attempt history (kb_refresh_item)
 * only THROTTLES retries after an error or a flag; it never drives dueness.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** date + n days, YYYY-MM-DD (UTC arithmetic on date-only strings is exact). */
export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  return new Date(t + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The date an item becomes due, or null when it never does. `bestBy`/`asAt` come straight from
 * frontmatter, so junk values must degrade safely: an unparseable best_by is ignored (the as_at
 * fallback applies); no usable date at all = not eligible (never silently due-forever).
 */
export function effectiveBestBy(bestBy: string | undefined, asAt: string | undefined, ttlDays = config.kbRefreshTtlDays): string | null {
  const bb = (bestBy ?? '').trim();
  if (bb === 'never') return null;
  if (DATE_RE.test(bb)) return bb;
  const aa = (asAt ?? '').trim();
  if (DATE_RE.test(aa)) return addDays(aa, ttlDays);
  return null;
}

export function isDue(effective: string | null, today: string): boolean {
  return effective !== null && today >= effective;
}

/** Clamp the agent's proposed next best_by into [today+min, today+max]; junk gets the default TTL. */
export function clampNextBestBy(proposed: string | undefined, today: string): string {
  const min = addDays(today, config.kbRefreshMinIntervalDays);
  const max = addDays(today, config.kbRefreshMaxIntervalDays);
  const p = (proposed ?? '').trim();
  if (!DATE_RE.test(p)) return addDays(today, config.kbRefreshTtlDays);
  return p < min ? min : p > max ? max : p;
}

// --- verbatim protection -------------------------------------------------------------------------

/** The heading ingest.ts writes above the untouched original text of an uploaded document. */
const VERBATIM_RE = /^## Full text \(verbatim from /m;

/**
 * Split a document into the editable head and the verbatim tail. The refresh agent is only ever
 * shown the head and the worker reattaches the tail byte-for-byte, so an uploaded document's
 * original text CANNOT be rewritten by a refresh — structurally, not by instruction.
 */
export function splitVerbatim(content: string): { head: string; verbatimTail: string } {
  const m = VERBATIM_RE.exec(content);
  if (!m || m.index <= 0) return { head: content, verbatimTail: '' };
  return { head: content.slice(0, m.index), verbatimTail: content.slice(m.index) };
}

// --- frontmatter stamping ------------------------------------------------------------------------

/** A leading YAML frontmatter block: --- newline, body, newline ---, optional trailing newline. */
const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/;

/**
 * Rewrite as_at / best_by in a file's frontmatter, preserving everything else byte-for-byte.
 * best_by is inserted directly after as_at when the file does not carry it yet. Returns null when
 * the frontmatter fences don't match or as_at is missing — the caller treats that as an error
 * rather than writing a file it could not stamp.
 */
export function stampFreshness(content: string, stamp: { asAt: string; bestBy: string }): string | null {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/.exec(content);
  if (!m) return null;
  const [, open, fm, close, body] = m;
  const lines = fm.split(/\r?\n/);
  let asAtIdx = lines.findIndex((l) => /^as_at:/.test(l));
  if (asAtIdx === -1) {
    // The agent's corrected content kept a frontmatter block but dropped as_at: insert it (after
    // title/id) rather than failing the whole update. Only a MISSING block (below) is unstampable.
    const anchor = lines.findIndex((l) => /^title:/.test(l));
    const idIdx = lines.findIndex((l) => /^id:/.test(l));
    asAtIdx = (anchor !== -1 ? anchor : idIdx) + 1;
    lines.splice(asAtIdx, 0, `as_at: ${stamp.asAt}`);
  } else {
    lines[asAtIdx] = `as_at: ${stamp.asAt}`;
  }
  const bestByIdx = lines.findIndex((l) => /^best_by:/.test(l));
  if (bestByIdx !== -1) lines[bestByIdx] = `best_by: ${stamp.bestBy}`;
  else lines.splice(asAtIdx + 1, 0, `best_by: ${stamp.bestBy}`);
  return open + lines.join('\n') + close + body;
}

/** The leading frontmatter block (--- ... ---) of a document, or null when it has none. */
export function frontmatterBlock(content: string): string | null {
  const m = FRONTMATTER_RE.exec(content);
  return m ? m[1] : null;
}

// --- retry backoff -------------------------------------------------------------------------------

export type RefreshOutcome = 'confirmed' | 'updated' | 'flagged' | 'error' | 'deleted' | 'created';

export interface LastAttempt { outcome: RefreshOutcome; at: string }

/**
 * Should a due item be skipped this tick because of a recent attempt? confirmed/updated moved the
 * item's best_by, so they need no throttle; error and flagged left the file alone and WOULD re-run
 * every tick forever — the same failure mode the external-data refresher hit with permanently
 * blocked sources. Bad timestamps read as "long ago", which errs toward retrying.
 */
export function underBackoff(last: LastAttempt | undefined, now: Date): boolean {
  if (!last || (last.outcome !== 'error' && last.outcome !== 'flagged')) return false;
  const t = Date.parse(last.at);
  if (Number.isNaN(t)) return false;
  const hours = (now.getTime() - t) / 3_600_000;
  return hours < (last.outcome === 'error' ? config.kbRefreshErrorBackoffH : config.kbRefreshFlaggedBackoffH);
}
