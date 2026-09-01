/**
 * Refresh knowledge/data/bom-weekly-outlook.json — BOM's NEAR-TERM (multi-week) rainfall and
 * temperature outlook: two weekly periods, two fortnights and a four-week aggregate, at the same
 * site catalogue as the seasonal snapshot.
 *   npx tsx src/scripts/refresh-bom-weekly.ts [--force]
 *
 * Why a separate script: the weekly product has its own manifest (outlook_w.json) on its own
 * reissue cadence (roughly twice a week, vs weekly for the seasonal product), and its manifest
 * carries NO next_issue_date — so freshness is handled by checking the manifest cheaply (one
 * request) on every scheduler pass and only pulling values (~1,300 requests) when the issue date
 * actually changes.
 *
 * This closes the "near-term" half of the weather requirement: before this, the advisor's shortest
 * forecast horizon was a full calendar month, and nothing told the model that a "next week" answer
 * was an extrapolation. NOTE: there is still no day-by-day forecast — the shortest period is a
 * week — and the tool text says so explicitly.
 *
 * File naming verified empirically 2026-08-06: the weekly products follow the exact convention of
 * the seasonal ones with kind = weekly | fortnightly | fourweekly (quintile probabilities per
 * time_N, exceedance scenario totals for the first period of each kind, climatology per
 * climatology_date_label, past-accuracy under skill/hc/hit_rate/<kind>/ with ini_avg).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SITES, type SiteDef } from '../bom-sites';
import { sydneyToday, nowIso } from '../au-dates';
import {
  MANIFEST_WEEKLY as MANIFEST, WMS, CLIMATOLOGY_BASELINE, PAST_ACCURACY_BASIS,
  fetchText, pointValue, pool, round1, derive, asPct, asMm, writeSnapshot, ymd, type SrcStatus,
} from './bom-wms';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'knowledge', 'data');
const TARGET = join(dataDir, 'bom-weekly-outlook.json');
const today = sydneyToday();
const FORCE = process.argv.includes('--force');

// The manifest also lists a "fourweekly" period, but no gridded files exist for it (probed
// 2026-08-06: every naming variant 500s; in BOM's own app it is only a timeline tab label, not a
// map product). Weekly + fortnightly span the same four weeks, so it is not ingested.
type Kind = 'weekly' | 'fortnightly';
const KINDS: Kind[] = ['weekly', 'fortnightly'];

function readExisting(): any | null {
  try {
    return JSON.parse(readFileSync(TARGET, 'utf8'));
  } catch {
    return null;
  }
}

function stampAttempt(status: SrcStatus[], note: string): void {
  const doc = readExisting();
  if (!doc) return;
  doc.last_refresh = { at: nowIso(), method: 'refresh-bom-weekly.ts', note, sources_attempted: status };
  writeSnapshot(TARGET, doc);
}

type PeriodMeta = {
  label: string; climatology_date_label: string;
  lead: string; skill_lead: string; forecast_span: string; forecast_type: string;
};

/** One site x one near-term period. Slimmer than the seasonal set (no tmax climatology, no tmax
 *  accuracy) to keep a twice-weekly ~38-site pull polite. */
