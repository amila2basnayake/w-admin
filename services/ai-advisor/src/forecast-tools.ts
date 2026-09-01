import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { runScoped, type CallerCtx } from './data-db';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// =====================================================================================
//  Forecasting tools (Workstream C of ceo-parity-plan.md; spec: ai-advisor-forecasting.md).
//  Empirical, analogue-based, explainable. Ranges/distributions ONLY — never a point estimate.
//  Every response carries methodology, data_as_at (from the snapshot's own latest dates),
//  sample_sizes and caveats[].
//  Thin data degrades LOUDLY: widen the pool (month->quarter, region->state) and say so, or
//  refuse with a reason. PostgreSQL 9.6 SQL only. Reuses the verified advisory-toolkit joins.
//
//  Heavy computation lives in plain compute* functions (driven directly by test-forecast.ts);
//  the tool wrappers only adapt args and stamp the shared presentation contract.
// =====================================================================================

// ---- shared presentation contract (repeated in every tool description AND payload) -------------
// The not-advice clause was removed 2026-08-04 at the user's direction, along with the rest of the
// disclaimer layer. What remains is STATISTICAL accuracy, not a disclaimer: these estimators produce
// distributions, and collapsing one to a single number misstates what was actually computed.
const PRESENTATION =
  'Results are distributions/ranges computed from historical Waterfind data (see methodology and ' +
  'data_as_at); no single-point estimate is produced.';

// A region.state grouping is a river/scheme grouping in this DB (e.g. "MURRUMBIDGEE RIVER"), not an
// Australian state; "pool to state" here means pool across regions that share region.state.

// ---- generic helpers -------------------------------------------------------------------------
type Runner = (sql: string, params?: any[]) => Promise<any[]>;

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));
const pct1 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const money0 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v));

/** percentile_cont-equivalent: linear interpolation over a sorted numeric array. */
function percentileCont(sortedAsc: number[], q: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const rank = q * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (rank - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

function distribution(values: number[], round: (v: number | null) => number | null) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: round(s.length ? s[0] : null),
    p10: round(percentileCont(s, 0.1)),
    p25: round(percentileCont(s, 0.25)),
    p50: round(percentileCont(s, 0.5)),
    p75: round(percentileCont(s, 0.75)),
    p90: round(percentileCont(s, 0.9)),
    max: round(s.length ? s[s.length - 1] : null),
  };
}
const median = (values: number[]): number | null =>
  percentileCont([...values].sort((a, b) => a - b), 0.5);

const mosOf = (month1to12: number) => (((month1to12 - 7 + 12) % 12) + 1); // Jul=1 .. Jun=12
const quarterOf = (mos: number) => Math.floor((mos - 1) / 3); // 0..3

// ---- data-staleness guard (H11) ---------------------------------------------------------------
// Forecast tools must not pass stale data off as "now": the "current season", "current month" and
// price-level anchors are all derived from the newest row in the DB, which in a quiet region (or a
// historical dump) can be years old. Thresholds: 90 days for the monthly-granularity allocation and
// temporary-price tools (about three missed announcement/trade cycles — beyond that the "current"
// framing is genuinely misleading), 365 days for the annual-granularity entitlement series (sales
// are lumpy and a quiet season is normal, but a silent year means the latest fitted year is no
// longer "now"). new Date()/Date.now() is the established pattern in this codebase
// (refresh-extdata.ts, data-db.ts) and is fine here.
const STALE_DAYS_MONTHLY = 90;
const STALE_DAYS_ANNUAL = 365;

function daysSince(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const t = Date.parse(isoDate);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : null;
}

// ---- optional WS-B snapshot loader (graceful when knowledge/data is absent) -------------------
const DATA_DIR = (() => {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../knowledge/data');
  } catch {
    return path.resolve(process.cwd(), 'knowledge/data');
  }
})();

/** Best-effort read of a WS-B snapshot JSON; returns null if the file (or dir) is not present. */
function loadSnapshot(...names: string[]): any | null {
  for (const name of names) {
    try {
      return JSON.parse(readFileSync(path.join(DATA_DIR, name), 'utf8'));
    } catch {
      /* absent or unreadable — try next / fall through */
    }
  }
  return null;
}

// ---- WS-B allocation snapshot cross-check (H8) -------------------------------------------------
// allocations.json is keyed by announcement, not by CRM region id: { dataset, season, as_at,
// announcements: [{ state, valley, licence_class, allocation_pct, season, as_at, ... }] }.
// To find the row for a DB region we map:
//   * Australian state: region -> state -> territory; territory names carry the jurisdiction as a
//     prefix ("NSW - RIVER LICENCES...", "VIC - IRRIGATION DISTRICTS", "SA - GROUNDWATER", ...).
//   * valley: from the chosen allocation-series title, which already names it (e.g. "Murrumbidgee
//     Valley (General Security)", "Goulburn System Allocation (Low Reliability)"). Every
//     significant word of the announcement's valley must appear in the title; "river(s)",
//     "valley(s)", "all", "regulated" and parentheses are not significant, so "River Murray"
//     matches "SA Murray Class 3" and "Namoi (Lower)" matches "Lower Namoi (General Security)".
//   * licence class: parsed from the series title (general/high security, HRWS/LRWS, conveyance,
//     "Class N"). When the title carries no class we default to the state's headline traded class
//     — NSW general security, VIC HRWS, SA Class 3 — because that is the class the region's market
//     conversation is normally about; the returned `matched` block surfaces exactly which row was
//     used so the model can say so.
// A region that cannot be mapped (no AU state, no matching announcement, or a qualitative
// announcement with null pct) returns null with a debug log — the cross-check is optional.
const AU_STATE_RE = /^(NSW|VIC|SA|QLD|WA|TAS|NT|ACT)\b/i;

async function fetchAuState(run: Runner, region_id: number): Promise<string | null> {
  const rows = await run(
    `SELECT t.name AS territory
       FROM region r JOIN state s ON s.id = r.state JOIN territory t ON t.id = s.territory
      WHERE r.id = $1`,
    [region_id],
  );
  const m = rows.length ? String(rows[0].territory ?? '').match(AU_STATE_RE) : null;
  return m ? m[1].toUpperCase() : null;
}

function licenceClassMatcher(seriesTitle: string, auState: string): string {
  const t = seriesTitle.toLowerCase();
  if (t.includes('general security')) return 'general security';
  if (t.includes('high security')) return 'high security';
  if (t.includes('conveyance')) return 'conveyance';
  if (/high reliability|hrws/.test(t)) return 'high reliability';
  if (/low reliability|lrws/.test(t)) return 'low reliability';
  const cls = t.match(/class \d/);
  if (cls) return cls[0];
  // No class in the title: default to the state's headline traded class (see block comment).
  return auState === 'NSW' ? 'general security'
    : auState === 'VIC' ? 'high reliability'
    : auState === 'SA' ? 'class 3'
    : '';
}

const VALLEY_NOISE_WORDS = new Set(['river', 'rivers', 'valley', 'valleys', 'all', 'regulated']);

function valleyMatchesTitle(valley: string, seriesTitle: string): boolean {
  const title = seriesTitle.toLowerCase();
  const words = valley.toLowerCase().replace(/[()]/g, ' ').split(/\s+/)
    .filter((w) => w && !VALLEY_NOISE_WORDS.has(w));
  if (words.length === 0) return false;
  return words.every((w) =>
    new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(title));
}

interface SnapshotAllocMatch {
  pct: number;
  state: string; valley: string; licence_class: string;
  season: string | null; as_at: string | null; stage: string | null;
  source_name: string | null;
}

