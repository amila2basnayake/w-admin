/**
 * Skeptic-round backtest runner (temp-price band recalibration).
 *
 *   npx tsx backtest/run-skeptic.ts
 *
 * Runs BOTH the improved2 estimator (priceSeasonalRatioQuantiles, adjacentPool) and the
 * skeptic estimator (t-predictive widened bands, variants-skeptic.ts) over the same
 * backtest/items.json temp-price items on the same as-of masked DB, scores them on the
 * identical step subset, and additionally reports:
 *   - inner-3-tau scores (p25/p50/p75 only) for BOTH, so they are tau-comparable with the
 *     production baseline band (which has no p10/p90 — its stored "crps" averages 3 taus,
 *     the 5-tau variants average 5; mixing those understates 5-tau variants' loss ~20-25%);
 *   - the production baseline's stored inner-3 score on the matched steps (from
 *     results/baseline.json);
 *   - slices by horizon step, by era (pre2019 vs 2019plus — the drought/spike regime where
 *     improved2's coverage collapsed), and by region.
 * Results land in backtest/results/skeptic.json. Sequential (one pg session — the cutoff
 * GUC is session-stateful).
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsofDb } from './asof-db';
import type { ItemBank } from './items';
import { priceSeasonalRatioQuantiles } from './variants-improved';
import { skepticPriceQuantiles } from './variants-skeptic';
import { scoreQuantiles, pointAsQuantiles, aggregate, aggregateBy, type QScore, type Quantiles } from './score';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ITEMS_PATH = path.join(DIR, 'items.json');
const RESULTS_DIR = path.join(DIR, 'results');
const BASELINE_PATH = path.join(RESULTS_DIR, 'baseline.json');

console.debug = () => {};

interface Row {
  region_id: number; season: number; mos: number; step: number; ym: string; actual: number;
  era: string; pairs: number;
  skeptic: QScore; skeptic_inner: QScore;
  imp2: QScore; imp2_inner: QScore;
  baseline_inner: QScore | null;   // production tool band (p25/p50/p75), matched from baseline.json
  persistence: QScore | null;
}

const rel = (q: Quantiles, y: number): Quantiles => ({
  p10: q.p10 != null ? q.p10 / y : null,
  p25: q.p25 != null ? q.p25 / y : null,
  p50: q.p50 != null ? q.p50 / y : null,
  p75: q.p75 != null ? q.p75 / y : null,
  p90: q.p90 != null ? q.p90 / y : null,
});
const inner = (q: Quantiles): Quantiles => ({ ...q, p10: null, p90: null });

async function main() {
  const bank: ItemBank = JSON.parse(readFileSync(ITEMS_PATH, 'utf8'));
  const items = bank.temp_price;

  // matched production-baseline band scores (stored QScore is inner-3 by construction)
  const baseKey = (r: { region_id: number; season: number; mos: number; step: number }) =>
    [r.region_id, r.season, r.mos, r.step].join('|');
  let baseMap = new Map<string, QScore>();
  try {
    const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    baseMap = new Map(base.temp_price.rows.map((r: any) => [baseKey(r), r.band as QScore]));
  } catch { console.log('note: results/baseline.json not readable — baseline_inner column will be null'); }

  const db = new AsofDb();
  await db.init();
  const rows: Row[] = [];
  const skipped = { imp2_missing: 0, skeptic_missing: 0 };
  const t0 = Date.now();
  try {
    let done = 0;
    for (const item of items) {
      const run = db.runnerAt(item.cutoff);
      const imp2Steps = await priceSeasonalRatioQuantiles(run, item, { adjacentPool: true });
      const skepSteps = await skepticPriceQuantiles(run, item);
      done++;
      if (done % 25 === 0) console.log(`  temp_price ${done}/${items.length}`);
      for (const o of item.outcomes) {
        const si = imp2Steps.get(o.step);
        const ss = skepSteps.get(o.step);
        if (!si) { skipped.imp2_missing++; continue; }
        if (!ss) { skipped.skeptic_missing++; continue; } // should not happen (same gating)
        const y = o.actual_median;
        rows.push({
          region_id: item.region_id, season: item.season, mos: item.mos, step: o.step, ym: o.ym, actual: y,
          era: item.season <= 2018 ? 'pre2019' : '2019plus',
          pairs: ss.pairs,
          skeptic: scoreQuantiles(rel(ss.q, y), 1),
          skeptic_inner: scoreQuantiles(inner(rel(ss.q, y)), 1),
          imp2: scoreQuantiles(rel(si.q, y), 1),
          imp2_inner: scoreQuantiles(inner(rel(si.q, y)), 1),
          baseline_inner: baseMap.get(baseKey({ region_id: item.region_id, season: item.season, mos: item.mos, step: o.step })) ?? null,
          persistence: item.last_med_before_cutoff != null
            ? scoreQuantiles(pointAsQuantiles(item.last_med_before_cutoff / y), 1)
            : null,
        });
      }
    }
  } finally {
    await db.close();
  }

  const withBase = rows.filter((r) => r.baseline_inner);
  const out = {
    variant: 'skeptic',
    ran_at: new Date().toISOString(),
    design: 'temp-price bands: improved2 pool + empirical median p50, band quantiles = wider of empirical and t-predictive (df<=6, sqrt(1+1/n)) in log space; widen-only vs improved2',
    items_total: items.length,
    steps_scored: rows.length,
    skipped,
    variants: {
      skeptic: aggregate(rows.map((r) => r.skeptic)),
      improved2: aggregate(rows.map((r) => r.imp2)),
      persistence: aggregate(rows.filter((r) => r.persistence).map((r) => r.persistence!)),
    },
    // tau-comparable with the production tool's stored band score (3 inner taus)
    inner3_tau_comparable: {
      skeptic: aggregate(rows.map((r) => r.skeptic_inner)),
      improved2: aggregate(rows.map((r) => r.imp2_inner)),
      baseline_tool: aggregate(withBase.map((r) => r.baseline_inner!)),
      matched_steps: withBase.length,
    },
    skeptic_by_step: aggregateBy(rows, (r) => `step_${r.step}`, (r) => r.skeptic),
    improved2_by_step: aggregateBy(rows, (r) => `step_${r.step}`, (r) => r.imp2),
    skeptic_by_era: aggregateBy(rows, (r) => r.era, (r) => r.skeptic),
    improved2_by_era: aggregateBy(rows, (r) => r.era, (r) => r.imp2),
    skeptic_by_season: aggregateBy(rows, (r) => `s${r.season}`, (r) => r.skeptic),
    improved2_by_season: aggregateBy(rows, (r) => `s${r.season}`, (r) => r.imp2),
    skeptic_by_region: aggregateBy(rows, (r) => `r${r.region_id}`, (r) => r.skeptic),
    improved2_by_region: aggregateBy(rows, (r) => `r${r.region_id}`, (r) => r.imp2),
    elapsed_s: Math.round((Date.now() - t0) / 1000),
    rows,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, 'skeptic.json');
  writeFileSync(file, JSON.stringify(out, null, 1));

  const fmt = (a: any) =>
    a ? `n=${a.n}  crps=${a.mean_crps}  cov80=${a.cov80_rate ?? '-'}  cov50=${a.cov50_rate ?? '-'}  ` +
        `w80=${a.mean_width80 ?? '-'}  w50=${a.mean_width50 ?? '-'}  |err50|=${a.mean_abs_err_p50 ?? '-'}` : 'n=0';
  console.log(`\n================ skeptic (temp price, ${rows.length} steps) ================`);
  for (const [k, v] of Object.entries(out.variants)) console.log(`  ${k.padEnd(12)} ${fmt(v)}`);
  console.log('inner-3-tau (comparable with production tool band):');
  console.log(`  skeptic      ${fmt(out.inner3_tau_comparable.skeptic)}`);
  console.log(`  improved2    ${fmt(out.inner3_tau_comparable.improved2)}`);
  console.log(`  baseline     ${fmt(out.inner3_tau_comparable.baseline_tool)}  (matched ${out.inner3_tau_comparable.matched_steps} steps)`);
  console.log('by era:');
  for (const era of ['pre2019', '2019plus']) {
    console.log(`  ${era.padEnd(9)} skeptic   ${fmt((out.skeptic_by_era as any)[era])}`);
    console.log(`  ${era.padEnd(9)} improved2 ${fmt((out.improved2_by_era as any)[era])}`);
  }
  console.log('by step (skeptic / improved2 crps, cov80):');
  for (let k = 1; k <= 6; k++) {
    const s = (out.skeptic_by_step as any)[`step_${k}`], i = (out.improved2_by_step as any)[`step_${k}`];
    if (s && i) console.log(`  step_${k}: ${s.mean_crps} / ${i.mean_crps}   cov80 ${s.cov80_rate} / ${i.cov80_rate}`);
  }
  console.log(`\nElapsed ${out.elapsed_s}s. Full results: ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
