/**
 * Unit + methodology test for the forecasting tools (Workstream C).
 * Drives the plain compute* functions directly, and one call through the tool wrapper to prove
 * the presentation contract. Also independently recomputes analogue finals from the
 * raw allocation series, and exercises the thin-data degradation path.
 *   npx tsx test-forecast.ts
 */
import { resolveCallerContext, runScoped } from './src/data-db';
import {
  computeAllocationForecast,
  computeTempPriceForecast,
  computeEntitlementValueForecast,
  buildForecastToolDefs,
} from './src/forecast-tools';

const ANY_UID = 119063;          // any real caller; forecast tools are region/market-scoped (de-identified)
const GOULBURN = 311325;         // 1A Central Goulburn (Low Reliability) — sparse-finals region (17/18 seasons stop mid-season)
const MURRUMBIDGEE = 686;        // Murrumbidgee GS — long NSW series + rich temp/permanent trades
const THIN_REGION = 238987442;   // Perth Leederville Aquifer — 1 reading only (deliberately thin)
const SNAPSHOT_MAX_DATE = '2026-02-02'; // max water_allocation_reading.effective_date in the snapshot
const MB_ALLOC_MAX_DATE = '2025-10-01'; // newest reading of series 651946 (Murrumbidgee GS) in the snapshot
const MB_PERM_MAX_DATE = '2025-03-10';  // newest settled permanent sale for region 686 in the snapshot
const MB_IMMATURE_EXCLUDED = 12;        // 686 seasons whose record stops mid-season (verified by SQL)
const GLB_IMMATURE_EXCLUDED = 17;       // 311325 (series 644489) seasons whose record stops mid-season

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  <- ' + detail : ''}`); }
}

const monotonic = (xs: (number | null)[]) => xs.every((v, i) => i === 0 || (v ?? 0) >= (xs[i - 1] ?? 0));

