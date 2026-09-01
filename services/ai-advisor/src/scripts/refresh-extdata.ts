/**
 * Re-fetch the external-data sources and rewrite the knowledge/data/*.json snapshots.
 *   npx tsx src/scripts/refresh-extdata.ts
 *
 * Design: no API keys; uses global fetch. Tolerates partial (or total) failure — a source that
 * fails, blocks (MDBA/Data.NSW return 403), times out, or parses to nothing leaves the existing
 * records untouched. Best-effort HTML extraction is implemented for the reliably-fetchable operator
 * pages (Goulburn-Murray Water, WaterNSW, NVRM); everything else is preserved as-is. Each dataset's
 * provenance gets a `last_refresh` report every run, and `fetched_at` is advanced only when a source
 * actually returned parseable data. New storage readings are appended to the history seed (deduped
 * by date) so the same-time-of-year baseline densifies over time.
 *
 * Note: run from an environment with outbound internet. In a network-sandboxed shell every fetch
 * fails safely and the files are rewritten unchanged apart from the last_refresh report.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));            // services/ai-advisor/src/scripts
const dataDir = join(here, '..', '..', 'knowledge', 'data');
const today = new Date().toISOString().slice(0, 10);
const nowIso = new Date().toISOString();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) waterfind-advisor-refresh';

type SrcStatus = { url: string; status: string; updated_records: number };

function loadJson<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(dataDir, name), 'utf8')) as T;
}
/** Atomic snapshot write: write to a temp file, then rename over the target. The sidecar loads
 *  these files at boot, so a crash/kill mid-write must never leave a truncated JSON behind
 *  (rename is atomic-or-nothing on the same volume, and replaces on Windows too). */
function saveJson(name: string, obj: unknown): void {
  const target = join(dataDir, name);
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

/** Strip tags, collapse whitespace — good enough to regex numbers out of a storage table. */
function toText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const num = (s: string) => Number(s.replace(/,/g, ''));

/**
 * Find "<label> ... <volume> <capacity> <pct>" for each label. Returns only plausible matches
 * (pct 0..110, capacity >= volume). Best-effort; returns {} if nothing usable.
 */
function extractStorages(text: string, labels: string[]): Record<string, { volume_ml: number; capacity_ml: number; pct: number }> {
  const out: Record<string, { volume_ml: number; capacity_ml: number; pct: number }> = {};
  for (const label of labels) {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^0-9]{0,40}([\\d,]{4,})[^0-9]{0,40}([\\d,]{4,})[^0-9]{0,40}(\\d{1,3}(?:\\.\\d+)?)', 'i');
    const m = text.match(re);
    if (!m) continue;
    const volume_ml = num(m[1]);
    const capacity_ml = num(m[2]);
    const pct = Number(m[3]);
    if (Number.isFinite(volume_ml) && Number.isFinite(capacity_ml) && Number.isFinite(pct)
        && pct >= 0 && pct <= 110 && capacity_ml >= volume_ml && capacity_ml > 0) {
      out[label] = { volume_ml, capacity_ml, pct };
    }
  }
  return out;
}

/** Append a dated reading to the history seed for a storage, deduped by date. */
function appendHistory(history: any, storageName: string, reading: any): boolean {
  history.storages = history.storages ?? {};
  const arr: any[] = history.storages[storageName] ?? (history.storages[storageName] = []);
  if (arr.some((r) => r.date === reading.date)) return false;
  arr.unshift(reading);
  arr.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return true;
}

