import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { snapshotReader } from './snapshot-cache';
import type { CallerCtx } from './data-db';
import {
  computeAllocationForecast,
  computeTempPriceForecast,
  computeEntitlementValueForecast,
} from './forecast-tools';
import {
  siteForRegion, seasonalLine, observationsLine, outlookFreshness,
  nearTermForKey, nearTermLine, nearTermFreshness,
} from './climate-outlook';

// =====================================================================================
//  Live Outlook Card (2026-08-01): one call composes the region's full forward picture —
//  allocation final-% range, temporary-price bands for the months ahead, entitlement
//  value range, and the current climate driver — from the SAME graduated engines the
//  individual forecast tools use, computed fresh per call (a dozen indexed queries,
//  sub-second). Nothing is precomputed or cached, so it is always as current as the DB.
//  Successor to the deleted precomputed house-outlook product: same card shape, live math.
// =====================================================================================

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'knowledge', 'data');

type Runner = (sql: string, params?: any[]) => Promise<any[]>;

const authorityDoc = snapshotReader(join(dataDir, 'authority-outlooks.json'), 'authority-outlooks (card)');

function climateDriver(): { line: string; issued: string | null } | null {
  try {
    const rec = (authorityDoc()?.outlooks as any[] | undefined)?.find((r) => r.kind === 'climate_outlook');
    return rec ? { line: `${rec.summary} (${rec.authority}, issued ${rec.issued})`, issued: rec.issued ?? null } : null;
  } catch {
    return null;
  }
}

