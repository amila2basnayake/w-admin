// B2 — per-client AI Advisor entitlement gate must FAIL CLOSED. Drives isAdvisorEnabled() directly
// against the live local DB and asserts both the verdict and the cache state for each path:
//   enabled       -> 'enabled',  and the verdict IS cached (up to the TTL)
//   disabled row  -> 'disabled', and the verdict is NOT cached (broker re-enable is immediate)
//   unknown uid   -> 'disabled', and NOT cached (a valid token whose user is gone is never enabled)
//   lookup error  -> 'unknown',  and NOTHING cached (fail closed; the middleware maps this to 503)
//
// Requires: local Postgres up (waterfind-db), RO role reachable — same as the other test-*.ts.
//   npx tsx test-advisor-flag.ts
//
// Flips ai_advisor for one real user to exercise the "row exists but disabled" branch, and restores
// the original value in a finally so the DB is left exactly as found.

import { isAdvisorEnabled, _advisorFlagCacheHas, _clearAdvisorFlagCache } from './src/data-db';
import { query, pool } from './src/db';

const UID_ENABLED = 2725534; // Beth  — left enabled
const UID_FLIP    = 119063;  // Stuart — temporarily disabled then restored
const UID_UNKNOWN = -1;      // no such waterfind_user row

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  (' + detail + ')' : ''}`); }
}

async function setFlag(uid: number, val: boolean | null) {
  await query('UPDATE public.waterfind_user SET ai_advisor = $2 WHERE id = $1', [uid, val]);
}
async function getFlag(uid: number): Promise<boolean | null> {
  const r = await query<{ ai_advisor: boolean | null }>(
    'SELECT ai_advisor FROM public.waterfind_user WHERE id = $1', [uid]);
  return r.rows[0]?.ai_advisor ?? null;
}

const origEnabled = await getFlag(UID_ENABLED);
const origFlip = await getFlag(UID_FLIP);

try {
  // 1. ENABLED -> 'enabled', and cached
  await setFlag(UID_ENABLED, true);
  _clearAdvisorFlagCache();
  const v1 = await isAdvisorEnabled(UID_ENABLED);
  ok("enabled uid -> 'enabled'", v1 === 'enabled', v1);
  ok('enabled verdict IS cached', _advisorFlagCacheHas(UID_ENABLED) === true);

  // ...and a cached 'enabled' is served within the TTL even after the DB flips to false (the
  // deliberate <=30s enabled-cache window from commit f3d9d6c).
  await setFlag(UID_ENABLED, false);
  const v1b = await isAdvisorEnabled(UID_ENABLED);
  ok('cached enabled served within TTL despite DB flip to false', v1b === 'enabled', v1b);
  await setFlag(UID_ENABLED, true);

  // 2. DISABLED row -> 'disabled', NOT cached, and re-enable is immediate
  await setFlag(UID_FLIP, false);
  _clearAdvisorFlagCache();
  const v2 = await isAdvisorEnabled(UID_FLIP);
  ok("disabled row -> 'disabled'", v2 === 'disabled', v2);
  ok('disabled verdict is NOT cached', _advisorFlagCacheHas(UID_FLIP) === false);
  await setFlag(UID_FLIP, true);
  const v2b = await isAdvisorEnabled(UID_FLIP);
  ok('re-enable takes effect on the very next request (no stale disabled)', v2b === 'enabled', v2b);

  // 3. UNKNOWN uid (zero rows) -> 'disabled', NOT cached — never treated as enabled
  _clearAdvisorFlagCache();
  const v3 = await isAdvisorEnabled(UID_UNKNOWN);
  ok("unknown uid (no row) -> 'disabled'", v3 === 'disabled', v3);
  ok('unknown-uid verdict is NOT cached', _advisorFlagCacheHas(UID_UNKNOWN) === false);

  // 4. LOOKUP ERROR -> 'unknown', NOTHING cached (does NOT fall back to enabled)
  _clearAdvisorFlagCache();
  const badUid = 'not-a-number' as unknown as number; // forces an int8 cast error in the query
  const v4 = await isAdvisorEnabled(badUid);
  ok("lookup error -> 'unknown' (fail closed, not enabled)", v4 === 'unknown', v4);
  ok('error verdict caches NOTHING', _advisorFlagCacheHas(badUid) === false);

  // The pool must still be healthy after the errored query (client rolled back + released).
  const v4b = await isAdvisorEnabled(UID_ENABLED);
  ok('read-only pool healthy after a lookup error', v4b === 'enabled', v4b);
} finally {
  // Restore the DB exactly as found.
  try { await setFlag(UID_ENABLED, origEnabled); } catch (e) { console.error('restore UID_ENABLED failed', e); }
  try { await setFlag(UID_FLIP, origFlip); } catch (e) { console.error('restore UID_FLIP failed', e); }
  await pool.end();
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
