/**
 * Shared plumbing for the BOM ACCESS-S outlook refreshers (refresh-bom-outlook.ts — monthly and
 * seasonal — and refresh-bom-weekly.ts — weekly/fortnightly/four-weekly). Both scripts point-query
 * the same public WMS in front of BOM's internal THREDDS server, so the fetch, validation and
 * derivation logic lives here once.
 *
 * FRAGILITY: the value endpoint is internal plumbing, not a published API — the public WMS proxies
 * BOM's THREDDS and we pass it a file path built from an observed naming convention (verified
 * 2026-08-06 to be byte-identical to what BOM's own outlooks web app constructs). It can change
 * without notice. Every fetch is therefore independent and fail-soft: failure yields null, never a
 * fake zero, and the callers refuse to overwrite a good snapshot with a gutted one (see their
 * coverage guards).
 *
 * Ingest-time validation: values are range-checked HERE, at the boundary, not just in the offline
 * test suite — a NetCDF fill value (e.g. -9999) leaking through the WMS must become null at ingest,
 * because by test time it would already have been served.
 */
import { writeFileSync, renameSync } from 'node:fs';

export const MANIFEST_SEASONAL = 'https://www.bom.gov.au/climate/ahead/outlooks/archive/outlook.json';
export const MANIFEST_WEEKLY = 'https://www.bom.gov.au/clim_data/IDCK000078/outlook_w.json';
export const WMS = 'https://www.bom.gov.au/climate/outlooks/mapcache';
export const THREDDS = 'http://localhost:8052/climate/tds/dodsC/climate/outlooks'; // proxied server-side
export const CLIMATOLOGY_BASELINE = '1981-2018';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) waterfind-advisor-refresh';

/** Wording verified against BOM's own docs and app source (2026-08-06): the files live under a
 *  directory named hit_rate/, but the metric inside is WPC — weighted percent correct, BOM's "past
 *  accuracy". Calling it a raw hit rate overstated its simplicity; the 50% chance baseline and the
 *  category bands below are BOM's own (legend_skill.png / classifySkillValue in their app). */
export const PAST_ACCURACY_BASIS =
  'BOM past accuracy (weighted percent correct): % of years 1981-2018 the model correctly called ' +
  'above/below median at this location and lead, weighted by how far observations were from ' +
  'median. ~50% = no better than chance. BOM\'s own bands: <=45 very low, 45-55 low, 55-65 ' +
  'moderate, 65-75 high, >75 very high.';

export type SrcStatus = { url: string; status: string; updated: boolean };

/** One HTTP GET with a single retry on transient failure. A single flaky response used to null a
 *  cell for a whole issue cycle; one retry removes most of that without hammering the service. */
export async function fetchText(url: string, timeoutMs = 25000): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json,text/xml,*/*' }, signal: ac.signal,
      });
      // 4xx will not get better on retry; 5xx and network errors might.
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 0) return text;
      } else if (res.status < 500) {
        return null;
      }
    } catch {
      // fall through to retry
    } finally {
      clearTimeout(t);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** One WMS point query, returning the grid value and the grid's own timestamp (needed when walking
 *  a time series, where a value is meaningless without knowing which month it is). Null on any
 *  failure or ServiceException — a null must never be confused with a real zero. */
export async function pointValueWithTime(layer: string, ncPath: string, lat: number, lon: number):
    Promise<{ value: number | null; time: string | null }> {
  const d = 0.05; // tiny bbox around the point; X/Y at its centre pixel
  const bbox = [lon - d, lat - d, lon + d, lat + d].join(',');
  const qs = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetFeatureInfo', SRS: 'EPSG:4326',
    BBOX: bbox, WIDTH: '101', HEIGHT: '101', X: '50', Y: '50', INFO_FORMAT: 'text/xml',
    QUERY_LAYERS: layer, LAYERS: layer, SOURCE_URL: `${THREDDS}/${ncPath}`,
  });
  const xml = await fetchText(`${WMS}?${qs}`);
  if (!xml || /ServiceException/i.test(xml)) return { value: null, time: null };
  const m = xml.match(/<value>([^<]*)<\/value>/);
  const t = xml.match(/<time>([^<]*)<\/time>/);
  const v = m ? Number(m[1]) : NaN;
  return { value: Number.isFinite(v) ? v : null, time: t ? t[1] : null };
}

export const pointValue = (layer: string, ncPath: string, lat: number, lon: number) =>
  pointValueWithTime(layer, ncPath, lat, lon).then((r) => r.value);

/** Bounded-concurrency map — the BOM WMS is a public service, so stay polite. A full refresh is
 *  now ~1,300-1,700 requests (38 sites x ~40 products), so an unbounded fan-out is not an option. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

// ---- ingest-time sanity guards -------------------------------------------------------------
// Out-of-range values (fill values, unit mixups, a layer semantics change upstream) become null —
// "not retrieved" — rather than being served. Bounds are deliberately loose physical limits.

/** Probabilities and percent-correct scores: 0-100. */
export const asPct = (n: number | null): number | null =>
  n != null && n >= 0 && n <= 100 ? n : null;
/** Rainfall totals in mm over up to a season: non-negative, below any Australian record. */
export const asMm = (n: number | null): number | null =>
  n != null && n >= 0 && n <= 5000 ? n : null;
/** Mean daily maximum temperature in degrees C. */
export const asTempC = (n: number | null): number | null =>
  n != null && n >= -15 && n <= 60 ? n : null;

/** Derived, presentation-ready fields, computed from the ROUNDED values the snapshot stores so
 *  the file is self-consistent (deriving from raw precision made pct_of_normal disagree with its
 *  own stored inputs at low-rainfall sites). The quintile baseline is 20% BY CONSTRUCTION (a
 *  quintile is a fifth of the historical distribution) — that is what makes "x times normal"
 *  meaningful. pct_of_normal is suppressed when the climatology is under 5mm: "500% of normal" on
 *  a 2mm dry-season median is arithmetic noise, not signal (tropical sites in the dry season). */
export function derive(climMm: number | null, medianMm: number | null, botPct: number | null, topPct: number | null) {
  const c = round1(climMm), m = round1(medianMm);
  const pctOfNormal = c != null && m != null && c >= 5
    ? Math.round((m / c) * 100) : null;
  const dryRatio = botPct != null ? Math.round((botPct / 20) * 10) / 10 : null;
  const wetRatio = topPct != null ? Math.round((topPct / 20) * 10) / 10 : null;
  return {
    pct_of_normal: pctOfNormal,
    dry_odds_multiple_vs_normal: dryRatio, // 1.0 = climatological odds; 3.0 = 3x the normal chance
    wet_odds_multiple_vs_normal: wetRatio,
  };
}

/** Atomic snapshot write (tmp + rename): a reader can never catch a half-written file. */
export function writeSnapshot(path: string, doc: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  renameSync(`${path}.tmp`, path);
}

export const ymd = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
