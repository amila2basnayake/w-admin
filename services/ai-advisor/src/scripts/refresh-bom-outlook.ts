/**
 * Refresh knowledge/data/bom-climate-outlook.json from the BOM ACCESS-S monthly/seasonal
 * climate outlook (the Bureau's own calibrated rainfall forecast).
 *   npx tsx src/scripts/refresh-bom-outlook.ts [--force]
 *
 * Why this source: this is BOM's calibrated probabilistic rainfall outlook, queryable per grid
 * point, so it can be read at the INFLOW CATCHMENTS that actually drive storage (Dartmouth,
 * Eildon, Burrinjuck...) rather than as a national headline. Inflow, not rain on the farm, is
 * what moves allocations. The near-term (weekly/fortnightly) product is a separate script,
 * refresh-bom-weekly.ts, because the two manifests reissue on different schedules.
 *
 * Endpoint chain, fragility notes and validation live in bom-wms.ts. Site catalogue in
 * bom-sites.ts. Contract: fail-soft per product; a bad run degrades the snapshot's coverage,
 * never corrupts it or invents numbers — and a run whose PROBABILITY coverage collapses vs the
 * previous snapshot refuses to overwrite it (the climatology files are static and keep working
 * when the forecast naming convention breaks, so "some cells filled" is not proof of a forecast).
 *
 * Known endpoint limits, encoded below rather than worked around:
 *   - The WMS ignores the TIME parameter on the scenario/exceedance files, so mm totals are only
 *     retrievable for the FIRST period of each type. Later periods carry probabilities only
 *     (their quintile files put the period in the PATH, which does work).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SITES, type SiteDef } from '../bom-sites';
import { sydneyToday, nowIso } from '../au-dates';
import {
  MANIFEST_SEASONAL as MANIFEST, WMS, CLIMATOLOGY_BASELINE, PAST_ACCURACY_BASIS,
  fetchText, pointValue, pointValueWithTime, pool, round1, derive,
  asPct, asMm, asTempC, writeSnapshot, ymd, type SrcStatus,
} from './bom-wms';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'knowledge', 'data');
const TARGET = join(dataDir, 'bom-climate-outlook.json');
const today = sydneyToday();
const FORCE = process.argv.includes('--force');

function readExisting(): any | null {
  try {
    return JSON.parse(readFileSync(TARGET, 'utf8'));
  } catch {
    return null;
  }
}

/** Stamp the attempt on the EXISTING snapshot and leave its data untouched. Every exit path must
 *  do this: the scheduler backs off on last_refresh.at, and a failure that leaves no stamp gets
 *  retried at full rate forever. */
function stampAttempt(status: SrcStatus[], note: string): void {
  const doc = readExisting();
  if (!doc) return;
  doc.last_refresh = { at: nowIso(), method: 'refresh-bom-outlook.ts', note, sources_attempted: status };
  writeSnapshot(TARGET, doc);
}

// lead / skill_lead / forecast_span / forecast_type come straight from the manifest and are what
// name the past-accuracy files — the skill product is keyed by forecast lead time, not by date.
type PeriodMeta = {
  label: string; climatology_date_label: string;
  lead: string; skill_lead: string; forecast_span: string; forecast_type: string;
};

/** All products for one site x one period. `withTotals` only for the first period of a type —
 *  the WMS ignores TIME on the scenario files, so later periods get probabilities only. */