export async function computeOutlookCard(run: Runner, region_id: number) {
  const nameRows = await run('SELECT name FROM region WHERE id = $1', [region_id]);
  const region_name = nameRows[0]?.name ?? `region ${region_id}`;

  const [alloc, price, ent]: any[] = [
    await computeAllocationForecast(run, region_id),
    await computeTempPriceForecast(run, region_id, 6),
    await computeEntitlementValueForecast(run, region_id),
  ];
  const climate = climateDriver();
  // BOM's actual rainfall forecast for the catchment that feeds this region — the ENSO line above
  // says what the Pacific is doing now, this says what rain is expected. Resolution goes via the
  // generated region_id -> site map first (covers zone names with no geography in them), then name
  // matching. Null when nothing maps; a wrong catchment would be worse than none.
  const rainSite = siteForRegion(region_id, region_name);
  const rainLine = rainSite ? seasonalLine(rainSite) : null;
  const obsLine = rainSite ? observationsLine(rainSite) : null;
  const rainFresh = outlookFreshness();
  // Near-term (multi-week) outlook for the same site — the "what's the weather doing NOW-ish"
  // horizon that the seasonal product cannot answer.
  const nearSite = rainSite ? nearTermForKey(rainSite.key) : null;
  const nearLine = nearSite ? nearTermLine(nearSite) : null;
  const nearFresh = nearTermFreshness();

  const lines: string[] = [];
  const staleFlags: string[] = [];

  if (!alloc.refused) {
    const q = alloc.result.final_pct_distribution;
    const a = alloc.inputs;
    lines.push(
      `Allocation (${a.series.title}): announced ${a.current_announced_pct}% at month ${a.current_month_of_season} ` +
      `of the season (as at ${alloc.data_as_at}). On ${alloc.sample_sizes.analogues} similar past seasons, the final ` +
      `typically lands between ${q.p25}% and ${q.p75}% (middle half), with ${q.p10}%-${q.p90}% covering roughly 8 of 10.`,
    );
    if (alloc.stale_data) staleFlags.push(`allocation data is stale (newest reading ${alloc.data_as_at})`);
  } else {
    lines.push(`Allocation: no reliable outlook (${alloc.reason})`);
  }

  if (!price.refused && price.result.anchored_outlook?.steps?.length) {
    const s0 = price.result.anchored_outlook.steps[0];
    lines.push(
      `Temporary water: next-month outlook band $${s0.band.p25}-$${s0.band.p75}/ML (median $${s0.band.median}, wide ` +
      `range $${s0.band.p10}-$${s0.band.p90}) anchored to the current level, as at ${price.data_as_at}. Later months ` +
      `and the dry/wet split are in the detail below; unprecedented seasons can land outside these bands.`,
    );
    if (price.stale_data) staleFlags.push(`price data is stale (newest trade ${price.data_as_at})`);
  } else if (!price.refused) {
    lines.push('Temporary water: too little ratio history for an anchored band; see scenario bands in the detail.');
  } else {
    lines.push(`Temporary water: no outlook (${price.reason})`);
  }

  if (!ent.refused && ent.result.projection?.length) {
    const p1 = ent.result.projection[0];
    const im = ent.result.increment_model;
    lines.push(
      `Entitlement value: last observed annual median $${im.last_median}/ML (${im.last_year}); over 1 year, historical ` +
      `variability puts the range around $${p1.lower_p25}-$${p1.upper_p75}/ML (no assumed growth — history shows no ` +
      `reliable directional signal in price alone).`,
    );
    if (ent.stale_data) staleFlags.push(`entitlement data is stale (newest sale ${ent.data_as_at})`);
  } else if (!ent.refused) {
    lines.push('Entitlement value: too few annual sales for a projection; CAGR history in the detail.');
  } else {
    lines.push(`Entitlement value: no outlook (${ent.reason})`);
  }

  if (climate) lines.push(`Climate driver: ${climate.line}`);
  if (nearLine) {
    lines.push(`Near-term rainfall (${rainSite!.name}): ${nearLine} (Bureau of Meteorology multi-week outlook, ` +
      `issued ${nearFresh.available ? nearFresh.issue_date : 'unknown'}.)`);
    if (nearFresh.available && nearFresh.stale) staleFlags.push('the BOM multi-week outlook snapshot is overdue for reissue');
  }
  if (rainLine) {
    lines.push(`Seasonal rainfall outlook: ${rainLine} (Bureau of Meteorology, issued ${rainFresh.available ? rainFresh.issue_date : 'unknown'}.)`);
    if (obsLine) lines.push(`Observed rainfall, months preceding the outlook period: ${obsLine}`);
    if (rainFresh.available && rainFresh.superseded) staleFlags.push(`the BOM seasonal outlook is superseded (newer issue due ${rainFresh.next_issue_date})`);
  }
  if (staleFlags.length) lines.push(`STALE DATA: ${staleFlags.join('; ')} — present those parts as historical and verify current figures.`);
  // The closing "general information only, not financial advice" line was removed 2026-08-04 at the
  // user's direction. The provenance half of it stays: it says what the numbers ARE (historical
  // frequencies, not model predictions), which is a description of the method, not a disclaimer.
  lines.push('Ranges are historical frequencies from Waterfind data.');

  return {
    region_id,
    region_name,
    computed_live_at: new Date().toISOString().slice(0, 10),
    card: lines.join('\n'),
    detail: {
      allocation: alloc.refused ? { refused: true, reason: alloc.reason } : {
        estimator: alloc.estimator, data_as_at: alloc.data_as_at, stale_data: alloc.stale_data,
        inputs: alloc.inputs, final_pct_distribution: alloc.result.final_pct_distribution,
        soi_conditioned: alloc.result.soi_conditioned, sample_sizes: alloc.sample_sizes,
      },
      temp_price: price.refused ? { refused: true, reason: price.reason } : {
        estimator: price.estimator, data_as_at: price.data_as_at, stale_data: price.stale_data,
        anchored_outlook: price.result.anchored_outlook, scenario_bands: price.result.scenario_bands,
      },
      entitlement: ent.refused ? { refused: true, reason: ent.reason } : {
        data_as_at: ent.data_as_at, stale_data: ent.stale_data,
        increment_model: ent.result.increment_model, projection: ent.result.projection, cagr: ent.result.cagr,
      },
      rainfall_outlook: rainSite ? {
        authority: 'Bureau of Meteorology', product: 'ACCESS-S calibrated multi-week and seasonal rainfall outlook',
        site_key: rainSite.key, site_name: rainSite.name, site_role: rainSite.role,
        issue_date: rainFresh.available ? rainFresh.issue_date : null,
        superseded: rainFresh.available ? rainFresh.superseded : null,
        near_term: nearSite ? {
          issue_date: nearFresh.available ? nearFresh.issue_date : null,
          weekly: nearSite.weekly, fortnightly: nearSite.fortnightly,
        } : null,
        seasonal: rainSite.seasonal,
        recent_observations: rainSite.recent_observations,
      } : { matched: false, reason: `no BOM outlook site maps to region "${region_name}"` },
    },
  };
}