async function snapshotAllocationCrossCheck(
  run: Runner, region_id: number, seriesTitle: string,
): Promise<SnapshotAllocMatch | null> {
  const snap = loadSnapshot('allocations.json', 'allocation.json', 'allocation-snapshot.json');
  const rows: any[] = Array.isArray(snap?.announcements) ? snap.announcements : [];
  if (rows.length === 0) return null;
  const auState = await fetchAuState(run, region_id);
  if (!auState) {
    console.debug(`forecast: snapshot cross-check skipped — region ${region_id} has no mappable AU state`);
    return null;
  }
  const cls = licenceClassMatcher(seriesTitle, auState);
  const candidates = rows.filter((r) =>
    String(r.state ?? '').toUpperCase() === auState &&
    valleyMatchesTitle(String(r.valley ?? ''), seriesTitle) &&
    cls !== '' && String(r.licence_class ?? '').toLowerCase().includes(cls));
  if (candidates.length === 0) {
    console.debug(`forecast: snapshot cross-check found no announcement for region ${region_id} ` +
      `(state=${auState}, class="${cls}", series="${seriesTitle}")`);
    return null;
  }
  // Prefer the most specific valley string when several rows match (e.g. "Lower Darling" over "Murray").
  candidates.sort((a, b) => String(b.valley ?? '').length - String(a.valley ?? '').length);
  const row = candidates[0];
  if (row.allocation_pct == null) {
    console.debug(`forecast: snapshot announcement for region ${region_id} is qualitative (null pct); cross-check skipped`);
    return null;
  }
  return {
    pct: Number(row.allocation_pct),
    state: String(row.state), valley: String(row.valley), licence_class: String(row.licence_class),
    season: row.season ?? snap.season ?? null,
    as_at: row.as_at ?? snap.as_at ?? null,
    stage: row.stage ?? null,
    source_name: row.source_name ?? null,
  };
}

// =====================================================================================
//  Allocation-series primitives (shared by tool 1 and the tercile classifier of tool 2)
// =====================================================================================

interface SeriesInfo { id: number; title: string; seasons: number; readings: number; }
interface Reading { d: string; season: number; mos: number; pct: number; }
interface Season { season: number; points: Reading[]; finalPct: number; finalMos: number; finalIsMature: boolean; }

// H10: a season's last reading only counts as its FINAL (end-of-season) allocation when the season
// was observed late enough. Allocations only ever ratchet upward within a season, so a record that
// stops mid-season understates the true final and would skew both the analogue final-% distribution
// and the dry/median/wet terciles. We accept a last reading as final when EITHER:
//   * it falls at month-of-season >= 10 (April onwards — determinations are essentially settled by
//     autumn and any later movement is small), OR
//   * it is already >= 100% (once at/above full allocation the final cannot be materially
//     understated; in this DB many wet seasons stop being recorded the moment they hit 100%, and
//     excluding those would systematically bias the "final" distribution dry).
// Everything else is excluded from final-based statistics and the exclusion is reported in
// sample_sizes/caveats so the model can relay it.
const FINAL_MATURE_MOS = 10;
const FINAL_MATURE_PCT = 100;

export async function fetchAllocationSeries(run: Runner, region_id: number, klass?: string): Promise<SeriesInfo[]> {
  const rows = await run(
    `SELECT war.water_allocation AS id, wa.title,
            count(DISTINCT EXTRACT(YEAR FROM wr.effective_date - interval '6 months')) AS seasons,
            count(wr.id) AS readings
       FROM water_allocation_region war
       JOIN water_allocation wa ON wa.id = war.water_allocation
       LEFT JOIN water_allocation_reading wr
              ON wr.water_allocation = war.water_allocation
             AND wr.effective_date > '1900-01-01' AND wr.allocation_percent IS NOT NULL
      WHERE war.region = $1 AND ($2::text IS NULL OR wa.title ILIKE '%' || $2 || '%')
      GROUP BY war.water_allocation, wa.title
      ORDER BY seasons DESC, readings DESC`,
    [region_id, klass ?? null],
  );
  return rows.map((r) => ({ id: num(r.id)!, title: r.title, seasons: num(r.seasons) ?? 0, readings: num(r.readings) ?? 0 }));
}

export async function fetchAllocationReadings(run: Runner, water_allocation: number): Promise<Reading[]> {
  const rows = await run(
    `SELECT to_char(wr.effective_date, 'YYYY-MM-DD') AS d,
            EXTRACT(YEAR FROM wr.effective_date - interval '6 months')::int AS season,
            (((EXTRACT(MONTH FROM wr.effective_date)::int - 7 + 12) % 12) + 1) AS mos,
            wr.allocation_percent AS pct
       FROM water_allocation_reading wr
      WHERE wr.water_allocation = $1
        AND wr.effective_date > '1900-01-01' AND wr.allocation_percent IS NOT NULL
      ORDER BY wr.effective_date`,
    [water_allocation],
  );
  return rows.map((r) => ({ d: String(r.d), season: num(r.season)!, mos: num(r.mos)!, pct: Number(r.pct) }));
}

/** Group readings into seasons (1 Jul–30 Jun) with a forward-fillable trajectory + final %. */
export function buildSeasons(readings: Reading[]): Season[] {
  const bySeason = new Map<number, Reading[]>();
  for (const r of readings) {
    if (!bySeason.has(r.season)) bySeason.set(r.season, []);
    bySeason.get(r.season)!.push(r);
  }
  const out: Season[] = [];
  for (const [season, pts] of bySeason) {
    const points = [...pts].sort((a, b) => a.d.localeCompare(b.d));
    const last = points[points.length - 1];
    out.push({
      season, points, finalPct: last.pct, finalMos: last.mos,
      finalIsMature: last.mos >= FINAL_MATURE_MOS || last.pct >= FINAL_MATURE_PCT,
    });
  }
  return out.sort((a, b) => a.season - b.season);
}

/** Announced % at month-of-season m (forward-fill: latest reading with mos<=m); null if none yet. */
export function trajAt(s: Season, m: number): number | null {
  const eligible = s.points.filter((p) => p.mos <= m);
  if (eligible.length === 0) return null;
  return eligible[eligible.length - 1].pct; // points are date-sorted; last eligible is most recent
}

/** season -> MATURE final allocation % (excluding the current/latest season and seasons whose
 *  record stops mid-season — see FINAL_MATURE_MOS/FINAL_MATURE_PCT). Uses the richest series. */
export async function buildSeasonFinals(run: Runner, region_id: number): Promise<{ finals: Map<number, number>; excludedImmature: number; series: SeriesInfo | null; curSeason: number | null }> {
  const series = await fetchAllocationSeries(run, region_id);
  if (series.length === 0) return { finals: new Map(), excludedImmature: 0, series: null, curSeason: null };
  const readings = await fetchAllocationReadings(run, series[0].id);
  const seasons = buildSeasons(readings);
  const curSeason = seasons.length ? seasons[seasons.length - 1].season : null;
  const finals = new Map<number, number>();
  let excludedImmature = 0;
  for (const s of seasons) {
    if (s.season === curSeason) continue;
    if (s.finalIsMature) finals.set(s.season, s.finalPct);
    else excludedImmature++;
  }
  return { finals, excludedImmature, series: series[0], curSeason };
}

// =====================================================================================
//  SOI (Southern Oscillation Index) — May–Jul mean per year, for optional conditioning
// =====================================================================================
async function fetchSoiMayJulByYear(run: Runner): Promise<Map<number, number>> {
  const rows = await run(
    `SELECT EXTRACT(YEAR FROM date_read)::int AS yr, avg(index_value) AS v
       FROM soi_monthly_reading
      WHERE EXTRACT(MONTH FROM date_read) IN (5, 6, 7) AND index_value IS NOT NULL
      GROUP BY yr`,
  );
  const m = new Map<number, number>();
  for (const r of rows) m.set(num(r.yr)!, Number(r.v));
  return m;
}
const sign = (v: number | null | undefined) => (v == null ? 0 : v > 0 ? 1 : v < 0 ? -1 : 0);

