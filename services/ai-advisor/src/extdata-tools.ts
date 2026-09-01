import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { runScoped, type CallerCtx } from './data-db';
import { computeOutlookCard } from './outlook-card';
import { snapshotReader } from './snapshot-cache';
import {
  matchSites, nearTermForKey, outlookFreshness, nearTermFreshness,
  outlookHeadline, climateOutlookAvailable, climateDrivers, siteForRegion,
} from './climate-outlook';

// External-data grounding tools (Workstream B of the CEO parity plan). These read ingested,
// as-at-dated public snapshots from services/ai-advisor/knowledge/data/*.json (dam storage +
// allocation announcements/history). They are NOT live at question time and carry provenance +
// confidence flags per record, so every answer can cite a source and an as-at date.
//
// Exported (buildExtdataToolDefs + EXTDATA_TOOL_NAMES) but NOT registered here — advisor.ts wires
// them into the `wf` MCP server and the allowlist. See knowledge/data/README.md.

const here = dirname(fileURLToPath(import.meta.url));            // services/ai-advisor/src
const dataDir = join(here, '..', 'knowledge', 'data');

// Hot-reloading snapshot readers (mtime-cached, fail-soft — see snapshot-cache.ts). These MUST NOT
// be read once at module init: the refresh scheduler rewrites the files daily under a long-running
// sidecar, and a boot-time cache serves week-old data while the disk copy is current.
const reader = (name: string) => snapshotReader(join(dataDir, name), name);
const DAM_STORAGE = reader('dam-storage.json');
const DAM_HISTORY = reader('dam-storage-history.json');
const ALLOCATIONS = reader('allocations.json');
const ALLOC_HISTORY = reader('allocations-history.json');
const AUTHORITY_OUTLOOKS = reader('authority-outlooks.json');
const NSW_DASHBOARDS = reader('nsw-dashboards.json');

