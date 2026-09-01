// =====================================================================================
//  Scoring for forecast backtests.
//
//  The workhorse is the pinball (quantile) loss — a proper scoring rule: over many
//  items the expected loss is minimised only by the true quantiles, so it rewards
//  BOTH calibration and sharpness and gives a single comparable number per variant.
//  Coverage rates make miscalibration legible (an 80% interval should cover ~80%),
//  and width shows what the coverage costs.
// =====================================================================================

export interface Quantiles {
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

export function pinball(tau: number, q: number, y: number): number {
  return q <= y ? tau * (y - q) : (1 - tau) * (q - y);
}

export interface QScore {
  crps_approx: number;       // mean pinball over available taus (same units as y)
  cov80: boolean | null;     // p10 <= y <= p90
  cov50: boolean | null;     // p25 <= y <= p75
  width80: number | null;
  width50: number | null;
  abs_err_p50: number | null;
}

/** Score a quantile set against outcome y. Missing quantiles are skipped (not penalised). */
export function scoreQuantiles(q: Quantiles, y: number): QScore {
  const taus: Array<[number, number | null]> = [
    [0.1, q.p10], [0.25, q.p25], [0.5, q.p50], [0.75, q.p75], [0.9, q.p90],
  ];
  const losses = taus.filter(([, v]) => v != null).map(([t, v]) => pinball(t, v!, y));
  return {
    crps_approx: losses.length ? losses.reduce((s, v) => s + v, 0) / losses.length : NaN,
    cov80: q.p10 != null && q.p90 != null ? q.p10 <= y && y <= q.p90 : null,
    cov50: q.p25 != null && q.p75 != null ? q.p25 <= y && y <= q.p75 : null,
    width80: q.p10 != null && q.p90 != null ? q.p90 - q.p10 : null,
    width50: q.p25 != null && q.p75 != null ? q.p75 - q.p25 : null,
    abs_err_p50: q.p50 != null ? Math.abs(q.p50 - y) : null,
  };
}

/** A point forecast scored as a degenerate quantile set (all quantiles = the point). */
export function pointAsQuantiles(v: number): Quantiles {
  return { p10: v, p25: v, p50: v, p75: v, p90: v };
}

// ---- aggregation ------------------------------------------------------------------
export interface Agg {
  n: number;
  mean_crps: number;
  cov80_rate: number | null;  // fraction of items covered (target 0.80)
  cov50_rate: number | null;  // target 0.50
  mean_width80: number | null;
  mean_width50: number | null;
  mean_abs_err_p50: number | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const r2 = (v: number | null): number | null => (v == null ? null : Math.round(v * 100) / 100);

export function aggregate(scores: QScore[]): Agg | null {
  const valid = scores.filter((s) => Number.isFinite(s.crps_approx));
  if (valid.length === 0) return null;
  const covs80 = valid.filter((s) => s.cov80 !== null);
  const covs50 = valid.filter((s) => s.cov50 !== null);
  return {
    n: valid.length,
    mean_crps: r2(mean(valid.map((s) => s.crps_approx)))!,
    cov80_rate: covs80.length ? r2(covs80.filter((s) => s.cov80).length / covs80.length) : null,
    cov50_rate: covs50.length ? r2(covs50.filter((s) => s.cov50).length / covs50.length) : null,
    mean_width80: r2(mean(valid.map((s) => s.width80).filter((v): v is number => v != null))),
    mean_width50: r2(mean(valid.map((s) => s.width50).filter((v): v is number => v != null))),
    mean_abs_err_p50: r2(mean(valid.map((s) => s.abs_err_p50).filter((v): v is number => v != null))),
  };
}

/** Aggregate with a grouping key (e.g. by month-of-season, by horizon step). */
export function aggregateBy<T>(rows: T[], key: (t: T) => string, score: (t: T) => QScore): Record<string, Agg | null> {
  const groups = new Map<string, QScore[]>();
  for (const r of rows) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(score(r));
  }
  const out: Record<string, Agg | null> = {};
  for (const [k, v] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) out[k] = aggregate(v);
  return out;
}