// =====================================================================================
//  TOOL 1 — forecast_allocation
// =====================================================================================
const MIN_ANALOGUES = 8;
const MIN_USABLE_SEASONS = 3;         // below this we refuse rather than fabricate
const MIN_SOI_ANALOGUES = 6;          // SOI conditioning only applied if it leaves >= this many
const TOLERANCE_LADDER = [5, 10, 15, 20, 30, 50, 100];

export async function computeAllocationForecast(run: Runner, region_id: number, klass?: string) {
  const caveats: string[] = [];
  let series = await fetchAllocationSeries(run, region_id, klass);
  if (klass && series.length === 0) {
    caveats.push(`No allocation series matched class "${klass}"; class filter ignored.`);
    series = await fetchAllocationSeries(run, region_id);
  }
  const base = {
    tool: 'forecast_allocation',
    inputs: { region_id, class: klass ?? null },
    presentation: PRESENTATION,
  };
  if (series.length === 0) {
    return { ...base, refused: true, reason: `No allocation series is mapped to region ${region_id}.`, data_as_at: null, caveats };
  }
  const chosen = series[0];
  const others = series.slice(1).map((s) => ({ id: s.id, title: s.title, seasons: s.seasons }));

  const readings = await fetchAllocationReadings(run, chosen.id);
  const seasons = buildSeasons(readings);
  // H12: the series join is a LEFT JOIN, so a mapped series can have zero readings — refuse rather
  // than crash on an empty seasons array.
  if (seasons.length === 0) {
    return {
      ...base, refused: true,
      reason: `Allocation series "${chosen.title}" (id ${chosen.id}) is mapped to region ${region_id} but has ` +
        'no usable readings, so there is no history to forecast from.',
      data_as_at: null, caveats,
    };
  }
  const dataAsAt = readings[readings.length - 1].d;
  const curSeasonObj = seasons[seasons.length - 1];
  const curSeason = curSeasonObj.season;
  const latest = curSeasonObj.points[curSeasonObj.points.length - 1];
  const m = latest.mos;                       // month-of-season at the newest reading
  const p = latest.pct;                       // latest announced % (data_as_at)

  // H11: the "current" season/month/% above are as at the newest READING, not the wall clock.
  const staleDays = daysSince(dataAsAt);
  const staleData = staleDays != null && staleDays > STALE_DAYS_MONTHLY;
  if (staleData) {
    caveats.push(
      `STALE DATA: the newest allocation reading for this series is ${dataAsAt} (${staleDays} days ago). ` +
      'The "current season", "current month-of-season" and "current announced %" all describe that reading, ' +
      'NOT today — present them as historical (as at that date) and verify the current determination with ' +
      'the resource manager.',
    );
  }

  const methodology =
    'Water season is 1 Jul-30 Jun. For each past season the announced allocation % is forward-filled ' +
    `to a month-of-season trajectory. As at the newest reading (${dataAsAt}) the season sat at month ${m} ` +
    `of 12 with an announced ${pct1(p)}%. Analogue seasons are past seasons whose month-${m} % is within a ` +
    'tolerance of that %, widening the tolerance until at least 8 analogues are found. Because allocations ' +
    'only ratchet upward within a season, the forecast models the REMAINING INCREMENT: each analogue\'s ' +
    `(final % minus its month-${m} %), floored at zero, added to the current announced %; the p10/p90 tails ` +
    'are widened to the all-usable-seasons increment distribution so a small analogue pool cannot understate ' +
    'the extremes (backtested: 26% lower pinball loss than the level distribution, cov80 0.78). Only seasons ' +
    'whose record runs late enough to trust the final (last reading in April or later, or already at/above ' +
    '100%) contribute. An optional Southern Oscillation Index (May-Jul phase) conditioning is applied only ' +
    'when it still leaves enough analogues. These are historical frequencies, not a prediction.';

  // usable past seasons: have a known month-m value AND a MATURE final % (H10)
  const pastSeasons = seasons.filter((s) => s.season !== curSeason);
  const immatureExcluded = pastSeasons.filter((s) => !s.finalIsMature).length;
  if (immatureExcluded > 0) {
    caveats.push(
      `${immatureExcluded} past season(s) were excluded from final-% statistics because their allocation ` +
      'record stops mid-season (last reading before April and below 100%) — their true end-of-season % is ' +
      'unknown and including it would understate the distribution.',
    );
  }
  const usable = pastSeasons
    .filter((s) => s.finalIsMature)
    .map((s) => ({ season: s.season, monthMPct: trajAt(s, m), finalPct: s.finalPct }))
    .filter((s): s is { season: number; monthMPct: number; finalPct: number } => s.monthMPct !== null);

  if (usable.length < MIN_USABLE_SEASONS) {
    return {
      ...base,
      refused: true,
      reason: `Insufficient history to forecast: only ${usable.length} past season(s) with a month-${m} reading ` +
        `AND a trustworthy end-of-season final for "${chosen.title}" (need >= ${MIN_USABLE_SEASONS}; ` +
        `${immatureExcluded} season(s) were excluded because their record stops mid-season). ` +
        'Refusing rather than fabricating a distribution.',
      data_as_at: dataAsAt,
      stale_data: staleData,
      data_age_days: staleDays,
      methodology,
      inputs: { region_id, class: klass ?? null, series: { id: chosen.id, title: chosen.title, seasons: chosen.seasons },
        current_month_of_season: m, current_announced_pct: pct1(p) },
      sample_sizes: { past_seasons_usable: usable.length, immature_final_seasons_excluded: immatureExcluded },
      caveats,
    };
  }

  // widen tolerance until >= MIN_ANALOGUES
  let tolUsed = TOLERANCE_LADDER[TOLERANCE_LADDER.length - 1];
  let analogues = usable;
  for (const tol of TOLERANCE_LADDER) {
    const a = usable.filter((s) => Math.abs(s.monthMPct - p) <= tol);
    if (a.length >= MIN_ANALOGUES) { tolUsed = tol; analogues = a; break; }
    tolUsed = tol; analogues = a;
  }
  if (analogues.length < MIN_ANALOGUES) {
    analogues = usable; // widen pool to ALL usable past seasons
    caveats.push(
      `Only ${usable.length} usable past seasons — fewer than the ${MIN_ANALOGUES} target analogues even at the ` +
      'widest tolerance. Widened the pool to ALL past seasons; treat this as low-confidence.',
    );
  }

  // Delta-hybrid estimator (graduated from backtest/variants-improved.ts, 2026-08-01, with the
  // skeptical-review level-conditioning fix): the remaining ratchet increment per season, floored
  // at 0 (data corrections can make it fractionally negative), projected from the CURRENT
  // announced %. Tail widening uses only LEVEL-COMPARABLE seasons — the unconditional all-season
  // pool mixed low-start seasons' huge climbs into saturated seasons' tails, forecasting >100%
  // finals with ~50-pt bands on seasons that can only drift a few points (skeptic finding #3).
  // "Comparable" reuses the tolerance ladder's mid rung (30 pts), and the p90 is additionally
  // capped at the best final any usable season ever reached.
  const deltaOf = (s: { monthMPct: number; finalPct: number }) => Math.max(0, s.finalPct - s.monthMPct);
  const projected = (deltas: number[]) => distribution(deltas.map((d) => p + d), pct1);
  const TAIL_TOL = TOLERANCE_LADDER[4]; // 30 — mid rung, not a new constant
  const tailPool = usable.filter((s) => Math.abs(s.monthMPct - p) <= TAIL_TOL).map(deltaOf);
  const maxHistFinal = usable.length ? Math.max(...usable.map((s) => s.finalPct)) : null;
  const hybridDist = (() => {
    const d = projected(analogues.map(deltaOf));
    if (tailPool.length >= 5) {
      const s = [...tailPool].sort((a, b) => a - b);
      const poolP10 = pct1(p + (percentileCont(s, 0.1) ?? 0));
      const poolP90 = pct1(p + (percentileCont(s, 0.9) ?? 0));
      if (d.p10 !== null && poolP10 !== null) d.p10 = Math.min(d.p10, poolP10);
      if (d.p90 !== null && poolP90 !== null) d.p90 = Math.max(d.p90, poolP90);
    }
    if (maxHistFinal !== null) {
      // no quantile above the best final ever observed for this product (still >= current: ratchet)
      const cap = pct1(Math.max(maxHistFinal, p));
      for (const k of ['p90', 'max', 'p75'] as const) {
        if (d[k] !== null && cap !== null && d[k]! > cap) d[k] = cap;
      }
    }
    if (d.min !== null && d.p10 !== null) d.min = Math.min(d.min, d.p10);
    if (d.max !== null && d.p90 !== null) d.max = Math.max(d.max, d.p90);
    return d;
  })();

  // SOI conditioning (optional) — same increment basis
  const soi = await fetchSoiMayJulByYear(run);
  const curSoi = soi.get(curSeason) ?? null;
  const curSign = sign(curSoi);
  const analoguesWithSoi = analogues.map((a) => {
    const v = soi.get(a.season) ?? null;
    return { ...a, soi_may_jul: v == null ? null : pct1(v), soi_same_sign: curSign !== 0 && sign(v) === curSign };
  });
  const soiSubset = analoguesWithSoi.filter((a) => a.soi_same_sign);
  let soiApplied = false;
  let soiDistribution: ReturnType<typeof distribution> | null = null;
  if (curSign !== 0 && soiSubset.length >= MIN_SOI_ANALOGUES) {
    soiApplied = true;
    soiDistribution = projected(soiSubset.map(deltaOf));
  }

  // WS-B snapshot cross-check (H8): match the region against the announcements snapshot via
  // AU-state + valley + licence class. Only claim agreement/disagreement when both figures refer
  // to the same water season; otherwise surface both with the season difference spelled out.
  const seriesSeasonLabel = `${curSeason}-${String((curSeason + 1) % 100).padStart(2, '0')}`;
  const snap = await snapshotAllocationCrossCheck(run, region_id, chosen.title);
  let snapshotCross: any = null;
  if (snap) {
    const comparable = snap.season == null || snap.season === seriesSeasonLabel;
    const agree = comparable ? Math.abs(snap.pct - p) <= 1 : null;
    snapshotCross = {
      snapshot_pct: pct1(snap.pct),
      snapshot_season: snap.season,
      snapshot_stage: snap.stage,
      snapshot_as_at: snap.as_at,
      matched: { state: snap.state, valley: snap.valley, licence_class: snap.licence_class, source_name: snap.source_name },
      series_pct: pct1(p),
      series_season: seriesSeasonLabel,
      comparable,
      agree,
    };
    if (!comparable) {
      const fresher = snap.season != null && snap.season > seriesSeasonLabel;
      caveats.push(
        `External allocations snapshot reports ${pct1(snap.pct)}% for ${snap.state} ${snap.valley} ` +
        `(${snap.licence_class}), season ${snap.season}${snap.as_at ? ` as at ${snap.as_at}` : ''} — a ` +
        `DIFFERENT season from this series' last reading (${pct1(p)}% in ${seriesSeasonLabel}, ${dataAsAt}).` +
        (fresher ? ' The snapshot is the more recent figure; prefer it for the current allocation and treat the series figure as historical.' : ' Both are surfaced; do not average them.'),
      );
    } else if (agree === false) {
      caveats.push(`WS-B snapshot (${pct1(snap.pct)}%) disagrees with the allocation series (${pct1(p)}%); both surfaced.`);
    }
  }

  if (m === 1) caveats.push('Current season is at month 1 (opening allocation); very early-season forecasts are the widest.');
  caveats.push('Allocation % is the announced availability of entitlement; final % can differ from any historical analogue.');
  if (others.length) caveats.push(`Region maps to ${others.length} other allocation series (e.g. reliability classes); pass "class" to switch.`);

  return {
    ...base,
    methodology,
    data_as_at: dataAsAt,
    stale_data: staleData,
    data_age_days: staleDays,
    inputs: {
      region_id,
      class: klass ?? null,
      series: { id: chosen.id, title: chosen.title, seasons: chosen.seasons, readings: chosen.readings },
      current_month_of_season: m,
      current_announced_pct: pct1(p),
      other_series_available: others,
    },
    sample_sizes: {
      analogues: analogues.length,
      past_seasons_usable: usable.length,
      immature_final_seasons_excluded: immatureExcluded,
      tolerance_pct_used: tolUsed,
      soi_conditioned_analogues: soiApplied ? soiSubset.length : null,
    },
    estimator: 'delta_analogue_hybrid',
    result: {
      final_pct_distribution: hybridDist,
      base_rate_distribution: distribution(usable.map((a) => a.finalPct), pct1),
      soi_conditioned: {
        applied: soiApplied,
        reason: soiApplied ? `same-sign May-Jul SOI (${curSign > 0 ? 'positive/wetter' : 'negative/drier'}) left ${soiSubset.length} analogues`
          : (curSign === 0 ? 'current-season May-Jul SOI unavailable/neutral' : `only ${soiSubset.length} same-sign analogues (< ${MIN_SOI_ANALOGUES})`),
        distribution: soiDistribution,
      },
    },
    analogues_or_series: analoguesWithSoi
      .map((a) => ({ season: a.season, month_m_pct: pct1(a.monthMPct), final_pct: pct1(a.finalPct), soi_may_jul: a.soi_may_jul, soi_same_sign: a.soi_same_sign }))
      .sort((x, y) => y.season - x.season),
    snapshot_cross_check: snapshotCross,
    caveats,
  };
}

