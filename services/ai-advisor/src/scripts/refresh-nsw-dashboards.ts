/**
 * Refresh knowledge/data/nsw-dashboards.json from the NSW DPIE public Tableau CSV views
 * (feed-automatability assessment #1 — four no-auth CSV endpoints, updated daily, CC-BY).
 *   npx tsx src/scripts/refresh-nsw-dashboards.ts
 *
 * Same contract as the other refresh scripts: best-effort, per-source status, atomic
 * snapshot writes, provenance per section. A source that fails leaves its section untouched.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'knowledge', 'data');
const FILE = 'nsw-dashboards.json';
const today = new Date().toISOString().slice(0, 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) waterfind-advisor-refresh';

const BASE = 'https://tableau.dpie.nsw.gov.au/t/DPIEExternal/views';
const SOURCES = {
  trade: `${BASE}/WaterTradeDashboard/WaterTradeSnapshot.csv`,
  balance: `${BASE}/AllocationsDashboard/CumulativeWaterBalance.csv`,
  usage: `${BASE}/UsageDashboard/WaterAccountSummary.csv`,
  utilisation: `${BASE}/UtilisationDashboard/UtilisationRate.csv`,
};

type SrcStatus = { url: string; status: string; updated: boolean };

async function fetchText(url: string, timeoutMs = 20000): Promise<string | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/csv,*/*' }, signal: ac.signal });
    if (!res.ok) return null;
    const text = await res.text();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Minimal CSV parse with quoted-field support (Tableau quotes fields containing commas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

const num = (s: string): number | null => {
  const v = Number(s.replace(/,/g, ''));
  return s !== '' && Number.isFinite(v) ? v : null;
};

async function main() {
  const doc: any = existsSync(join(dataDir, FILE))
    ? JSON.parse(readFileSync(join(dataDir, FILE), 'utf8'))
    : {
        dataset: 'nsw-dashboards',
        description: 'NSW DPIE/DPE public water dashboards (Tableau CSV views, updated daily, CC-BY — attribute NSW DPE). Trade prices are per valley for the current water year to date; balance and usage are STATEWIDE aggregates.',
      };
  const results: SrcStatus[] = [];

  // trade snapshot: (measure, valley) -> value
  {
    const url = SOURCES.trade;
    const text = await fetchText(url);
    if (!text) results.push({ url, status: 'fetch failed', updated: false });
    else {
      const rows = parseCsv(text).slice(1);
      const byValley = new Map<string, any>();
      for (const [measure, valley, value] of rows) {
        if (!measure || !valley) continue;
        const key = valley.trim();
        if (!byValley.has(key)) byValley.set(key, { water_source: key });
        const rec = byValley.get(key);
        if (/weighted average price/i.test(measure)) rec.allocation_weighted_avg_price_per_ml = num(value);
        else if (/entitlement trade/i.test(measure)) rec.entitlement_trade_per_share = num(value);
      }
      if (byValley.size > 0) {
        doc.trade = {
          as_at: today,
          semantics: 'Current-water-year-to-date NSW trade summary per regulated valley: allocation-trade weighted average $/ML and entitlement trade $/share for selected licence categories (null = no trades reported).',
          rows: [...byValley.values()],
        };
        results.push({ url, status: `ok (${byValley.size} valleys)`, updated: true });
      } else results.push({ url, status: 'fetched but no rows parsed', updated: false });
    }
  }

  // cumulative water balance: statewide fractions by (water year, month)
  {
    const url = SOURCES.balance;
    const text = await fetchText(url);
    if (!text) results.push({ url, status: 'fetch failed', updated: false });
    else {
      const rows = parseCsv(text).slice(1);
      const byKey = new Map<string, any>();
      for (const [measure, month, wy, total, value] of rows) {
        if (!measure || !month || !wy) continue;
        const key = `${wy}|${month}`;
        if (!byKey.has(key)) byKey.set(key, { water_year: wy, month, total_balance_fraction: num(total) });
        const rec = byKey.get(key);
        if (/cum allocations/i.test(measure)) rec.cumulative_allocation_fraction = num(value);
        else if (/carry over/i.test(measure)) rec.carryover_fraction = num(value);
      }
      if (byKey.size > 0) {
        doc.balance = {
          as_at: today,
          semantics: 'STATEWIDE NSW cumulative water balance by month: fractions of total entitlement (e.g. 0.16 = 16%) split into cumulative allocations made this water year plus carryover from last year. Not per valley.',
          rows: [...byKey.values()],
        };
        results.push({ url, status: `ok (${byKey.size} month-rows)`, updated: true });
      } else results.push({ url, status: 'fetched but no rows parsed', updated: false });
    }
  }

  // usage by source type (carries the dashboard's own script-run date)
  {
    const url = SOURCES.usage;
    const text = await fetchText(url);
    if (!text) results.push({ url, status: 'fetch failed', updated: false });
    else {
      const rows = parseCsv(text).slice(1);
      const out = rows
        .filter((r) => r.length >= 4)
        .map(([run, code, name, usage]) => ({ script_run: run, source_type: code, name, usage_ml: num(usage) }));
      if (out.length > 0) {
        doc.usage = {
          as_at: out[0].script_run || today,
          semantics: 'STATEWIDE NSW water usage this water year to date, ML, by source type. script_run is the dashboard refresh date.',
          rows: out,
        };
        results.push({ url, status: `ok (${out.length} source types)`, updated: true });
      } else results.push({ url, status: 'fetched but no rows parsed', updated: false });
    }
  }

  // utilisation view currently carries only a caveat note — keep it as the dataset caveat
  {
    const url = SOURCES.utilisation;
    const text = await fetchText(url);
    if (!text) results.push({ url, status: 'fetch failed', updated: false });
    else {
      const note = parseCsv(text).flat().filter((s) => s && !/^Current WY info$/i.test(s)).join(' ');
      if (note) {
        doc.current_wy_note = note;
        results.push({ url, status: 'ok (note)', updated: true });
      } else results.push({ url, status: 'fetched but empty', updated: false });
    }
  }

  const updated = results.filter((r) => r.updated).length;
  if (updated > 0) doc.as_at = today;
  doc.last_refresh = { at: today, method: 'refresh-nsw-dashboards.ts', sources_attempted: results };
  const target = join(dataDir, FILE);
  writeFileSync(`${target}.tmp`, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  renameSync(`${target}.tmp`, target);
  for (const r of results) console.log(`${r.status.padEnd(30)} ${r.url}`);
  console.log(`${updated}/4 sections updated; snapshot as_at=${doc.as_at}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