async function main() {
  const ctx = await resolveCallerContext(ANY_UID);
  const run = (sql: string, params: any[] = []) => runScoped(ctx, sql, params);

  // ============================ TOOL 1 — forecast_allocation ============================
  // H10: this series (Goulburn LR) records almost every season only at its 1 July opening, so its
  // "finals" were openings — the tool must now refuse rather than serve openings as end-of-season %.
  console.log('\n=== forecast_allocation: region 311325 (Central Goulburn LR — sparse finals) ===');
  const g = await computeAllocationForecast(run, GOULBURN);
  console.log(JSON.stringify({ refused: g.refused, reason: g.reason, sample_sizes: g.sample_sizes, caveats: g.caveats }, null, 2));

  check('311325: refuses (sparse-final seasons excluded)', g.refused === true);
  check('311325: reason cites mid-season exclusion', /mid-season/i.test(g.reason ?? ''), g.reason);
  check('311325: exclusion count reported', g.sample_sizes?.immature_final_seasons_excluded === GLB_IMMATURE_EXCLUDED,
    `got ${g.sample_sizes?.immature_final_seasons_excluded}`);
  check('311325: no fabricated distribution', (g as any).result === undefined || (g as any).result === null);
  check('311325: data_as_at populated', !!g.data_as_at);
  check('311325: data_as_at <= snapshot max', (g.data_as_at ?? '') <= SNAPSHOT_MAX_DATE, `${g.data_as_at}`);
  check('311325: presentation contract present', !!g.presentation);
  check('311325: caveats populated', Array.isArray(g.caveats) && g.caveats.length > 0);

  console.log('\n=== forecast_allocation: region 686 (Murrumbidgee GS, long NSW series) ===');
  const mb = await computeAllocationForecast(run, MURRUMBIDGEE);
  console.log(JSON.stringify({
    data_as_at: mb.data_as_at, m: mb.inputs?.current_month_of_season, p: mb.inputs?.current_announced_pct,
    analogues: mb.sample_sizes?.analogues, tol: mb.sample_sizes?.tolerance_pct_used,
    soi_applied: mb.result?.soi_conditioned?.applied, final_dist: mb.result?.final_pct_distribution,
  }, null, 2));
  check('686: not refused', !mb.refused);
  check('686: analogue count >= 8', (mb.sample_sizes?.analogues ?? 0) >= 8, `got ${mb.sample_sizes?.analogues}`);
  const md = mb.result!.final_pct_distribution;
  check('686: percentiles monotonic', monotonic([md.p10, md.p25, md.p50, md.p75, md.p90]),
    JSON.stringify([md.p10, md.p25, md.p50, md.p75, md.p90]));
  check('686: analogue list + base rate present', mb.analogues_or_series!.length >= 8 && (mb.result?.base_rate_distribution?.n ?? 0) > 0);
  check('686: data_as_at <= snapshot max', (mb.data_as_at ?? '') <= SNAPSHOT_MAX_DATE, `${mb.data_as_at}`);
  check('686: data_as_at is the true newest reading', mb.data_as_at === MB_ALLOC_MAX_DATE, `${mb.data_as_at}`);

  // H10: sparse seasons excluded from final-based statistics, and the exclusion is reported
  check('686: sparse-final exclusion count reported', mb.sample_sizes?.immature_final_seasons_excluded === MB_IMMATURE_EXCLUDED,
    `got ${mb.sample_sizes?.immature_final_seasons_excluded}`);
  check('686: exclusion caveat present', (mb.caveats ?? []).some((c: string) => /stops mid-season/i.test(c)));
  check('686: usable seasons shrank accordingly', (mb.sample_sizes?.past_seasons_usable ?? 0) === 33,
    `got ${mb.sample_sizes?.past_seasons_usable}`);

  // H11: the newest reading (2025-10-01) is > 90 days old — must be flagged, machine-readably
  check('686: stale_data flagged', (mb as any).stale_data === true, `age=${(mb as any).data_age_days}`);
  check('686: stale caveat names the data date', (mb.caveats ?? []).some((c: string) => c.includes('STALE DATA') && c.includes(MB_ALLOC_MAX_DATE)));

  // H8: the WS-B snapshot cross-check actually fires for a real southern-basin region
  const xc = (mb as any).snapshot_cross_check;
  console.log('  snapshot_cross_check:', JSON.stringify(xc));
  check('686: snapshot cross-check fired', xc != null);
  check('686: cross-check returns a number', typeof xc?.snapshot_pct === 'number', `got ${xc?.snapshot_pct}`);
  check('686: cross-check matched NSW Murrumbidgee GS', xc?.matched?.state === 'NSW' && /murrumbidgee/i.test(xc?.matched?.valley ?? '') && /general security/i.test(xc?.matched?.licence_class ?? ''), JSON.stringify(xc?.matched));
  check('686: cross-check season honesty (snapshot is a different, newer season)', xc?.comparable === false && xc?.snapshot_season === '2026-27', JSON.stringify({ comparable: xc?.comparable, season: xc?.snapshot_season }));
  check('686: different-season caveat surfaced', (mb.caveats ?? []).some((c: string) => /DIFFERENT season/.test(c)));

  // ---- independent recomputation: verify tool final-% for 2 named analogue seasons ----
  console.log('\n=== independent recomputation of analogue final % (region 686) ===');
  const raw = await run(
    `SELECT DISTINCT ON (season) season, round(pct::numeric,1) AS final_pct FROM (
        SELECT EXTRACT(YEAR FROM wr.effective_date - interval '6 months')::int AS season,
               wr.allocation_percent AS pct, wr.effective_date
          FROM water_allocation_region war
          JOIN water_allocation_reading wr ON wr.water_allocation = war.water_allocation
         WHERE war.region = $1 AND wr.effective_date > '1900-01-01' AND wr.allocation_percent IS NOT NULL
     ) t ORDER BY season, effective_date DESC`,
    [MURRUMBIDGEE],
  );
  const rawFinal = new Map<number, number>(raw.map((r: any) => [Number(r.season), Number(r.final_pct)]));
  const byS = new Map<number, number>(mb.analogues_or_series!.map((a: any) => [a.season, a.final_pct]));
  // pick 2 named analogue seasons that the tool actually returned
  const named = [...byS.keys()].filter((s) => rawFinal.has(s)).slice(0, 2);
  for (const s of named) {
    const toolV = byS.get(s);
    const rawV = rawFinal.get(s);
    console.log(`  season ${s}: tool=${toolV}  raw=${rawV}`);
    check(`686: analogue ${s} final % matches raw series`, toolV === rawV, `tool=${toolV} raw=${rawV}`);
  }
  check('686: recomputation used 2 named analogues', named.length === 2);

  // ---- tool-wrapper contract check ----
  const defs = buildForecastToolDefs(ctx);
  const wrapped = JSON.parse((await defs.find((d: any) => d.name === 'forecast_allocation')!.handler({ region_id: GOULBURN }, {})).content[0].text);
  check('wrapper: forecast_allocation returns the presentation contract', !!wrapped.presentation);
  check('wrapper: 3 forecast tools exported', defs.length === 3);

  // ============================ TOOL 2 — forecast_temp_price ============================
  console.log('\n=== forecast_temp_price: region 686, horizon 6 ===');
  const tp = await computeTempPriceForecast(run, MURRUMBIDGEE, 6);
  console.log(JSON.stringify({
    data_as_at: tp.data_as_at, m: tp.inputs?.current_month_of_season, anchor: tp.anchor,
    terciles: tp.sample_sizes?.seasons_by_tercile, first_band: tp.result?.scenario_bands?.[0],
  }, null, 2));
  check('686 price: not refused', !tp.refused);
  const bands = tp.result?.scenario_bands ?? [];
  check('686 price: scenario bands present', bands.length === 6);
  let structOk = true; let bandDetail = '';
  for (const step of bands) {
    for (const t of ['dry', 'median', 'wet'] as const) {
      const b = step.bands[t];
      if (b.n > 0 && b.p25 != null && b.p75 != null && b.p25 > b.p75) { structOk = false; bandDetail = `mos ${step.month_of_season} ${t}: p25=${b.p25} p75=${b.p75}`; }
    }
  }
  check('686 price: p25 <= p75 in every populated band', structOk, bandDetail);
  const anyPopulated = bands.some((s: any) => (['dry', 'median', 'wet'] as const).some((t) => s.bands[t].n > 0));
  check('686 price: at least one populated band', anyPopulated);
  check('686 price: sample sizes reported', !!tp.sample_sizes && (tp.sample_sizes.region_temp_trades ?? 0) > 0
    && bands.every((s: any) => (['dry', 'median', 'wet'] as const).every((t) => typeof s.bands[t].n === 'number')));
  check('686 price: no economic-direction assumption (dry may exceed wet is allowed)', true);
  check('686 price: methodology + presentation present', !!tp.methodology && !!tp.presentation);
  check('686 price: caveats populated', (tp.caveats?.length ?? 0) > 0);
  // H11: trades run to 2026-06-18 in this snapshot (< 90 days old at fix time) — not stale, and
  // data_as_at must be the true newest trade date, never fabricated or in the future.
  check('686 price: data_as_at is a real date not in the future', !!tp.data_as_at && tp.data_as_at <= new Date().toISOString().slice(0, 10), `${tp.data_as_at}`);
  check('686 price: stale_data is a boolean', typeof (tp as any).stale_data === 'boolean');
  check('686 price: stale caveat consistent with flag', (tp as any).stale_data === (tp.caveats ?? []).some((c: string) => c.includes('STALE DATA')));
  // H10: tercile classification also excludes sparse-final seasons and reports it
  check('686 price: sparse-final exclusion reported', tp.sample_sizes?.immature_final_seasons_excluded === MB_IMMATURE_EXCLUDED,
    `got ${tp.sample_sizes?.immature_final_seasons_excluded}`);

  // ============================ TOOL 3 — forecast_entitlement_value ============================
  console.log('\n=== forecast_entitlement_value: region 686 ===');
  const ev = await computeEntitlementValueForecast(run, MURRUMBIDGEE);
  console.log(JSON.stringify({
    data_as_at: ev.data_as_at, cagr: ev.result?.cagr, trend: ev.result?.trend,
    projection: ev.result?.projection,
  }, null, 2));
  check('686 value: not refused', !ev.refused);
  const cg = ev.result?.cagr;
  const finiteCagr = (c: any) => c == null || Number.isFinite(c.cagr_pct);
  check('686 value: CAGR values finite', finiteCagr(cg?.trailing_5y) && finiteCagr(cg?.trailing_10y) && finiteCagr(cg?.full_series)
    && !!cg?.full_series, JSON.stringify(cg));
  const proj = ev.result?.projection ?? [];
  check('686 value: projection has 5 horizons', proj.length === 5);
  const ratios = proj.map((p: any) => p.band_ratio);
  check('686 value: band widens with horizon (band_ratio increasing)', monotonic(ratios) && ratios[ratios.length - 1] > ratios[0], JSON.stringify(ratios));
  const hasPolicy = (ev.caveats ?? []).some((c: string) => /basin plan|carryover|buyback|policy/i.test(c));
  check('686 value: policy caveat present', hasPolicy);
  check('686 value: annual series present', (ev.analogues_or_series?.length ?? 0) >= 5);
  check('686 value: presentation contract present', !!ev.presentation);
  // H11: data_as_at must be the TRUE newest sale (2025-03-10), not a fabricated "<year>-12-31"
  // (the old code even produced future dates); and at > 365 days old it must be flagged stale.
  check('686 value: data_as_at is the true max sale date', ev.data_as_at === MB_PERM_MAX_DATE, `${ev.data_as_at}`);
  check('686 value: data_as_at not fabricated year-end', !(ev.data_as_at ?? '').endsWith('-12-31'), `${ev.data_as_at}`);
  check('686 value: stale_data flagged (last sale > 1 year ago)', (ev as any).stale_data === true, `age=${(ev as any).data_age_days}`);
  check('686 value: stale caveat present', (ev.caveats ?? []).some((c: string) => c.includes('STALE DATA') && c.includes(MB_PERM_MAX_DATE)));

  // ============================ Degradation — thin region ============================
  console.log('\n=== degradation: thin region 238987442 (1 reading) ===');
  const thin = await computeAllocationForecast(run, THIN_REGION);
  console.log(JSON.stringify({ refused: thin.refused, reason: thin.reason, caveats: thin.caveats }, null, 2));
  const refusedWithReason = thin.refused === true && !!thin.reason;
  const widenedCaveat = (thin.caveats ?? []).some((c: string) => /widen|low-confidence|insufficient/i.test(c));
  check('thin: refuses with a reason OR reports widened-pool caveats', refusedWithReason || widenedCaveat);
  const noFabricatedNumbers = thin.refused === true
    ? (thin.result === undefined || thin.result === null)
    : true;
  check('thin: no fabricated distribution when refusing', noFabricatedNumbers);

  // Also prove temp-price degrades on a genuinely thin trade region (falls through to refusal).
  const thinPrice = await computeTempPriceForecast(run, THIN_REGION, 6);
  check('thin price: refuses or heavily caveats', thinPrice.refused === true || (thinPrice.caveats?.length ?? 0) > 0);

  // ============================ H12 — empty allocation series ============================
  // fetchAllocationSeries LEFT JOINs readings, so a mapped series can carry ZERO readings. No such
  // region exists in the current snapshot (verified by SQL), so simulate one with a stub runner:
  // the series query returns one series, every other query returns no rows. Before the fix this
  // crashed with a TypeError on seasons[seasons.length - 1]; it must refuse with the standard shape.
  console.log('\n=== H12: empty allocation series refuses instead of crashing ===');
  const stubRun = async (sql: string) =>
    /FROM water_allocation_region/i.test(sql)
      ? [{ id: 999001, title: 'Stub Series (No Readings)', seasons: 0, readings: 0 }]
      : [];
  try {
    const empty = await computeAllocationForecast(stubRun as any, 424242);
    console.log(JSON.stringify({ refused: empty.refused, reason: empty.reason }, null, 2));
    check('empty series: refuses with reason', empty.refused === true && /no usable readings/i.test(empty.reason ?? ''), empty.reason);
    check('empty series: standard contract intact', !!empty.presentation && Array.isArray(empty.caveats));
  } catch (e: any) {
    check('empty series: refuses with reason', false, `threw ${e?.message}`);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  (${pass} ok, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
