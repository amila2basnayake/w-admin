/**
 * Best-effort refresh of knowledge/data/authority-outlooks.json (option 3 of the
 * forecast-excellence work — the authority forward-outlook corpus).
 *   npx tsx src/scripts/refresh-outlooks.ts
 *
 * Mirrors refresh-extdata.ts: no API keys, tolerates partial/total failure, atomic writes,
 * per-run last_refresh provenance. Sources are the authorities that publish forward guidance:
 *   - BOM ENSO Outlook (alert status: La Nina / El Nino WATCH / ALERT / active / inactive)
 *   - NSW DCCEEW water allocation statements listing (newest per-valley statement PDFs)
 * A source that fails or parses to nothing leaves existing records untouched. PDFs are NOT
 * parsed here — statements are linked for the advisor to cite, with figures entered via the
 * curation path (confidence="reported" until verified against the primary document).
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'knowledge', 'data');
const FILE = 'authority-outlooks.json';
const today = new Date().toISOString().slice(0, 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) waterfind-advisor-refresh';

type SrcStatus = { url: string; status: string; updated_records: number };

function loadJson(): any {
  return JSON.parse(readFileSync(join(dataDir, FILE), 'utf8'));
}
function saveJson(obj: unknown): void {
  const target = join(dataDir, FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);
}

async function fetchText(url: string, timeoutMs = 20000): Promise<string | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, signal: ac.signal });
    if (!res.ok) return null;
    const text = await res.text();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const decodeEntities = (s: string) => s
  .replace(/&ntilde;/gi, 'ñ').replace(/&Ntilde;/g, 'Ñ').replace(/&deg;/gi, '°')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#\d+;/g, ' ');
const strip = (html: string) => decodeEntities(
  html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' '),
).replace(/\s+/g, ' ');

async function refreshBomEnso(doc: any): Promise<SrcStatus> {
  // /climate/enso/outlook/ is a tombstone — BOM retired the ENSO Outlook (WATCH/ALERT dial)
  // from Dec 2024. The living product is the fortnightly "Southern hemisphere monitoring"
  // wrap-up at /climate/enso/, which carries an issue date, a headline sentence, and the
  // relative Niño3.4 index value (feed-automatability assessment #4).
  const url = 'https://www.bom.gov.au/climate/enso/';
  const html = await fetchText(url);
  if (!html) return { url, status: 'fetch failed', updated_records: 0 };
  const text = strip(html);
  // headline runs from after the issue date to the start of the body prose; the body reliably
  // opens with a subject + verb ("El Niño has been underway...", "The ENSO Outlook...")
  const issuedM = text.match(/Issued\s+(\d{1,2}\s+\w+\s+\d{4})\s+(.{10,140}?)(?=\s+(?:El Ni|La Ni|ENSO|The |Atmospheric|Oceanic|Sea surface))/);
  const headlineM = issuedM ?? text.match(/Issued\s+(\d{1,2}\s+\w+\s+\d{4})\s+([^.]{10,160})/);
  if (!headlineM) return { url, status: 'fetched but no issued/headline parsed', updated_records: 0 };
  const issuedRaw = headlineM[1];
  const headline = headlineM[2].trim();
  const issuedDate = new Date(`${issuedRaw} UTC`);
  const issued = Number.isNaN(issuedDate.getTime()) ? today : issuedDate.toISOString().slice(0, 10);
  const nino = text.match(/Ni[ñn]o\s?3\.4 index value[^+\-]{0,60}([+\-]\d+(?:\.\d+)?)\s?°?C/i);
  const phase = /El Ni[ñn]o/i.test(headline) ? 'El Niño' : /La Ni[ñn]a/i.test(headline) ? 'La Niña' : /neutral/i.test(headline) ? 'ENSO-neutral' : null;

  // ENSO is one of THREE drivers of southern-Basin rainfall, and reporting it as the only one is a
  // real misread risk: a negative IOD can override an El Niño signal over the south-east. The same
  // wrap-up page states the current IOD and SAM status in a fixed sentence form, so both come free.
  const iodM = text.match(/The Indian Ocean Dipole \(IOD\) is currently ([a-z\s-]{3,40}?)\./i);
  const samM = text.match(/The Southern Annular Mode \(SAM\) index is ([a-z\s-]{3,40}?)\./i);
  const iod = iodM ? iodM[1].trim().toLowerCase() : null;
  const sam = samM ? samM[1].trim().toLowerCase() : null;

  // update the single climate_outlook record in place — one authoritative climate driver
  let rec = (doc.outlooks as any[]).find((r) => r.kind === 'climate_outlook');
  if (!rec) {
    rec = { kind: 'climate_outlook', jurisdiction: 'AU', valley: null };
    doc.outlooks.push(rec);
  }
  rec.id = 'bom-enso-current';
  rec.authority = 'Bureau of Meteorology';
  rec.title = phase ? `ENSO status: ${phase}` : 'ENSO status';
  rec.summary =
    `${headline}.` +
    (nino ? ` Latest relative Niño3.4 index ${nino[1]}°C (El Niño threshold +0.80°C).` : '') +
    (iod ? ` Indian Ocean Dipole: ${iod}.` : '') +
    (sam ? ` Southern Annular Mode (SAM) index: ${sam}.` : '') +
    ' El Niño seasons lean drier over the southern Basin: historically slower allocation ratchet-up and firmer temporary-water prices; La Niña the reverse.' +
    ' The IOD and SAM act alongside ENSO — a negative IOD favours wetter conditions over south-east Australia and can offset an El Niño signal, and a positive SAM in winter-spring tends to reduce southern rainfall. Read the three together, not ENSO alone.';
  rec.drivers = {
    enso: phase ?? 'see summary',
    enso_nino34_relative_c: nino ? Number(nino[1]) : null,
    iod: iod ?? null,
    sam: sam ?? null,
  };
  rec.issued = issued;
  rec.valid_for = 'current';
  rec.source_url = url;
  delete rec.secondary_url;
  rec.confidence = 'scraped';
  rec.verification_note = 'Machine-extracted from the BOM southern-hemisphere monitoring wrap-up; read the source page for the full text and model survey.';
  return { url, status: `ok ("${headline.slice(0, 60)}...", issued ${issued})`, updated_records: 1 };
}

async function refreshNvrmOutlook(doc: any): Promise<SrcStatus> {
  // NVRM current-outlook page: per-system HRWS seasonal-determination outlook tables —
  // Wet / Average / Dry / Extreme Dry scenario rows, each with a similar historical season
  // and projected determination % at the next four announcement dates. Plain HTML, no WAF
  // (feed-automatability assessment #2 — "the single best allocation-forecasting input").
  const url = 'https://nvrm.net.au/outlooks/current-outlook';
  const html = await fetchText(url);
  if (!html) return { url, status: 'fetch failed', updated_records: 0 };
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

  const seasonM = strip(body).match(/Outlook for the (\d{4}\/\d{2,4}) season/i);
  const systems: any[] = [];
  // pair each "<system> ... Outlook for Seasonal Determination" heading with its next table
  const headingRe = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = headingRe.exec(body)) !== null) {
    const heading = decodeEntities(hm[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!/Outlook for Seasonal Determination/i.test(heading)) continue;
    const system = heading.replace(/\s*Outlook for Seasonal Determination.*$/i, '').trim();
    const rest = body.slice(hm.index + hm[0].length);
    const tm = rest.match(/<table[\s\S]*?<\/table>/i);
    if (!tm) continue;
    const rows = [...tm[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) =>
      [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((c) => decodeEntities(c[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
        .filter((c) => c !== ''),
    ).filter((r) => r.length > 0);
    if (rows.length < 2) continue;
    const header = rows[0];
    const dates = header.filter((c) => /\d{1,2}\s+\w+\s+\d{4}/.test(c));
    const scenarios = rows.slice(1)
      .filter((r) => r.length >= 2 + dates.length)
      .map((r) => ({
        inflow_conditions: r[0],
        similar_season: r[1],
        projections: dates.map((d, i) => ({ date: d, determination_pct: r[2 + i] ?? null })),
      }));
    if (scenarios.length > 0) systems.push({ system, water_share_class: 'high-reliability', scenarios });
  }
  if (systems.length === 0) return { url, status: 'fetched but no outlook tables parsed', updated_records: 0 };

  let rec = (doc.outlooks as any[]).find((r) => r.id === 'nvrm-hrws-outlook');
  if (!rec) {
    rec = { id: 'nvrm-hrws-outlook', kind: 'allocation_outlook', jurisdiction: 'VIC', valley: null };
    doc.outlooks.push(rec);
  }
  rec.authority = 'Northern Victoria Resource Manager';
  rec.title = `Victorian HRWS seasonal-determination outlook${seasonM ? ` (${seasonM[1]} season)` : ''}`;
  rec.summary =
    `NVRM's published outlook of high-reliability water share determinations for ${systems.map((s) => s.system).join(', ')}: ` +
    'projected determination % at each upcoming announcement date under Wet / Average / Dry / Extreme Dry inflow scenarios, each ' +
    'anchored to a similar historical season. This is the resource manager\'s own forward guidance — lead with it for VIC allocation outlook questions.';
  rec.issued = today;
  rec.valid_for = seasonM ? `${seasonM[1]} season` : 'current season';
  rec.source_url = url;
  rec.confidence = 'scraped';
  rec.verification_note = 'Machine-extracted from the NVRM outlook page tables; verify against the page before high-stakes use.';
  rec.systems = systems;
  return { url, status: `ok (${systems.length} systems)`, updated_records: 1 };
}

async function refreshNswStatements(doc: any): Promise<SrcStatus> {
  const url = 'https://www.water.dcceew.nsw.gov.au/our-work/allocations-and-availability/allocations/water-allocation-statements';
  const html = await fetchText(url);
  if (!html) return { url, status: 'fetch failed', updated_records: 0 };
  // Collect statement PDF links (was-<valley>-<yyyymmdd>.pdf); keep the newest per valley.
  const links = [...html.matchAll(/href="([^"]*was-([a-z-]+)-(\d{8})\.pdf)"/gi)];
  if (links.length === 0) return { url, status: 'fetched but no statement links parsed', updated_records: 0 };
  const newest = new Map<string, { href: string; date: string }>();
  for (const [, href, valley, ymd] of links) {
    const abs = href.startsWith('http') ? href : `https://www.water.dcceew.nsw.gov.au${href}`;
    const cur = newest.get(valley);
    if (!cur || ymd > cur.date.replace(/-/g, '')) {
      newest.set(valley, { href: abs, date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` });
    }
  }
  let rec = (doc.outlooks as any[]).find((r) => r.id === 'nsw-was-latest-statements');
  if (!rec) {
    rec = { id: 'nsw-was-latest-statements', authority: 'NSW DCCEEW (Water)', kind: 'allocation_outlook_index', jurisdiction: 'NSW', valley: null, source_url: url };
    doc.outlooks.push(rec);
  }
  rec.title = 'Latest NSW water allocation statements (per valley)';
  rec.summary = 'Newest per-valley allocation statement PDFs — each carries the current determination and forward scenario projections. Direct the client to the statement for their valley.';
  rec.issued = today;
  rec.valid_for = 'current';
  rec.confidence = 'scraped';
  rec.statements = [...newest.entries()].map(([valley, v]) => ({ valley, date: v.date, url: v.href }));
  return { url, status: `ok (${newest.size} valleys)`, updated_records: 1 };
}

async function main() {
  const doc = loadJson();
  const results: SrcStatus[] = [];
  for (const fn of [refreshBomEnso, refreshNvrmOutlook, refreshNswStatements]) {
    try {
      results.push(await fn(doc));
    } catch (e: any) {
      results.push({ url: fn.name, status: `error: ${e?.message ?? e}`, updated_records: 0 });
    }
  }
  const updated = results.reduce((s, r) => s + r.updated_records, 0);
  if (updated > 0) doc.as_at = today;
  doc.last_refresh = { at: today, method: 'refresh-outlooks.ts', sources_attempted: results };
  saveJson(doc);
  for (const r of results) console.log(`${r.status.padEnd(40)} ${r.url}`);
  console.log(`${updated} record(s) updated; snapshot as_at=${doc.as_at}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