async function refreshDamStorage(storage: any, history: any): Promise<SrcStatus[]> {
  const statuses: SrcStatus[] = [];
  // Label -> canonical storage name in the dataset + source page group.
  const GMW_LABELS: Record<string, string> = {
    'Dartmouth Dam': 'Dartmouth Dam',
    'Hume Dam': 'Hume Dam (Lake Hume)',
    'Lake Eildon': 'Lake Eildon',
    'Waranga Basin': 'Waranga Basin',
    'Lake Eppalock': 'Lake Eppalock',
    'Cairn Curran': 'Cairn Curran Reservoir',
  };
  const WNSW_LABELS: Record<string, string> = {
    'Blowering': 'Blowering Dam',
    'Burrinjuck': 'Burrinjuck Dam (Lake Burrinjuck)',
    'Menindee': 'Menindee Lakes (combined storage)',
  };

  const groups: Array<{ url: string; labels: Record<string, string>; source_name: string }> = [
    { url: 'https://www.g-mwater.com.au/water-operations/storage-levels', labels: GMW_LABELS, source_name: 'Goulburn-Murray Water storage levels' },
    { url: 'https://www.waternsw.com.au/nsw-dams/nsw-storage-levels/regional-nsw-dam-levels', labels: WNSW_LABELS, source_name: 'WaterNSW regional NSW dam levels' },
  ];

  let anyUpdated = false;
  for (const g of groups) {
    const html = await fetchText(g.url);
    if (!html) { statuses.push({ url: g.url, status: 'fetch-failed/blocked (kept old data)', updated_records: 0 }); continue; }
    const found = extractStorages(toText(html), Object.keys(g.labels));
    let updated = 0;
    for (const [label, canonical] of Object.entries(g.labels)) {
      const f = found[label];
      if (!f) continue;
      const rec = (storage.storages as any[]).find((s) => s.storage === canonical);
      if (!rec) continue;
      rec.volume_gl = Math.round((f.volume_ml / 1000) * 1000) / 1000;
      rec.capacity_gl = Math.round((f.capacity_ml / 1000) * 1000) / 1000;
      rec.pct_full = f.pct;
      rec.as_at = today;
      rec.source_name = g.source_name;
      rec.source_url = g.url;
      rec.confidence = 'high';
      appendHistory(history, canonical, {
        date: today, pct_full: f.pct, volume_gl: rec.volume_gl,
        source_name: g.source_name, source_url: g.url, confidence: 'high',
      });
      updated++;
    }
    if (updated > 0) anyUpdated = true;
    statuses.push({ url: g.url, status: updated > 0 ? 'ok' : 'fetched but nothing parsed (kept old data)', updated_records: updated });
  }

  if (anyUpdated) storage.as_at = today;
  return statuses;
}

// ---- H9: water-year season guard --------------------------------------------------------------
// The NVRM page is "current" — after the 1 July rollover it silently starts reporting the NEW
// season's determinations. Writing those numbers under the old dataset's season/stage labels would
// corrupt the snapshot, so we parse the season(s) the page mentions and refuse to update unless the
// page verifiably reports the dataset's own season. An intentional rollover requires an explicit
// --new-season=YYYY-YY flag; automatic silent rollover is forbidden.

/** All distinct season labels ("2026-27") mentioned in the page text. Accepts 2026/27, 2026-27,
 *  2026–27 and 2026/2027 forms; only consecutive-year pairs count. */
export function parseNvrmSeasons(text: string): string[] {
  const re = /\b(20\d{2})\s*[/–—-]\s*((?:20)?\d{2})\b/g;
  const seasons = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const y1 = Number(m[1]);
    const y2 = Number(m[2]) % 100;
    if (y2 === (y1 + 1) % 100) seasons.add(`${y1}-${String(y2).padStart(2, '0')}`);
  }
  return [...seasons].sort();
}

export type SeasonCheck =
  | { action: 'update' }                    // page verifiably reports the dataset's season
  | { action: 'rollover'; season: string }  // explicit --new-season matched the page's newest season
  | { action: 'skip'; reason: string };     // cannot verify / mismatch — keep existing data

/** Decide whether the page's numbers may be written under the dataset's labels. The page may
 *  legitimately mention neighbouring seasons (e.g. carryover from last season), so the NEWEST
 *  season mentioned is taken as the season the determinations belong to. */
export function checkSeason(pageSeasons: string[], datasetSeason: string, newSeasonFlag?: string): SeasonCheck {
  if (pageSeasons.length === 0) {
    return { action: 'skip', reason: 'season not found on page — cannot verify, kept existing data' };
  }
  const newest = pageSeasons[pageSeasons.length - 1]; // parseNvrmSeasons returns sorted labels
  if (newSeasonFlag) {
    if (newest === newSeasonFlag) return { action: 'rollover', season: newest };
    return { action: 'skip', reason: `--new-season ${newSeasonFlag} does not match page season ${newest} — kept existing data` };
  }
  if (newest === datasetSeason) return { action: 'update' };
  return {
    action: 'skip',
    reason: `season mismatch: page reports ${newest}, dataset holds ${datasetSeason} — kept existing data ` +
      `(re-run with --new-season=${newest} to roll the labels intentionally)`,
  };
}

/** Stage label for an in-place update: NVRM's 1 July determination is the season opening; anything
 *  written later in the water year is an in-season update, not "opening". */
export function stageForDate(season: string, isoDate: string): 'opening' | 'in-season update' {
  const startYear = Number(season.slice(0, 4));
  return isoDate <= `${startYear}-07-31` ? 'opening' : 'in-season update';
}

