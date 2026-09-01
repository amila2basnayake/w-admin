/**
 * Unit + adversarial test for the curated data-grounding tools.
 * Runs every tool handler for a real client, then proves cross-tenant isolation.
 *   npx tsx test-tools.ts
 */
import { resolveCallerContext, runScoped } from './src/data-db';
import { buildToolDefs } from './src/data-tools';

const STUART = 119063;      // uid; account 666157; 31 holdings
const CLIENT_B = 1539;      // uid; account 664724; 14 holdings
const B_ACCOUNT = 664724;
const FLOAT_OWNER = 10;     // the one uid that owns a water_float_account

function parse(res: any) {
  try { return JSON.parse(res.content[0].text); } catch { return res?.content?.[0]?.text; }
}
const rowsOf = (p: any) => (Array.isArray(p) ? p : p?.rows ?? []);

async function callTool(defs: any[], name: string, args: any) {
  const d = defs.find((t) => t.name === name);
  if (!d) throw new Error('no such tool: ' + name);
  return parse(await d.handler(args, {}));
}

async function main() {
  const ctx = await resolveCallerContext(STUART);
  console.log('Stuart ctx:', JSON.stringify(ctx));
  const defs = buildToolDefs(ctx);
  console.log('tool count:', defs.length, '\n');

  const holdings = rowsOf(await callTool(defs, 'get_my_holdings', {}));
  const region = holdings[0]?.region_id;
  console.log(`holdings groups=${holdings.length}, first region_id=${region}\n`);

  const plan: [string, any][] = [
    ['get_my_profile', {}],
    ['get_my_holdings', {}],
    ['estimate_my_seasonal_allocation', {}],
    ['get_my_trade_history', {}],
    ['get_my_settlement_progress', {}],
    ['get_my_disputes', {}],
    ['get_my_engagement', {}],
    ['get_my_context', {}],
    ['get_my_account_setup', {}],
    ['find_region', { name: 'Murray' }],
    ['get_region_tradability', { region_id: region, is_permanent: false }],
    ['get_matchable_orders', { region_id: region, is_permanent: false, looking_for: 'buyers' }],
    ['get_market_liquidity', { region_id: region, is_permanent: false, looking_for: 'buyers' }],
    ['get_price_band', { region_id: region, is_permanent: false, months: 12 }],
    ['get_price_band', { region_id: region, is_permanent: false, months: 240 }],
    ['get_market_reference', { region_id: region, is_permanent: false, months: 12 }],
    ['get_price_history_series', { region_id: region, is_permanent: false }],
    ['get_price_history_series', { region_id: region, is_permanent: false, group_by: 'month', date_from: '2024-07-01' }],
    ['get_region_allocation', { region_id: region }],
    ['get_allocation_trajectory', { region_id: region }],
    ['get_climate_drivers', {}],
    ['estimate_net_proceeds', { region_id: region, is_permanent: false, volume_ml: 100, price_per_ml: 250 }],
    ['get_my_fee_schedule', {}],
    ['get_market_events', {}],
    ['get_my_water_account', {}],
  ];

  let ok = 0, fail = 0;
  for (const [name, args] of plan) {
    try {
      const p = await callTool(defs, name, args);
      const rows = rowsOf(p);
      const extra = p && !Array.isArray(p) ? Object.keys(p).filter((k) => k !== 'rows') : [];
      console.log(`  OK  ${name.padEnd(32)} rows=${String(Array.isArray(rows) ? rows.length : '-').padStart(3)} ${extra.length ? 'extra:{' + extra.join(',') + '}' : ''}`);
      ok++;
    } catch (e: any) {
      console.log(`  ERR ${name.padEnd(32)} ${e.message}`);
      fail++;
    }
  }
  console.log(`\ntools: ${ok} ok, ${fail} failed`);

  // ---- adversarial: cross-tenant isolation ------------------------------------------
  console.log('\n--- adversarial: cross-tenant isolation ---');
  const ctxB = await resolveCallerContext(CLIENT_B);
  const defsB = buildToolDefs(ctxB);
  const sum = (h: any[]) => h.reduce((s, r) => s + Number(r.n_holdings || 0), 0);
  const hA = rowsOf(await callTool(defs, 'get_my_holdings', {}));
  const hB = rowsOf(await callTool(defsB, 'get_my_holdings', {}));
  const sA = sum(hA), sB = sum(hB);
  // Compare the actual holding sets, not their sizes — counts can collide legitimately.
  const fp = (h: any[]) => JSON.stringify(h.map((r) => [r.region_id, r.product, r.total_ml]).sort());
  const distinct = fp(hA) !== fp(hB);
  console.log(`Stuart tradable holdings=${sA} | ClientB=${sB} | both>0=${sA > 0 && sB > 0} distinct-sets=${distinct}`);

  // RLS killer proof: even a query that NAMES B's account returns 0 under Stuart's GUC.
  const leak = await runScoped(ctx, 'select count(*)::int as n from property where registry_user=$1', [B_ACCOUNT]);
  console.log(`RLS probe: B's holdings visible under Stuart's scope = ${leak[0].n} (expect 0)`);

  // float-account positive path
  const ctxF = await resolveCallerContext(FLOAT_OWNER);
  const wa = await callTool(buildToolDefs(ctxF), 'get_my_water_account', {});
  console.log(`float-owner(uid ${FLOAT_OWNER}) account present=${!!wa.account} txns=${(wa.transactions || []).length}`);

  // au_state regression: the SQL expression must agree with the canonical \b-anchored
  // mapping in forecast-tools (fetchAuState) for EVERY territory — a prefix match without
  // a word boundary once classified "Waterfind Consultancy" as WA.
  const AU_STATE_RE = /^(NSW|VIC|SA|QLD|WA|TAS|NT|ACT)\b/i;
  const terr = await runScoped(ctx,
    `select name, substring(upper(name) from '^(NSW|VIC|SA|QLD|WA|TAS|NT|ACT)([^A-Z0-9]|$)') as au_state
       from territory`);
  const auBad = terr.filter((r) => (r.au_state ?? null) !== (r.name.match(AU_STATE_RE)?.[1].toUpperCase() ?? null));
  console.log(`au_state mapping: ${terr.length} territories checked, ${auBad.length} mismatches` +
    (auBad.length ? ' ' + JSON.stringify(auBad) : ''));

  const pass = fail === 0 && sA > 0 && sB > 0 && distinct && leak[0].n === 0 && auBad.length === 0;
  console.log(`\n${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
