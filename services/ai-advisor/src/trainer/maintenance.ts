import { query } from '../db';
import { config } from '../config';
import { reconcileExternal, sweepUncommitted, SYSTEM_ACTOR_ID } from './store';

/**
 * Startup maintenance for the knowledge ledger — runs once per process, after the DB is reachable:
 *
 *  1. reconcile: record anything that changed on disk while this process was not running (a deploy,
 *     a git pull, a developer edit, a replica sync) as via='external' events, so undo / restore-to-
 *     point reason over the real history. The first run ever writes 'snapshot' baselines for files
 *     that predate the ledger; every later run treats an unledgered file as an external create.
 *  2. git sweep (only when TRAINER_GIT_COMMIT=1): commit earlier changes that could not be committed
 *     at the time.
 *
 * Fire-and-forget, best effort: a failure is logged and the trainer still serves — the ledger rows
 * written by live changes are unaffected. Set TRAINER_MAINTENANCE=0 to skip (tests, one-off scripts).
 */

export interface MaintenanceStatus {
  ran_at: string | null;
  reconcile: { files: number; events: number; batch_id: number | null; first_run: boolean } | null;
  git_sweep: number | null;
  error: string | null;
}

export const maintenanceStatus: MaintenanceStatus = { ran_at: null, reconcile: null, git_sweep: null, error: null };

let started = false;

export async function runTrainerMaintenance(): Promise<MaintenanceStatus> {
  try {
    const prior = await query<{ n: number }>(`SELECT count(*)::int AS n FROM kb_reconcile`);
    const firstRun = Number(prior.rows[0]?.n ?? 0) === 0;
    const r = await reconcileExternal({ actorUserId: SYSTEM_ACTOR_ID, unledgered: firstRun ? 'snapshot' : 'create' });
    await query(`INSERT INTO kb_reconcile (files, events, batch_id) VALUES ($1,$2,$3)`, [r.files, r.events.length, r.batchId]);
    maintenanceStatus.reconcile = { files: r.files, events: r.events.length, batch_id: r.batchId, first_run: firstRun };
    const ext = r.events.filter((e) => e.op !== 'snapshot').length;
    console.log(`trainer: reconcile checked ${r.files} files — ${ext} external change${ext === 1 ? '' : 's'}${firstRun ? `, ${r.events.length - ext} baseline snapshot${r.events.length - ext === 1 ? '' : 's'}` : ''}`);
    maintenanceStatus.git_sweep = await sweepUncommitted();
    maintenanceStatus.error = null;
  } catch (e: any) {
    maintenanceStatus.error = String(e?.message ?? e);
    console.error('trainer: startup maintenance failed (the trainer still serves; undo/restore may not see changes made outside it)', e);
  }
  maintenanceStatus.ran_at = new Date().toISOString();
  return maintenanceStatus;
}

/** Schedule the startup maintenance once (idempotent). Called from the router module on load. */
export function startTrainerMaintenance(delayMs = 1500): void {
  if (started || !config.trainerEnabled || process.env.TRAINER_MAINTENANCE === '0') return;
  started = true;
  const t = setTimeout(() => { void runTrainerMaintenance(); }, delayMs);
  t.unref?.();
}
