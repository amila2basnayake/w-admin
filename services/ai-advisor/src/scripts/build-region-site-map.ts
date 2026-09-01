/**
 * Build knowledge/data/bom-region-sites.json — an explicit CRM region_id -> BOM outlook site map.
 *   npx tsx src/scripts/build-region-site-map.ts
 *
 * Why it exists: name matching alone cannot place most regions. Audited 2026-08-06, 1,168 of
 * 1,558 non-deleted regions had names carrying no usable geography at all ("ZONE KB - CLASS 1K",
 * "MD - ZONE A - HIGH PRIORITY"). But the CRM links regions to their supply dams (dam_region) and
 * to weather stations (weather_station_region), both of which carry coordinates — so a region
 * whose name says nothing can still be resolved to the right catchment.
 *
 * Resolution order, most meaningful first:
 *   1. name     — the region NAME matches a site's valley keywords (whole-word, both directions).
 *   2. dam      — the region's linked supply dam(s): each dam votes for its nearest site; majority
 *                 wins. This is the inflow logic — the dam IS what fills the region's allocation.
 *   3. station  — centroid of the region's linked weather stations, nearest site within radius.
 *   4. market   — the region's MARKET (state-table row, e.g. "STANTHORPE WATER MANAGEMENT AREA",
 *                 "GNANGARA GROUNDWATER AREA") name-matches a site. Member zone names often carry
 *                 no geography ("BROADWATER ZONE CC - CLASS BC1") while the market name does.
 *   5. siblings — modal site of the already-mapped regions in the same market, when the market is
 *                 coherent (>=3 mapped siblings, >=60% agreeing).
 *   6. unmapped — recorded with the reason for review, served as "no outlook".
 *
 * Run it against the local waterfind-db (reads region/dam/weather_station only) whenever the SITES
 * catalogue in src/bom-sites.ts changes or regions are added. NOT on the refresh scheduler —
 * regions change rarely and this needs DB access; the output is committed like the other
 * knowledge/data snapshots.
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { SITES, hasWord, nearestSite, haversineKm } from '../bom-sites';
import { sydneyToday, nowIso } from '../au-dates';
import { writeSnapshot } from './bom-wms';

const here = dirname(fileURLToPath(import.meta.url));
const TARGET = join(here, '..', '..', 'knowledge', 'data', 'bom-region-sites.json');

const DAM_RADIUS_KM = 500;      // Menindee -> the Barwon-Darling site is ~420km; supply links are
                                // semantic, so a generous radius is right for them.
const STATION_RADIUS_KM = 400;  // stations locate the region itself; tighter.

async function main() {
  const pool = new pg.Pool({
    host: process.env.PGHOST ?? 'localhost', port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'waterfind', password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? 'waterfind-db',
  });

  const regions = (await pool.query(`
    SELECT r.id, r.name, r.state AS market_id, st.name AS market_name
    FROM region r LEFT JOIN state st ON st.id = r.state
    WHERE r.deleted IS NOT TRUE ORDER BY r.id`)).rows;
  const damLinks = (await pool.query(`
    SELECT dr.region, d.latitude AS lat, d.longitude AS lon
    FROM dam_region dr JOIN dam d ON d.id = dr.dam
    WHERE d.latitude IS NOT NULL AND d.longitude IS NOT NULL`)).rows;
  const stationLinks = (await pool.query(`
    SELECT wr.region, avg(w.latitude) AS lat, avg(w.longitude) AS lon
    FROM weather_station_region wr JOIN weather_station w ON w.id = wr.weather_station
    WHERE w.latitude IS NOT NULL AND w.longitude IS NOT NULL
    GROUP BY wr.region`)).rows;
  await pool.end();

  const damsByRegion = new Map<string, { lat: number; lon: number }[]>();
  for (const d of damLinks) {
    (damsByRegion.get(String(d.region)) ?? damsByRegion.set(String(d.region), []).get(String(d.region))!)
      .push({ lat: Number(d.lat), lon: Number(d.lon) });
  }
  const stationByRegion = new Map<string, { lat: number; lon: number }>();
  for (const s of stationLinks) {
    stationByRegion.set(String(s.region), { lat: Number(s.lat), lon: Number(s.lon) });
  }

  type Method = 'name' | 'dam' | 'station' | 'market' | 'siblings' | 'consensus' | 'pin';

  /** Manual adjudications from the 2026-08-06 full-map domain audit — rows where no general rule
   *  can safely decide (geological-province names whose basin qualifier must win, NSW WSP "North
   *  Coast" plan titles that reach the Hawkesbury, cross-state operator homonyms). site: null
   *  means DELIBERATELY unmapped (catch-all rows whose members span opposite rainfall regimes).
   *  Keyed by region id; ids are stable in this CRM. */
  const PINS: Record<string, { site: string | null; why: string }> = {
    '498': { site: 'sa-riverland', why: 'CIT Chaffey = SA Central Irrigation Trust district (Berri), not Chaffey Dam NSW' },
    '103886415': { site: 'macquarie-upper', why: 'Lachlan Fold Belt (MUDGEE) = Cudgegong valley; province name, not the Lachlan' },
    '1162901477': { site: 'macquarie-upper', why: 'Sydney Basin MDB = western margin (Mudgee/Capertee); the MDB qualifier governs' },
    '1314720789': { site: 'hawkesbury-nepean', why: 'Lachlan Fold Belt GREATER METROPOLITAN = Sydney-metro basement; qualifier governs' },
    '541951904': { site: 'hawkesbury-nepean', why: 'Sydney Basin - North Coast GW = Central Coast/Lower Hunter; plan title, not geography' },
    '1087886527': { site: 'hunter-valley', why: 'Tomago sandbeds = Newcastle, despite the North Coast WSP title' },
    '1087886559': { site: 'hunter-valley', why: 'Tomaree = Port Stephens, despite the North Coast WSP title' },
    '1087886050': { site: 'hunter-valley', why: 'Great Lakes coastal sands = Forster/Myall, despite the North Coast WSP title' },
    '1087886301': { site: 'hunter-valley', why: 'Hawkesbury-to-Hunter coastal sands: extent is in the name, not the WSP title' },
    '1096852299': { site: 'hawkesbury-nepean', why: 'Kulnura Mangrove Mountain = Central Coast (Mangrove Ck Dam catchment)' },
    '1096852482': { site: 'hunter-valley', why: 'Liverpool Ranges Basalt COAST = Hunter-draining side (Pages/Isis R NSW)' },
    '565574324': { site: 'gwydir-upper', why: 'GAB Surat Shallow is the NSW WSP source (Moree-Walgett), not Surat QLD' },
    '591831284': { site: 'macquarie-upper', why: 'GAB Southern Recharge = Pilliga/Warrumbungle margin, not Bourke' },
    '363950098': { site: 'condamine-headwaters', why: 'Surat East 3 GAB unit sits on the eastern margin (Miles/Chinchilla)' },
    '1162714248': { site: 'vic-southwest', why: 'Southern Rural Water South West Limestone = Warrnambool/Port Campbell VIC' },
    '368847165': { site: 'murrumbidgee-upper', why: 'Coleambally supplementary = event water driven by upper-catchment flows' },
    '285941113': { site: null, why: 'WA - OTHER catch-all: members may span monsoonal north vs Mediterranean SW' },
    '175346': { site: null, why: 'Mid West Dams (Geraldton region): no site; sibling-inherited SW rainfall would mislead' },
  };

  /** Name/market matching with KEYWORD SHADOWING: a site whose only matched keywords are proper
   *  substrings of a DISTANT site's matched keyword is dropped — "BOWEN BROKEN C" matches
   *  burdekin via 'bowen broken' AND the VIC Goulburn via 'broken', and the longer keyword is the
   *  real signal (2026-08-06 domain audit). Restricted to sites >250km apart: within one system,
   *  "LOWER GOULBURN" containing "goulburn" is a district/catchment nuance the inflow preference
   *  should decide, not a collision. */
  const shadowedHits = (query: string) => {
    const q = query.toLowerCase();
    const withKeys = SITES
      .map((s) => ({ site: s, keys: s.valleys.filter((v) => hasWord(q, v) || hasWord(v, q)) }))
      .filter((x) => x.keys.length > 0 || x.site.name.toLowerCase().includes(q));
    return withKeys
      .filter((x) => x.keys.length === 0 || !x.keys.every((k) =>
        withKeys.some((o) => o !== x &&
          haversineKm(o.site.lat, o.site.lon, x.site.lat, x.site.lon) > 250 &&
          o.keys.some((ok) => ok.length > k.length && ok.includes(k)))))
      .map((x) => x.site);
  };
  /** Longest keyword a site matched in a query — the specificity of the evidence. */
  const maxKeyLen = (site: (typeof SITES)[number], query: string) => {
    const q = query.toLowerCase();
    return Math.max(0, ...site.valleys.filter((v) => hasWord(q, v) || hasWord(v, q)).map((v) => v.length));
  };
  /** Best pick from a hit list: inflow preference, then nearest to the region's stations. */
  const pickFrom = (hits: typeof SITES, st0?: { lat: number; lon: number }) => {
    const preferred = hits.filter((s) => s.role === 'inflow_catchment');
    const pool = preferred.length > 0 ? preferred : hits;
    if (pool.length > 1 && st0) {
      return [...pool].sort((a, b) =>
        haversineKm(st0.lat, st0.lon, a.lat, a.lon) - haversineKm(st0.lat, st0.lon, b.lat, b.lon))[0];
    }
    return pool[0];
  };
  const mapped: Record<string, { site: string; method: Method; km?: number; name: string }> = {};
  const unmapped: { id: number; name: string; market?: string | null; reason: string; nearest?: string; km?: number }[] = [];
  const counts = { name: 0, dam: 0, station: 0, market: 0, siblings: 0, consensus: 0, unmapped: 0 };
  const pending: any[] = [];

  for (const r of regions) {
    const id = String(r.id);
    // 0. pins — audited one-off adjudications beat every heuristic.
    const pin = PINS[id];
    if (pin) {
      if (pin.site) {
        mapped[id] = { site: pin.site, method: 'pin', name: r.name };
        (counts as any).pin = ((counts as any).pin ?? 0) + 1;
      } else {
        unmapped.push({ id: r.id, name: r.name, market: r.market_name ?? null, reason: `pinned unmapped: ${pin.why}` });
        counts.unmapped++;
      }
      continue;
    }
    const st0raw = stationByRegion.get(id);
    const st0 = st0raw ? { lat: Number(st0raw.lat), lon: Number(st0raw.lon) } : undefined;
    const mktHits = r.market_name ? shadowedHits(String(r.market_name)) : [];
    const mktBest = mktHits.length > 0 ? pickFrom(mktHits, st0) : null;
    const dist = (s: { lat: number; lon: number }) =>
      st0 ? haversineKm(st0.lat, st0.lon, s.lat, s.lon) : Infinity;

    // 1. name — shadowed keyword match, inflow catchment preferred, station tiebreak WITHIN the
    // preferred role. A name hit is VETOED when the region's other signals gang up against it:
    // valley keywords collide across states/basins (the 2026-08-06 audits found QLD's "Bowen
    // Broken" on the VIC Broken R., Stanthorpe's "Pike zone" on the SA Pike River, "SA 3" aquifer
    // codes read as South Australia, the Hunter's "GOULBURN R." tributary...). The market name
    // and station geometry outvote a keyword.
    const hits = shadowedHits(r.name);
    if (hits.length > 0) {
      const site = pickFrom(hits, st0);
      const mktDisagrees = mktHits.length > 0 && !mktHits.some((s) => s.key === site.key);
      // Cross-system only: a market/name disagreement between two sites of the same system
      // (GMW's broad 'murray' vs a specific 'loddon') must not veto the more specific name.
      const crossSystem = mktBest != null &&
        haversineKm(mktBest.lat, mktBest.lon, site.lat, site.lon) > 250;
      const mktMoreSpecific = mktBest != null && r.market_name != null &&
        maxKeyLen(mktBest, String(r.market_name)) > maxKeyLen(site, r.name);
      let vetoed = false;
      if (mktDisagrees && !st0 && crossSystem && mktMoreSpecific) {
        vetoed = true;                                   // only the market knows where this is
      } else if (mktDisagrees && mktBest && dist(mktBest) < dist(site) / 2) {
        vetoed = true;                                   // stations clearly side with the market
      } else if (st0) {
        // Pure-geometry veto (works even with no market signal): the region's stations sit far
        // from the named site and close to a different one. A junk centroid — far from EVERY
        // site, e.g. statewide WA groupings — never vetoes.
        const near = nearestSite(st0.lat, st0.lon);
        const mktBacks = mktHits.some((s) => s.key === site.key);
        if (!mktBacks && dist(site) > 250 && near.km < 100 && near.site.key !== site.key) vetoed = true;
      }
      if (!vetoed) {
        mapped[id] = { site: site.key, method: 'name', name: r.name };
        counts.name++;
        continue;
      }
    }
    // 2. dam majority vote.
    const dams = damsByRegion.get(id) ?? [];
    if (dams.length > 0) {
      const votes = new Map<string, { n: number; km: number }>();
      for (const d of dams) {
        const { site, km } = nearestSite(d.lat, d.lon);
        if (km > DAM_RADIUS_KM) continue;
        const v = votes.get(site.key) ?? { n: 0, km };
        v.n++; v.km = Math.min(v.km, km);
        votes.set(site.key, v);
      }
      const best = [...votes.entries()].sort((a, b) => b[1].n - a[1].n || a[1].km - b[1].km)[0];
      if (best) {
        mapped[id] = { site: best[0], method: 'dam', km: best[1].km, name: r.name };
        counts.dam++;
        continue;
      }
    }
    // 3. weather-station centroid — but the MARKET name overrides pure geometry when they
    // disagree and the market's site is also plausibly nearby: Barker Barambah's zones sit 76km
    // from the Mary site and 105km from the Burnett site, yet the WSS is a Burnett-basin scheme.
    // A named supply system beats a 30km geometric preference.
    if (st0) {
      const { site, km } = nearestSite(st0.lat, st0.lon);
      if (km <= STATION_RADIUS_KM) {
        // Proportionality guard on the override: the market site must be in the region's
        // neighbourhood, not merely under the cap — "CENTRAL CONDAMINE ALLUVIUM" names the
        // Balonne system 266km away while the Darling Downs site sits 35km from its stations;
        // dragging it downstream would be the market name overpowering better local evidence.
        if (mktBest && mktBest.key !== site.key && dist(mktBest) <= 300 && dist(mktBest) <= 3 * km) {
          mapped[id] = { site: mktBest.key, method: 'market', km: Math.round(dist(mktBest)), name: r.name };
          counts.market++;
        } else {
          mapped[id] = { site: site.key, method: 'station', km, name: r.name };
          counts.station++;
        }
        continue;
      }
    }
    // 4. market name — the grouping row often carries the geography its member zones lack.
    if (mktBest) {
      mapped[id] = { site: mktBest.key, method: 'market', name: r.name };
      counts.market++;
      continue;
    }
    pending.push(r);   // give siblings a chance after the direct methods have populated the map
  }

  // 5. sibling-modal: adopt the market's consensus site when it clearly has one.
  const byMarket = new Map<string, string[]>();   // market_id -> mapped site keys
  for (const r of regions) {
    const m = mapped[String(r.id)];
    if (!m || r.market_id == null) continue;
    (byMarket.get(String(r.market_id)) ?? byMarket.set(String(r.market_id), []).get(String(r.market_id))!)
      .push(m.site);
  }
  for (const r of pending) {
    const siblings = r.market_id != null ? byMarket.get(String(r.market_id)) ?? [] : [];
    if (siblings.length >= 3) {
      const tally = new Map<string, number>();
      for (const s of siblings) tally.set(s, (tally.get(s) ?? 0) + 1);
      const [topSite, topN] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
      if (topN / siblings.length >= 0.6) {
        mapped[String(r.id)] = { site: topSite, method: 'siblings', name: r.name };
        counts.siblings++;
        continue;
      }
    }
    const st = stationByRegion.get(String(r.id));
    const near = st ? nearestSite(Number(st.lat), Number(st.lon)) : null;
    unmapped.push({
      id: r.id, name: r.name, market: r.market_name ?? null,
      reason: near ? 'anchors too far from any site' : 'no name/market match and no dam/station anchor',
      ...(near ? { nearest: near.site.key, km: near.km } : {}),
    });
    counts.unmapped++;
  }

  // 6. CONSENSUS pass: a name-mapped row whose market siblings overwhelmingly landed on a
  // DIFFERENT site is almost always a keyword grab the vetoes could not see — the Tasmanian
  // "MACQUARIE RIVER" zones (vs the NSW Macquarie), "RENMARK GROUP" (a geological formation) in
  // the Marne Saunders PWA, "MALLEE HIGHLAND" in the SA Peake PWA. Flip to the consensus when the
  // market is cohesive (>=3 mapped siblings, >=80% agreement) and the disagreement is either
  // cross-system (>250km) or unanimous.
  const siteByKey2 = new Map(SITES.map((s) => [s.key, s]));
  for (const r of regions) {
    const id = String(r.id);
    const m = mapped[id];
    if (!m || m.method !== 'name' || r.market_id == null) continue;
    const siblings = (byMarket.get(String(r.market_id)) ?? []).slice();
    const selfIdx = siblings.indexOf(m.site);
    if (selfIdx >= 0) siblings.splice(selfIdx, 1);       // judge against the OTHERS
    if (siblings.length < 3) continue;
    const tally = new Map<string, number>();
    for (const s of siblings) tally.set(s, (tally.get(s) ?? 0) + 1);
    const [topSite, topN] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topSite === m.site || topN / siblings.length < 0.8) continue;
    const cur = siteByKey2.get(m.site)!, top = siteByKey2.get(topSite)!;
    // Two or more distinct keyword matches is strong own-name evidence — "LOWER DARLING
    // (MENINDEE LAKES...)" matches both 'darling' and 'menindee' and must not be dragged to its
    // NSW-Murray market siblings. A single grabbed token (TAS "MACQUARIE RIVER", "RENMARK GROUP")
    // is exactly what this pass exists to correct.
    const ownEvidence = cur.valleys.filter((v) => hasWord(m.name.toLowerCase(), v)).length;
    if (ownEvidence >= 2) continue;
    const apart = haversineKm(cur.lat, cur.lon, top.lat, top.lon);
    if (apart > 250 || topN === siblings.length) {
      counts.name--;
      counts.consensus++;
      mapped[id] = { site: topSite, method: 'consensus', name: m.name };
    }
  }

  const doc = {
    dataset: 'bom-region-sites',
    description:
      'CRM region_id -> BOM outlook site map. Generated by build-region-site-map.ts from region ' +
      'names (valley-keyword match), dam_region supply links and weather_station_region coordinates ' +
      'in the local waterfind-db. Consumed by climate-outlook.ts siteForRegion(). Regenerate after ' +
      'editing SITES in src/bom-sites.ts or when regions change.',
    as_at: sydneyToday(),
    generated_at: nowIso(),
    site_keys: SITES.map((s) => s.key),
    method_counts: counts,
    total_regions: regions.length,
    regions: mapped,
    unmapped,
  };
  writeSnapshot(TARGET, doc);

  console.log(`regions: ${regions.length}`);
  console.log(`  by name:     ${counts.name}`);
  console.log(`  by dam:      ${counts.dam}`);
  console.log(`  by station:  ${counts.station}`);
  console.log(`  by market:   ${counts.market}`);
  console.log(`  by siblings: ${counts.siblings}`);
  console.log(`  consensus:   ${counts.consensus}`);
  console.log(`  unmapped:    ${counts.unmapped}`);
  for (const u of unmapped.slice(0, 30)) {
    console.log(`    [${u.id}] ${u.name}${u.nearest ? ` (nearest ${u.nearest} at ${u.km}km)` : ''} — ${u.reason}`);
  }
  if (unmapped.length > 30) console.log(`    ... and ${unmapped.length - 30} more (see the JSON)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
