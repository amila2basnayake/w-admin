import {
  fetchAllocationSeries,
  fetchAllocationReadings,
  buildSeasons,
  trajAt,
  buildSeasonFinals,
  fetchPermAnnual,
} from '../src/forecast-tools';
import type { Runner } from './asof-db';

// =====================================================================================
//  Backtest item generation + outcome extraction.
//
//  An item is one historically-answerable predictive question: "standing at <cutoff>,
//  what will X be?" together with the actual outcome extracted from the FULL data.
//  Items are generated from the unmasked DB with the same season/mature-final logic
//  the forecast tools use (imported, not re-implemented, so scoring can never drift
//  from tool semantics).
// =====================================================================================

export interface AllocItem {
  kind: 'allocation';
  region_id: number;
  series_id: number;         // the series the FULL data picks for this region (dedupe key)
  season: number;            // the season being forecast (Jul season .. Jun season+1)
  mos: number;               // month-of-season the question is asked at (1=Jul)
  cutoff: string;            // YYYY-MM-DD, inclusive
  announced_pct: number;     // announced % as at cutoff (persistence baseline)
  outcome_final_pct: number; // the season's actual (mature) final %
}

export interface PriceStepOutcome { step: number; ym: string; n: number; actual_median: number; season: number; }
export interface PriceItem {
  kind: 'temp_price';
  region_id: number;
  season: number;
  mos: number;
  cutoff: string;
  horizon: number;
  outcomes: PriceStepOutcome[];              // only months with >= MIN_OUTCOME_TRADES
  season_final_pct: Record<string, number>;  // season -> actual final alloc % (for realized tercile), if known
  last_med_before_cutoff: number | null;     // newest monthly median <= cutoff (persistence baseline)
}

export interface EntOutcome { horizon_years: number; year: number; n: number; actual_median: number; }
export interface EntItem {
  kind: 'entitlement';
  region_id: number;
  cutoff: string;      // Dec 31 of last_year
  last_year: number;
  last_median: number; // last_year's annual median (persistence baseline)
  outcomes: EntOutcome[];
}

export interface ItemBank {
  generated_from: string;   // max data date observed at generation time
  allocation: AllocItem[];
  temp_price: PriceItem[];
  entitlement: EntItem[];
}

// ---- knobs ------------------------------------------------------------------------
const ALLOC_REGION_CANDIDATES = 60;
const ALLOC_MAX_SERIES = 20;          // distinct series (regions dedupe onto series)
const ALLOC_MIN_SEASONS = 12;         // series must have this many seasons in full data
const ALLOC_MOS_POINTS = [2, 4, 6, 8, 10];  // Aug, Oct, Dec, Feb, Apr
const ALLOC_MAX_SEASONS_PER_REGION = 12;    // latest N mature seasons

const PRICE_REGION_CANDIDATES = 15;
const PRICE_MAX_SEASONS_PER_REGION = 8;
const PRICE_MIN_TRADES = 150;
const PRICE_MIN_SEASONS = 6;
const PRICE_MOS_POINTS = [3, 6];      // Sep, Dec — one early, one mid-season ask per season
const PRICE_HORIZON = 6;
const PRICE_MIN_PRIOR_TRADES = 30;    // region trades before cutoff for the item to exist
const MIN_OUTCOME_TRADES = 3;         // month medians below this aren't scoreable

const ENT_REGION_CANDIDATES = 20;
const ENT_MIN_GOOD_YEARS = 8;         // years with >= 4 sales
const ENT_HORIZONS = [1, 2, 3];

// ---- helpers ----------------------------------------------------------------------
const p2 = (n: number) => String(n).padStart(2, '0');
/** month-of-season (1=Jul) of season -> calendar {y, m} */
function mosToCal(season: number, mos: number): { y: number; m: number } {
  const m = ((mos + 5) % 12) + 1;              // 1->7 ... 6->12, 7->1 ... 12->6
  return { y: season + (mos <= 6 ? 0 : 1), m };
}
function endOfMonth(y: number, m: number): string {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month
  return `${y}-${p2(m)}-${p2(last)}`;
}
function addMonths(y: number, m: number, k: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + k;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}
const seasonOfCal = (y: number, m: number) => (m >= 7 ? y : y - 1);