async function sitePeriod(site: SiteDef, kind: 'seasonal' | 'monthly', idx: number,
                          meta: PeriodMeta, init: string, withTotals: boolean) {
  const { lat, lon } = site;
  const quintNc = `forecasts/quintiles/${kind}/${init}/time_${idx}/rain.forecast.calib.quintile.aus.pall.${kind}.${init}.time_${idx}.nc`;
  const climNc = `climatology/${kind}/rain.climatology.median.${kind}.${meta.climatology_date_label}.${CLIMATOLOGY_BASELINE}.nc`;
  const scenarioNc = (p: number) =>
    `forecasts/exceedance/${kind}/${init}/rain.forecast.calib.scenario.aus.${p}.${kind}.${init}.nc`;

  // Temperature drives evaporation and irrigation demand — the demand side of the price question.
  const tmaxQuintNc = `forecasts/quintiles/${kind}/${init}/time_${idx}/tmax.forecast.calib.quintile.aus.pall.${kind}.${init}.time_${idx}.nc`;
  const tmaxClimNc = `climatology/${kind}/tmax.climatology.median.${kind}.${meta.climatology_date_label}.${CLIMATOLOGY_BASELINE}.nc`;
  // Past accuracy: BOM's weighted-percent-correct hindcast score for THIS lead and location.
  // Presenting a probability without it overstates what is known — seasonal accuracy varies a lot
  // by region and season. Layer is `skill_global` because the accuracy grids are global (.glb).
  // (The directory says hit_rate/, but the metric is WPC — see PAST_ACCURACY_BASIS.)
  const skillNc = (v: string) =>
    `skill/hc/hit_rate/${kind}/${v}.skill.wpc.median.${meta.forecast_type}.ini${meta.lead}.${meta.skill_lead}.${meta.forecast_span}.glb.nc`;

  const haveSkillMeta = Boolean(meta.lead && meta.skill_lead && meta.forecast_span);
  const [clim, bot, top, tmaxClim, tmaxTop, rainSkill, tmaxSkill] = await Promise.all([
    pointValue(`rain_climatology_${kind}`, climNc, lat, lon),
    pointValue('rain_bottom_quintile_probability', quintNc, lat, lon),
    pointValue('rain_top_quintile_probability', quintNc, lat, lon),
    pointValue('tmax_climatology', tmaxClimNc, lat, lon),
    pointValue('tmax_top_quintile_probability', tmaxQuintNc, lat, lon),
    haveSkillMeta ? pointValue('skill_global', skillNc('rain'), lat, lon) : Promise.resolve(null),
    haveSkillMeta ? pointValue('skill_global', skillNc('tmax'), lat, lon) : Promise.resolve(null),
  ]).then((vs) => [
    asMm(vs[0]), asPct(vs[1]), asPct(vs[2]), asTempC(vs[3]), asPct(vs[4]), asPct(vs[5]), asPct(vs[6]),
  ]);
  let p25: number | null = null, p50: number | null = null, p75: number | null = null;
  if (withTotals) {
    [p25, p50, p75] = await Promise.all([25, 50, 75].map((p) =>
      pointValue(`rain_exceedance_scenario_${kind}`, scenarioNc(p), lat, lon).then(asMm)));
  }

  return {
    period: meta.label,
    period_index: idx,
    climatology_median_mm: round1(clim),
    forecast_median_mm: round1(p50),
    // p25/p75 are EXCEEDANCE percentiles: a 25% chance of at least p25_mm, 75% of at least p75_mm.
    // So p25_mm > p75_mm. Named for the exceedance probability, not the distribution percentile.
    wet_case_mm_25pct_chance_of_exceeding: round1(p25),
    dry_case_mm_75pct_chance_of_exceeding: round1(p75),
    chance_unusually_dry_pct: round1(bot),
    chance_unusually_wet_pct: round1(top),
    ...derive(clim, p50, bot, top),
    temperature: {
      climatology_mean_max_c: round1(tmaxClim),
      chance_unusually_warm_pct: round1(tmaxTop),
      warm_odds_multiple_vs_normal: tmaxTop == null ? null : Math.round((tmaxTop / 20) * 10) / 10,
    },
    past_accuracy: {
      rain_past_accuracy_pct: round1(rainSkill),
      tmax_past_accuracy_pct: round1(tmaxSkill),
      basis: PAST_ACCURACY_BASIS,
    },
    totals_available: withTotals,
    note: withTotals ? null
      : 'mm totals are only published through this endpoint for the nearest period; probabilities only here.',
  };
}

/**
 * Recent OBSERVED monthly rainfall at a site, with the climatology band it landed in.
 *
 * These are ANTECEDENT CATCHMENT CONDITIONS, not a check on the forecast: past months and the
 * forecast period are different quantities over different windows. Catchment response to rainfall
 * is strongly non-linear in how wet the catchment already is — wet soils and elevated baseflow
 * turn the same forecast rain into materially more storage inflow, and therefore allocation.
 *
 * The series is walked by time_N rather than computed from the init date: whether the climagram
 * indexing is "calendar year to date" or a rolling window is not documented, and guessing wrong
 * would silently mislabel months. Probing until the values run out is robust to either — PROVIDED
 * the probe depth covers a full year: for the 2026-07-27 init time_0 was January, so a
 * November/December init needs ~11-12 steps. The old maxSteps=9 silently truncated the most
 * recent months from ~October onward, which is why this is now 13.
 */
