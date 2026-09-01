/**
 * Forecast backtest runner ("time-travel eval", option 2 of the forecast-excellence work).
 *
 *   npx tsx backtest/run-backtest.ts gen        # (re)generate backtest/items.json from full data
 *   npx tsx backtest/run-backtest.ts baseline   # run + score the deterministic forecast tools
 *
 * For every item the SAME production compute* functions run against a database masked to the
 * item's cutoff date (see asof-db.ts), and their ranges are scored against the known outcome.
 * One tool call yields three scored variants per allocation item:
 *   analogue    — the tool's headline analogue-conditioned distribution
 *   baserate    — the tool's own unconditional base-rate distribution (does conditioning help?)
 *   persistence — "final = today's announced %" naive point forecast
 * Price/entitlement items score the tool's band vs a persistence point.
 * Results land in backtest/results/<name>.json; a summary prints to stdout.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsofDb } from './asof-db';
import { generateItems, type ItemBank, type AllocItem, type PriceItem, type EntItem } from './items';
import {
  computeAllocationForecast,
  computeTempPriceForecast,
  computeEntitlementValueForecast,
  fetchAllocationReadings,
  buildSeasons,
  trajAt,
} from '../src/forecast-tools';
import { allocDeltaHybridQuantiles } from './variants-improved';
import { scoreQuantiles, pointAsQuantiles, aggregate, aggregateBy, type QScore, type Quantiles } from './score';
import { allocDeltaQuantiles, priceSeasonalRatioQuantiles, entIncrementQuantiles } from './variants-improved';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ITEMS_PATH = path.join(DIR, 'items.json');
const RESULTS_DIR = path.join(DIR, 'results');

// The tools console.debug per-call about the (2026) snapshot cross-check; that's noise here.
console.debug = () => {};

const seasonOfDate = (iso: string) => {
  const y = Number(iso.slice(0, 4));
  return Number(iso.slice(5, 7)) >= 7 ? y : y - 1;
};

// ---- allocation --------------------------------------------------------------------
interface AllocRow {
  item: AllocItem;
  outcome: number;
  analogue: QScore; baserate: QScore; persistence: QScore;
  analogues_n: number; tol: number;
}

async function runAllocation(db: AsofDb, items: AllocItem[]) {
  const rows: AllocRow[] = [];
  const skipped = { refused: 0, series_mismatch: 0, season_mismatch: 0, no_result: 0 };
  let done = 0;
  for (const item of items) {
    const run = db.runnerAt(item.cutoff);
    const f: any = await computeAllocationForecast(run, item.region_id);
    done++;
    if (done % 100 === 0) console.log(`  allocation ${done}/${items.length}`);
    if (f.refused) { skipped.refused++; continue; }
    if (f.inputs?.series?.id !== item.series_id) { skipped.series_mismatch++; continue; }
    if (!f.data_as_at || seasonOfDate(f.data_as_at) !== item.season) { skipped.season_mismatch++; continue; }
    const d = f.result?.final_pct_distribution;
    const b = f.result?.base_rate_distribution;
    if (!d) { skipped.no_result++; continue; }
    const y = item.outcome_final_pct;
    const q = (x: any): Quantiles => ({ p10: x.p10, p25: x.p25, p50: x.p50, p75: x.p75, p90: x.p90 });
    rows.push({
      item,
      outcome: y,
      analogue: scoreQuantiles(q(d), y),
      baserate: b ? scoreQuantiles(q(b), y) : scoreQuantiles({ p10: null, p25: null, p50: null, p75: null, p90: null }, y),
      persistence: scoreQuantiles(pointAsQuantiles(f.inputs?.current_announced_pct ?? item.announced_pct), y),
      analogues_n: f.sample_sizes?.analogues ?? 0,
      tol: f.sample_sizes?.tolerance_pct_used ?? -1,
    });
  }
  return {
    items_total: items.length,
    scored: rows.length,
    skipped,
    variants: {
      analogue: aggregate(rows.map((r) => r.analogue)),
      baserate: aggregate(rows.map((r) => r.baserate)),
      persistence: aggregate(rows.map((r) => r.persistence)),
    },
    analogue_by_mos: aggregateBy(rows, (r) => `mos_${String(r.item.mos).padStart(2, '0')}`, (r) => r.analogue),
    persistence_by_mos: aggregateBy(rows, (r) => `mos_${String(r.item.mos).padStart(2, '0')}`, (r) => r.persistence),
    rows,
  };
}

// ---- temp price --------------------------------------------------------------------
interface PriceStepRow {
  region_id: number; season: number; mos: number; step: number; ym: string;
  actual: number; tercile: string; tercile_known: boolean;
  band: QScore;               // relative units (y normalised to 1)
  persistence: QScore | null; // last observed monthly median before cutoff
}

async function runPrice(db: AsofDb, items: PriceItem[]) {
  const rows: PriceStepRow[] = [];
  const skipped = { refused: 0, no_band: 0 };
  let done = 0;
  for (const item of items) {
    const run = db.runnerAt(item.cutoff);
    const f: any = await computeTempPriceForecast(run, item.region_id, item.horizon);
    done++;
    if (done % 50 === 0) console.log(`  temp_price ${done}/${items.length}`);
    if (f.refused) { skipped.refused++; continue; }
    const cutd = f.result?.tercile_cutoffs;
    const anchored: any[] = f.result?.anchored_outlook?.steps ?? [];
    for (const o of item.outcomes) {
      // graduated tools publish an anchored_outlook headline band — score that when present
      const aStep = anchored.find((s: any) => s.horizon_step === o.step);
      if (aStep?.band?.median != null) {
        const y = o.actual_median;
        const b = aStep.band;
        rows.push({
          region_id: item.region_id, season: item.season, mos: item.mos, step: o.step, ym: o.ym,
          actual: y, tercile: 'anchored', tercile_known: false,
          band: scoreQuantiles({
            p10: b.p10 != null ? b.p10 / y : null,
            p25: b.p25 != null ? b.p25 / y : null,
            p50: b.median / y,
            p75: b.p75 != null ? b.p75 / y : null,
            p90: b.p90 != null ? b.p90 / y : null,
          }, 1),
          persistence: item.last_med_before_cutoff != null
            ? scoreQuantiles(pointAsQuantiles(item.last_med_before_cutoff / y), 1)
            : null,
        });
        continue;
      }
      const entry = (f.result?.scenario_bands ?? []).find((s: any) => s.horizon_step === o.step);
      if (!entry) { skipped.no_band++; continue; }
      // realized tercile from the target month's season final (hindsight), else 'median'
      const fin = item.season_final_pct[String(o.season)];
      let tercile = 'median';
      let known = false;
      if (fin != null && cutd?.dry_max_final_pct != null && cutd?.wet_min_final_pct != null) {
        known = true;
        tercile = fin <= cutd.dry_max_final_pct ? 'dry' : fin <= cutd.wet_min_final_pct ? 'median' : 'wet';
      }
      let band = entry.bands?.[tercile];
      if (!band || band.median == null) band = entry.bands?.median;
      if (!band || band.median == null) { skipped.no_band++; continue; }
      const y = o.actual_median;
      const rel: Quantiles = {
        p10: null, p90: null,
        p25: band.p25 != null ? band.p25 / y : null,
        p50: band.median / y,
        p75: band.p75 != null ? band.p75 / y : null,
      };
      rows.push({
        region_id: item.region_id, season: item.season, mos: item.mos, step: o.step, ym: o.ym,
        actual: y, tercile, tercile_known: known,
        band: scoreQuantiles(rel, 1),
        persistence: item.last_med_before_cutoff != null
          ? scoreQuantiles(pointAsQuantiles(item.last_med_before_cutoff / y), 1)
          : null,
      });
    }
  }
  return {
    items_total: items.length,
    steps_scored: rows.length,
    skipped,
    tercile_known_rate: rows.length ? Math.round((rows.filter((r) => r.tercile_known).length / rows.length) * 100) / 100 : null,
    variants: {
      band: aggregate(rows.map((r) => r.band)),
      persistence: aggregate(rows.filter((r) => r.persistence).map((r) => r.persistence!)),
    },
    band_by_step: aggregateBy(rows, (r) => `step_${r.step}`, (r) => r.band),
    persistence_by_step: aggregateBy(rows.filter((r) => r.persistence), (r) => `step_${r.step}`, (r) => r.persistence!),
    rows,
  };
}

// ---- entitlement -------------------------------------------------------------------
interface EntRow {
  region_id: number; last_year: number; horizon: number; year: number; actual: number;
  band: QScore;               // relative units
  persistence: QScore;
}

async function runEnt(db: AsofDb, items: EntItem[]) {
  const rows: EntRow[] = [];
  const skipped = { refused: 0, no_projection: 0, year_mismatch: 0 };
  let done = 0;
  for (const item of items) {
    const run = db.runnerAt(item.cutoff);
    const f: any = await computeEntitlementValueForecast(run, item.region_id);
    done++;
    if (done % 25 === 0) console.log(`  entitlement ${done}/${items.length}`);
    if (f.refused) { skipped.refused++; continue; }
    const proj: any[] = f.result?.projection ?? [];
    if (proj.length === 0) { skipped.no_projection++; continue; }
    for (const o of item.outcomes) {
      const e = proj.find((p) => p.horizon_years === o.horizon_years);
      if (!e) { skipped.no_projection++; continue; }
      if (e.year !== o.year) { skipped.year_mismatch++; continue; }
      const y = o.actual_median;
      rows.push({
        region_id: item.region_id, last_year: item.last_year, horizon: o.horizon_years, year: o.year, actual: y,
        band: scoreQuantiles({ p10: null, p25: e.lower_p25 / y, p50: e.central / y, p75: e.upper_p75 / y, p90: null }, 1),
        persistence: scoreQuantiles(pointAsQuantiles(item.last_median / y), 1),
      });
    }
  }
  return {
    items_total: items.length,
    horizons_scored: rows.length,
    skipped,
    variants: {
      band: aggregate(rows.map((r) => r.band)),
      persistence: aggregate(rows.map((r) => r.persistence)),
    },
    band_by_horizon: aggregateBy(rows, (r) => `h${r.horizon}`, (r) => r.band),
    persistence_by_horizon: aggregateBy(rows, (r) => `h${r.horizon}`, (r) => r.persistence),
    rows,
  };
}

// ---- improved variants (see variants-improved.ts for design rationale) --------------
async function runAllocationImproved(db: AsofDb, items: AllocItem[], opts?: { hybridTails?: boolean }) {
  const rows: Array<{ item: AllocItem; outcome: number; delta: QScore; deltas_n: number }> = [];
  const skipped = { refused: 0, series_mismatch: 0, season_mismatch: 0, no_result: 0, thin_deltas: 0 };
  let done = 0;
  for (const item of items) {
    const run = db.runnerAt(item.cutoff);
    const f: any = await computeAllocationForecast(run, item.region_id);
    done++;
    if (done % 100 === 0) console.log(`  allocation ${done}/${items.length}`);
    if (f.refused) { skipped.refused++; continue; }
    if (f.inputs?.series?.id !== item.series_id) { skipped.series_mismatch++; continue; }
    if (!f.data_as_at || seasonOfDate(f.data_as_at) !== item.season) { skipped.season_mismatch++; continue; }
    let d;
    if (opts?.hybridTails) {
      // all usable past seasons' month-m increments, from the same masked data
      const readings = await fetchAllocationReadings(run, item.series_id);
      const seasons = buildSeasons(readings);
      const cur = seasons.length ? seasons[seasons.length - 1].season : null;
      const m = f.inputs?.current_month_of_season;
      const allDeltas = seasons
        .filter((s) => s.season !== cur && s.finalIsMature)
        .map((s) => ({ at: trajAt(s, m), fin: s.finalPct }))
        .filter((s): s is { at: number; fin: number } => s.at !== null)
        .map((s) => s.fin - s.at);
      d = allocDeltaHybridQuantiles(f, allDeltas);
    } else {
      d = allocDeltaQuantiles(f);
    }
    if (!d) { skipped.thin_deltas++; continue; }
    rows.push({ item, outcome: item.outcome_final_pct, delta: scoreQuantiles(d.q, item.outcome_final_pct), deltas_n: d.n });
  }
  return {
    items_total: items.length,
    scored: rows.length,
    skipped,
    variants: { [opts?.hybridTails ? 'delta_hybrid' : 'delta_analogue']: aggregate(rows.map((r) => r.delta)) },
    delta_by_mos: aggregateBy(rows, (r) => `mos_${String(r.item.mos).padStart(2, '0')}`, (r) => r.delta),
    rows,
  };
}

async function runPriceImproved(db: AsofDb, items: PriceItem[], opts?: { adjacentPool?: boolean }) {
  const rows: Array<{ region_id: number; season: number; mos: number; step: number; actual: number; ratio: QScore; pairs: number }> = [];
  const skipped = { no_anchor_or_thin: 0 };
  let done = 0;
  for (const item of items) {
    const run = db.runnerAt(item.cutoff);
    const perStep = await priceSeasonalRatioQuantiles(run, item, opts);
    done++;
    if (done % 50 === 0) console.log(`  temp_price ${done}/${items.length}`);
    for (const o of item.outcomes) {
      const s = perStep.get(o.step);
      if (!s) { skipped.no_anchor_or_thin++; continue; }
      const y = o.actual_median;
      const rel: Quantiles = {
        p10: s.q.p10! / y, p25: s.q.p25! / y, p50: s.q.p50! / y, p75: s.q.p75! / y, p90: s.q.p90! / y,
      };
      rows.push({ region_id: item.region_id, season: item.season, mos: item.mos, step: o.step, actual: y, ratio: scoreQuantiles(rel, 1), pairs: s.pairs });
    }
  }
  return {
    items_total: items.length,
    steps_scored: rows.length,
    skipped,
    variants: { seasonal_ratio: aggregate(rows.map((r) => r.ratio)) },
    ratio_by_step: aggregateBy(rows, (r) => `step_${r.step}`, (r) => r.ratio),
    rows,
  };
}

async function runEntImproved(db: AsofDb, items: EntItem[], opts?: { drift?: 'empirical' | 'none' }) {
  const rows: Array<{ region_id: number; last_year: number; horizon: number; year: number; actual: number; inc: QScore; basis: string }> = [];
  const skipped = { refused: 0, thin_series: 0 };
  let done = 0;
  for (const item of items) {
    const run = db.runnerAt(item.cutoff);
    const f: any = await computeEntitlementValueForecast(run, item.region_id);
    done++;
    if (done % 25 === 0) console.log(`  entitlement ${done}/${items.length}`);
    if (f.refused) { skipped.refused++; continue; }
    for (const o of item.outcomes) {
      const inc = entIncrementQuantiles(f, o.horizon_years, opts?.drift ?? 'empirical');
      if (!inc) { skipped.thin_series++; continue; }
      const y = o.actual_median;
      const rel: Quantiles = {
        p10: inc.q.p10! / y, p25: inc.q.p25! / y, p50: inc.q.p50! / y, p75: inc.q.p75! / y, p90: inc.q.p90! / y,
      };
      rows.push({ region_id: item.region_id, last_year: item.last_year, horizon: o.horizon_years, year: o.year, actual: y, inc: scoreQuantiles(rel, 1), basis: inc.basis });
    }
  }
  return {
    items_total: items.length,
    horizons_scored: rows.length,
    skipped,
    variants: { empirical_increment: aggregate(rows.map((r) => r.inc)) },
    inc_by_horizon: aggregateBy(rows, (r) => `h${r.horizon}`, (r) => r.inc),
    rows,
  };
}

// ---- summary printer ---------------------------------------------------------------
function printSummary(name: string, out: any) {
  const fmt = (a: any) =>
    a ? `n=${a.n}  crps=${a.mean_crps}  cov80=${a.cov80_rate ?? '-'}  cov50=${a.cov50_rate ?? '-'}  ` +
        `w80=${a.mean_width80 ?? '-'}  w50=${a.mean_width50 ?? '-'}  |err50|=${a.mean_abs_err_p50 ?? '-'}` : 'n=0';
  console.log(`\n================ ${name} ================`);
  console.log(`ALLOCATION (final % units)  scored=${out.allocation.scored}/${out.allocation.items_total}  skipped=${JSON.stringify(out.allocation.skipped)}`);
  for (const [k, v] of Object.entries(out.allocation.variants)) console.log(`  ${k.padEnd(12)} ${fmt(v)}`);
  console.log(`TEMP PRICE (relative to actual=1)  steps=${out.temp_price.steps_scored}  tercile_known=${out.temp_price.tercile_known_rate}`);
  for (const [k, v] of Object.entries(out.temp_price.variants)) console.log(`  ${k.padEnd(12)} ${fmt(v)}`);
  console.log(`ENTITLEMENT (relative to actual=1)  horizons=${out.entitlement.horizons_scored}`);
  for (const [k, v] of Object.entries(out.entitlement.variants)) console.log(`  ${k.padEnd(12)} ${fmt(v)}`);
}

// ---- entry -------------------------------------------------------------------------
async function main() {
  const cmd = process.argv[2] ?? 'baseline';
  const db = new AsofDb();
  await db.init();
  try {
    if (cmd === 'gen') {
      const bank = await generateItems(db.runnerFull());
      writeFileSync(ITEMS_PATH, JSON.stringify(bank, null, 1));
      console.log(`items.json written: allocation=${bank.allocation.length} temp_price=${bank.temp_price.length} ` +
        `entitlement=${bank.entitlement.length} (data through ${bank.generated_from})`);
      return;
    }
    const bank: ItemBank = JSON.parse(readFileSync(ITEMS_PATH, 'utf8'));
    console.log(`Running "${cmd}" over allocation=${bank.allocation.length} temp_price=${bank.temp_price.length} entitlement=${bank.entitlement.length} items`);
    const t0 = Date.now();
    const improved = cmd === 'improved' || cmd === 'improved2';
    const v2 = cmd === 'improved2';
    const out = {
      variant: cmd,
      ran_at: new Date().toISOString(),
      allocation: improved
        ? await runAllocationImproved(db, bank.allocation, { hybridTails: v2 })
        : await runAllocation(db, bank.allocation),
      temp_price: improved
        ? await runPriceImproved(db, bank.temp_price, { adjacentPool: v2 })
        : await runPrice(db, bank.temp_price),
      entitlement: improved
        ? await runEntImproved(db, bank.entitlement, { drift: v2 ? 'none' : 'empirical' })
        : await runEnt(db, bank.entitlement),
      elapsed_s: 0,
    };
    out.elapsed_s = Math.round((Date.now() - t0) / 1000);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const file = path.join(RESULTS_DIR, `${cmd}.json`);
    writeFileSync(file, JSON.stringify(out, null, 1));
    printSummary(cmd, out);
    console.log(`\nElapsed ${out.elapsed_s}s. Full results: ${file}`);
  } finally {
    await db.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