async function sitePeriod(site: SiteDef, kind: Kind, idx: number, meta: PeriodMeta,
                          init: string, withTotals: boolean) {
  const { lat, lon } = site;
  const quintNc = `forecasts/quintiles/${kind}/${init}/time_${idx}/rain.forecast.calib.quintile.aus.pall.${kind}.${init}.time_${idx}.nc`;
  const climNc = `climatology/${kind}/rain.climatology.median.${kind}.${meta.climatology_date_label}.${CLIMATOLOGY_BASELINE}.nc`;
  const tmaxQuintNc = `forecasts/quintiles/${kind}/${init}/time_${idx}/tmax.forecast.calib.quintile.aus.pall.${kind}.${init}.time_${idx}.nc`;
  const scenarioNc = (p: number) =>
    `forecasts/exceedance/${kind}/${init}/rain.forecast.calib.scenario.aus.${p}.${kind}.${init}.nc`;
  const skillNc =
    `skill/hc/hit_rate/${kind}/rain.skill.wpc.median.${meta.forecast_type}.ini${meta.lead}.${meta.skill_lead}.${meta.forecast_span}.glb.nc`;

  const haveSkillMeta = Boolean(meta.lead && meta.skill_lead && meta.forecast_span);
  const [clim, bot, top, tmaxTop, rainSkill] = await Promise.all([
    pointValue(`rain_climatology_${kind}`, climNc, lat, lon),
    pointValue('rain_bottom_quintile_probability', quintNc, lat, lon),
    pointValue('rain_top_quintile_probability', quintNc, lat, lon),
    pointValue('tmax_top_quintile_probability', tmaxQuintNc, lat, lon),
    haveSkillMeta ? pointValue('skill_global', skillNc, lat, lon) : Promise.resolve(null),
  ]).then((vs) => [asMm(vs[0]), asPct(vs[1]), asPct(vs[2]), asPct(vs[3]), asPct(vs[4])]);

  let p25: number | null = null, p50: number | null = null, p75: number | null = null;
  if (withTotals) {
    [p25, p50, p75] = await Promise.all([25, 50, 75].map((p) =>
      pointValue(`rain_exceedance_scenario_${kind}`, scenarioNc(p), lat, lon).then(asMm)));
  }

  return {
    period: meta.label,           // e.g. "10 Aug - 16 Aug"
    period_index: idx,
    climatology_median_mm: round1(clim),
    forecast_median_mm: round1(p50),
    wet_case_mm_25pct_chance_of_exceeding: round1(p25),
    dry_case_mm_75pct_chance_of_exceeding: round1(p75),
    chance_unusually_dry_pct: round1(bot),
    chance_unusually_wet_pct: round1(top),
    ...derive(clim, p50, bot, top),
    temperature: {
      chance_unusually_warm_pct: round1(tmaxTop),
      warm_odds_multiple_vs_normal: tmaxTop == null ? null : Math.round((tmaxTop / 20) * 10) / 10,
    },
    past_accuracy: {
      rain_past_accuracy_pct: round1(rainSkill),
      basis: PAST_ACCURACY_BASIS,
    },
    totals_available: withTotals,
    note: withTotals ? null
      : 'mm totals are only published through this endpoint for the nearest period of each length; probabilities only here.',
  };
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
    console.error('weekly manifest is not valid JSON — snapshot left unchanged');
    stampAttempt([{ url: MANIFEST, status: 'invalid JSON', updated: false }], 'manifest invalid JSON');
    process.exit(1);
  }
  const s = manifest.settings_w ?? {};
  const initIso: string = String(s.init_date ?? '');           // this manifest uses YYYY-MM-DD
  const init = initIso.replace(/-/g, '');
  if (!/^\d{8}$/.test(init)) {
    console.error(`weekly manifest carries no usable init_date (got ${JSON.stringify(s.init_date)}) — snapshot left unchanged`);
    stampAttempt([{ url: MANIFEST, status: 'no init_date', updated: false }], 'manifest missing init_date');
    process.exit(1);
  }
  const manifestIssue = String(s.issue_date ?? '') || null;    // already YYYY-MM-DD
  results.push({ url: MANIFEST, status: `ok (issued ${manifestIssue}, init ${initIso})`, updated: true });

  // Cheap-check contract: same issue as on disk means nothing to do. This runs on every scheduler
  // tick, so it must cost one request in the common case.
  const existing = readExisting();
  if (!FORCE && existing && manifestIssue && existing.issue_date === manifestIssue &&
      (existing.coverage?.filled ?? 0) > 0) {
    console.log(`BOM weekly issue ${manifestIssue} already ingested — nothing to do (use --force to re-pull)`);
    stampAttempt(results, `no new issue (still ${manifestIssue})`);
    return;
  }

  const periodsOf = (kind: Kind): PeriodMeta[] => {
    const block = s.rainfall?.[kind] ?? {};
    return Object.keys(block).sort((a, b) => Number(a) - Number(b)).map((k) => ({
      label: String(block[k].label ?? '').replace(/&ndash;/g, '-').trim(),
      climatology_date_label: String(block[k].climatology_date_label ?? ''),
      lead: String(block[k].lead ?? ''),
      skill_lead: String(block[k].skill_lead ?? ''),
      forecast_span: String(block[k].forecast_span ?? ''),
      forecast_type: String(block[k].forecast_type ?? kind),
    })).filter((p) => p.label && p.climatology_date_label);
  };
  const periods = new Map<Kind, PeriodMeta[]>(KINDS.map((k) => [k, periodsOf(k)]));
  const totalPeriods = KINDS.reduce((n, k) => n + periods.get(k)!.length, 0);
  if (totalPeriods === 0) {
    console.error('weekly manifest parsed but lists no rainfall periods — snapshot left unchanged');
    stampAttempt(results, 'manifest listed no periods');
    process.exit(1);
  }

  type Job = { site: SiteDef; kind: Kind; idx: number; meta: PeriodMeta };
  const jobs: Job[] = [];
  for (const site of SITES) {
    for (const kind of KINDS) {
      periods.get(kind)!.forEach((meta, idx) => jobs.push({ site, kind, idx, meta }));
    }
  }
  console.log(`querying ${jobs.length} site-periods (${SITES.length} sites x ${totalPeriods} near-term periods)...`);

  const rows = await pool(jobs, 6, async (j) =>
    ({ key: j.site.key, kind: j.kind, data: await sitePeriod(j.site, j.kind, j.idx, j.meta, init, j.idx === 0) }));

  const bySite = new Map<string, Record<Kind, any[]>>();
  for (const r of rows) {
    if (!bySite.has(r.key)) bySite.set(r.key, { weekly: [], fortnightly: [] });
    bySite.get(r.key)![r.kind].push(r.data);
  }

  const sites = SITES.map((site) => {
    const got = bySite.get(site.key) ?? { weekly: [], fortnightly: [] };
    const sortByIdx = (a: any, b: any) => a.period_index - b.period_index;
    return {
      key: site.key, name: site.name, role: site.role,
      lat: site.lat, lon: site.lon, valleys: site.valleys,
      weekly: got.weekly.sort(sortByIdx),
      fortnightly: got.fortnightly.sort(sortByIdx),
    };
  });

  const cells = sites.flatMap((s2) => [...s2.weekly, ...s2.fortnightly]);
  const filled = cells.filter((c) => c.chance_unusually_dry_pct != null).length;
  results.push({ url: `${WMS} (GetFeatureInfo x ${jobs.length})`,
    status: filled > 0 ? `ok (${filled}/${cells.length} site-periods with forecast probabilities)` : 'no probabilities parsed',
    updated: filled > 0 });

  if (filled === 0) {
    console.error('no forecast probabilities retrieved — leaving the previous snapshot in place');
    stampAttempt(results, 'no probabilities retrieved');
    process.exit(1);
  }
  const prevRatio = existing?.coverage?.cells > 0 ? existing.coverage.filled / existing.coverage.cells : null;
  const newRatio = filled / cells.length;
  if (!FORCE && prevRatio != null && prevRatio > 0 && newRatio < prevRatio * 0.5) {
    console.error(`probability coverage collapsed (${(newRatio * 100).toFixed(0)}% vs previous ` +
      `${(prevRatio * 100).toFixed(0)}%) — refusing to overwrite; use --force to override`);
    stampAttempt(results, `coverage regression ${(newRatio * 100).toFixed(0)}% vs ${(prevRatio * 100).toFixed(0)}%`);
    process.exit(1);
  }

  const doc = {
    dataset: 'bom-weekly-outlook',
    description:
      'Bureau of Meteorology ACCESS-S calibrated NEAR-TERM rainfall outlook — the next two weeks and ' +
      'two overlapping fortnights (covering ~4 weeks out) — point-queried at the same inflow-catchment ' +
      'and irrigation-district sites as the seasonal snapshot. Probabilistic BOM forecast, not a ' +
      'Waterfind prediction. The shortest period is a WEEK: no day-by-day forecast exists in this dataset.',
    as_at: today,
    issue_date: manifestIssue,
    // The weekly manifest publishes no next_issue_date; the product reissues roughly twice a week
    // and the scheduler discovers new issues by re-checking the manifest (cheap) each pass.
    next_issue_date: null,
    model_init_date: ymd(init),
    climatology_baseline: CLIMATOLOGY_BASELINE,
    coverage: { cells: cells.length, filled },
    reading_guide: {
      chance_unusually_dry_pct:
        'Probability the period lands in the driest fifth of the historical record for that week/fortnight ' +
        'of the year. The climatological baseline is 20% by construction.',
      exceedance_percentiles:
        'wet_case (25% chance of exceeding) is HIGHER than dry_case (75% chance of exceeding) — both are ' +
        'named for the exceedance probability, not the distribution percentile.',
      past_accuracy:
        'BOM weighted-percent-correct hindcast score at this lead and location; ~50% is chance level. ' +
        'Multi-week accuracy is generally higher than seasonal at week 1 and decays fast by week 2+.',
      no_daily_detail:
        'The shortest period is a week. Questions about a specific day cannot be answered from this ' +
        'dataset — say so rather than interpolating.',
      odds_multiples_are_not_amounts:
        '*_odds_multiple_vs_normal fields are dimensionless multiples of the 20% climatological baseline, ' +
        'not mm and not degrees.',
    },
    sites,
    provenance: {
      source_name: 'Bureau of Meteorology — multi-week climate outlooks (ACCESS-S)',
      source_url: ['https://www.bom.gov.au/climate/outlooks/', MANIFEST],
      fetched_at: today,
      licence_or_terms_note: 'BOM data is CC BY 4.0 — attribute "Bureau of Meteorology" at point of use.',
      gaps: [
        'mm totals only for the first period of each length (weekly/fortnightly/fourweekly); the WMS ' +
        'ignores TIME on the scenario files.',
        'The value endpoint is undocumented internal plumbing and can change without notice.',
        'Sites are single grid points chosen to represent a catchment, not catchment-averaged rainfall.',
        'No day-by-day forecast: the shortest period BOM publishes through this product is a week.',
      ],
    },
    last_refresh: { at: nowIso(), method: 'refresh-bom-weekly.ts', note: null, sources_attempted: results },
  };

  writeSnapshot(TARGET, doc);
  for (const r of results) console.log(`${r.status.padEnd(46)} ${r.url}`);
  console.log(`snapshot as_at=${doc.as_at}, issued ${doc.issue_date}, init ${doc.model_init_date}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
