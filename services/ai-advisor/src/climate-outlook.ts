import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { snapshotReader } from './snapshot-cache';
import { sydneyToday } from './au-dates';
import { matchSitesIn } from './bom-sites';

/**
 * Shared reader for the BOM outlook snapshots:
 *   - knowledge/data/bom-climate-outlook.json  (monthly/seasonal — refresh-bom-outlook.ts)
 *   - knowledge/data/bom-weekly-outlook.json   (weekly/fortnightly near-term — refresh-bom-weekly.ts)
 *   - knowledge/data/bom-region-sites.json     (CRM region_id -> site map — build-region-site-map.ts)
 *
 * Lives in its own module because BOTH extdata-tools.ts (the get_climate_outlook tool) and
 * outlook-card.ts (the per-region card) need it, and extdata-tools already imports outlook-card —
 * putting it in either would be a cycle. All reads hot-reload on mtime via snapshotReader, so a
 * scheduler refresh reaches a running sidecar without a restart.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'knowledge', 'data');

export type OutlookPeriod = {
  period: string;
  period_index: number;
  climatology_median_mm: number | null;
  forecast_median_mm: number | null;
  wet_case_mm_25pct_chance_of_exceeding: number | null;
  dry_case_mm_75pct_chance_of_exceeding: number | null;
  chance_unusually_dry_pct: number | null;
  chance_unusually_wet_pct: number | null;
  pct_of_normal: number | null;
  dry_odds_multiple_vs_normal: number | null;
  wet_odds_multiple_vs_normal: number | null;
  temperature: {
    climatology_mean_max_c?: number | null;
    chance_unusually_warm_pct: number | null;
    warm_odds_multiple_vs_normal: number | null;
  };
  past_accuracy: {
    rain_past_accuracy_pct: number | null;
    tmax_past_accuracy_pct?: number | null;
    basis: string;
  };
  totals_available: boolean;
};
/** Observed monthly rainfall preceding the outlook — antecedent conditions, NOT verification. */
export type ObservedMonth = {
  month: string;                       // YYYY-MM
  observed_mm: number | null;
  normal_band_mm: [number, number] | null;   // local 40th-60th percentile
  vs_normal: 'below normal' | 'near normal' | 'above normal' | null;
};
export type OutlookSite = {
  key: string; name: string; role: 'inflow_catchment' | 'irrigation_district';
  lat: number; lon: number; valleys: string[];
  seasonal: OutlookPeriod[]; monthly: OutlookPeriod[];
  recent_observations: ObservedMonth[];
};
export type NearTermSite = {
  key: string; name: string; role: 'inflow_catchment' | 'irrigation_district';
  lat: number; lon: number; valleys: string[];
  weekly: OutlookPeriod[]; fortnightly: OutlookPeriod[];
};

const seasonalDoc = snapshotReader(join(dataDir, 'bom-climate-outlook.json'), 'bom-climate-outlook');
const weeklyDoc = snapshotReader(join(dataDir, 'bom-weekly-outlook.json'), 'bom-weekly-outlook');
const regionMapDoc = snapshotReader(join(dataDir, 'bom-region-sites.json'), 'bom-region-sites');
const authorityDoc = snapshotReader(join(dataDir, 'authority-outlooks.json'), 'authority-outlooks');

export const climateOutlookAvailable = () => seasonalDoc() != null;
export const nearTermOutlookAvailable = () => weeklyDoc() != null;

/**
 * Has BOM published a newer outlook than the one in this snapshot? The manifest tells us exactly
 * when the next issue lands, so staleness is knowable rather than guessed — and a superseded
 * forecast presented as current is the single worst failure mode for this dataset.
 *
 * Dates compare as SYDNEY calendar dates (BOM's operating timezone). On the issue day itself the
 * new outlook usually lands mid-morning and the scheduler picks it up within a tick, but until it
 * does we flag "possibly updated today" rather than asserting currency.
 */
