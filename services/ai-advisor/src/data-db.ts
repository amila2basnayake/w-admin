import pg from 'pg';
import { config } from './config';

// int8 -> number (ids are within safe-integer range); mirrors db.ts in case this loads first.
pg.types.setTypeParser(20, (v) => (v == null ? null : parseInt(v, 10)));

// Least-privilege, read-only connection for the advisor's data-grounding tools.
const roPool = new pg.Pool({
  host: config.roDb.host,
  port: config.roDb.port,
  user: config.roDb.user,
  password: config.roDb.password,
  database: config.roDb.database,
  max: 6,
});

// node-postgres emits 'error' on the Pool when an IDLE connection dies (Postgres restart, network
// blip). With no listener attached, that error is unhandled and Node exits — one idle-client drop
// would take the whole sidecar down. Log with context and swallow; the pool discards the dead client
// and hands out a fresh one on the next checkout, so no reconnect logic is needed here.
roPool.on('error', (err) => {
  console.error('[data-db] idle client error on read-only pool (roPool):', err?.message ?? err);
});

export interface CallerCtx {
  uid: number;            // waterfind_user.id (the person) — from the verified token
  account: number | null; // registry_user.id (the account) — resolved from uid
  premium: boolean;
  accessClass: string | null;
  subclass: string | null;
  asof: string;
}

/** Plain read-only query (no caller GUC). Only used to resolve the caller's own row by uid. */
async function roQuery(sql: string, params: any[]): Promise<any[]> {
  const c = await roPool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r.rows;
  } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
  finally { c.release(); }
}

/**
 * Scoped read: sets `ai.account` / `ai.client` GUCs (consumed by the RLS policies) for the
 * duration of a READ ONLY transaction, so private tables can only ever return the caller's rows.
 */
export async function runScoped(ctx: CallerCtx, sql: string, params: any[] = []): Promise<any[]> {
  const c = await roPool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query("SELECT set_config('ai.account', $1, true), set_config('ai.client', $2, true)", [
      ctx.account == null ? '' : String(ctx.account),
      String(ctx.uid),
    ]);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r.rows;
  } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
  finally { c.release(); }
}

// Per-client AI Advisor entitlement (waterfind_user.ai_advisor, default ON for rows that exist).
// This is a compliance KILL SWITCH, enforced on every authenticated request so a broker's toggle
// also kills tokens minted before the disable (30-min token TTL), not just new mints. Because it is
// a control, it FAILS CLOSED: if the flag cannot be read we refuse the request (the middleware maps
// the 'unknown' verdict to 503) instead of assuming enabled, and we cache NOTHING from that path —
// the flag is re-checked the moment the DB recovers. A short cache keeps only confirmed-ENABLED
// verdicts off the hot path.
export type AdvisorFlag = 'enabled' | 'disabled' | 'unknown';
const advisorFlagCache = new Map<number, { at: number }>();
const ADVISOR_FLAG_TTL_MS = 30_000;

/**
 * Resolve the caller's entitlement:
 *   'enabled'  — ai_advisor is true (or NULL -> default-ON) for an existing row. Cached up to the TTL.
 *   'disabled' — ai_advisor is false, OR the uid has no waterfind_user row (a valid signed token whose
 *                user is gone is treated as disabled, never enabled). NEVER cached, so a broker
 *                re-enable takes effect on the very next request (see f3d9d6c).
 *   'unknown'  — the lookup itself failed (DB blip / restart). NEVER cached; the request is refused.
 */
export async function isAdvisorEnabled(uid: number): Promise<AdvisorFlag> {
  // Only confirmed-ENABLED verdicts are ever cached (a cached "disabled"/"unknown" could keep 403/503ing
  // a client after a broker re-enables them or the DB recovers), so any fresh hit is an enabled hit.
  const hit = advisorFlagCache.get(uid);
  if (hit && Date.now() - hit.at < ADVISOR_FLAG_TTL_MS) return 'enabled';
  let rows: any[];
  try {
    rows = await roQuery('SELECT COALESCE(ai_advisor, true) AS enabled FROM waterfind_user WHERE id = $1', [uid]);
  } catch (e) {
    // Fail CLOSED: cannot verify the kill switch -> refuse (mapped to 503) and cache nothing.
    console.error(`advisor-flag lookup failed for uid=${uid}; refusing (fail-closed, 503)`, e);
    return 'unknown';
  }
  const enabled = rows.length > 0 && rows[0].enabled === true;
  if (enabled) {
    advisorFlagCache.set(uid, { at: Date.now() });
    return 'enabled';
  }
  advisorFlagCache.delete(uid); // disabled / unknown-uid is never cached
  return 'disabled';
}

// Test-only introspection of the entitlement cache (see test-advisor-flag.ts). Inert in production.
export function _advisorFlagCacheHas(uid: number): boolean {
  const hit = advisorFlagCache.get(uid);
  return !!hit && Date.now() - hit.at < ADVISOR_FLAG_TTL_MS;
}
export function _clearAdvisorFlagCache(): void { advisorFlagCache.clear(); }

export async function resolveCallerContext(uid: number): Promise<CallerCtx> {
  const rows = await roQuery(
    `SELECT wu.registry_user AS account,
            COALESCE(wu.premium_user, false) AS premium,
            wu.subclass,
            at.name AS access_class
       FROM waterfind_user wu
       LEFT JOIN waterfind_user_type wut ON wut.id = wu.usertype
       LEFT JOIN access_type at ON at.id = wut.access_id
      WHERE wu.id = $1`,
    [uid],
  );
  const row = rows[0] || {};
  return {
    uid,
    account: row.account ?? null,
    premium: row.premium === true,
    accessClass: row.access_class ?? null,
    subclass: row.subclass ?? null,
    asof: config.asof,
  };
}