async function refreshAllocations(alloc: any, newSeasonFlag?: string): Promise<SrcStatus[]> {
  const url = 'https://nvrm.net.au/seasonal-determinations/current';
  const html = await fetchText(url);
  if (!html) return [{ url, status: 'fetch-failed/blocked (kept old data)', updated_records: 0 }];
  const text = toText(html);

  const seasonCheck = checkSeason(parseNvrmSeasons(text), String(alloc.season ?? ''), newSeasonFlag);
  if (seasonCheck.action === 'skip') {
    return [{ url, status: seasonCheck.reason, updated_records: 0 }];
  }
  const targetSeason = seasonCheck.action === 'rollover' ? seasonCheck.season : String(alloc.season);

  const systems = ['Murray', 'Goulburn', 'Campaspe', 'Loddon', 'Broken', 'Bullarook'];
  let updated = 0;
  for (const sys of systems) {
    // "<System> <HRWS>% <LRWS>%" — accept only when both look like percentages.
    const m = text.match(new RegExp('\\b' + sys + '\\b[^0-9]{0,20}(\\d{1,3})\\s*%[^0-9]{0,20}(\\d{1,3})\\s*%', 'i'));
    if (!m) continue;
    const hrws = Number(m[1]), lrws = Number(m[2]);
    if (hrws > 100 || lrws > 100) continue;
    const hr = (alloc.announcements as any[]).find((r) => r.state === 'VIC' && r.valley === sys && String(r.licence_class).includes('HRWS'));
    const lr = (alloc.announcements as any[]).find((r) => r.state === 'VIC' && r.valley === sys && String(r.licence_class).includes('LRWS'));
    if (hr) { hr.allocation_pct = hrws; hr.as_at = today; hr.season = targetSeason; hr.stage = stageForDate(targetSeason, today); updated++; }
    if (lr) { lr.allocation_pct = lrws; lr.as_at = today; lr.season = targetSeason; lr.stage = stageForDate(targetSeason, today); updated++; }
  }
  if (updated === 0) return [{ url, status: 'fetched but nothing parsed (kept old data)', updated_records: 0 }];

  alloc.as_at = today;
  if (seasonCheck.action === 'rollover') {
    // Intentional (flag-driven) rollover only: the dataset-level season follows the page. Rows
    // from other announcers (NSW/SA) keep their own per-row season labels until re-curated.
    alloc.season = targetSeason;
    return [{ url, status: `ok — rolled season labels to ${targetSeason} (VIC rows; other announcers keep their per-row season until re-curated)`, updated_records: updated }];
  }
  return [{ url, status: 'ok', updated_records: updated }];
}

/** --new-season=YYYY-YY (or "--new-season YYYY-YY"): intentional season rollover (see checkSeason). */
function parseNewSeasonFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = a.startsWith('--new-season=') ? a.slice('--new-season='.length)
      : a === '--new-season' ? argv[i + 1] : undefined;
    if (v === undefined) continue;
    if (!/^\d{4}-\d{2}$/.test(v)) throw new Error(`--new-season must look like 2027-28, got "${v}"`);
    return v;
  }
  return undefined;
}

async function main() {
  const newSeasonFlag = parseNewSeasonFlag(process.argv.slice(2));
  const storage = loadJson('dam-storage.json');
  const history = loadJson('dam-storage-history.json');
  const alloc = loadJson('allocations.json');
  const allocHistory = loadJson('allocations-history.json');

  const damStatuses = await refreshDamStorage(storage, history);
  const allocStatuses = await refreshAllocations(alloc, newSeasonFlag);

  const stamp = (obj: any, statuses: SrcStatus[]) => {
    obj.provenance = obj.provenance ?? {};
    obj.provenance.last_refresh = { at: nowIso, sources: statuses };
    if (statuses.some((s) => s.updated_records > 0)) obj.provenance.fetched_at = today;
  };
  stamp(storage, damStatuses);
  stamp(history, damStatuses);
  stamp(alloc, allocStatuses);
  // allocations-history is compiled/curated (opening+final), not a single-fetch source; record the attempt.
  allocHistory.provenance = allocHistory.provenance ?? {};
  allocHistory.provenance.last_refresh = { at: nowIso, sources: [{ url: 'multiple (NVRM/NSW AWD/SA DEW archives)', status: 'not auto-parsed — curated dataset, values preserved', updated_records: 0 }] };

  saveJson('dam-storage.json', storage);
  saveJson('dam-storage-history.json', history);
  saveJson('allocations.json', alloc);
  saveJson('allocations-history.json', allocHistory);

  const all = [...damStatuses, ...allocStatuses];
  const okSources = all.filter((s) => s.updated_records > 0).length;
  console.log(`refresh-extdata: ${okSources}/${all.length} sources updated data`);
  for (const s of all) console.log(`  [${s.status}] ${s.url} (updated ${s.updated_records})`);
  console.log('Datasets rewritten. Blocked/failed sources kept their previous records (see provenance.last_refresh).');
}

// Run only when invoked directly (npx tsx src/scripts/refresh-extdata.ts ...), not when the pure
// helpers above are imported by tests. Path equality plus a basename fallback covers runner quirks.
const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
const self = resolve(fileURLToPath(import.meta.url));
if (invoked === self || (invoked && basename(invoked) === basename(self))) {
  main().catch((e) => { console.error('refresh-extdata failed:', e); process.exit(1); });
}
