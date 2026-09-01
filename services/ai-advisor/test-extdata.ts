/**
 * Offline test for the external-data datasets + tools (Workstream B). No DB, no network.
 *   npx tsx test-extdata.ts
 * Checks: every dataset parses, provenance is present, every record carries a date, and the three
 * tools return sensible output for Hume and NSW Murrumbidgee general security.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildExtdataToolDefs, EXTDATA_TOOL_NAMES } from './src/extdata-tools';
import { parseNvrmSeasons, checkSeason, stageForDate } from './src/scripts/refresh-extdata';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'knowledge', 'data');
const load = (n: string) => JSON.parse(readFileSync(join(dataDir, n), 'utf8'));

const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isSeason = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  ERR ${name}${detail ? ' — ' + detail : ''}`); }
}

function parse(res: any) { return JSON.parse(res.content[0].text); }
async function callTool(defs: any[], name: string, args: any) {
  const d = defs.find((t) => t.name === name);
  if (!d) throw new Error('no such tool: ' + name);
  return parse(await d.handler(args, {}));
}

const PROV_KEYS = ['source_url', 'source_name', 'fetched_at', 'licence_or_terms_note'];
function checkProvenance(label: string, ds: any) {
  check(`${label}: provenance present`, !!ds.provenance);
  for (const k of PROV_KEYS) check(`${label}: provenance.${k}`, ds.provenance && ds.provenance[k] != null);
}

async function main() {
  console.log('=== datasets parse + provenance ===');
  const storage = load('dam-storage.json');
  const history = load('dam-storage-history.json');
  const alloc = load('allocations.json');
  const allocHistory = load('allocations-history.json');
  checkProvenance('dam-storage', storage);
  checkProvenance('dam-storage-history', history);
  checkProvenance('allocations', alloc);
  checkProvenance('allocations-history', allocHistory);

  console.log('\n=== every record carries a date ===');
  check('dam-storage: >=7 storages', (storage.storages ?? []).length >= 7, `got ${storage.storages?.length}`);
  check('dam-storage: every storage has a date', (storage.storages as any[]).every((s) => isDate(s.as_at)));
  check('dam-storage: every storage has numeric pct_full', (storage.storages as any[]).every((s) => typeof s.pct_full === 'number'));
  check('dam-storage: system_totals dated', (storage.system_totals as any[]).every((t) => isDate(t.as_at)));

  const histReadings = Object.values(history.storages ?? {}).flat() as any[];
  check('dam-storage-history: has readings', histReadings.length > 0, `got ${histReadings.length}`);
  check('dam-storage-history: every reading has a date', histReadings.every((r) => isDate(r.date)));
  check('dam-storage-history: every reading has numeric pct_full', histReadings.every((r) => typeof r.pct_full === 'number'));

  check('allocations: >=15 announcements', (alloc.announcements ?? []).length >= 15, `got ${alloc.announcements?.length}`);
  check('allocations: every record dated (as_at)', (alloc.announcements as any[]).every((r) => isDate(r.as_at)));
  check('allocations: every record has season', (alloc.announcements as any[]).every((r) => isSeason(r.season)));
  check('allocations: allocation_pct number-or-null', (alloc.announcements as any[]).every((r) => r.allocation_pct === null || typeof r.allocation_pct === 'number'));
  check('allocations: every record has announcer + source_url', (alloc.announcements as any[]).every((r) => r.announcer && r.source_url));

  check('allocations-history: has rows', (allocHistory.history ?? []).length > 0);
  check('allocations-history: every row has a season', (allocHistory.history as any[]).every((r) => isSeason(r.season)));
  check('allocations-history: every row has source_url + confidence', (allocHistory.history as any[]).every((r) => r.source_url && r.confidence));

  console.log('\n=== tools ===');
  const defs = buildExtdataToolDefs();
  // 7th is get_climate_outlook (BOM rainfall outlook) — its own suite is test-climate-outlook.ts.
  check('tool count = 7', defs.length === 7, `got ${defs.length}`);
  check('tool names match EXTDATA_TOOL_NAMES', defs.map((d: any) => d.name).sort().join(',') === [...EXTDATA_TOOL_NAMES].sort().join(','));

  // get_dam_storage — Hume, with historical same-month comparison.
  const hume = await callTool(defs, 'get_dam_storage', { storage_or_system: 'Hume' });
  check('get_dam_storage(Hume): matched >=1', hume.matched >= 1);
  const humeRow = (hume.storages as any[]).find((s) => /hume/i.test(s.storage));
  check('get_dam_storage(Hume): row present', !!humeRow);
  check('get_dam_storage(Hume): current pct_full numeric', typeof humeRow?.pct_full === 'number');
  check('get_dam_storage(Hume): cites as_at + source', isDate(humeRow?.as_at) && !!humeRow?.source_name);
  const cmp = humeRow?.vs_historical_same_month;
  check('get_dam_storage(Hume): has same-month comparison', !!cmp && typeof cmp.n_prior_years === 'number');
  check('get_dam_storage(Hume): July prior-year avg present', cmp?.month === 'July' && cmp?.avg_pct_full != null, `month=${cmp?.month} avg=${cmp?.avg_pct_full} n=${cmp?.n_prior_years}`);
  check('get_dam_storage(Hume): delta computed', typeof cmp?.delta_vs_avg_pct_points === 'number');
  console.log(`      Hume: ${humeRow?.pct_full}% now vs ${cmp?.avg_pct_full}% avg for ${cmp?.month} over ${cmp?.n_prior_years} prior yr(s); delta=${cmp?.delta_vs_avg_pct_points}pp`);

  // get_dam_storage — all
  const allDams = await callTool(defs, 'get_dam_storage', {});
  check('get_dam_storage(all): returns storages + totals', (allDams.storages?.length ?? 0) >= 7 && (allDams.system_totals?.length ?? 0) >= 1);

  // get_allocation_announcements — NSW Murrumbidgee general security
  const mbGS = await callTool(defs, 'get_allocation_announcements', { state: 'NSW', valley: 'Murrumbidgee', licence_class: 'general security' });
  check('get_allocation_announcements(NSW Murrumbidgee GS): matched >=1', mbGS.matched >= 1);
  const mbRow = (mbGS.rows as any[])[0];
  check('get_allocation_announcements: row dated + announcer + source', isDate(mbRow?.as_at) && !!mbRow?.announcer && !!mbRow?.source_url);
  check('get_allocation_announcements: Murrumbidgee GS opening = 0%', mbRow?.allocation_pct === 0, `got ${mbRow?.allocation_pct}`);
  console.log(`      NSW Murrumbidgee GS (${mbRow?.season}, ${mbRow?.as_at}): ${mbRow?.allocation_pct}% via ${mbRow?.announcer}`);

  // get_allocation_announcements — VIC Murray HRWS
  const vicMurray = await callTool(defs, 'get_allocation_announcements', { state: 'VIC', valley: 'Murray' });
  const hrwsRow = (vicMurray.rows as any[]).find((r) => /HRWS/.test(r.licence_class));
  check('get_allocation_announcements(VIC Murray): HRWS present', !!hrwsRow && typeof hrwsRow.allocation_pct === 'number', `got ${hrwsRow?.allocation_pct}`);

  // get_allocation_history — NSW Murrumbidgee GS
  const mbHist = await callTool(defs, 'get_allocation_history', { state: 'NSW', valley: 'Murrumbidgee', licence_class: 'general security' });
  check('get_allocation_history(NSW Murrumbidgee GS): >=3 seasons', mbHist.matched >= 3, `got ${mbHist.matched}`);
  check('get_allocation_history: rows carry season + source + confidence', (mbHist.rows as any[]).every((r) => isSeason(r.season) && r.source_url && r.confidence));
  check('get_allocation_history: sorted newest-first', (mbHist.rows as any[])[0].season >= (mbHist.rows as any[])[mbHist.rows.length - 1].season);
  console.log(`      NSW Murrumbidgee GS history: ${(mbHist.rows as any[]).map((r) => `${r.season}:${r.opening_pct ?? '-'}→${r.final_pct ?? '-'}`).join('  ')}`);

  // ---- refresh-extdata season guard (H9): a new-season NVRM page must never be written under ----
  // ---- the old season's labels; rollover only via an explicit --new-season flag.            ----
  console.log('\n=== refresh-extdata: water-year season guard (H9) ===');
  check('parse: "2026/27" form', parseNvrmSeasons('Seasonal determinations for 2026/27 were announced').includes('2026-27'));
  check('parse: "2026-27" and en-dash forms', parseNvrmSeasons('the 2026-27 and 2027–28 outlooks').join(',') === '2026-27,2027-28');
  check('parse: full-year form "2026/2027"', parseNvrmSeasons('water year 2026/2027').includes('2026-27'));
  check('parse: non-consecutive pairs ignored', parseNvrmSeasons('ISO 9001-2015, phone 03 5833-70 and 2019/23').length === 0);
  check('parse: carryover mention kept as separate season', JSON.stringify(parseNvrmSeasons('2026/27 opening; carryover from 2025/26')) === JSON.stringify(['2025-26', '2026-27']));

  check('guard: page matching dataset season updates', checkSeason(['2025-26', '2026-27'], '2026-27').action === 'update');
  const mismatch = checkSeason(['2026-27', '2027-28'], '2026-27');
  check('guard: newer page season refuses without flag', mismatch.action === 'skip' && /season mismatch/.test((mismatch as any).reason ?? ''), JSON.stringify(mismatch));
  check('guard: unparseable page refuses', checkSeason([], '2026-27').action === 'skip');
  const roll = checkSeason(['2027-28'], '2026-27', '2027-28');
  check('guard: explicit --new-season rolls intentionally', roll.action === 'rollover' && (roll as any).season === '2027-28');
  check('guard: wrong --new-season refuses', checkSeason(['2027-28'], '2026-27', '2028-29').action === 'skip');
  check('stage: July write is "opening"', stageForDate('2026-27', '2026-07-05') === 'opening');
  check('stage: later write is "in-season update"', stageForDate('2026-27', '2026-10-15') === 'in-season update');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} checks ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
