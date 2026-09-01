/**
 * Offline test for the auto-refresh scheduler's DUE-NESS logic. No network, no spawning.
 *   npx tsx test-refresh-scheduler.ts
 * The predicates are the whole safety story: too eager and every sidecar restart fires a
 * ~1,600-request BOM sweep; too lazy and the advisor answers from a superseded forecast, which is
 * the failure this was built to prevent. Both directions are asserted against the real JOBS.
 *
 * 2026-08-06 semantics: all dates are SYDNEY calendar dates; the climate job is due ON the reissue
 * day (>=, not the day after — the old strict > compounded with UTC dates into a ~24-40h weekly
 * window of serving superseded data); attempt stamps are full ISO timestamps and back off at hour
 * granularity, which is safe because the BOM refreshers early-exit after one manifest request when
 * the on-disk issue is still current.
 */
import { JOBS, dueJobs, type Job } from './src/refresh-scheduler';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  ERR ${name}${detail ? ' — ' + detail : ''}`); }
}
const job = (name: string): Job => {
  const j = JOBS.find((x) => x.name === name);
  if (!j) throw new Error(`no job ${name}`);
  return j;
};

const climate = job('climate');
const weekly = job('climate-weekly');
const daily = job('nsw-dashboards');
// Sydney 2026-08-05 ~4pm — the fixture "now" most tests run at.
const NOW = new Date('2026-08-05T06:00:00Z');

console.log('=== climate: driven by BOM\'s own next_issue_date ===');
const fresh = { as_at: '2026-08-05', next_issue_date: '2026-08-06', issue_date: '2026-07-30',
  last_refresh: { at: '2026-08-05T02:00:00Z' } };
check('not due before BOM reissues', climate.due(fresh, '2026-08-05', NOW) === false);
check('DUE ON the reissue date (early-exit makes premature checks cost one request)',
  climate.due(fresh, '2026-08-06', new Date('2026-08-06T00:30:00Z')) === true);
check('DUE the day after BOM reissues', climate.due(fresh, '2026-08-07', new Date('2026-08-07T00:30:00Z')) === true);
check('missing snapshot is due', climate.due(null, '2026-08-05', NOW) === true);
// A manifest that stops carrying next_issue_date must not freeze the data forever.
const noNext = { as_at: '2026-08-05', last_refresh: { at: '2026-08-05T02:00:00Z' } };
check('no next_issue_date: not due within 7 days', climate.due(noNext, '2026-08-10', NOW) === false);
check('no next_issue_date: due at 7 days', climate.due(noNext, '2026-08-12', NOW) === true);
check('sidecar down a fortnight: due immediately on boot',
  climate.due({ as_at: '2026-07-22', next_issue_date: '2026-07-23', last_refresh: { at: '2026-07-22T00:00:00Z' } },
    '2026-08-05', NOW) === true);

console.log('\n=== hour-grained backoff around reissue time ===');
const issueDay = { as_at: '2026-08-06', next_issue_date: '2026-08-06', issue_date: '2026-07-30',
  last_refresh: { at: '2026-08-06T00:00:00Z' } };
check('attempted 2h ago on the reissue day -> not due (backoff)',
  climate.due(issueDay, '2026-08-06', new Date('2026-08-06T02:00:00Z')) === false);
check('attempted 6h ago on the reissue day -> due again (retry until the new issue lands)',
  climate.due(issueDay, '2026-08-06', new Date('2026-08-06T06:00:00Z')) === true);

console.log('\n=== restart storm: a dev bouncing the sidecar must not re-fire refreshes ===');
for (let i = 0; i < 5; i++) {
  check(`restart #${i + 1} with same-day data -> not due`, climate.due({ ...fresh }, '2026-08-05', NOW) === false);
}

console.log('\n=== climate-weekly: cheap manifest check on a tick cadence ===');
const wdoc = { as_at: '2026-08-05', issue_date: '2026-08-05', last_refresh: { at: '2026-08-05T02:00:00Z' } };
check('missing snapshot due', weekly.due(null, '2026-08-05', NOW) === true);
check('attempted 4h ago -> not due', weekly.due(wdoc, '2026-08-05', NOW) === false);
check('attempted 6h ago -> due (one-request manifest check)',
  weekly.due(wdoc, '2026-08-05', new Date('2026-08-05T08:00:00Z')) === true);
