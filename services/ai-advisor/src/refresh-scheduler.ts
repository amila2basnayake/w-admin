import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sydneyToday, hoursSince } from './au-dates';

/**
 * Self-refreshing external data. The snapshots under knowledge/data/ used to be refreshed by hand,
 * which meant that in practice they weren't: the BOM outlook reissues weekly and the advisor would
 * keep answering from a superseded forecast until someone remembered to run a script. Freshness
 * cannot depend on a human remembering.
 *
 * Design notes:
 * - Refreshers run as CHILD PROCESSES, never imported. They are scripts that call process.exit()
 *   on their failure paths — importing one would take the sidecar down with it. A child also
 *   contains a hung fetch or a crash to that run.
 * - Children are spawned under the parent's own loader (process.execArgv carries the tsx flags),
 *   so this works without npx and without a shell — which also sidesteps Windows quoting.
 * - Due-ness is computed from the DATA's own dates, not from a timer that resets on restart. A dev
 *   restarting the sidecar five times must not fire five full BOM refreshes (a full BOM value pull
 *   is ~1,600 requests at 38 sites), and a sidecar that was down for a week must refresh as soon
 *   as it comes back.
 * - ALL calendar comparisons use the SYDNEY date. BOM issues on AEST mornings; with UTC dates the
 *   day-after-reissue condition fired ~10 hours later than it should, which compounded into a
 *   ~24-40h weekly window of serving a superseded outlook as current.
 * - The two BOM refreshers early-exit after ONE manifest request when the issue on disk is still
 *   current, so their due-predicates can fire every tick around reissue time at negligible cost.
 * - Everything is fail-soft. A refresher that fails leaves the previous snapshot untouched (their
 *   own contract), and a failed run here never propagates: worst case the data stays stale and the
 *   tools keep reporting their own staleness, which they already do.
 */

const here = dirname(fileURLToPath(import.meta.url));          // services/ai-advisor/src
const serviceRoot = join(here, '..');
const dataDir = join(serviceRoot, 'knowledge', 'data');

const DAY = 24 * 60 * 60 * 1000;

export type Job = {
  name: string;
  script: string;                 // relative to services/ai-advisor
  file: string;                   // its snapshot, relative to knowledge/data
  /** Is a run due, given the snapshot on disk and today's (Sydney) date? `now` backs the
   *  hour-grained attempt backoff and is injectable so the predicates test deterministically. */
  due: (doc: any | null, today: string, now?: Date) => boolean;
};

const daysBetween = (fromIso: string | null | undefined, today: string): number => {
  if (!fromIso) return Infinity;
  const a = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.floor((b - a) / DAY);
};

/**
 * When the refresher last RAN — not when the data last changed.
 *
 * These are the wrong thing to confuse. Every refresher is fail-soft: when a source is blocked
 * (mdba.gov.au 403s, the G-MW/WaterNSW DOM shifts) it keeps the previous records and leaves `as_at`
 * where it was. Scheduling off `as_at` therefore means a permanently-blocked source is "due"
 * forever and gets retried at full rate — observed live: dam-storage sat at 2026-07-08 while its
 * refresher ran fine, which would have re-scraped blocked endpoints every 6 hours indefinitely.
 * Every refresher stamps its own attempt time (now a full ISO timestamp, so backoff can be
 * hour-grained), so back off on that instead.
 */
const lastAttempt = (doc: any | null): string | null =>
  doc?.last_refresh?.at ?? doc?.provenance?.last_refresh?.at ?? doc?.as_at ?? doc?.provenance?.fetched_at ?? null;

/** Cheap-check jobs (the BOM pair) can afford to re-check every tick once their data MIGHT be
 *  stale — a no-new-issue run costs one manifest request. The guard is only against re-running
 *  within the same tick window. */
const TICK_BACKOFF_H = 5;

export const JOBS: Job[] = [
  {
    // Seasonal/monthly outlook. BOM publishes next_issue_date, so this is driven by the Bureau's
    // own schedule: from the reissue day ONWARD (>=, Sydney dates — on the issue day BOM publishes
    // mid-morning, and the early-exit makes premature checks nearly free), re-check each tick
    // until the refresher ingests the new issue. The 7-day floor catches a manifest that stops
    // carrying the field.
    name: 'climate',
    script: 'src/scripts/refresh-bom-outlook.ts',
    file: 'bom-climate-outlook.json',
    due: (doc, today, now) => {
      if (!doc) return true;
      if (doc.next_issue_date && today >= String(doc.next_issue_date)) {
        return hoursSince(lastAttempt(doc), now) >= TICK_BACKOFF_H;
      }
      return daysBetween(lastAttempt(doc), today) >= 7;
    },
  },
  {
    // Near-term (multi-week) outlook. Its manifest carries NO next_issue_date and the product
    // reissues roughly twice a week, so: cheap manifest check every tick (>= 5h since last
    // attempt); the refresher only pulls values when the issue date actually changed.
    name: 'climate-weekly',
    script: 'src/scripts/refresh-bom-weekly.ts',
    file: 'bom-weekly-outlook.json',
    due: (doc, _today, now) => !doc || hoursSince(lastAttempt(doc), now) >= TICK_BACKOFF_H,
  },
  {
    name: 'nsw-dashboards',
    script: 'src/scripts/refresh-nsw-dashboards.ts',
    file: 'nsw-dashboards.json',
    due: (doc, today) => daysBetween(lastAttempt(doc), today) >= 1,   // NSW Tableau updates daily
  },
  {
    name: 'authority-outlooks',
    script: 'src/scripts/refresh-outlooks.ts',
    file: 'authority-outlooks.json',
    due: (doc, today) => daysBetween(lastAttempt(doc), today) >= 1,   // ENSO fortnightly, NVRM 1st+15th
  },
  {
    name: 'extdata',
    script: 'src/scripts/refresh-extdata.ts',
    file: 'dam-storage.json',
    due: (doc, today) => daysBetween(lastAttempt(doc), today) >= 1,
  },
];