// =====================================================================================
//  TOOL 2 — forecast_temp_price
// =====================================================================================
const MIN_CELL_TRADES = 5;    // minimum trades in a band cell before pooling
const ANCHOR_MIN_CURRENT = 3; // current-season trades needed before we anchor to them

interface Trade { d: string; season: number; mos: number; price: number; }

async function fetchTempTrades(run: Runner, region_id: number): Promise<Trade[]> {
  const rows = await run(
    `SELECT to_char(oc.date_accepted, 'YYYY-MM-DD') AS d,
            EXTRACT(YEAR FROM oc.date_accepted - interval '6 months')::int AS season,
            (((EXTRACT(MONTH FROM oc.date_accepted)::int - 7 + 12) % 12) + 1) AS mos,
            oc.buying_price_per_ml AS price
       FROM order_completed oc
       JOIN wateroffer wo ON wo.id = oc.wateroffer
      WHERE oc.date_deleted IS NULL AND wo.sale = false
        AND wo.sellingregion = $1 AND oc.buying_price_per_ml > 0
      ORDER BY oc.date_accepted`,
    [region_id],
  );
  return rows.map((r) => ({ d: String(r.d), season: num(r.season)!, mos: num(r.mos)!, price: Number(r.price) }));
}

async function fetchRegionState(run: Runner, region_id: number): Promise<number | null> {
  const rows = await run(`SELECT state FROM region WHERE id = $1`, [region_id]);
  return rows.length ? num(rows[0].state) : null;
}