/** Standard "snapshot unavailable" tool payload — report, never guess. */
const unavailable = (dataset: string) => R({
  error: `The ${dataset} snapshot is unavailable on this deployment (file missing or unreadable); ` +
    'no values from this data source can be returned.',
  matched: 0,
});

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function R(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const ci = (s: unknown) => String(s ?? '').toLowerCase();
const round1 = (n: number) => Math.round(n * 10) / 10;

// Kept in sync with the tools below — advisor.ts builds the allowlist as mcp__wf__<name>.
export const EXTDATA_TOOL_NAMES = [
  'get_dam_storage', 'get_allocation_announcements', 'get_allocation_history',
  'get_authority_outlooks', 'get_outlook_card', 'get_nsw_water_dashboards',
  'get_climate_outlook',
] as const;

// Local CRM dam_reading series (waterfind-db; readings to ~Feb 2026, Hume to 1969, Burrinjuck to
// 1913). Explicit dam ids — name matching is unsafe ("Victoria Dam" in the DB is not Lake Victoria).
const LOCAL_DAM_IDS: Record<string, number> = {
  'Hume': 654538, 'Dartmouth': 654531, 'Lake Eildon': 154132, 'Burrinjuck': 654442,
  'Blowering': 654449, 'Menindee Lakes': 154069, 'Lake Victoria': 154015,
  'Waranga Basin': 154134, 'Lake Eppalock': 154142, 'Cairn Curran': 154150,
};
const localDamId = (storageName: string): number | null => {
  const s = ci(storageName);
  for (const [k, id] of Object.entries(LOCAL_DAM_IDS)) {
    const key = ci(k);
    if (s.includes(key) || key.includes(s)) return id;
  }
  return null;
};

/** Deep same-month baseline from the local dam_reading history: per-dam yearly averages for every
 *  calendar month, one batched query. Returns dam_id -> month(1-12) -> [{yr, avg_pct}]. */
async function localSameMonthSeries(ctx: CallerCtx, damIds: number[]) {
  const rows = await runScoped(ctx, `
    SELECT dr.dam::bigint AS dam_id, extract(month FROM dr.date_read)::int AS mo,
           extract(year FROM dr.date_read)::int AS yr,
           avg(dr.percent_of_full_storage)::float AS avg_pct
    FROM   dam_reading dr
    WHERE  dr.dam = ANY($1) AND dr.date_read > '1900-01-01'
      AND  dr.percent_of_full_storage IS NOT NULL
    GROUP  BY 1, 2, 3`, [damIds]);
  const out: Record<string, Record<number, { yr: number; avg_pct: number }[]>> = {};
  for (const r of rows) {
    const byMo = (out[String(r.dam_id)] ??= {});
    (byMo[r.mo] ??= []).push({ yr: r.yr, avg_pct: r.avg_pct });
  }
  return out;
}

function localBaselineFor(series: Record<number, { yr: number; avg_pct: number }[]> | undefined, asAt: string) {
  if (!series) return null;
  const month = parseInt(asAt.slice(5, 7), 10);
  const year = parseInt(asAt.slice(0, 4), 10);
  const prior = (series[month] ?? []).filter((r) => r.yr < year && Number.isFinite(r.avg_pct));
  if (!prior.length) return null;
  const pcts = prior.map((r) => r.avg_pct);
  return {
    n_prior_years: prior.length,
    years_span: `${Math.min(...prior.map((r) => r.yr))}-${Math.max(...prior.map((r) => r.yr))}`,
    avg_pct_full: round1(pcts.reduce((a, b) => a + b, 0) / pcts.length),
    min_pct_full: round1(Math.min(...pcts)),
    max_pct_full: round1(Math.max(...pcts)),
    source: 'Waterfind CRM dam_reading history (readings to ~Feb 2026)',
  };
}

/** Current-month historical comparison for one storage, from the history dataset. */
function historicalSameMonth(storageName: string, asAt: string) {
  const readings: any[] = (DAM_HISTORY()?.storages?.[storageName] as any[]) ?? [];
  const month = asAt.slice(5, 7);
  const year = asAt.slice(0, 4);
  const sameMonth = readings.filter((r) => typeof r.date === 'string' && r.date.slice(5, 7) === month);
  const priorYears = sameMonth.filter((r) => r.date.slice(0, 4) !== year);
  const pcts = priorYears.map((r) => Number(r.pct_full)).filter((n) => Number.isFinite(n));
  const avg = pcts.length ? round1(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
  const minConfidence = priorYears.some((r) => r.confidence !== 'high') ? 'reported/unverified' : 'high';
  return {
    month: MONTHS[parseInt(month, 10) - 1] ?? month,
    n_prior_years: priorYears.length,
    avg_pct_full: avg,
    min_pct_full: pcts.length ? Math.min(...pcts) : null,
    max_pct_full: pcts.length ? Math.max(...pcts) : null,
    prior_year_readings: priorYears
      .map((r) => ({ year: r.date.slice(0, 4), date: r.date, pct_full: r.pct_full, confidence: r.confidence, source_url: r.source_url }))
      .sort((a, b) => b.year.localeCompare(a.year)),
    baseline_confidence: pcts.length ? minConfidence : 'insufficient',
    note: pcts.length
      ? 'Same-month baseline is a growing seed; with few prior years it may rest on 1-2 readings (some from secondary sources) — see n_prior_years and baseline_confidence.'
      : 'No prior-year reading exists for this calendar month; a same-time-of-year average is not available.',
  };
}

export function buildExtdataToolDefs(ctx?: CallerCtx) {
  const tools = [
    tool('get_dam_storage',
      'Current water-in-storage for major Murray-Darling Basin storages (Dartmouth, Hume, Eildon, ' +
      'Burrinjuck, Blowering, Menindee Lakes, Lake Victoria, plus VIC regional total): volume_gl, ' +
      'capacity_gl, pct_full, per-storage as_at/source/confidence, and a same-calendar-month ' +
      'historical comparison. Values are an ingested snapshot with an as_at date, not live. In ' +
      'vs_historical_same_month, local_long_run is a multi-decade baseline from Waterfind\'s own ' +
      'storage series where available (e.g. Hume to 1969); otherwise the baseline is the snapshot\'s ' +
      'growing same-month seed (n_prior_years gives its depth, delta_basis says which baseline the ' +
      'delta uses). Optional storage_or_system filters by name; omit for all.',
      { storage_or_system: z.string().optional().describe('partial storage or system name, e.g. "Hume", "Dartmouth", "Murray"') },
      async (a: { storage_or_system?: string }) => {
        const damStorage = DAM_STORAGE();
        if (!damStorage) return unavailable('dam-storage');
        const q = ci(a.storage_or_system);
        const storages: any[] = damStorage.storages ?? [];
        const totals: any[] = damStorage.system_totals ?? [];
        const matchS = q
          ? storages.filter((s) => ci(s.storage).includes(q) || ci(s.system).includes(q) || ci(s.state).includes(q))
          : storages;
        const matchT = q
          ? totals.filter((t) => ci(t.system).includes(q))
          : totals;
        // Deep local baseline (one batched query) — only when a caller context is wired in;
        // offline/unregistered use (no ctx) keeps the snapshot-only behaviour.
        let localSeries: Awaited<ReturnType<typeof localSameMonthSeries>> = {};
        if (ctx) {
          const ids = [...new Set(matchS.map((s) => localDamId(s.storage)).filter((n): n is number => n != null))];
          if (ids.length) {
            try { localSeries = await localSameMonthSeries(ctx, ids); }
            catch { localSeries = {}; } // baseline is an enhancement; never fail the tool on it
          }
        }
        const rows = matchS.map((s) => ({
          storage: s.storage, system: s.system, state: s.state,
          volume_gl: s.volume_gl, capacity_gl: s.capacity_gl, pct_full: s.pct_full,
          as_at: s.as_at, source_name: s.source_name, source_url: s.source_url, confidence: s.confidence,
          note: s.note,
          vs_historical_same_month: (() => {
            const h = historicalSameMonth(s.storage, s.as_at);
            const id = localDamId(s.storage);
            const local = id != null ? localBaselineFor(localSeries[String(id)], s.as_at) : null;
            const baseAvg = local?.avg_pct_full ?? h.avg_pct_full;
            const delta = baseAvg != null ? round1(Number(s.pct_full) - baseAvg) : null;
            return {
              ...h, current_pct_full: s.pct_full,
              local_long_run: local,
              delta_vs_avg_pct_points: delta,
              delta_basis: baseAvg == null ? null : local ? 'local_long_run' : 'snapshot_seed',
            };
          })(),
        }));
        return R({
          as_at: damStorage.as_at,
          storages: rows,
          system_totals: matchT,
          matched: rows.length,
          note: 'Ingested snapshot, not live; each storage carries its own source_name and as_at. The same-month history is a growing seed (see n_prior_years).',
        });
      }),

    tool('get_allocation_announcements',
      'Current-season water allocation / available-water-determination announcements by state, valley ' +
      'and licence class: NSW AWDs (general/high security, conveyance), VIC seasonal determinations ' +
      '(HRWS/LRWS), SA River Murray. An ingested snapshot of official announcements with an as-at ' +
      'date, not live; each row carries its announcer (e.g. "NSW DCCEEW", "Northern Victoria Resource ' +
      'Manager", "SA DEW"), source and as_at. null allocation_pct means the figure was not published ' +
      '(qualitative announcement). Some NSW per-valley figures are confidence="medium" (via secondary ' +
      'reporting). Filters are optional and partial-match.',
      { state: z.string().optional().describe('e.g. "NSW", "VIC", "SA"'),
        valley: z.string().optional().describe('e.g. "Murray", "Murrumbidgee", "Goulburn"'),
        licence_class: z.string().optional().describe('e.g. "general security", "high security", "HRWS"') },
      async (a: { state?: string; valley?: string; licence_class?: string }) => {
        const allocations = ALLOCATIONS();
        if (!allocations) return unavailable('allocations');
        const st = ci(a.state), va = ci(a.valley), lc = ci(a.licence_class);
        const rows = ((allocations.announcements ?? []) as any[]).filter((r) =>
          (!st || ci(r.state).includes(st)) &&
          (!va || ci(r.valley).includes(va)) &&
          (!lc || ci(r.licence_class).includes(lc)));
        return R({
          season: allocations.season, as_at: allocations.as_at, matched: rows.length, rows,
          note: 'Ingested snapshot of official determinations; rows carry announcer, source_url and as_at. null allocation_pct means the figure was not published (qualitative announcement).',
        });
      }),

    tool('get_allocation_history',
      'Historical opening and final (end-of-season) allocation / seasonal-determination percentages ' +
      'for a state + valley, one row per past season. opening_pct is the 1 July determination; ' +
      'final_pct is end-of-season (null if not captured). Each row carries source_url and confidence; ' +
      'many pre-2026 values are confidence="reported" (secondary sources) and indicative rather than ' +
      'exact. state and valley are required; licence_class optional.',
      { state: z.string().describe('e.g. "NSW", "VIC", "SA"'),
        valley: z.string().describe('e.g. "Murrumbidgee", "Murray", "Goulburn", "River Murray"'),
        licence_class: z.string().optional().describe('e.g. "general security", "HRWS"') },
      async (a: { state: string; valley: string; licence_class?: string }) => {
        const allocHistory = ALLOC_HISTORY();
        if (!allocHistory) return unavailable('allocations-history');
        const st = ci(a.state), va = ci(a.valley), lc = ci(a.licence_class);
        const rows = ((allocHistory.history ?? []) as any[])
          .filter((r) =>
            ci(r.state).includes(st) &&
            ci(r.valley).includes(va) &&
            (!lc || ci(r.licence_class).includes(lc)))
          .sort((a2, b2) => String(b2.season).localeCompare(String(a2.season)));
        return R({
          state: a.state, valley: a.valley, licence_class: a.licence_class ?? null,
          matched: rows.length, rows,
          note: 'opening_pct = 1 July determination; final_pct = end-of-season (null if not captured). Rows carry source_url + confidence; confidence="reported" values come from secondary sources and are indicative.',
        });
      }),

    tool('get_authority_outlooks',
      'Forward-looking statements published by the authorities that decide or forecast water ' +
      'availability: state allocation outlook statements (opening determinations, scenario ' +
      'projections) and BOM/agency climate and ENSO outlooks. An ingested snapshot, not live; each ' +
      'record carries authority, issue date and source, and confidence="reported" records came via ' +
      'secondary reporting. Use for questions about future allocations or seasonal conditions; ' +
      'get_climate_outlook holds the gridded BOM rainfall/temperature forecast, and the forecast_* ' +
      'tools compute historical-analogue ranges. Filters optional and partial-match.',
      { jurisdiction: z.string().optional().describe('e.g. "NSW", "VIC", "SA", "AU" (climate outlooks are AU-wide)'),
        valley: z.string().optional().describe('e.g. "Murrumbidgee", "Murray"'),
        kind: z.string().optional().describe('e.g. "allocation_opening", "climate_outlook"') },
      async (a: { jurisdiction?: string; valley?: string; kind?: string }) => {
        const authorityOutlooks = AUTHORITY_OUTLOOKS();
        if (!authorityOutlooks) return unavailable('authority-outlooks');
        const ju = ci(a.jurisdiction), va = ci(a.valley), ki = ci(a.kind);
        const rows = ((authorityOutlooks.outlooks ?? []) as any[]).filter((r) =>
          (!ju || ci(r.jurisdiction).includes(ju) || ci(r.jurisdiction) === 'au') &&
          (!va || r.valley == null || ci(r.valley).includes(va)) &&
          (!ki || ci(r.kind).includes(ki)));
        return R({
          as_at: authorityOutlooks.as_at, matched: rows.length, rows,
          note: 'Published authority outlooks, ingested as a snapshot — not live. Records carry authority, ' +
            'issued date and source_url; confidence="reported" records came via secondary reporting rather ' +
            'than the primary source.',
        });
      }),

    tool('get_nsw_water_dashboards',
      'NSW government water dashboard data (DPE/DPIE public Tableau, CC-BY): current-water-year ' +
      'trade summary per NSW valley (allocation weighted-average $/ML and entitlement $/share), ' +
      'statewide cumulative water balance by month (allocation + carryover fractions of entitlement), ' +
      'and statewide usage by source type. Trade rows are per-valley; balance and usage are statewide ' +
      'aggregates, not per-valley. An ingested snapshot with an as_at date, not live. Use for the ' +
      'official NSW government picture alongside Waterfind trade data. Optional section filter.',
      { section: z.string().optional().describe('"trade", "balance", or "usage" — omit for all') },
      async (a: { section?: string }) => {
        const nswDashboards = NSW_DASHBOARDS();
        if (!nswDashboards) return unavailable('nsw-dashboards');
        const sec = ci(a.section);
        const pick = (name: string) => (sec === '' || sec.includes(name) ? nswDashboards[name] ?? null : undefined);
        return R({
          as_at: nswDashboards.as_at,
          current_wy_note: nswDashboards.current_wy_note ?? null,
          trade: pick('trade'),
          balance: pick('balance'),
          usage: pick('usage'),
          note: 'NSW DPE dashboard snapshot, not live. Trade rows are current-water-year weighted averages ' +
            'per valley; balance and usage are statewide aggregates, not per-valley.',
        });
      }),

    tool('get_climate_outlook',
      'The Bureau of Meteorology\'s calibrated rainfall and temperature outlook (ACCESS-S) at NEAR-TERM ' +
      '(next 1-2 weeks, fortnights, four-week aggregate) and LONG-RANGE (calendar months and 3-month ' +
      'seasons) horizons, point-queried at inflow catchments and irrigation districts across every ' +
      'system Waterfind trades (MDB, QLD coastal, Tasmania, WA/SA groundwater areas, coastal NSW/VIC), ' +
      'with BOM\'s own past-accuracy scores and recent observed rainfall. Use for any question about ' +
      'rainfall, weather, temperature or seasonal conditions; unlike the ENSO status (a current-state ' +
      'indicator), these are forecasts. IMPORTANT: the shortest period is a WEEK — no day-by-day ' +
      'forecast exists here, so answer day-specific questions by saying the finest resolution is ' +
      'weekly. An ingested snapshot with issue dates, not live. Field semantics: ' +
      'chance_unusually_dry_pct is the probability of landing in the driest quintile (climatological ' +
      'baseline 20%); temperature.chance_unusually_warm_pct is the warmest-quintile probability on the ' +
      'same baseline; past_accuracy.rain_past_accuracy_pct is BOM\'s weighted-percent-correct hindcast ' +
      'score at this lead and location (50% is chance level); recent_observations are observed monthly ' +
      'rainfall for completed months preceding the outlook, with the local 40th-60th percentile normal ' +
      'band. Optional region_or_valley filters by valley, catchment or CRM region name; optional ' +
      'region_id resolves via the region-to-catchment map. Omitted, returns inflow-catchment sites ' +
      'across all systems (monthly + full near-term detail included only when filtered).',
      { region_or_valley: z.string().optional()
          .describe('valley, catchment, storage or CRM region name, e.g. "Goulburn", "Hume", "Murrumbidgee", "SA Riverland"'),
        region_id: z.number().int().optional()
          .describe('CRM region.id (from get_my_holdings / find_region) — resolves via the region-to-catchment map') },
      async (a: { region_or_valley?: string; region_id?: number }) => {
        if (!climateOutlookAvailable()) return unavailable('BOM climate outlook');
        const fresh = outlookFreshness();
        const nearFresh = nearTermFreshness();
        const filtered = !!a.region_or_valley?.trim() || a.region_id != null;
        let hits = matchSites(a.region_or_valley);
        if (a.region_id != null) {
          // The generated region map is keyed by id and covers regions whose names carry no
          // geography at all ("ZONE KB - CLASS 1K"); prefer it when an id is given.
          const mapped = siteForRegion(a.region_id, a.region_or_valley ?? '');
          if (mapped) hits = [mapped];
        }
        // Unfiltered, return the inflow catchments only: they are what drives allocations, and all
        // sites x all periods would bury the signal. A filter that matches nothing falls back to the
        // same default rather than returning an empty set the model might read as "no forecast".
        const matchedFilter = filtered && hits.length > 0;
        const sites = matchedFilter ? hits : matchSites().filter((s) => s.role === 'inflow_catchment');
        return R({
          authority: 'Bureau of Meteorology',
          product: 'ACCESS-S calibrated multi-week and monthly/seasonal rainfall outlook',
          headline: outlookHeadline(),
          issue_date: fresh.available ? fresh.issue_date : null,
          next_issue_date: fresh.available ? fresh.next_issue_date : null,
          superseded: fresh.available ? fresh.superseded : null,
          staleness_note: fresh.available ? fresh.staleness_note : null,
          near_term_issue_date: nearFresh.available ? nearFresh.issue_date : null,
          near_term_staleness_note: nearFresh.available ? nearFresh.staleness_note : null,
          climatology_baseline: '1981-2018',
          climate_drivers: climateDrivers(),
          matched: sites.length,
          filter_matched: filtered ? matchedFilter : null,
          sites: sites.map((s) => {
            const near = nearTermForKey(s.key);
            return {
              key: s.key, name: s.name, role: s.role,
              // Near-term first: it answers "what's the weather doing" more directly than a season.
              near_term: near ? {
                weekly: matchedFilter ? near.weekly : near.weekly.slice(0, 1),
                fortnightly: matchedFilter ? near.fortnightly : near.fortnightly.slice(-1),
              } : null,
              seasonal: s.seasonal,
              // Monthly detail only when the caller narrowed to a place — keeps the broad call readable.
              monthly: matchedFilter ? s.monthly : undefined,
              recent_observations: s.recent_observations,
            };
          }),
          note:
            'BOM forecast, ingested as a snapshot — not live. near_term periods are weeks/fortnights (the ' +
            'FINEST resolution available — no day-by-day product exists); seasonal periods are 3-month ' +
            'windows. chance_unusually_dry_pct is the probability of landing in the driest fifth of the ' +
            'record (climatological baseline 20%). past_accuracy is BOM\'s weighted-percent-correct ' +
            'hindcast score at this lead and place (~50% = chance; >75 is "very high" on BOM\'s own bands); ' +
            'accuracy decays with lead time. mm totals are published for the nearest period of each length ' +
            'only; later periods carry probabilities alone. recent_observations are observed rainfall for ' +
            'completed months preceding the outlook, not forecast verification. Units: ' +
            '*_odds_multiple_vs_normal are dimensionless multiples of the 20% baseline (4.6 = 4.6x normal ' +
            'odds), not degrees and not mm. No forecast temperature anomaly is included; ' +
            'climatology_mean_max_c is a 1981-2018 historical average, not a forecast.' +
            (matchedFilter ? '' : ' These are the inflow catchments across all traded systems; pass region_or_valley or region_id for one place.'),
        });
      }),

    tool('get_outlook_card',
      'Composed forward outlook for one region in one call, computed live from current data: allocation ' +
      'final-% range, temporary-price bands for the months ahead, entitlement value range, the current ' +
      'climate driver, and the BOM near-term + seasonal rainfall outlook for the catchment that feeds ' +
      'the region — the same engines as the individual forecast_* tools. Suits broad predictive ' +
      'questions spanning several dimensions; use the individual forecast_* tools for a single dimension ' +
      'or longer price horizons. Each section carries its own data_as_at and any staleness flag. Returns ' +
      'ranges, not point estimates.',
      { region_id: z.number().int().describe('region.id (from get_my_holdings / find_region)') },
      async (a: { region_id: number }, extra?: unknown) => {
        if (!ctx) return R({ error: 'Outlook card requires an authenticated client context.' });
        const run = (sql: string, params: any[] = []) => runScoped(ctx, sql, params);
        return R(await computeOutlookCard(run, a.region_id));
      }),
  ];

  return tools;
}