// ---- allocation items --------------------------------------------------------------
async function genAllocationItems(run: Runner): Promise<AllocItem[]> {
  const cand = await run(
    `SELECT war.region AS region_id, count(wr.id) AS readings
       FROM water_allocation_region war
       JOIN water_allocation_reading wr ON wr.water_allocation = war.water_allocation
      WHERE wr.effective_date > '1900-01-01' AND wr.allocation_percent IS NOT NULL
      GROUP BY war.region
      ORDER BY count(wr.id) DESC
      LIMIT ${ALLOC_REGION_CANDIDATES}`,
  );
  const items: AllocItem[] = [];
  const seenSeries = new Set<number>();
  for (const c of cand) {
    if (seenSeries.size >= ALLOC_MAX_SERIES) break;
    const region_id = Number(c.region_id);
    const series = await fetchAllocationSeries(run, region_id);
    if (series.length === 0) continue;
    const chosen = series[0];
    if (chosen.seasons < ALLOC_MIN_SEASONS || seenSeries.has(chosen.id)) continue;
    seenSeries.add(chosen.id);

    const readings = await fetchAllocationReadings(run, chosen.id);
    const seasons = buildSeasons(readings);
    const maxSeason = seasons[seasons.length - 1].season;
    // candidate seasons: mature final, strictly before the (possibly in-progress) newest season
    const mature = seasons.filter((s) => s.season < maxSeason && s.finalIsMature);
    for (const s of mature.slice(-ALLOC_MAX_SEASONS_PER_REGION)) {
      for (const mos of ALLOC_MOS_POINTS) {
        const announced = trajAt(s, mos);
        if (announced === null) continue;    // season had no reading yet at this month
        const { y, m } = mosToCal(s.season, mos);
        items.push({
          kind: 'allocation',
          region_id,
          series_id: chosen.id,
          season: s.season,
          mos,
          cutoff: endOfMonth(y, m),
          announced_pct: announced,
          outcome_final_pct: s.finalPct,
        });
      }
    }
  }
  return items;
}

// ---- temp-price items --------------------------------------------------------------
async function genPriceItems(run: Runner): Promise<PriceItem[]> {
  const cand = await run(
    `SELECT wo.sellingregion AS region_id, count(*) AS trades,
            count(DISTINCT EXTRACT(YEAR FROM oc.date_accepted - interval '6 months')) AS seasons
       FROM order_completed oc
       JOIN wateroffer wo ON wo.id = oc.wateroffer
      WHERE oc.date_deleted IS NULL AND wo.sale = false AND oc.buying_price_per_ml > 0
      GROUP BY wo.sellingregion
     HAVING count(*) >= ${PRICE_MIN_TRADES}
        AND count(DISTINCT EXTRACT(YEAR FROM oc.date_accepted - interval '6 months')) >= ${PRICE_MIN_SEASONS}
      ORDER BY count(*) DESC
      LIMIT ${PRICE_REGION_CANDIDATES}`,
  );
  const items: PriceItem[] = [];
  for (const c of cand) {
    const region_id = Number(c.region_id);
    // full monthly medians (outcome source) + cumulative trade counts
    const monthly = await run(
      `SELECT to_char(date_trunc('month', oc.date_accepted), 'YYYY-MM') AS ym, count(*) AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY oc.buying_price_per_ml) AS med
         FROM order_completed oc
         JOIN wateroffer wo ON wo.id = oc.wateroffer
        WHERE oc.date_deleted IS NULL AND wo.sale = false AND oc.buying_price_per_ml > 0
          AND wo.sellingregion = $1
        GROUP BY 1 ORDER BY 1`,
      [region_id],
    );
    const medByYm = new Map<string, { n: number; med: number }>();
    for (const r of monthly) medByYm.set(String(r.ym), { n: Number(r.n), med: Number(r.med) });

    // actual season finals for realized-tercile scoring (may be empty if no alloc series)
    const { finals } = await buildSeasonFinals(run, region_id);
    const seasonFinal: Record<string, number> = {};
    for (const [s, f] of finals) seasonFinal[String(s)] = f;

    // seasons present in the trade record
    const seasonsPresent = Array.from(
      new Set(monthly.map((r) => seasonOfCal(Number(String(r.ym).slice(0, 4)), Number(String(r.ym).slice(5, 7))))),
    ).sort((a, b) => a - b);
    const maxSeason = seasonsPresent[seasonsPresent.length - 1];
    // skip the first 3 seasons (too little history to forecast from) and the last (outcomes censored)
    for (const season of seasonsPresent.slice(3).filter((s) => s < maxSeason).slice(-PRICE_MAX_SEASONS_PER_REGION)) {
      for (const mos of PRICE_MOS_POINTS) {
        const { y, m } = mosToCal(season, mos);
        const cutoff = endOfMonth(y, m);
        // require enough history before the cutoff
        const prior = monthly.filter((r) => String(r.ym) <= `${y}-${p2(m)}`).reduce((s2, r) => s2 + Number(r.n), 0);
        if (prior < PRICE_MIN_PRIOR_TRADES) continue;
        const outcomes: PriceStepOutcome[] = [];
        for (let k = 1; k <= PRICE_HORIZON; k++) {
          const t = addMonths(y, m, k);
          const ym = `${t.y}-${p2(t.m)}`;
          const cell = medByYm.get(ym);
          if (cell && cell.n >= MIN_OUTCOME_TRADES) {
            outcomes.push({ step: k, ym, n: cell.n, actual_median: Math.round(cell.med), season: seasonOfCal(t.y, t.m) });
          }
        }
        if (outcomes.length >= 2) {
          const priorMonths = monthly.filter((r) => String(r.ym) <= `${y}-${p2(m)}` && Number(r.n) >= MIN_OUTCOME_TRADES);
          const lastMed = priorMonths.length ? Math.round(Number(priorMonths[priorMonths.length - 1].med)) : null;
          items.push({
            kind: 'temp_price', region_id, season, mos, cutoff, horizon: PRICE_HORIZON,
            outcomes, season_final_pct: seasonFinal, last_med_before_cutoff: lastMed,
          });
        }
      }
    }
  }
  return items;
}