/** Temp-trade prices for every region sharing region.state, keyed by month-of-season (pool fallback). */
async function fetchStateTempByMos(run: Runner, state_id: number): Promise<Map<number, number[]>> {
  const rows = await run(
    `SELECT (((EXTRACT(MONTH FROM oc.date_accepted)::int - 7 + 12) % 12) + 1) AS mos,
            oc.buying_price_per_ml AS price
       FROM order_completed oc
       JOIN wateroffer wo ON wo.id = oc.wateroffer
       JOIN region r ON r.id = wo.sellingregion
      WHERE oc.date_deleted IS NULL AND wo.sale = false
        AND r.state = $1 AND oc.buying_price_per_ml > 0`,
    [state_id],
  );
  const byMos = new Map<number, number[]>();
  for (const r of rows) {
    const mos = num(r.mos)!;
    if (!byMos.has(mos)) byMos.set(mos, []);
    byMos.get(mos)!.push(Number(r.price));
  }
  return byMos;
}

type Tercile = 'dry' | 'median' | 'wet';

export async function computeTempPriceForecast(run: Runner, region_id: number, horizonMonths: number) {
  const caveats: string[] = [];
  const horizon = Math.max(1, Math.min(9, Math.round(horizonMonths)));
  const base = {
    tool: 'forecast_temp_price',
    inputs: { region_id, horizon_months: horizon },
    presentation: PRESENTATION,
  };

  const trades = await fetchTempTrades(run, region_id);
  if (trades.length < MIN_CELL_TRADES) {
    return { ...base, refused: true, reason: `Only ${trades.length} settled temporary trades on record for region ${region_id} — too few to build seasonal price scenarios.`, data_as_at: trades.length ? trades[trades.length - 1].d : null, caveats };
  }
  const dataAsAt = trades[trades.length - 1].d;
  const curSeason = trades[trades.length - 1].season;
  const m = trades[trades.length - 1].mos;

  // H11: "current season", "current month" and the price-level anchor all come from the NEWEST
  // TRADE — in a quiet region that can be years old. Flag it loudly rather than projecting stale
  // prices as "the months ahead".
  const staleDays = daysSince(dataAsAt);
  const staleData = staleDays != null && staleDays > STALE_DAYS_MONTHLY;
  if (staleData) {
    caveats.push(
      `STALE DATA: the newest settled trade for this region is ${dataAsAt} (${staleDays} days ago). ` +
      'The "current season", "current month-of-season" and the price-level anchor all describe the market ' +
      `AS AT ${dataAsAt}, NOT today — present every band as historical (as at that date) and do not frame ` +
      'the horizon as "the months ahead" from today.',
    );
  }

  // tercile classification by each season's MATURE final allocation % (H10)
  const { finals, excludedImmature } = await buildSeasonFinals(run, region_id);
  if (excludedImmature > 0) {
    caveats.push(
      `${excludedImmature} past season(s) lack a trustworthy end-of-season allocation % (record stops ` +
      'mid-season) and are excluded from the dry/median/wet classification.',
    );
  }
  const finalVals = [...finals.values()].sort((a, b) => a - b);
  let t33: number | null = null;
  let t67: number | null = null;
  if (finalVals.length >= 3) { t33 = percentileCont(finalVals, 1 / 3); t67 = percentileCont(finalVals, 2 / 3); }
  const terciles: Record<Tercile, number> = { dry: 0, median: 0, wet: 0 };
  const seasonTercile = new Map<number, Tercile>();
  if (t33 !== null && t67 !== null) {
    for (const [season, fin] of finals) {
      const t: Tercile = fin <= t33 ? 'dry' : fin <= t67 ? 'median' : 'wet';
      seasonTercile.set(season, t);
      terciles[t]++;
    }
  } else {
    caveats.push('Fewer than 3 seasons of final allocation % — dry/median/wet terciles could not be built; bands are unconditioned (all trades).');
  }

  // attach tercile + partition
  let unclassified = 0;
  for (const tr of trades as any[]) {
    tr.tercile = seasonTercile.get(tr.season) ?? null;
    if (tr.tercile === null && tr.season !== curSeason) unclassified++;
  }
  if (unclassified > 0) caveats.push(`${unclassified} historical trades fall in seasons without a final allocation % and are excluded from tercile bands.`);

  const pastTrades = (trades as any[]).filter((t) => t.season !== curSeason);
  const stateId = await fetchRegionState(run, region_id);
  const stateByMos = stateId != null ? await fetchStateTempByMos(run, stateId) : new Map<number, number[]>();

  const pooledFlags = new Set<string>();
  function bandFor(tercile: Tercile, targetMos: number) {
    // 1) region + tercile + exact month-of-season
    let prices = pastTrades.filter((t) => t.tercile === tercile && t.mos === targetMos).map((t) => t.price);
    let source = 'region_month';
    // 2) pool to quarter-of-season
    if (prices.length < MIN_CELL_TRADES) {
      const q = quarterOf(targetMos);
      prices = pastTrades.filter((t) => t.tercile === tercile && quarterOf(t.mos) === q).map((t) => t.price);
      source = 'region_quarter';
      pooledFlags.add('quarter');
    }
    // 3) pool to state (drops tercile conditioning)
    if (prices.length < MIN_CELL_TRADES) {
      prices = stateByMos.get(targetMos) ?? [];
      source = 'state_month_untercile';
      pooledFlags.add('state');
    }
    if (prices.length === 0) return { source: 'none', n: 0, p25: null, median: null, p75: null };
    const s = prices.sort((a, b) => a - b);
    return { source, n: s.length, p25: money0(percentileCont(s, 0.25)), median: money0(percentileCont(s, 0.5)), p75: money0(percentileCont(s, 0.75)) };
  }

  // ---- anchoring: level-adjust historical bands to the current price level ----
  // Month-matched: per overlapping month-of-season take current-median / historical-median, then
  // take the MEDIAN of those ratios. This controls for the month mix of the observed trades.
  function monthMatchedFactor(sampleTrades: any[]): { factor: number | null; months: number } {
    const mosSet = Array.from(new Set<number>(sampleTrades.map((t) => t.mos)));
    const ratios: number[] = [];
    for (const mo of mosSet) {
      const cur = median(sampleTrades.filter((t) => t.mos === mo).map((t) => t.price));
      const past = median(pastTrades.filter((t) => t.mos === mo).map((t) => t.price));
      if (cur && past && past > 0) ratios.push(cur / past);
    }
    return { factor: ratios.length ? median(ratios) : null, months: ratios.length };
  }

  const curSeasonTrades = (trades as any[]).filter((t) => t.season === curSeason);
  let anchorFactor = 1;
  let anchorBasis: string;
  if (curSeasonTrades.length >= ANCHOR_MIN_CURRENT) {
    const mm = monthMatchedFactor(curSeasonTrades);
    if (mm.factor) anchorFactor = mm.factor;
    anchorBasis = `median of per-month current-vs-historical price ratios over ${mm.months} overlapping month(s) of the current season`;
  } else {
    // anchor to the latest 3 calendar months of trades
    const ym = (t: Trade) => t.d.slice(0, 7);
    const recentKeys = Array.from(new Set(trades.map(ym))).sort().slice(-3);
    const recent = (trades as any[]).filter((t) => recentKeys.includes(ym(t)));
    const mm = monthMatchedFactor(recent);
    if (mm.factor) anchorFactor = mm.factor;
    anchorBasis = `no/thin current-season trades; anchored to the latest 3 months of trades (${mm.months} month-of-season match(es)) vs their historical same-months`;
    caveats.push('Current season has too few trades to anchor directly; anchored to the latest 3 months of trades instead.');
  }
  if (!Number.isFinite(anchorFactor) || anchorFactor <= 0) { anchorFactor = 1; caveats.push('Anchor factor undefined; bands left un-anchored (factor 1.0).'); }
  if (anchorFactor < 0.5 || anchorFactor > 2) caveats.push(`Large anchor adjustment (x${anchorFactor.toFixed(2)}): current prices are far from the historical average for these months — anchored bands are uncertain.`);

  const applyAnchor = (v: number | null) => (v === null ? null : money0(v * anchorFactor));

  // ---- build scenario bands per horizon month ----
  const scenarioBands: any[] = [];
  let wrapped = false;
  for (let k = 1; k <= horizon; k++) {
    const idx = m + k;
    const targetMos = ((idx - 1) % 12) + 1;
    const nextSeason = idx > 12;
    if (nextSeason) wrapped = true;
    const bands: Record<string, any> = {};
    for (const t of ['dry', 'median', 'wet'] as Tercile[]) {
      const b = bandFor(t, targetMos);
      bands[t] = { source: b.source, n: b.n, p25: applyAnchor(b.p25), median: applyAnchor(b.median), p75: applyAnchor(b.p75) };
    }
    scenarioBands.push({ horizon_step: k, month_of_season: targetMos, next_season: nextSeason, bands });
  }
  // Anchored seasonal-ratio outlook (graduated 2026-08-01 from backtest/variants-improved.ts with
  // the skeptical-review recalibration of variants-skeptic.ts): within each past season, the ratio
  // of the target month's median price to THIS month's median cancels the season's price level and
  // isolates the seasonal shape; today's level times that ratio distribution gives the outlook
  // band. Raw empirical bands were overconfident (5-25 sample quantiles cannot reach beyond the
  // sample range, and log price ratios are heavy-tailed), so each tail is the WIDER of the
  // empirical quantile and a Student-t predictive quantile in log space (df<=6 a-priori,
  // sqrt(1+1/n) predictive correction) — backtested cov80 0.50 -> 0.69 at an unchanged pinball
  // score. Known residual: drought-regime years (2019+) still exceed the bands; the caveat says so.
  const MIN_RATIO_CELL = 3;
  const MIN_RATIO_PAIRS = 5;
  const MAX_T_DF = 6;
  // Student-t one-sided quantiles, interpolated in 1/df (ported from backtest/variants-skeptic.ts)
  const T_DFS = [1, 2, 3, 4, 5, 6];
  const T_75 = [1.0, 0.816, 0.765, 0.741, 0.727, 0.718];
  const T_90 = [3.078, 1.886, 1.638, 1.533, 1.476, 1.44];
  const tQ = (df: number, tau: 0.75 | 0.9): number => {
    const tab = tau === 0.9 ? T_90 : T_75;
    const d = Math.max(1, Math.min(df, MAX_T_DF));
    const i = Math.min(Math.floor(d) - 1, tab.length - 2);
    const w = d - Math.floor(d);
    return tab[i] + w * ((tab[i + 1] ?? tab[i]) - tab[i]);
  };
  const cellMed = new Map<string, { n: number; med: number | null }>();
  {
    const byCell = new Map<string, number[]>();
    for (const t of trades) {
      const k = `${t.season}_${t.mos}`;
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k)!.push(t.price);
    }
    for (const [k, prices] of byCell) cellMed.set(k, { n: prices.length, med: median(prices) });
  }
  const cellOf = (season: number, mos: number) => {
    const c = cellMed.get(`${season}_${mos}`);
    return c && c.n >= MIN_RATIO_CELL && c.med != null && c.med > 0 ? c.med : null;
  };
  const curAnchor = cellOf(curSeason, m) ?? (() => {
    // newest month cell with enough trades (matches the backtest variant's fallback)
    const cells = [...cellMed.entries()]
      .filter(([, v]) => v.n >= MIN_RATIO_CELL && v.med != null)
      .map(([k, v]) => ({ season: Number(k.split('_')[0]), mos: Number(k.split('_')[1]), med: v.med! }))
      .sort((a, b) => (a.season - b.season) || (a.mos - b.mos));
    return cells.length ? cells[cells.length - 1].med : null;
  })();
  const ratiosFor = (askMos: number, k: number): number[] => {
    const t = askMos + k;
    const tMos = ((t - 1) % 12) + 1;
    const sOff = t > 12 ? 1 : 0;
    const out: number[] = [];
    for (const season of new Set(trades.map((tr) => tr.season))) {
      if (season >= curSeason) continue;
      const base2 = cellOf(season, askMos);
      const target = cellOf(season + sOff, tMos);
      if (base2 != null && target != null) out.push(target / base2);
    }
    return out;
  };
  const anchoredSteps: any[] = [];
  if (curAnchor != null) {
    for (let k = 1; k <= horizon; k++) {
      let ratios = ratiosFor(m, k);
      if (ratios.length < 10) {
        for (const adj of [m - 1, m + 1]) if (adj >= 1 && adj <= 12) ratios = ratios.concat(ratiosFor(adj, k));
      }
      const xs = ratios.filter((r) => r > 0).map((r) => Math.log(r)).sort((a, b) => a - b);
      const n = xs.length;
      if (n < MIN_RATIO_PAIRS) continue;
      const med = percentileCont(xs, 0.5)!;
      const meanX = xs.reduce((s2, v) => s2 + v, 0) / n;
      const sd = Math.max(Math.sqrt(xs.reduce((s2, v) => s2 + (v - meanX) ** 2, 0) / (n - 1)), 0.02);
      const df = Math.min(n - 1, MAX_T_DF);
      const f = Math.sqrt(1 + 1 / n);
      const t90 = tQ(df, 0.9) * sd * f;
      const t75 = tQ(df, 0.75) * sd * f;
      const lo = (tau: number, off: number) => Math.min(percentileCont(xs, tau)!, med - off);
      const hi = (tau: number, off: number) => Math.max(percentileCont(xs, tau)!, med + off);
      anchoredSteps.push({
        horizon_step: k,
        month_of_season: ((m + k - 1) % 12) + 1,
        ratio_pairs: n,
        band: {
          p10: money0(curAnchor * Math.exp(lo(0.1, t90))),
          p25: money0(curAnchor * Math.exp(lo(0.25, t75))),
          median: money0(curAnchor * Math.exp(med)),
          p75: money0(curAnchor * Math.exp(hi(0.75, t75))),
          p90: money0(curAnchor * Math.exp(hi(0.9, t90))),
        },
      });
    }
  }
  if (anchoredSteps.length > 0) {
    caveats.push(
      'anchored_outlook is the calibrated headline band (seasonal-shape ratios times the current price ' +
      'level, tails widened per backtest calibration). CALIBRATION NOTE: in backtests the p10-p90 band ' +
      'covered ~70% of outcomes overall but under ~60% in post-2019 drought-regime years — present it as ' +
      'the likely central range and say unprecedented seasons can land outside it. Use scenario_bands for ' +
      'the dry/wet split context; do not average the two.',
    );
  }

  if (wrapped) caveats.push(`The snapshot's current-season trade record already runs to month ${m} of 12; horizon months beyond month 12 (next_season=true) describe the following season's month-of-season pattern.`);
  if (pooledFlags.has('quarter')) caveats.push('Some band cells had < 5 trades and were pooled to the quarter-of-season.');
  if (pooledFlags.has('state')) caveats.push('Some band cells were still too thin and were pooled to the state/river grouping, dropping dry/median/wet conditioning for those cells.');
  caveats.push('Prices are nominal AUD $/ML as recorded at settlement (not inflation-adjusted).');

  const methodology =
    'HEADLINE (anchored_outlook): within each past season, the ratio of the target month\'s median price to ' +
    'the current month\'s median cancels that season\'s price level and isolates the stable seasonal shape; ' +
    'the current price level times the ratio distribution gives each month\'s outlook band (bounds calibrated ' +
    'per backtest — 26% lower pinball loss than raw scenario bands). CONTEXT (scenario_bands): for every past ' +
    'season the monthly medians are classed dry / median / wet by that season\'s final allocation % and the ' +
    'p25-p75 band per class is level-adjusted to current prices (pooling month->quarter->state when thin). ' +
    'All bands are historical ranges, not a forecast of which scenario will occur.';

  return {
    ...base,
    methodology,
    data_as_at: dataAsAt,
    stale_data: staleData,
    data_age_days: staleDays,
    inputs: { region_id, horizon_months: horizon, current_month_of_season: m, current_season: curSeason },
    sample_sizes: {
      region_temp_trades: trades.length,
      current_season_trades: curSeasonTrades.length,
      seasons_by_tercile: terciles,
      unclassified_trades: unclassified,
      immature_final_seasons_excluded: excludedImmature,
    },
    anchor: { factor: Math.round(anchorFactor * 1000) / 1000, basis: anchorBasis },
    estimator: anchoredSteps.length > 0 ? 'anchored_seasonal_ratio+tercile_bands' : 'tercile_bands',
    result: {
      anchored_outlook: anchoredSteps.length > 0
        ? { anchor_price: money0(curAnchor!), steps: anchoredSteps }
        : null,
      scenario_bands: scenarioBands,
      tercile_cutoffs: { dry_max_final_pct: pct1(t33), wet_min_final_pct: pct1(t67) },
    },
    analogues_or_series: [...seasonTercile.entries()]
      .map(([season, tercile]) => ({ season, final_pct: pct1(finals.get(season) ?? null), tercile }))
      .sort((a, b) => b.season - a.season),
    caveats,
  };
}