function readSnapshot(file: string): any | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
  } catch {
    return null;                  // missing/corrupt reads as "due"
  }
}

/** Which jobs are due right now. Exported so it can be tested without spawning anything. */
export function dueJobs(today = sydneyToday(), jobs: Job[] = JOBS, now = new Date()): Job[] {
  return jobs.filter((j) => {
    try {
      return j.due(readSnapshot(j.file), today, now);
    } catch {
      return false;               // a broken predicate must not wedge the scheduler
    }
  });
}

export type RunRecord = { name: string; at: string; ok: boolean; detail: string };
const lastRuns = new Map<string, RunRecord>();
const inFlight = new Set<string>();

export const refreshStatus = () => ({
  enabled: ENABLED,
  running: [...inFlight],
  last_runs: Object.fromEntries(lastRuns),
});

/** Spawn one refresher. Resolves when it exits; never rejects. The timeout must cover a FULL BOM
 *  value pull: ~1,600 point queries at concurrency 6 runs several minutes on a slow day. */
function runJob(job: Job, timeoutMs = 15 * 60 * 1000): Promise<RunRecord> {
  return new Promise((resolve) => {
    const at = new Date().toISOString();
    if (inFlight.has(job.name)) {
      return resolve({ name: job.name, at, ok: false, detail: 'skipped — already running' });
    }
    inFlight.add(job.name);

    // Keep only the loader flags; --eval/-e and a script path would confuse the child.
    const loaderArgs: string[] = [];
    const argv = process.execArgv;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--require' || argv[i] === '--import') {
        loaderArgs.push(argv[i], argv[i + 1]);
        i++;
      }
    }

    const child = spawn(process.execPath, [...loaderArgs, join(serviceRoot, job.script)], {
      cwd: serviceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let out = '';
    const cap = (b: Buffer) => { if (out.length < 4000) out += b.toString(); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);

    const killer = setTimeout(() => child.kill(), timeoutMs);
    const finish = (ok: boolean, detail: string) => {
      clearTimeout(killer);
      inFlight.delete(job.name);
      const rec = { name: job.name, at, ok, detail: detail.replace(/\s+/g, ' ').trim().slice(0, 300) };
      lastRuns.set(job.name, rec);
      console.log(`refresh[${job.name}] ${ok ? 'ok' : 'FAILED'}: ${rec.detail}`);
      resolve(rec);
    };

    child.on('error', (e) => finish(false, `spawn failed: ${e.message}`));
    child.on('close', (code) => {
      const tail = out.split('\n').filter(Boolean).slice(-2).join(' | ');
      finish(code === 0, code === 0 ? tail : `exit ${code}: ${tail}`);
    });
  });
}

/** One pass: run every due job, SERIALLY. These are scraper-heavy (a full BOM value pull is over a
 *  thousand requests); firing them together would be a needless burst at public services. */
export async function tick(today = sydneyToday()): Promise<RunRecord[]> {
  const due = dueJobs(today);
  if (due.length === 0) return [];
  console.log(`refresh: ${due.length} snapshot(s) due — ${due.map((j) => j.name).join(', ')}`);
  const records: RunRecord[] = [];
  for (const job of due) records.push(await runJob(job));
  return records;
}

const ENABLED = process.env.ADVISOR_AUTO_REFRESH !== '0';
const CHECK_EVERY_MS = Number(process.env.ADVISOR_REFRESH_CHECK_MS ?? 6 * 60 * 60 * 1000);

/** Start the background refresher. Safe to call once at boot; a no-op when disabled. */
export function startRefreshScheduler(): void {
  if (!ENABLED) {
    console.log('refresh: auto-refresh disabled (ADVISOR_AUTO_REFRESH=0)');
    return;
  }
  // Boot pass is delayed so it never competes with startup or slows the first request. It only
  // does work if the DATA is actually stale, so restarts are cheap.
  setTimeout(() => { void tick(); }, 15_000).unref();
  setInterval(() => { void tick(); }, CHECK_EVERY_MS).unref();
  console.log(`refresh: auto-refresh on (checking every ${Math.round(CHECK_EVERY_MS / 60000)} min)`);
}