check('date-only attempt stamp (legacy) still parses and backs off daily-ish',
  weekly.due({ as_at: '2026-08-05', last_refresh: { at: '2026-08-05' } }, '2026-08-05',
    new Date('2026-08-05T02:00:00Z')) === false);

console.log('\n=== daily jobs ===');
check('same-day data not due', daily.due({ as_at: '2026-08-05' }, '2026-08-05', NOW) === false);
check('yesterday\'s data IS due', daily.due({ as_at: '2026-08-04' }, '2026-08-05', NOW) === true);
check('missing snapshot due', daily.due(null, '2026-08-05', NOW) === true);
check('unparseable date treated as due (fail toward freshness)',
  daily.due({ as_at: 'not-a-date' }, '2026-08-05', NOW) === true);

console.log('\n=== blocked sources must not be retried at full rate ===');
// Every refresher is fail-soft: a blocked source keeps the old records and leaves as_at behind.
// Scheduling must key off the ATTEMPT stamp, or a permanently-403 source is due on every tick.
// Observed for real: dam-storage stayed at 2026-07-08 while its refresher ran successfully.
const blockedFlat = { as_at: '2026-07-08', last_refresh: { at: '2026-08-05' } };
check('flat last_refresh.at stops the retry loop', daily.due(blockedFlat, '2026-08-05', NOW) === false,
  'stale as_at + fresh attempt must NOT be due');
const blockedNested = { as_at: '2026-07-08', provenance: { last_refresh: { at: '2026-08-05T04:40:34.872Z' } } };
check('nested provenance.last_refresh.at is honoured (extdata shape)',
  job('extdata').due(blockedNested, '2026-08-05', NOW) === false, 'stale as_at + fresh attempt must NOT be due');
check('a blocked source IS retried the next day',
  job('extdata').due(blockedNested, '2026-08-06', NOW) === true);
check('climate: superseded but attempted 2h ago -> not due',
  climate.due({ as_at: '2026-07-30', next_issue_date: '2026-08-06', last_refresh: { at: '2026-08-07T02:00:00Z' } },
    '2026-08-07', new Date('2026-08-07T04:00:00Z')) === false,
  'would retry every tick if attempt time were ignored');
check('climate: superseded and attempt is old -> due',
  climate.due({ as_at: '2026-07-30', next_issue_date: '2026-08-06', last_refresh: { at: '2026-08-06T20:00:00Z' } },
    '2026-08-07', new Date('2026-08-07T04:00:00Z')) === true);

console.log('\n=== job wiring ===');
check('every job names a script under src/scripts',
  JOBS.every((j) => /^src\/scripts\/refresh-[a-z-]+\.ts$/.test(j.script)), JSON.stringify(JOBS.map((j) => j.script)));
check('every job names a snapshot file', JOBS.every((j) => /\.json$/.test(j.file)));
check('job names are unique', new Set(JOBS.map((j) => j.name)).size === JOBS.length);
check('all five snapshots are covered', JOBS.length === 5, `got ${JOBS.length}`);
check('the BOM seasonal snapshot is scheduled', JOBS.some((j) => j.file === 'bom-climate-outlook.json'));
check('the BOM near-term snapshot is scheduled', JOBS.some((j) => j.file === 'bom-weekly-outlook.json'));

console.log('\n=== dueJobs reads the REAL snapshots on disk ===');
const nowDue = dueJobs();
check('a far-future date makes every job due', dueJobs('2099-01-01', JOBS, new Date('2099-01-01')).length === JOBS.length);
check('dueJobs returns real Job objects', nowDue.every((j) => typeof j.script === 'string'));
console.log(`  (informational: ${nowDue.length} job(s) due right now: ${nowDue.map((j) => j.name).join(', ') || 'none'})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