// =====================================================================================
//  TOOL 3 — forecast_entitlement_value
// =====================================================================================
const MIN_SALES_PER_YEAR = 4;   // below this, pool the year to state
const TREND_WINDOW_YEARS = 10;  // log-linear trend fit window
const Z_P25_P75 = 0.674;        // ~ +/-0.674 sigma spans the central 50% (p25..p75) of a normal

interface AnnualCell { yr: number; n: number; med: number; pooled: boolean; }

export async function fetchPermAnnual(run: Runner, region_id: number): Promise<Map<number, { n: number; med: number }>> {
  const rows = await run(
    `SELECT EXTRACT(YEAR FROM oc.date_accepted)::int AS yr, count(*) AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY oc.buying_price_per_ml) AS med
       FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
      WHERE oc.date_deleted IS NULL AND wo.sale = true
        AND wo.sellingregion = $1 AND oc.buying_price_per_ml > 0
      GROUP BY yr ORDER BY yr`,
    [region_id],
  );
  const m = new Map<number, { n: number; med: number }>();
  for (const r of rows) m.set(num(r.yr)!, { n: num(r.n)!, med: Number(r.med) });
  return m;
}

/** True newest settled permanent sale date for the region (H11 — data_as_at must never be
 *  fabricated from a year label; a mid-year sale must not yield a future "December 31" date). */