export function outlookFreshness(today = sydneyToday()) {
  const DOC = seasonalDoc();
  if (!DOC) return { available: false as const };
  const next = DOC.next_issue_date as string | null;
  const superseded = next != null && today > next;
  const possiblyUpdatedToday = next != null && today === next;
  return {
    available: true as const,
    issue_date: DOC.issue_date as string | null,
    next_issue_date: next,
    snapshot_as_at: DOC.as_at as string | null,
    superseded,
    possibly_updated_today: possiblyUpdatedToday,
    staleness_note: superseded
      ? `BOM published a newer outlook on ${next}; this snapshot is from the ${DOC.issue_date} issue. ` +
        'Say the outlook may have been updated and point to bom.gov.au/climate/outlooks/ before acting on it.'
      : possiblyUpdatedToday
        ? `BOM is due to reissue this outlook today (${next}); the ${DOC.issue_date} issue shown here may be ` +
          'hours from being superseded.'
        : null,
  };
}

/** Freshness for the near-term snapshot. Its manifest has no next_issue_date; the product
 *  reissues roughly twice a week, so anything older than ~5 days is treated as stale. */
export function nearTermFreshness(today = sydneyToday()) {
  const DOC = weeklyDoc();
  if (!DOC) return { available: false as const };
  const issue = DOC.issue_date as string | null;
  const ageDays = issue
    ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${issue}T00:00:00Z`)) / 86_400_000)
    : null;
  const stale = ageDays != null && ageDays > 5;
  return {
    available: true as const,
    issue_date: issue,
    snapshot_as_at: DOC.as_at as string | null,
    stale,
    staleness_note: stale
      ? `This multi-week outlook was issued ${issue} (${ageDays} days ago) and BOM reissues it roughly ` +
        'twice a week — a newer issue almost certainly exists; check bom.gov.au/climate/outlooks/.'
      : null,
  };
}

export const outlookHeadline = (): string | null => (seasonalDoc()?.headline as string) ?? null;

/**
 * ENSO + IOD + SAM, from the authority-outlooks snapshot.
 *
 * Surfaced HERE, on the rainfall-outlook tool, rather than only on get_authority_outlooks: asked
 * "what climate drivers are in play?", the model reached for the rainfall outlook and the DB's SOI
 * and never saw IOD or SAM at all. Data the model doesn't discover is as good as absent, and ENSO
 * alone is a genuine misread risk — a negative IOD can offset an El Niño over the south-east.
 * When the drivers record is missing (the source page is scraped from fixed sentence forms and a
 * BOM rephrase can break it), that ABSENCE is reported explicitly rather than silently omitted.
 */
export function climateDrivers(): Record<string, unknown> {
  try {
    const d = authorityDoc();
    const rec = (d?.outlooks as any[] | undefined)?.find((r) => r.kind === 'climate_outlook');
    if (!rec) return { unavailable: 'No climate-driver record in the authority-outlooks snapshot.' };
    const drivers = rec.drivers ?? {};
    const missing = ['enso', 'iod', 'sam'].filter((k) => drivers[k] == null);
    return {
      authority: rec.authority ?? 'Bureau of Meteorology',
      issued: rec.issued ?? null,
      source_url: rec.source_url ?? null,
      ...drivers,
      ...(missing.length
        ? { note: `Driver(s) not parsed from the source this cycle: ${missing.join(', ')} — treat as unknown, not neutral.` }
        : {}),
    };
  } catch {
    return { unavailable: 'Climate-driver snapshot unreadable.' };
  }
}

/** Match sites by free text against site key, name and the `valleys` keyword list. Used for both
 *  a user's phrasing ("Goulburn", "Hume") and a CRM region name
 *  ("7 VIC MURRAY (BARMAH TO SA) GMW - HIGH R"). Matching semantics live in bom-sites.ts. */
export function matchSites(query?: string): OutlookSite[] {
  return matchSitesIn<OutlookSite>((seasonalDoc()?.sites as OutlookSite[]) ?? [], query);
}

export function matchNearTermSites(query?: string): NearTermSite[] {
  return matchSitesIn<NearTermSite>((weeklyDoc()?.sites as NearTermSite[]) ?? [], query);
}

/** Near-term data for one site key, or null. */
export const nearTermForKey = (key: string): NearTermSite | null =>
  ((weeklyDoc()?.sites as NearTermSite[]) ?? []).find((s) => s.key === key) ?? null;

/** The single most relevant site for a CRM region, preferring an explicit region_id entry in the
 *  generated bom-region-sites map (built from the region's linked dams/weather stations), then
 *  name matching, preferring the INFLOW CATCHMENT — storage inflow is what drives an allocation,
 *  not rainfall over the irrigation district. Returns null rather than a wrong guess. */
export function siteForRegion(regionId: number | null, regionName: string): OutlookSite | null {
  if (regionId != null) {
    const entry = regionMapDoc()?.regions?.[String(regionId)];
    if (entry?.site) {
      const hit = matchSites().find((s) => s.key === entry.site);
      if (hit) return hit;
    }
  }
  return siteForRegionName(regionName);
}

/** Name-only variant, for free text (no region id available). */
export function siteForRegionName(regionName: string): OutlookSite | null {
  const hits = matchSites(regionName);
  if (hits.length === 0) return null;
  return hits.find((s) => s.role === 'inflow_catchment') ?? hits[0];
}

/** One-line summary of a site's nearest seasonal period, for the outlook card. */
export function seasonalLine(site: OutlookSite): string | null {
  const p = site.seasonal?.[0];
  if (!p || p.chance_unusually_dry_pct == null) return null;
  const bits = [`${site.name}: BOM's ${p.period} rainfall outlook puts the chance of an unusually dry period at ` +
    `${p.chance_unusually_dry_pct}% (normal is 20%)`];
  if (p.pct_of_normal != null) {
    bits.push(`forecast median ${p.forecast_median_mm}mm vs ${p.climatology_median_mm}mm typical (${p.pct_of_normal}% of normal)`);
  }
  if (p.chance_unusually_wet_pct != null) bits.push(`chance of an unusually wet period ${p.chance_unusually_wet_pct}%`);
  if (p.temperature?.chance_unusually_warm_pct != null) {
    bits.push(`chance of an unusually warm period ${p.temperature.chance_unusually_warm_pct}%`);
  }
  // Accuracy belongs on the same line as the probability it qualifies — quoting one without the
  // other is how a 60% figure gets read as more certain than BOM's own hindcast supports.
  if (p.past_accuracy?.rain_past_accuracy_pct != null) {
    bits.push(`BOM's past accuracy for rainfall here at this lead is ${p.past_accuracy.rain_past_accuracy_pct}% ` +
      '(weighted percent correct; 50% = chance)');
  }
  return `${bits.join('; ')}.`;
}

