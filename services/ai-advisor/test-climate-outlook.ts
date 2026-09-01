/**
 * Offline test for the BOM climate-outlook datasets + get_climate_outlook tool. No DB, no network.
 *   npx tsx test-climate-outlook.ts
 * Checks: both snapshots (seasonal + near-term weekly) parse and carry provenance/dates, values
 * are physically sane and internally consistent, the region->catchment matcher and the generated
 * region_id map resolve real CRM regions to the right site, and the tool reports staleness and
 * the no-daily-forecast limitation honestly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildExtdataToolDefs, EXTDATA_TOOL_NAMES } from './src/extdata-tools';
import {
  matchSites, siteForRegionName, siteForRegion, seasonalLine, nearTermLine,
  outlookFreshness, nearTermFreshness, nearTermForKey, climateDrivers,
} from './src/climate-outlook';
import { SITES } from './src/bom-sites';

const here = dirname(fileURLToPath(import.meta.url));
const load = (n: string) => JSON.parse(readFileSync(join(here, 'knowledge', 'data', n), 'utf8'));
const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** Whole months between two YYYY-MM strings. */
const monthsApart = (a: string, b: string) => {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return Math.abs((by * 12 + bm) - (ay * 12 + am));
};

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  ERR ${name}${detail ? ' — ' + detail : ''}`); }
}
const parse = (res: any) => JSON.parse(res.content[0].text);
async function callTool(name: string, args: any) {
  const d = buildExtdataToolDefs().find((t: any) => t.name === name);
  if (!d) throw new Error('no such tool: ' + name);
  return parse(await (d as any).handler(args, {}));
}

async function main() {
  const doc = load('bom-climate-outlook.json');

  console.log('=== seasonal snapshot: shape + provenance ===');
  check('dataset id', doc.dataset === 'bom-climate-outlook');
  check('headline present', typeof doc.headline === 'string' && doc.headline.length > 20);
  check('issue_date is a date', isDate(doc.issue_date), String(doc.issue_date));
  check('next_issue_date is a date', isDate(doc.next_issue_date), String(doc.next_issue_date));
  check('model_init_date is a date', isDate(doc.model_init_date), String(doc.model_init_date));
  check('init precedes issue', doc.model_init_date <= doc.issue_date);
  check('issue precedes next issue', doc.issue_date < doc.next_issue_date);
  check('coverage recorded (the regression guard depends on it)',
    doc.coverage?.cells > 0 && doc.coverage?.filled > 0, JSON.stringify(doc.coverage));
  check('last_refresh.at is a full timestamp (hour-grained backoff needs it)',
    /^\d{4}-\d{2}-\d{2}T/.test(String(doc.last_refresh?.at)), String(doc.last_refresh?.at));
  for (const k of ['source_url', 'source_name', 'fetched_at', 'licence_or_terms_note', 'gaps']) {
    check(`provenance.${k}`, doc.provenance?.[k] != null);
  }
  check('gaps documented incl. no-daily-forecast',
    Array.isArray(doc.provenance.gaps) && doc.provenance.gaps.some((g: string) => /day-by-day/.test(g)));
  check('reading_guide explains the 20% baseline', /20%/.test(doc.reading_guide?.chance_unusually_dry_pct ?? ''));
  check('reading_guide explains past accuracy as WPC', /weighted/.test(doc.reading_guide?.past_accuracy ?? ''));

  console.log('\n=== sites ===');
  const sites: any[] = doc.sites ?? [];
  check('site catalogue matches bom-sites.ts', sites.length === SITES.length,
    `snapshot ${sites.length} vs catalogue ${SITES.length}`);
  const inflow = sites.filter((s) => s.role === 'inflow_catchment');
  check('>=15 inflow catchments', inflow.length >= 15, `got ${inflow.length}`);
  check('every site has coordinates in Australia',
    sites.every((s) => s.lat < -10 && s.lat > -44 && s.lon > 112 && s.lon < 154));
  check('every site has a valleys keyword list', sites.every((s) => Array.isArray(s.valleys) && s.valleys.length > 0));
  check('every site has >=1 seasonal period', sites.every((s) => (s.seasonal ?? []).length >= 1));
  check('the marquee southern storages are covered',
    ['upper-murray', 'goulburn-upper', 'murrumbidgee-upper'].every((k) => sites.some((s) => s.key === k)));
  check('non-MDB systems are covered (QLD coastal, TAS, SA groundwater, WA)',
    ['burdekin-haughton', 'tas-midlands', 'mount-lofty-ranges', 'wa-southwest', 'barwon-darling']
      .every((k) => sites.some((s) => s.key === k)));

  console.log('\n=== values are physically sane ===');
  const periods = sites.flatMap((s) => [...(s.seasonal ?? []), ...(s.monthly ?? [])]);
  const pct = (v: unknown) => v == null || (typeof v === 'number' && v >= 0 && v <= 100);
  check('all probabilities within 0-100',
    periods.every((p) => pct(p.chance_unusually_dry_pct) && pct(p.chance_unusually_wet_pct)));
  check('all rainfall totals non-negative',
    periods.every((p) => [p.climatology_median_mm, p.forecast_median_mm].every((v) => v == null || v >= 0)));
  check('climatology present for every period', periods.every((p) => typeof p.climatology_median_mm === 'number'));
  const withTotals = periods.filter((p) => p.forecast_median_mm != null && p.wet_case_mm_25pct_chance_of_exceeding != null);
  check('some periods carry mm totals', withTotals.length > 0, `got ${withTotals.length}`);
  // Exceedance ordering: a 25% chance of exceeding X must mean a HIGHER X than a 75% chance.
  check('exceedance percentiles ordered wet > dry',
    withTotals.every((p) => p.wet_case_mm_25pct_chance_of_exceeding >= p.dry_case_mm_75pct_chance_of_exceeding));
  check('pct_of_normal matches its inputs (null allowed below the 5mm climatology floor)',
    withTotals.every((p) => p.pct_of_normal == null
      ? p.climatology_median_mm < 5
      : Math.abs(p.pct_of_normal - (p.forecast_median_mm / p.climatology_median_mm) * 100) <= 1));
  check('dry_odds_multiple_vs_normal is the 20%-baseline multiple',
    periods.filter((p) => p.chance_unusually_dry_pct != null)
      .every((p) => Math.abs(p.dry_odds_multiple_vs_normal - p.chance_unusually_dry_pct / 20) <= 0.06));
  // Upper-catchment climatology must exceed the semi-arid districts, else the sites are mis-keyed.
  const clim = (k: string) => sites.find((s) => s.key === k)?.seasonal?.[0]?.climatology_median_mm;
  check('upper-murray is wetter than the SA Riverland', clim('upper-murray') > clim('sa-riverland'),
    `${clim('upper-murray')} vs ${clim('sa-riverland')}`);

  console.log('\n=== temperature (evaporation / demand side) ===');
  check('every period carries a temperature block', periods.every((p) => p.temperature != null));
  const warm = periods.filter((p) => p.temperature?.chance_unusually_warm_pct != null);
  check('warm probability present for every period', warm.length === periods.length, `${warm.length}/${periods.length}`);
  check('warm probabilities within 0-100', warm.every((p) => pct(p.temperature.chance_unusually_warm_pct)));
  check('warm_odds_multiple_vs_normal is the 20%-baseline multiple',
    warm.every((p) => Math.abs(p.temperature.warm_odds_multiple_vs_normal - p.temperature.chance_unusually_warm_pct / 20) <= 0.06));
  const tclim = periods.filter((p) => p.temperature?.climatology_mean_max_c != null);
  check('mean-max climatology present', tclim.length === periods.length, `${tclim.length}/${periods.length}`);
  check('mean-max temperatures are physically plausible (0-50C)',
    tclim.every((p) => p.temperature.climatology_mean_max_c > 0 && p.temperature.climatology_mean_max_c < 50));
  // The alpine headwaters must be cooler than the semi-arid districts, else sites are mis-keyed.
  const tOf = (k: string) => sites.find((s) => s.key === k)?.seasonal?.[0]?.temperature?.climatology_mean_max_c;
  check('upper Goulburn is cooler than the SA Riverland', tOf('goulburn-upper') < tOf('sa-riverland'),
    `${tOf('goulburn-upper')} vs ${tOf('sa-riverland')}`);

  console.log('\n=== past accuracy (how much the probability is worth) ===');
  check('every period carries a past_accuracy block', periods.every((p) => p.past_accuracy != null));
  const sk = periods.filter((p) => p.past_accuracy?.rain_past_accuracy_pct != null);
  check('rain past accuracy present for every period', sk.length === periods.length, `${sk.length}/${periods.length}`);
  check('accuracy scores within 0-100', sk.every((p) => pct(p.past_accuracy.rain_past_accuracy_pct)));
  // Nationally, some cells genuinely score below chance (BOM's "very low" band — e.g. October in
  // the coastal NSW/SEQ sites) and that is INFORMATION, not an error. But if most cells were at or
  // below 50 the layer would likely be misread, so require a strong majority above chance.
  const above = sk.filter((p) => p.past_accuracy.rain_past_accuracy_pct > 50).length;
  check('a strong majority of accuracy scores beat chance', above / sk.length >= 0.75,
    `${above}/${sk.length}`);
  check('the marquee MDB catchments beat chance at the nearest lead',
    ['upper-murray', 'goulburn-upper', 'murrumbidgee-upper'].every((k) =>
      (sites.find((s) => s.key === k)?.seasonal?.[0]?.past_accuracy?.rain_past_accuracy_pct ?? 0) > 50));
  check('tmax past accuracy present', periods.every((p) => p.past_accuracy?.tmax_past_accuracy_pct != null));
  check('basis text says weighted percent correct, 50% baseline and BOM bands',
    periods.every((p) => /weighted percent correct/.test(p.past_accuracy.basis) &&
      /50%/.test(p.past_accuracy.basis) && /75/.test(p.past_accuracy.basis)));

  console.log('\n=== recent observations (antecedent conditions) ===');
  check('every site carries an observations array', sites.every((s) => Array.isArray(s.recent_observations)));
  const obs = sites.flatMap((s) => s.recent_observations);
  check('observations present', obs.length > 0, `got ${obs.length}`);
  check('every site has observations', sites.every((s) => s.recent_observations.length > 0));
  check('months are YYYY-MM', obs.every((o: any) => /^\d{4}-\d{2}$/.test(o.month)));
  check('observed mm are non-negative', obs.every((o: any) => o.observed_mm >= 0));
  check('every observation is classified vs normal',
    obs.every((o: any) => ['below normal', 'near normal', 'above normal'].includes(o.vs_normal)));
  check('normal band is an ordered [low, high] pair',
    obs.every((o: any) => Array.isArray(o.normal_band_mm) && o.normal_band_mm[0] <= o.normal_band_mm[1]));
  // The classification must actually follow from the numbers, not be decorative.
  check('classification agrees with the band',
    obs.every((o: any) => {
      const [lo, hi] = o.normal_band_mm;
      const expect = o.observed_mm < lo ? 'below normal' : o.observed_mm > hi ? 'above normal' : 'near normal';
      return o.vs_normal === expect;
    }));
  // Truncation guard: the newest observed month must be recent. With the old maxSteps=9 walk, a
  // late-calendar-year init silently dropped the latest months and served mid-year data as
  // "recent" — 3 months is the worst honest gap (obs lag the init by ~1 month + 3 kept months).
  const newestBySite = sites.map((s) => s.recent_observations[s.recent_observations.length - 1]?.month).filter(Boolean);
  check('newest observation is within 3 months of the snapshot (walk not truncated)',
    newestBySite.every((m: string) => monthsApart(m, String(doc.as_at).slice(0, 7)) <= 3),
    JSON.stringify(newestBySite.slice(0, 4)));

  console.log('\n=== near-term (weekly/fortnightly) snapshot ===');
  const wdoc = load('bom-weekly-outlook.json');
  check('dataset id', wdoc.dataset === 'bom-weekly-outlook');
  check('issue_date is a date', isDate(wdoc.issue_date), String(wdoc.issue_date));
  check('model_init_date is a date', isDate(wdoc.model_init_date), String(wdoc.model_init_date));
  check('coverage recorded', wdoc.coverage?.cells > 0 && wdoc.coverage?.filled > 0, JSON.stringify(wdoc.coverage));
  check('same site catalogue as seasonal', (wdoc.sites ?? []).length === SITES.length);
  check('reading guide states the no-daily-detail limit', /week/.test(wdoc.reading_guide?.no_daily_detail ?? ''));
  const wsites: any[] = wdoc.sites ?? [];
  const wperiods = wsites.flatMap((s) => [...(s.weekly ?? []), ...(s.fortnightly ?? [])]);
  check('every site has 2 weekly + 2 fortnightly periods',
    wsites.every((s) => s.weekly?.length === 2 && s.fortnightly?.length === 2));
  check('weekly probabilities within 0-100',
    wperiods.every((p) => pct(p.chance_unusually_dry_pct) && pct(p.chance_unusually_wet_pct)));
  check('weekly probabilities present for a strong majority of cells',
    wperiods.filter((p) => p.chance_unusually_dry_pct != null).length / wperiods.length >= 0.9);
  check('weekly climatology present', wperiods.every((p) => typeof p.climatology_median_mm === 'number'));
  const wTotals = wperiods.filter((p) => p.forecast_median_mm != null && p.wet_case_mm_25pct_chance_of_exceeding != null);
  check('first weekly/fortnightly periods carry mm totals', wTotals.length >= wsites.length,
    `got ${wTotals.length}`);
  check('weekly exceedance ordered wet > dry',
    wTotals.every((p) => p.wet_case_mm_25pct_chance_of_exceeding >= p.dry_case_mm_75pct_chance_of_exceeding));
  // A week's rain cannot plausibly exceed the same site's 3-month climatology.
  const wByKey = new Map(wsites.map((s) => [s.key, s]));
  check('weekly climatology < seasonal climatology per site',
    sites.every((s) => {
      const w = wByKey.get(s.key)?.weekly?.[0]?.climatology_median_mm;
      const se = s.seasonal?.[0]?.climatology_median_mm;
      return w == null || se == null || w < se;
    }));

  console.log('\n=== region -> catchment matcher (free text) ===');
  // Real CRM region names, verbatim from the region table.
  const cases: [string, string][] = [
    ['7 VIC MURRAY (BARMAH TO SA) GMW - HIGH R', 'upper-murray'],
    ['MURRUMBIDGEE (GENERAL SECURITY) RIVER LICENCES', 'murrumbidgee-upper'],
    ['3 LOWER GOULBURN - HIGH R', 'goulburn-upper'],
    ['LV 1 - UPPER LACHLAN RIVER (above Lake Cargelligo) GENERAL S (Take sub-account)', 'lachlan-upper'],
    ['MQV 2A MACQUARIE RIVER  (Below Lake Burrendong) - HIGH S', 'macquarie-upper'],
    ['NV - UPPER (SPLIT ROCK DAM TO KEEPIT DAM) - GENERAL S', 'namoi-upper'],
    // Coverage added 2026-08-06 — previously unmatched systems.
    ['7 TORRUMBARRY IRRIGATION AREA - HIGH R', 'upper-murray'],
    ['ROBINVALE IRRIGATION DISTRICT - HIGH RELIABILITY', 'vic-mallee'],
    ['14 LOWER DARLING (MENINDEE LAKES TO ASHVALE) - GENERAL.S', 'barwon-darling'],
    ['YANCO/BILLABONG CREEK (GENERAL SECURITY) LICENCES', 'murrumbidgee-upper'],
    ['MCLAREN VALE - WEST OF WILLUNGA FAULT LINE', 'mount-lofty-ranges'],
    ['BURDEKIN C - MEDIUM PRIORITY', 'burdekin-haughton'],
    ['ZONE 11 - JORDAN RIVER LINE - IRRIGATION RIGHT', 'tas-midlands'],
    ['ZONE 21 WIMMERA IRRIGATION DISTRICT', 'wimmera-grampians'],
    ['BURNETT ZONE CA - MEDIUM PRIORITY', 'burnett-bundaberg'],
    ['MD - ZONE A - HIGH PRIORITY', 'barron-atherton'],
  ];
  for (const [regionName, expected] of cases) {
    const got = siteForRegionName(regionName);
    check(`"${regionName.slice(0, 34)}..." -> ${expected}`, got?.key === expected, `got ${got?.key ?? 'null'}`);
  }
  check('prefers the inflow catchment over the district',
    siteForRegionName('7 VIC MURRAY (BARMAH TO SA) GMW - HIGH R')?.role === 'inflow_catchment');
  // Barossa was the original mis-match bug (substring "sa"); it now matches the Mount Lofty
  // Ranges site DELIBERATELY — the right catchment for Barossa groundwater, not a keyword accident.
  check('Barossa resolves to the Mount Lofty Ranges site',
    siteForRegionName('BAROSSA - EAST PARA ZONE')?.key === 'mount-lofty-ranges',
    String(siteForRegionName('BAROSSA - EAST PARA ZONE')?.key));
  check('an unmappable administrative name returns null, not a wrong guess',
    siteForRegionName('Waterfind Consultancy') === null,
    String(siteForRegionName('Waterfind Consultancy')?.key));
  check('free-text matching works', matchSites('Hume').some((s) => s.key === 'upper-murray'));
  check('seasonalLine cites the 20% baseline',
    /normal is 20%/.test(seasonalLine(siteForRegionName('Goulburn')!) ?? ''));
  check('nearTermLine states the weekly floor',
    /shortest BOM period is a week/.test(nearTermLine(nearTermForKey('upper-murray')!) ?? ''));

  console.log('\n=== region_id map (generated bom-region-sites.json) ===');
  const rmap = load('bom-region-sites.json');
  const entries = Object.entries(rmap.regions ?? {}) as [string, any][];
  check('map present with >1500 regions', entries.length > 1500, `got ${entries.length}`);
  check('>=99% of regions mapped',
    entries.length / (entries.length + (rmap.unmapped?.length ?? 0)) >= 0.99,
    `${entries.length} mapped, ${rmap.unmapped?.length} unmapped`);
  const siteKeys = new Set(SITES.map((s) => s.key));
  check('every mapped site key exists in the catalogue', entries.every(([, e]) => siteKeys.has(e.site)));
  check('unmapped residue is only administrative rows and pinned catch-alls',
    (rmap.unmapped ?? []).every((u: any) =>
      /SUNDRY|OTHER|REPORTS|Consultancy|FAR NORTH|Dams and Reservoirs/.test(u.name)),
    JSON.stringify((rmap.unmapped ?? []).map((u: any) => u.name)));
  // Spot checks straight from the audit.
  const spot: [number, string][] = [
    [2463, 'upper-murray'],          // TORRUMBARRY
    [677, 'barwon-darling'],         // LOWER DARLING
    [2821, 'mount-lofty-ranges'],    // MCLAREN VALE
    [2426559, 'burdekin-haughton'],  // BURDEKIN A
  ];
  for (const [id, expected] of spot) {
    check(`region ${id} -> ${expected}`, rmap.regions[String(id)]?.site === expected,
      String(rmap.regions[String(id)]?.site));
  }
  check('siteForRegion(id) resolves via the map',
    siteForRegion(2463, 'TORRUMBARRY')?.key === 'upper-murray');
  check('siteForRegion falls back to name matching without an id',
    siteForRegion(null, 'ROBINVALE IRRIGATION DISTRICT - HIGH RELIABILITY')?.key === 'vic-mallee');

  console.log('\n=== tool ===');
  check('registered in EXTDATA_TOOL_NAMES', (EXTDATA_TOOL_NAMES as readonly string[]).includes('get_climate_outlook'));
  check('tool is built without a caller context', buildExtdataToolDefs().some((t: any) => t.name === 'get_climate_outlook'));

  const all = await callTool('get_climate_outlook', {});
  check('unfiltered: attributes BOM', all.authority === 'Bureau of Meteorology');
  check('unfiltered: carries the headline', typeof all.headline === 'string' && all.headline.length > 20);
  check('unfiltered: returns inflow catchments only',
    all.sites.length > 0 && all.sites.every((s: any) => s.role === 'inflow_catchment'));
  check('unfiltered: omits monthly detail', all.sites.every((s: any) => s.monthly === undefined));
  check('unfiltered: includes a near-term block', all.sites.every((s: any) => s.near_term != null));
  check('unfiltered: issue date surfaced', isDate(all.issue_date));
  check('note states no day-by-day forecast', /no day-by-day/.test(all.note));
  check('climate drivers surfaced', all.climate_drivers != null);

  const gb = await callTool('get_climate_outlook', { region_or_valley: 'Goulburn' });
  check('filtered: matches Goulburn', gb.sites.some((s: any) => s.key === 'goulburn-upper'), JSON.stringify(gb.sites?.map((s: any) => s.key)));
  check('filtered: filter_matched true', gb.filter_matched === true);
  check('filtered: includes monthly detail', gb.sites.every((s: any) => Array.isArray(s.monthly)));
  check('filtered: includes full near-term detail',
    gb.sites.every((s: any) => s.near_term?.weekly?.length === 2 && s.near_term?.fortnightly?.length === 2));

  const byId = await callTool('get_climate_outlook', { region_id: 2463 });
  check('region_id filter resolves via the map', byId.sites.length === 1 && byId.sites[0].key === 'upper-murray',
    JSON.stringify(byId.sites?.map((s: any) => s.key)));

  const none = await callTool('get_climate_outlook', { region_or_valley: 'Zorbulon Prime' });
  check('no match: falls back to catchments rather than empty', none.matched > 0);
  check('no match: says the filter missed', none.filter_matched === false);

  console.log('\n=== staleness is reported, not hidden ===');
  const fresh = outlookFreshness();
  check('freshness available', fresh.available === true);
  const future = outlookFreshness('2099-01-01');
  check('a superseded outlook is flagged', future.available && future.superseded === true);
  check('superseded carries an actionable note', /bom\.gov\.au/.test((future as any).staleness_note ?? ''));
  const early = outlookFreshness(doc.issue_date);
  check('a current outlook is not flagged stale', early.available && early.superseded === false);
  const onDay = outlookFreshness(doc.next_issue_date);
  check('on the reissue day, flags "possibly updated today" instead of asserting currency',
    onDay.available && (onDay as any).possibly_updated_today === true && onDay.superseded === false);
  const nearFuture = nearTermFreshness('2099-01-01');
  check('a stale near-term snapshot is flagged', nearFuture.available && (nearFuture as any).stale === true);
  const nearNow = nearTermFreshness(String(wdoc.issue_date));
  check('a current near-term snapshot is not flagged', nearNow.available && (nearNow as any).stale === false);
  const drivers = climateDrivers();
  check('climate drivers include ENSO or an explicit unavailability note',
    (drivers as any).enso != null || (drivers as any).unavailable != null || (drivers as any).note != null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