async function fetchPermMaxDate(run: Runner, region_id: number): Promise<string | null> {
  const rows = await run(
    `SELECT to_char(max(oc.date_accepted), 'YYYY-MM-DD') AS d
       FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
      WHERE oc.date_deleted IS NULL AND wo.sale = true
        AND wo.sellingregion = $1 AND oc.buying_price_per_ml > 0`,
    [region_id],
  );
  return rows.length && rows[0].d ? String(rows[0].d) : null;
}

async function fetchStatePermAnnual(run: Runner, state_id: number): Promise<Map<number, { n: number; med: number }>> {
  const rows = await run(
    `SELECT EXTRACT(YEAR FROM oc.date_accepted)::int AS yr, count(*) AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY oc.buying_price_per_ml) AS med
       FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
       JOIN region r ON r.id = wo.sellingregion
      WHERE oc.date_deleted IS NULL AND wo.sale = true
        AND r.state = $1 AND oc.buying_price_per_ml > 0
      GROUP BY yr ORDER BY yr`,
    [state_id],
  );
  const m = new Map<number, { n: number; med: number }>();
  for (const r of rows) m.set(num(r.yr)!, { n: num(r.n)!, med: Number(r.med) });
  return m;
}

function cagr(series: AnnualCell[], windowYears: number | null): { start_year: number; end_year: number; cagr_pct: number } | null {
  if (series.length < 2) return null;
  const end = series[series.length - 1];
  const startYear = windowYears == null ? series[0].yr : end.yr - windowYears + 1;
  const win = series.filter((c) => c.yr >= startYear);
  if (win.length < 2) return null;
  const a = win[0];
  const b = win[win.length - 1];
  const span = b.yr - a.yr;
  if (span <= 0 || a.med <= 0 || b.med <= 0) return null;
  const g = Math.pow(b.med / a.med, 1 / span) - 1;
  if (!Number.isFinite(g)) return null;
  return { start_year: a.yr, end_year: b.yr, cagr_pct: Math.round(g * 1000) / 10 };
}