/** One-line NEAR-TERM summary (week 1 + the trailing fortnight), for the outlook card. */
export function nearTermLine(site: NearTermSite): string | null {
  const w = site.weekly?.[0];
  if (!w || w.chance_unusually_dry_pct == null) return null;
  const bits = [`Week ahead (${w.period}): chance of an unusually dry week ${w.chance_unusually_dry_pct}%, ` +
    `unusually wet ${w.chance_unusually_wet_pct ?? '?'}% (normal is 20% each)`];
  if (w.forecast_median_mm != null && w.climatology_median_mm != null) {
    bits.push(`median ${w.forecast_median_mm}mm vs ${w.climatology_median_mm}mm typical`);
  }
  const fn = site.fortnightly?.[site.fortnightly.length - 1];
  if (fn?.chance_unusually_dry_pct != null) {
    bits.push(`fortnight ${fn.period}: dry ${fn.chance_unusually_dry_pct}% / wet ${fn.chance_unusually_wet_pct ?? '?'}%`);
  }
  return `${bits.join('; ')}. No day-by-day forecast exists; the shortest BOM period is a week.`;
}

/** What already fell — one line, for the outlook card. This is ANTECEDENT catchment wetness going
 *  into the forecast period, NOT a verification of the forecast: different months, different
 *  quantities. Its value is that a wet catchment converts a given rainfall into more inflow. */
export function observationsLine(site: OutlookSite): string | null {
  const obs = (site.recent_observations ?? []).filter((o) => o.observed_mm != null);
  if (obs.length === 0) return null;
  const parts = obs.map((o) => `${o.month} ${o.observed_mm}mm (${o.vs_normal ?? 'unclassified'})`);
  return `Recent actuals at ${site.name}: ${parts.join(', ')}.`;
}
