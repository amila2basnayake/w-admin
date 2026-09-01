import type { Runner } from './asof-db';
import type { AllocItem, PriceItem } from './items';
import type { Quantiles } from './score';

// =====================================================================================
//  "Improved" deterministic forecast variants, designed FROM the baseline backtest
//  findings (results/baseline.json):
//
//  1. Allocation: persistence beats the analogue-level distribution from month ~4 on,
//     because allocations only ratchet upward — the tool forecasts the LEVEL and
//     ignores that final >= current. Fix: forecast the remaining INCREMENT
//     (final - month-m %) from the same analogues, add it to the current announced %,
//     clamp at the current % (delta >= 0).
//
//  2. Temp price: the tool's tercile bands are ~1.7x actual wide and their median is
//     no better than the last observed price. Fix: anchor on the current price level
//     and apply the empirical distribution of same-month-pair seasonal ratios
//     (med[target month] / med[ask month] across past seasons).
//
//  3. Entitlement: the log-linear trend projection badly loses to persistence
//     (overfit growth). Fix: random-walk-with-empirical-increment — quantiles of
//     historical h-year log-changes applied to the last annual median.
// =====================================================================================

const q = (sorted: number[], t: number): number => {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const rank = t * (n - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return lo === hi ? sorted[lo] : sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
};
const asc = (xs: number[]) => [...xs].sort((a, b) => a - b);
const r1 = (v: number) => Math.round(v * 10) / 10;

// ---- 1. allocation: delta-analogue --------------------------------------------------
/**
 * Derive increment-based quantiles from the baseline tool's own output
 * (analogues_or_series carries month_m_pct + final_pct per analogue season).
 */
export function allocDeltaQuantiles(baselineOut: any): { q: Quantiles; n: number } | null {
  const cur = baselineOut?.inputs?.current_announced_pct;
  const analogues: any[] = baselineOut?.analogues_or_series ?? [];
  if (cur == null || analogues.length < 3) return null;
  // remaining ratchet increment per analogue season; data corrections can make it
  // fractionally negative — the ratchet constraint says clamp at 0
  const deltas = asc(analogues
    .filter((a) => a.month_m_pct != null && a.final_pct != null)
    .map((a) => Math.max(0, a.final_pct - a.month_m_pct)));
  if (deltas.length < 3) return null;
  return {
    n: deltas.length,
    q: {
      p10: r1(cur + q(deltas, 0.1)),
      p25: r1(cur + q(deltas, 0.25)),
      p50: r1(cur + q(deltas, 0.5)),
      p75: r1(cur + q(deltas, 0.75)),
      p90: r1(cur + q(deltas, 0.9)),
    },
  };
}

/**
 * Round-2 refinement: analogue deltas are few (8-30), so their empirical p10/p90 tails are
 * understated (cov80 came out 0.72). Hybrid: inner quantiles (p25/p50/p75) from the
 * conditioned analogue deltas, tail quantiles (p10/p90) from the WIDER of analogue and
 * all-usable-season deltas. allUsableDeltas must be the month-m increments of every usable
 * past season (computed by the caller from the same masked data).
 */
export function allocDeltaHybridQuantiles(baselineOut: any, allUsableDeltas: number[]): { q: Quantiles; n: number } | null {
  const base = allocDeltaQuantiles(baselineOut);
  if (!base) return null;
  const cur = baselineOut.inputs.current_announced_pct as number;
  const all = asc(allUsableDeltas.map((d) => Math.max(0, d)));
  if (all.length < 5) return base;
  return {
    n: base.n,
    q: {
      ...base.q,
      p10: r1(Math.min(base.q.p10!, cur + q(all, 0.1))),
      p90: r1(Math.max(base.q.p90!, cur + q(all, 0.9))),
    },
  };
}

// ---- 2. temp price: seasonal-ratio anchored on current level ------------------------
interface MosCell { season: number; mos: number; n: number; med: number; }

async function fetchSeasonMosMedians(run: Runner, region_id: number): Promise<MosCell[]> {
  const rows = await run(
    `SELECT EXTRACT(YEAR FROM oc.date_accepted - interval '6 months')::int AS season,
            (((EXTRACT(MONTH FROM oc.date_accepted)::int - 7 + 12) % 12) + 1) AS mos,
            count(*) AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY oc.buying_price_per_ml) AS med
       FROM order_completed oc
       JOIN wateroffer wo ON wo.id = oc.wateroffer
      WHERE oc.date_deleted IS NULL AND wo.sale = false
        AND wo.sellingregion = $1 AND oc.buying_price_per_ml > 0
      GROUP BY 1, 2`,
    [region_id],
  );
  return rows.map((r) => ({ season: Number(r.season), mos: Number(r.mos), n: Number(r.n), med: Number(r.med) }));
}

const MIN_CELL = 3;
const MIN_RATIO_PAIRS = 5;

/**
 * For each horizon step, quantiles of (anchor price x historical seasonal ratio).
 * Runs against the MASKED runner so only pre-cutoff trades are visible.
 * Returns one Quantiles per step (or null when the ratio pool is too thin).
 */
export async function priceSeasonalRatioQuantiles(
  run: Runner, item: PriceItem, opts?: { adjacentPool?: boolean },
): Promise<Map<number, { q: Quantiles; pairs: number }>> {
  const out = new Map<number, { q: Quantiles; pairs: number }>();
  const cells = await fetchSeasonMosMedians(run, item.region_id);
  const cell = new Map<string, MosCell>();
  for (const c of cells) cell.set(`${c.season}_${c.mos}`, c);

  const m = item.mos;
  const curSeason = item.season;
  const anchorCell = cell.get(`${curSeason}_${m}`);
  const anchor = anchorCell && anchorCell.n >= MIN_CELL ? anchorCell.med : item.last_med_before_cutoff;
  if (anchor == null || anchor <= 0) return out;

  // Ratios of med[ask month + k] / med[ask month] across past seasons. With adjacentPool,
  // thin pools are widened using ask-months m-1 and m+1 at the same lag k (round-2: the
  // strict same-month pool left half the steps unscored and understated the tails).
  const ratiosFor = (askMos: number, k: number): number[] => {
    const t = askMos + k;
    const tMos = ((t - 1) % 12) + 1;
    const sOff = t > 12 ? 1 : 0;
    const ratios: number[] = [];
    for (const c of cells) {
      if (c.season >= curSeason || c.mos !== askMos || c.n < MIN_CELL) continue;
      const target = cell.get(`${c.season + sOff}_${tMos}`);
      if (!target || target.n < MIN_CELL || c.med <= 0) continue;
      ratios.push(target.med / c.med);
    }
    return ratios;
  };

  for (let k = 1; k <= item.horizon; k++) {
    let ratios = ratiosFor(m, k);
    if (opts?.adjacentPool && ratios.length < 10) {
      for (const adj of [m - 1, m + 1]) {
        if (adj >= 1 && adj <= 12) ratios = ratios.concat(ratiosFor(adj, k));
      }
    }
    if (ratios.length < MIN_RATIO_PAIRS) continue;
    const s = asc(ratios);
    out.set(k, {
      pairs: ratios.length,
      q: {
        p10: Math.round(anchor * q(s, 0.1)),
        p25: Math.round(anchor * q(s, 0.25)),
        p50: Math.round(anchor * q(s, 0.5)),
        p75: Math.round(anchor * q(s, 0.75)),
        p90: Math.round(anchor * q(s, 0.9)),
      },
    });
  }
  return out;
}

// ---- 3. entitlement: random walk with empirical increment ---------------------------
/**
 * From the baseline tool's annual series (analogues_or_series: {year, median_pml}),
 * quantiles of historical h-year log-changes applied to the last observed median.
 * Exact-h pairs when there are enough; otherwise a normal approximation from 1-year
 * log-changes (mean*h, sd*sqrt(h)).
 */
export function entIncrementQuantiles(
  baselineOut: any, horizon: number, drift: 'empirical' | 'none' = 'empirical',
): { q: Quantiles; basis: string } | null {
  const series: any[] = (baselineOut?.analogues_or_series ?? [])
    .filter((c: any) => c.median_pml != null && c.median_pml > 0)
    .sort((a: any, b: any) => a.year - b.year);
  if (series.length < 4) return null;
  const last = series[series.length - 1].median_pml;
  const byYear = new Map<number, number>(series.map((c: any) => [c.year, c.median_pml]));

  const exact: number[] = [];
  for (const c of series) {
    const t = byYear.get(c.year + horizon);
    if (t != null) exact.push(Math.log(t / c.median_pml));
  }
  const mk = (p10: number, p25: number, p50: number, p75: number, p90: number, basis: string) => ({
    basis,
    q: {
      p10: Math.round(last * Math.exp(p10)),
      p25: Math.round(last * Math.exp(p25)),
      p50: Math.round(last * Math.exp(p50)),
      p75: Math.round(last * Math.exp(p75)),
      p90: Math.round(last * Math.exp(p90)),
    },
  });
  if (exact.length >= 6) {
    const s = asc(exact);
    // drift 'none': recentre the increment distribution on zero (round-2 finding — the
    // historical median drift overshoots when growth stalls; persistence beat it)
    const shift = drift === 'none' ? q(s, 0.5) : 0;
    return mk(q(s, 0.1) - shift, q(s, 0.25) - shift, q(s, 0.5) - shift, q(s, 0.75) - shift, q(s, 0.9) - shift,
      `empirical_${exact.length}_pairs${drift === 'none' ? '_zero_drift' : ''}`);
  }
  // normal approx from 1-year changes
  const one: number[] = [];
  for (const c of series) {
    const t = byYear.get(c.year + 1);
    if (t != null) one.push(Math.log(t / c.median_pml));
  }
  if (one.length < 3) return null;
  const mu = one.reduce((s, v) => s + v, 0) / one.length;
  const sd = Math.sqrt(one.reduce((s, v) => s + (v - mu) ** 2, 0) / Math.max(1, one.length - 1));
  const m = (drift === 'none' ? 0 : mu * horizon), w = sd * Math.sqrt(horizon);
  // z for 10/25/50/75/90
  return mk(m - 1.282 * w, m - 0.674 * w, m, m + 0.674 * w, m + 1.282 * w,
    `normal_approx_${one.length}_one_year_changes${drift === 'none' ? '_zero_drift' : ''}`);
}
