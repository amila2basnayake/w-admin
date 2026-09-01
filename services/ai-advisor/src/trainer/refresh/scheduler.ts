import { config } from '../../config';
import { sweepKbRefresh, findDueItems, kbRefreshState } from './worker';

/**
 * Ticks for the knowledge auto-refresh. Deliberately dumb: all scheduling INTELLIGENCE lives in
 * the dueness rules (policy.ts — computed from the files' own best_by dates) and the attempt
 * backoff (worker.ts — read from the DB), both of which survive restarts. This module only makes
 * sure a pass RUNS now and then:
 *
 *   - a delayed boot pass, so a sidecar that was down for a week catches up minutes after it is
 *     back (dueness is in the files; nothing was lost while it was down)
 *   - a steady interval after that (default 6h)
 *
 * A tick with nothing due costs a corpus walk and one DB query. Restart storms are cheap for the
 * same reason: a freshly-refreshed corpus has nothing due.
 */

let started = false;

export function startKbRefreshScheduler(): void {
  if (started) return;
  started = true;
  if (!config.kbRefreshEnabled) {
    console.log('kb-refresh: off (KB_REFRESH=0, or the Trainer is off and KB_REFRESH is unset)');
    return;
  }
  // Boot pass at 45s: after the trainer's startup reconcile (1.5s) has recorded external changes,
  // and clear of the external-data refresher's boot pass (15s).
  setTimeout(() => { void sweepKbRefresh(); }, 45_000).unref?.();
  setInterval(() => { void sweepKbRefresh(); }, config.kbRefreshCheckMs).unref?.();
  console.log(`kb-refresh: on (checking every ${Math.round(config.kbRefreshCheckMs / 60000)} min, ${config.kbRefreshMaxPerTick} items per pass, model ${config.kbRefreshModel})`);
}

/** For /health and the Trainer overview. `due_now` walks the corpus — cheap, but not free. */
export function kbRefreshStatus(withDue = false) {
  return {
    enabled: config.kbRefreshEnabled,
    running: kbRefreshState.running,
    last_run: kbRefreshState.lastRun,
    last_error: kbRefreshState.lastError,
    ...(withDue ? { due_now: safeDueCount() } : {}),
  };
}

function safeDueCount(): number | null {
  try { return findDueItems().length; } catch { return null; }
}