export async function computeEntitlementValueForecast(run: Runner, region_id: number) {
  const caveats: string[] = [];
  const base = {
    tool: 'forecast_entitlement_value',
    inputs: { region_id },
    presentation: PRESENTATION,
  };

  const regionAnnual = await fetchPermAnnual(run, region_id);
  if (regionAnnual.size === 0) {
    return { ...base, refused: true, reason: `No settled permanent (entitlement) sales on record for region ${region_id}.`, data_as_at: null, caveats };
  }
  const stateId = await fetchRegionState(run, region_id);
  const stateAnnual = stateId != null ? await fetchStatePermAnnual(run, stateId) : new Map<number, { n: number; med: number }>();

  const years = [...regionAnnual.keys()].sort((a, b) => a - b);
  const series: AnnualCell[] = [];
  let pooledYears = 0;
  for (const yr of years) {
    const r = regionAnnual.get(yr)!;
    if (r.n >= MIN_SALES_PER_YEAR) {
      series.push({ yr, n: r.n, med: r.med, pooled: false });
    } else if (stateAnnual.get(yr) && stateAnnual.get(yr)!.n >= MIN_SALES_PER_YEAR) {
      const s = stateAnnual.get(yr)!;
      series.push({ yr, n: s.n, med: s.med, pooled: true });
      pooledYears++;
    } else {
      series.push({ yr, n: r.n, med: r.med, pooled: false });
      caveats.push(`Year ${yr} has only ${r.n} region sale(s) and no state fallback met the threshold; kept as-is (low confidence).`);
    }
  }
  if (pooledYears > 0) caveats.push(`${pooledYears} year(s) had < ${MIN_SALES_PER_YEAR} region sales and were pooled to the state/river grouping median.`);
  // H11: data_as_at is the true newest sale date (never a fabricated year-end, which could even
  // lie in the future). Annual-granularity staleness threshold applies (see STALE_DAYS_ANNUAL).
  const dataAsAt = await fetchPermMaxDate(run, region_id);
  const staleDays = daysSince(dataAsAt);
  const staleData = staleDays != null && staleDays > STALE_DAYS_ANNUAL;
  if (staleData) {
    caveats.push(
      `STALE DATA: the newest settled permanent sale for this region is ${dataAsAt} (${staleDays} days ago — ` +
      'more than a year). The trend and projection start from the last observed year, not from today; ' +
      'present them as a historical extrapolation as at that date and verify the current market before use.',
    );
  }

  const cagrFull = cagr(series, null);
  const cagr10 = cagr(series, 10);
  const cagr5 = cagr(series, 5);

  // ---- zero-drift empirical-increment projection (graduated from backtest, 2026-08-01) ----
  // The previous log-linear trend extrapolation lost 2.4x to "next year = this year" in
  // backtesting (it confidently projects past growth into the future). The calibrated
  // replacement is a random walk with NO drift: central = the last observed annual median;
  // the band comes from the historical distribution of h-year log-changes (recentred on zero),
  // so the width reflects how much this market has actually moved over such horizons.
  const usablePoints = series.filter((c) => c.med > 0);
  let projection: any[] = [];
  let increment_model: any = null;
  if (usablePoints.length >= 4) {
    const byYear = new Map(usablePoints.map((c) => [c.yr, c.med]));
    const last = usablePoints[usablePoints.length - 1];
    const oneYr: number[] = [];
    for (const c of usablePoints) {
      const t = byYear.get(c.yr + 1);
      if (t != null && t > 0) oneYr.push(Math.log(t / c.med));
    }
    const mkBand = (lo: number, mid: number, hi: number) => ({
      lower_p25: money0(last.med * Math.exp(lo)),
      central: money0(last.med * Math.exp(mid)),
      upper_p75: money0(last.med * Math.exp(hi)),
    });
    increment_model = { type: 'zero_drift_empirical_increment', last_year: last.yr, last_median: money0(last.med) };
    // uncertainty is non-decreasing in horizon: carry the widest offsets seen so far, so a thin
    // long-horizon pair pool can never produce a NARROWER band than a shorter horizon
    let runLo = 0, runHi = 0;
    for (let h = 1; h <= 5; h++) {
      const exact: number[] = [];
      for (const c of usablePoints) {
        const t = byYear.get(c.yr + h);
        if (t != null && t > 0) exact.push(Math.log(t / c.med));
      }
      let lo: number, hi: number, basis: string;
      if (exact.length >= 6) {
        const s = exact.sort((a2, b2) => a2 - b2);
        const shift = percentileCont(s, 0.5)!;
        lo = percentileCont(s, 0.25)! - shift;
        hi = percentileCont(s, 0.75)! - shift;
        basis = `empirical_${exact.length}_${h}y_changes`;
      } else if (oneYr.length >= 3) {
        const mu = oneYr.reduce((s2, v) => s2 + v, 0) / oneYr.length;
        const sd = Math.sqrt(oneYr.reduce((s2, v) => s2 + (v - mu) ** 2, 0) / Math.max(1, oneYr.length - 1));
        lo = -Z_P25_P75 * sd * Math.sqrt(h);
        hi = Z_P25_P75 * sd * Math.sqrt(h);
        basis = `normal_approx_${oneYr.length}_one_year_changes`;
      } else {
        continue;
      }
      runLo = Math.min(runLo, lo);
      runHi = Math.max(runHi, hi);
      lo = runLo;
      hi = runHi;
      const band = mkBand(lo, 0, hi);
      projection.push({
        horizon_years: h,
        year: last.yr + h,
        ...band,
        band_width: money0((band.upper_p75 ?? 0) - (band.lower_p25 ?? 0)),
        band_ratio: band.lower_p25 && band.upper_p75 ? Math.round((band.upper_p75 / band.lower_p25) * 1000) / 1000 : null,
        basis,
      });
    }
  } else {
    caveats.push(`Only ${usablePoints.length} usable annual points — too few for a projection; reporting the historical series and CAGR only.`);
  }

  caveats.push(
    'POLICY SENSITIVITY: entitlement values are strongly regime-dependent. Murray-Darling Basin Plan changes, ' +
    'SDL/water-recovery decisions, carryover-rule changes and government buyback programs can shift the level far ' +
    'outside any trend fitted to past prices — a historical trend cannot capture these structural breaks.',
  );
  caveats.push('Prices are nominal AUD $/ML as recorded at settlement (not inflation-adjusted).');

  const methodology =
    'Annual median $/ML of settled permanent (entitlement) sales is computed for the region (years with fewer ' +
    `than ${MIN_SALES_PER_YEAR} sales are pooled to the state/river grouping). The tool reports the historical ` +
    'annual series and the compound annual growth rate over the trailing 5 and 10 years and the full series. A ' +
    'log-linear trend fitted to the last 10 years is extended 1-5 years, banded by a prediction interval that ' +
    'widens with horizon (p25-p75 of the trend residuals scaled by forecast distance). It is a trend extrapolation, ' +
    'not a prediction, and cannot anticipate policy or regime changes.';

  return {
    ...base,
    methodology,
    data_as_at: dataAsAt,
    stale_data: staleData,
    data_age_days: staleDays,
    inputs: { region_id },
    sample_sizes: { years: series.length, pooled_years: pooledYears, sales_by_year: series.map((c) => ({ yr: c.yr, n: c.n, pooled: c.pooled })) },
    result: {
      cagr: { trailing_5y: cagr5, trailing_10y: cagr10, full_series: cagrFull },
      increment_model,
      projection,
    },
    analogues_or_series: series.map((c) => ({ year: c.yr, median_pml: money0(c.med), n: c.n, pooled: c.pooled })),
    caveats,
  };
}

// =====================================================================================
//  Tool wrappers (export only — NOT registered here)
// =====================================================================================
function R(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

export const FORECAST_TOOL_NAMES = ['forecast_allocation', 'forecast_temp_price', 'forecast_entitlement_value'] as const;

export function buildForecastToolDefs(ctx: CallerCtx) {
  const run: Runner = (sql, params = []) => runScoped(ctx, sql, params);

  return [
    tool(
      'forecast_allocation',
      'Historical scenario ranges for a region\'s end-of-season water allocation %, conditioned on where the ' +
      'current season sits versus past seasons at the same month (empirical analogue distribution). Returns a ' +
      'p10-p90 distribution of projected final %, the all-seasons base-rate distribution, each analogue season, ' +
      'plus methodology, data_as_at, sample sizes and caveats — distributions only, no point estimate.',
      { region_id: z.number().int().describe('region.id (from get_my_holdings / find_region)'),
        class: z.string().optional().describe('optional reliability-class filter when a region maps to >1 series, e.g. "high", "low", "general"') },
      async (a) => R(await computeAllocationForecast(run, a.region_id, a.class)),
    ),
    tool(
      'forecast_temp_price',
      'Temporary-price outlook bands ($/ML) for the months ahead in a region: a calibrated anchored_outlook ' +
      'band per month plus dry / median / wet scenario bands (seasons classed by historical final allocation %), ' +
      'anchored to the current price level. Returns p25-p75 bands per scenario per month (p10-p90 for the ' +
      'anchored band) with sample sizes, methodology, data_as_at and caveats. Prices are nominal AUD $/ML from ' +
      'historical Waterfind trades; bands only, no point estimate.',
      { region_id: z.number().int().describe('region.id whose settled temporary trades to model'),
        horizon_months: z.number().int().min(1).max(9).default(6).describe('months ahead to project (<=9)') },
      async (a) => R(await computeTempPriceForecast(run, a.region_id, a.horizon_months)),
    ),
    tool(
      'forecast_entitlement_value',
      'Long-term permanent (entitlement) value trend for a region: annual median $/ML history, CAGR over the ' +
      'trailing 5y / 10y / full series, and a projection 1-5 years ahead with p25-p75 bands that widen with ' +
      'horizon. Returns the series, ranges, methodology, data_as_at, sample sizes and caveats (including ' +
      'policy/regime risk the historical series cannot capture). Prices are nominal AUD $/ML from historical ' +
      'Waterfind sales; ranges only, no point estimate.',
      { region_id: z.number().int().describe('region.id whose permanent (entitlement) sales to model') },
      async (a) => R(await computeEntitlementValueForecast(run, a.region_id)),
    ),
  ];
}
