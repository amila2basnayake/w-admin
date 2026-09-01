import type { Runner } from './asof-db';
import type { PriceItem } from './items';
import type { Quantiles } from './score';

// =====================================================================================
//  "Skeptic" temp-price variant (skeptical-review round, 2026-08-01).
//
//  Target weakness (on record + confirmed by slicing improved2.json rows):
//  the anchored seasonal-ratio bands are systematically overconfident — cov80 0.50,
//  cov50 0.26 — and the failure is NOT a thin-pool problem (pools >= 10 pairs cover
//  0.50 too). Two mechanisms:
//    a) empirical p10/p90 of 5-25 sample ratios understate the true tails (order
//       statistics of small samples cannot reach beyond the sample range);
//    b) log price ratios are heavy-tailed and regime-shifting (2019-2023 drought
//       spike + crash), so even the sample range understates forward dispersion.
//
//  Fix (deterministic, no parameter tuned on the backtest):
//  keep the improved2 anchor and ratio-pool construction EXACTLY (same gating, so the
//  scored subset is identical), keep the empirical median as p50 (the improved2 p50 is
//  already persistence-grade; we change bands, not the centre), and replace the raw
//  empirical band quantiles with the WIDER of
//    - the empirical quantile (captures realized skew), and
//    - a Student-t predictive quantile in log space:
//        med(x) +/- t_{df,tau} * sd(x) * sqrt(1 + 1/n),   x = ln(ratio)
//      with df = min(n-1, 6). df<=6 is an a-priori heavy-tail assumption (standard for
//      price relatives), not fitted to these results; sqrt(1+1/n) is the usual
//      predictive-interval correction for estimating the centre from the same sample.
//  Widening only (max/min with the empirical quantile) because the KNOWN direction of
//  miscalibration is overconfidence; the pinball score will arbitrate whether the
//  width is worth it.
// =====================================================================================

const qEmp = (sorted: number[], t: number): number => {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const rank = t * (n - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return lo === hi ? sorted[lo] : sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
};
const asc = (xs: number[]) => [...xs].sort((a, b) => a - b);

// ---- Student-t one-sided quantiles (table + interpolation in 1/df) ------------------
const T_DFS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 60];
const T_75 = [1.0, 0.816, 0.765, 0.741, 0.727, 0.718, 0.711, 0.706, 0.703, 0.7, 0.695, 0.691, 0.687, 0.683, 0.679];
const T_90 = [3.078, 1.886, 1.638, 1.533, 1.476, 1.44, 1.415, 1.397, 1.383, 1.372, 1.356, 1.341, 1.325, 1.31, 1.296];
const T_INF = { 0.75: 0.674, 0.9: 1.282 } as const;

export function tQuantile(df: number, tau: 0.75 | 0.9): number {
  const tab = tau === 0.9 ? T_90 : T_75;
  if (df <= T_DFS[0]) return tab[0];
  if (df >= T_DFS[T_DFS.length - 1]) {
    // interpolate in 1/df between df=60 and df=inf
    const x = 1 / df, x0 = 1 / 60;
    const v60 = tab[tab.length - 1], vInf = T_INF[tau];
    return vInf + (v60 - vInf) * (x / x0);
  }
  for (let i = 0; i < T_DFS.length - 1; i++) {
    if (df >= T_DFS[i] && df <= T_DFS[i + 1]) {
      const x = 1 / df, x0 = 1 / T_DFS[i], x1 = 1 / T_DFS[i + 1];
      const w = (x - x0) / (x1 - x0);
      return tab[i] + w * (tab[i + 1] - tab[i]);
    }
  }
  return T_INF[tau];
}

// ---- season/month median cells (identical to variants-improved, which keeps this
//      private; re-stated here verbatim so the pool construction cannot diverge) ------
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
const MAX_DF = 6; // a-priori heavy-tail cap, see header

export interface SkepticStep { q: Quantiles; pairs: number; sd_log: number; df: number; }

/**
 * Per horizon step: anchored quantiles with t-predictive tail widening in log space.
 * Pool construction (anchor, MIN_CELL, MIN_RATIO_PAIRS, adjacent-month widening at
 * <10 pairs) mirrors priceSeasonalRatioQuantiles(run, item, {adjacentPool: true})
 * exactly, so the scored subset matches improved2 step-for-step.
 */
export async function skepticPriceQuantiles(run: Runner, item: PriceItem): Promise<Map<number, SkepticStep>> {
  const out = new Map<number, SkepticStep>();
  const cells = await fetchSeasonMosMedians(run, item.region_id);
  const cell = new Map<string, MosCell>();
  for (const c of cells) cell.set(`${c.season}_${c.mos}`, c);

  const m = item.mos;
  const curSeason = item.season;
  const anchorCell = cell.get(`${curSeason}_${m}`);
  const anchor = anchorCell && anchorCell.n >= MIN_CELL ? anchorCell.med : item.last_med_before_cutoff;
  if (anchor == null || anchor <= 0) return out;

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
    if (ratios.length < 10) {
      for (const adj of [m - 1, m + 1]) {
        if (adj >= 1 && adj <= 12) ratios = ratios.concat(ratiosFor(adj, k));
      }
    }
    if (ratios.length < MIN_RATIO_PAIRS) continue;

    const xs = asc(ratios.filter((r) => r > 0).map((r) => Math.log(r)));
    const n = xs.length;
    if (n < MIN_RATIO_PAIRS) continue;
    const med = qEmp(xs, 0.5);
    const mean = xs.reduce((s, v) => s + v, 0) / n;
    let sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
    sd = Math.max(sd, 0.02); // degenerate-pool floor
    const df = Math.min(n - 1, MAX_DF);
    const f = Math.sqrt(1 + 1 / n);
    const t90 = tQuantile(df, 0.9) * sd * f;
    const t75 = tQuantile(df, 0.75) * sd * f;

    // widen-only merge: empirical quantile vs t-predictive quantile around the median
    const lo = (emp: number, off: number) => Math.min(emp, med - off);
    const hi = (emp: number, off: number) => Math.max(emp, med + off);
    out.set(k, {
      pairs: n,
      sd_log: Math.round(sd * 1000) / 1000,
      df,
      q: {
        p10: Math.round(anchor * Math.exp(lo(qEmp(xs, 0.1), t90))),
        p25: Math.round(anchor * Math.exp(lo(qEmp(xs, 0.25), t75))),
        p50: Math.round(anchor * Math.exp(med)),
        p75: Math.round(anchor * Math.exp(hi(qEmp(xs, 0.75), t75))),
        p90: Math.round(anchor * Math.exp(hi(qEmp(xs, 0.9), t90))),
      },
    });
  }
  return out;
}