async function siteObservations(site: SiteDef, init: string, maxSteps = 13, keepMonths = 3) {
  const { lat, lon } = site;
  const nc = (n: number) =>
    `forecasts/climagram/monthly/${init}/time_${n}/rain.forecast.calib.climagram.aus.monthly.${init}.time_${n}.nc`;

  const raw = await Promise.all(
    Array.from({ length: maxSteps }, (_, n) =>
      pointValueWithTime('climagram_obs', nc(n), lat, lon).then((r) => ({ n, value: asMm(r.value), time: r.time }))),
  );
  // Non-null = a completed, observed month. Forecast months come back empty on this layer.
  const observed = raw.filter((r) => r.value != null && r.time != null);
  if (observed.length === 0) return [];

  const recent = observed.slice(-keepMonths);
  // Climatology bands for those months, so "was it dry?" is answered against the local normal
  // rather than an absolute millimetre figure that means nothing without context.
  return Promise.all(recent.map(async (r) => {
    const [c40, c60] = await Promise.all([
      pointValue('climagram_clim_40', nc(r.n), lat, lon).then(asMm),
      pointValue('climagram_clim_60', nc(r.n), lat, lon).then(asMm),
    ]);
    // Classify from the ROUNDED values the snapshot stores, so the label always agrees with the
    // band a reader sees (raw-precision comparison flipped borderline dry-season cells).
    const mm = round1(r.value as number) as number;
    const lo = round1(c40), hi = round1(c60);
    let vs: string | null = null;
    if (lo != null && hi != null) {
      vs = mm < lo ? 'below normal' : mm > hi ? 'above normal' : 'near normal';
    }
    return {
      month: (r.time as string).slice(0, 7),
      observed_mm: mm,
      normal_band_mm: lo != null && hi != null ? [lo, hi] : null,
      vs_normal: vs,
    };
  }));
}