// ---- entitlement items -------------------------------------------------------------
async function genEntItems(run: Runner): Promise<EntItem[]> {
  const cand = await run(
    `SELECT wo.sellingregion AS region_id, count(*) AS sales
       FROM order_completed oc
       JOIN wateroffer wo ON wo.id = oc.wateroffer
      WHERE oc.date_deleted IS NULL AND wo.sale = true AND oc.buying_price_per_ml > 0
      GROUP BY wo.sellingregion
     HAVING count(*) >= 40
      ORDER BY count(*) DESC
      LIMIT ${ENT_REGION_CANDIDATES}`,
  );
  const items: EntItem[] = [];
  for (const c of cand) {
    const region_id = Number(c.region_id);
    const annual = await fetchPermAnnual(run, region_id);
    const goodYears = [...annual.entries()].filter(([, v]) => v.n >= 4).map(([y]) => y).sort((a, b) => a - b);
    if (goodYears.length < ENT_MIN_GOOD_YEARS) continue;
    const maxYear = goodYears[goodYears.length - 1];
    // cutoffs: end of each year that leaves >= 5 years history before and >= 1 scoreable year after
    for (const y of goodYears) {
      const history = goodYears.filter((g) => g <= y).length;
      if (history < 5 || y >= maxYear) continue;
      const outcomes: EntOutcome[] = [];
      for (const h of ENT_HORIZONS) {
        const target = y + h;
        const cell = annual.get(target);
        if (cell && cell.n >= 4) outcomes.push({ horizon_years: h, year: target, n: cell.n, actual_median: Math.round(cell.med) });
      }
      if (outcomes.length > 0) {
        items.push({
          kind: 'entitlement', region_id, cutoff: `${y}-12-31`, last_year: y,
          last_median: Math.round(annual.get(y)!.med), outcomes,
        });
      }
    }
  }
  return items;
}

// ---- entry ------------------------------------------------------------------------
export async function generateItems(run: Runner): Promise<ItemBank> {
  const maxRows = await run(
    `SELECT to_char(greatest(
        (SELECT max(effective_date) FROM water_allocation_reading),
        (SELECT max(date_accepted)::date FROM order_completed)), 'YYYY-MM-DD') AS d`,
  );
  const [allocation, temp_price, entitlement] = [
    await genAllocationItems(run),
    await genPriceItems(run),
    await genEntItems(run),
  ];
  return {
    generated_from: String(maxRows[0]?.d ?? 'unknown').slice(0, 10),
    allocation,
    temp_price,
    entitlement,
  };
}