async function main() {
  const results: SrcStatus[] = [];

  const manifestRaw = await fetchText(MANIFEST);
  if (!manifestRaw) {
    console.error(`manifest fetch failed (${MANIFEST}) — snapshot left unchanged`);
    stampAttempt([{ url: MANIFEST, status: 'fetch failed', updated: false }], 'manifest fetch failed');
    process.exit(1);
  }
  let manifest: any;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    console.error('manifest fetched but is not valid JSON — snapshot left unchanged');
    stampAttempt([{ url: MANIFEST, status: 'invalid JSON', updated: false }], 'manifest invalid JSON');
    process.exit(1);
  }
  const s = manifest.settings ?? {};
  const init: string = String(s.init_date ?? '');
  if (!/^\d{8}$/.test(init)) {
    console.error(`manifest carries no usable init_date (got ${JSON.stringify(s.init_date)}) — snapshot left unchanged`);
    stampAttempt([{ url: MANIFEST, status: 'no init_date', updated: false }], 'manifest missing init_date');
    process.exit(1);
  }
  results.push({ url: MANIFEST, status: `ok (issued ${s.issue_date}, init ${init})`, updated: true });

  // Same issue as the snapshot already holds -> nothing new to pull. This makes the scheduler's
  // on-issue-day retries cost ONE request each instead of a ~1,600-request sweep, so it can poll
  // every tick on the day BOM is due to publish without being impolite.
  const existing = readExisting();
  const manifestIssue = s.issue_date ? ymd(String(s.issue_date)) : null;
  if (!FORCE && existing && manifestIssue && existing.issue_date === manifestIssue &&
      (existing.coverage?.filled ?? 0) > 0) {
    console.log(`BOM issue ${manifestIssue} already ingested — nothing to do (use --force to re-pull)`);
    stampAttempt(results, `no new issue (still ${manifestIssue})`);
    return;
  }

  const periodsOf = (kind: 'seasonal' | 'monthly'): PeriodMeta[] => {
    const block = s.rainfall?.[kind] ?? {};
    // Numeric sort: Object.keys are "0","1",... — a lexicographic sort would break at 10 periods.
    return Object.keys(block).sort((a, b) => Number(a) - Number(b)).map((k) => ({
      label: String(block[k].label ?? '').replace(/&ndash;/g, '-').trim(),
      climatology_date_label: String(block[k].climatology_date_label ?? ''),
      lead: String(block[k].lead ?? ''),
      skill_lead: String(block[k].skill_lead ?? ''),
      forecast_span: String(block[k].forecast_span ?? ''),
      forecast_type: String(block[k].forecast_type ?? kind),
    })).filter((p) => p.label && p.climatology_date_label);
  };
  const seasonal = periodsOf('seasonal');
  const monthly = periodsOf('monthly');
  if (seasonal.length === 0 && monthly.length === 0) {
    console.error('manifest parsed but lists no rainfall periods — snapshot left unchanged');
    stampAttempt(results, 'manifest listed no periods');
    process.exit(1);
  }

  // One flat work-list so the concurrency cap applies across the whole run, not per site.
  type Job = { site: SiteDef; kind: 'seasonal' | 'monthly'; idx: number; meta: PeriodMeta };
  const jobs: Job[] = [];
  for (const site of SITES) {
    seasonal.forEach((meta, idx) => jobs.push({ site, kind: 'seasonal', idx, meta }));
    monthly.forEach((meta, idx) => jobs.push({ site, kind: 'monthly', idx, meta }));
  }
  console.log(`querying ${jobs.length} site-periods (${SITES.length} sites x ${seasonal.length} seasonal + ${monthly.length} monthly)...`);

  const rows = await pool(jobs, 6, async (j) =>
    ({ key: j.site.key, kind: j.kind, data: await sitePeriod(j.site, j.kind, j.idx, j.meta, init, j.idx === 0) }));

  const bySite = new Map<string, { seasonal: any[]; monthly: any[] }>();
  for (const r of rows) {
    if (!bySite.has(r.key)) bySite.set(r.key, { seasonal: [], monthly: [] });
    bySite.get(r.key)![r.kind].push(r.data);
  }

  console.log(`querying recent observations for ${SITES.length} sites...`);
  const obsBySite = new Map<string, any[]>();
  const obsRows = await pool(SITES, 6, async (site) => {
    try { return { key: site.key, obs: await siteObservations(site, init) }; }
    catch { return { key: site.key, obs: [] as any[] }; }   // observations are an enhancement
  });
  for (const r of obsRows) obsBySite.set(r.key, r.obs);

  const sites = SITES.map((site) => {
    const got = bySite.get(site.key) ?? { seasonal: [], monthly: [] };
    const sortByIdx = (a: any, b: any) => a.period_index - b.period_index;
    return {
      key: site.key, name: site.name, role: site.role,
      lat: site.lat, lon: site.lon, valleys: site.valleys,
      seasonal: got.seasonal.sort(sortByIdx),
      monthly: got.monthly.sort(sortByIdx),
      recent_observations: obsBySite.get(site.key) ?? [],
    };
  });
  const obsCount = sites.reduce((n, s2) => n + s2.recent_observations.length, 0);
  results.push({ url: `${WMS} (climagram observations)`,
    status: obsCount > 0 ? `ok (${obsCount} observed months across ${SITES.length} sites)` : 'no observations parsed',
    updated: obsCount > 0 });

  // Coverage is the honest health metric — and it counts PROBABILITIES, the actual forecast.
  // Climatology is a static file that keeps working when the forecast naming convention breaks,
  // so counting it would let a forecast-free snapshot pass as healthy.
  const cells = sites.flatMap((s2) => [...s2.seasonal, ...s2.monthly]);
  const filled = cells.filter((c) => c.chance_unusually_dry_pct != null).length;
  results.push({ url: `${WMS} (GetFeatureInfo x ${jobs.length})`,
    status: filled > 0 ? `ok (${filled}/${cells.length} site-periods with forecast probabilities)` : 'no probabilities parsed',
    updated: filled > 0 });

  if (filled === 0) {
    console.error('no forecast probabilities retrieved — leaving the previous snapshot in place');
    stampAttempt(results, 'no probabilities retrieved');
    process.exit(1);
  }
  // Regression guard: refuse to replace a healthy snapshot with a gutted one. Ratio-based so a
  // legitimate structural change (BOM offering fewer/more periods, site list edits) still passes.
  const prevRatio = existing?.coverage?.cells > 0 ? existing.coverage.filled / existing.coverage.cells : null;
  const newRatio = filled / cells.length;
  if (!FORCE && prevRatio != null && prevRatio > 0 && newRatio < prevRatio * 0.5) {
    console.error(`probability coverage collapsed (${(newRatio * 100).toFixed(0)}% vs previous ` +
      `${(prevRatio * 100).toFixed(0)}%) — refusing to overwrite; use --force to override`);
    stampAttempt(results, `coverage regression ${(newRatio * 100).toFixed(0)}% vs ${(prevRatio * 100).toFixed(0)}%`);
    process.exit(1);
  }

  const doc = {
    dataset: 'bom-climate-outlook',
    description:
      'Bureau of Meteorology ACCESS-S calibrated monthly and seasonal RAINFALL OUTLOOK, point-queried at ' +
      'inflow catchments and irrigation districts across every system Waterfind trades (Murray-Darling ' +
      'Basin, QLD coastal schemes, Tasmania, WA and SA groundwater areas, coastal NSW/VIC). This is a ' +
      'probabilistic forecast issued by BOM — the authority on Australian climate prediction — not a ' +
      'Waterfind prediction and not a certainty. Inflow-catchment sites drive storage and therefore ' +
      'allocations; irrigation-district sites are demand-side context only.',
    as_at: today,
    issue_date: manifestIssue,
    next_issue_date: s.next_issue_date ? ymd(String(s.next_issue_date)) : null,
    model_init_date: ymd(init),
    headline: String(s.title ?? '').replace(/\s+/g, ' ').trim() || null,
    period_range: s.period_range ?? null,
    climatology_baseline: CLIMATOLOGY_BASELINE,
    coverage: { cells: cells.length, filled },
    reading_guide: {
      chance_unusually_dry_pct:
        'Probability the period lands in the driest fifth of the historical record. The climatological ' +
        'baseline is 20% by construction.',
      pct_of_normal: 'Forecast median rainfall as a percentage of the same-period climatological median.',
      exceedance_percentiles:
        'wet_case (25% chance of exceeding) is HIGHER than dry_case (75% chance of exceeding) — both are ' +
        'named for the exceedance probability, not the distribution percentile.',
      skill_caveat:
        'These are probabilistic outlooks: seasonal rainfall forecasts carry real but limited skill, and ' +
        'skill generally decays with lead time (though it also varies with the target season).',
      past_accuracy:
        'past_accuracy.rain_past_accuracy_pct is BOM\'s weighted-percent-correct hindcast score at this ' +
        'lead and location: % of years 1981-2018 correctly called above/below median, weighted by the ' +
        'observed anomaly. ~50% is chance level; BOM classes <=45 very low, 45-55 low, 55-65 moderate, ' +
        '65-75 high, >75 very high.',
      temperature:
        'chance_unusually_warm_pct is the probability of landing in the warmest fifth of the record (20% ' +
        'baseline, same as rainfall). climatology_mean_max_c is the 1981-2018 average daily maximum in ' +
        'degrees C — a historical average, not a forecast.',
      odds_multiples_are_not_amounts:
        '*_odds_multiple_vs_normal fields are dimensionless multiples of the 20% climatological baseline — ' +
        '4.6 means "4.6 times the normal odds", not 4.6 degrees and not 4.6 mm. This dataset publishes no ' +
        'forecast temperature anomaly; the only temperature figure is climatology_mean_max_c, a historical ' +
        'average.',
      recent_observations:
        'Observed rainfall for the last completed months, shown against the local 40th-60th percentile ' +
        'normal band. These describe antecedent conditions preceding the outlook periods, not forecast ' +
        'verification.',
    },
    sites,
    provenance: {
      source_name: 'Bureau of Meteorology — climate outlooks (ACCESS-S)',
      source_url: ['https://www.bom.gov.au/climate/outlooks/', MANIFEST],
      fetched_at: today,
      licence_or_terms_note: 'BOM data is CC BY 4.0 — attribute "Bureau of Meteorology" at point of use.',
      gaps: [
        'mm totals (median / exceedance scenarios) are only retrievable for the FIRST period of each type; ' +
        'the WMS ignores the TIME parameter on those files. Later periods carry probabilities only.',
        'The value endpoint is undocumented internal plumbing (a WMS proxy in front of BOM THREDDS) and can ' +
        'change without notice. Treat a coverage drop as an expected failure mode, not a data signal.',
        'Sites are single grid points chosen to represent a catchment, not catchment-averaged rainfall.',
        'The raw.median product was not ingested: its values did not reconcile with the calibrated ' +
        'products or the climatology, so only the calibrated scenario/quintile products are used.',
        'Shortest horizon here is a calendar month; the weekly/fortnightly outlook is the separate ' +
        'bom-weekly-outlook snapshot. No day-by-day forecast is ingested from any source.',
      ],
    },
    last_refresh: { at: nowIso(), method: 'refresh-bom-outlook.ts', note: null, sources_attempted: results },
  };

  writeSnapshot(TARGET, doc);

  for (const r of results) console.log(`${r.status.padEnd(46)} ${r.url}`);
  console.log(`snapshot as_at=${doc.as_at}, issued ${doc.issue_date}, next issue ${doc.next_issue_date}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
