/**
 * Unit + adversarial test for get_my_opportunities (Workstream E / Tom Rooney C3).
 * Runs the tool for two real clients, checks tenant isolation, and re-derives the
 * observations' underlying numbers with independent queries.
 *   npx tsx test-opportunities.ts
 */
import { resolveCallerContext, runScoped, type CallerCtx } from './src/data-db';
import { buildToolDefs } from './src/data-tools';

const STUART = 119063;   // uid; account 666157
const BETH = 2725534;    // uid; account 2725535 (Victorian Environmental Water Holder)

function parse(res: any) {
  try { return JSON.parse(res.content[0].text); } catch { return res?.content?.[0]?.text; }
}
async function callTool(defs: any[], name: string, args: any) {
  const d = defs.find((t) => t.name === name);
  if (!d) throw new Error('no such tool: ' + name);
  return parse(await d.handler(args, {}));
}
const N = (v: any) => (v == null ? null : Number(v));
const seasonStartOf = (label: string) => parseInt(label.slice(0, 4), 10);
const SEASON_CASE = "(CASE WHEN extract(month from oc.date_accepted)>=7 THEN extract(year from oc.date_accepted) ELSE extract(year from oc.date_accepted)-1 END)::int";

let checks = 0, failed = 0;
function assert(cond: boolean, label: string, detail = '') {
  checks++;
  if (cond) { console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label} ${detail}`); }
}

async function runFor(name: string, uid: number, ctx: CallerCtx, otherUid: number, otherAccount: number) {
  console.log(`\n===== ${name} (uid ${uid} / account ${ctx.account}) =====`);
  const defs = buildToolDefs(ctx);
  const out = await callTool(defs, 'get_my_opportunities', {});
  const json = JSON.stringify(out);

  // shape
  assert(!!out.history_profile && Array.isArray(out.current_market) && Array.isArray(out.observations),
    'output has {history_profile, current_market, observations[]}');
  assert(typeof out.data_as_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(out.data_as_at),
    'data_as_at present (snapshot provenance)', out.data_as_at);
  assert(typeof out.current_season === 'string' && /^\d{4}-\d{2}$/.test(out.current_season),
    'current_season derived', out.current_season);

  // ---- tenant isolation: no other account's identifiers, no fee data of any client ----
  assert(!json.includes(String(otherUid)) && !json.includes(String(otherAccount)),
    "output contains no other client's uid/account id");
  assert(!/commission|brokerage|_fee|fee_|fees/i.test(json),
    'output contains no fee/commission/brokerage fields (never exposes fee data)');

  // ---- observation text is data, not prose ----
  // The not-advice assertions here were removed 2026-08-04 with the rest of the disclaimer layer.
  // What is still worth asserting is that the TOOL emits observations rather than editorialising:
  // the model does the advising now, off these figures.
  const texts = out.observations.map((o: any) => String(o.text || '')).join(' || ');
  assert(texts.length > 0, 'observations carry text', texts.slice(0, 120));

  // ---- independent re-derivation of history_profile ----
  const bySell = out.history_profile.by_direction.find((r: any) => r.direction === 'sell' && r.is_permanent === false);
  const byBuy = out.history_profile.by_direction.find((r: any) => r.direction === 'buy' && r.is_permanent === false);
  const rawSell = (await runScoped(ctx,
    `SELECT count(*)::int n, round(coalesce(sum(oc.buying_quantity),0)::numeric,0) ml
       FROM order_completed oc JOIN wateroffer wo ON wo.id=oc.wateroffer
      WHERE wo.seller=$1 AND wo.sale=false AND oc.date_deleted IS NULL`, [uid]))[0];
  const rawBuy = (await runScoped(ctx,
    `SELECT count(*)::int n FROM order_completed oc JOIN wateroffer wo ON wo.id=oc.wateroffer
      WHERE wo.buyer=$1 AND wo.sale=false AND oc.date_deleted IS NULL`, [uid]))[0];
  assert((bySell?.trades ?? 0) === rawSell.n && (rawSell.n === 0 || N(bySell.total_ml) === N(rawSell.ml)),
    'temp-sell trades+ML match an independent raw query', `tool=${bySell?.trades}/${bySell?.total_ml} raw=${rawSell.n}/${rawSell.ml}`);
  assert((byBuy?.trades ?? 0) === rawBuy.n,
    'temp-buy trades match an independent raw query', `tool=${byBuy?.trades} raw=${rawBuy.n}`);

  const rawSeasons = (await runScoped(ctx,
    `SELECT count(DISTINCT ${SEASON_CASE})::int n
       FROM order_completed oc JOIN wateroffer wo ON wo.id=oc.wateroffer
      WHERE (wo.seller=$1 OR wo.buyer=$1) AND oc.date_deleted IS NULL`, [uid]))[0];
  assert(out.history_profile.data_span.seasons_active === rawSeasons.n && out.history_profile.seasons_active.length === rawSeasons.n,
    'seasons_active count matches independent raw query', `tool=${out.history_profile.data_span.seasons_active} raw=${rawSeasons.n}`);

  // ---- current_market: de-identified, best_bid re-derivable ----
  assert(out.current_market.every((m: any) => !('counterparty' in m) && !('seller' in m) && !('buyer' in m) && !('owner' in m)),
    'current_market rows carry no counterparty identity');
  const cm = out.current_market.find((m: any) => m.best_bid_pml != null);
  if (cm) {
    const raw = (await runScoped(ctx,
      `SELECT round(max(ol.price_per_ml)::numeric,0) bid FROM order_listing ol
         JOIN order_region oreg ON oreg.order_listing=ol.id AND COALESCE(oreg.deleted,false)=false
        WHERE oreg.region=$1 AND ol.order_type='B' AND ol.sale=$2
          AND (ol.deleted IS NULL OR ol.deleted=false) AND ol.date_completed IS NULL AND ol.quantity_avelable>0
          AND (ol.date_effective IS NULL OR ol.date_effective<=$3) AND ol.date_expired>=$3`,
      [cm.region_id, cm.is_permanent, ctx.asof]))[0];
    assert(N(raw.bid) === N(cm.best_bid_pml),
      `best_bid for region ${cm.region_id} matches an independent query`, `tool=${cm.best_bid_pml} raw=${raw.bid}`);
  } else {
    console.log('  --   (no live bid in holding regions to cross-check)');
  }

  // ---- price_context: pct is internally consistent with its own numbers ----
  const pc = out.observations.find((o: any) => o.type === 'price_context' && o.numbers.pct_bid_vs_my_sell != null);
  if (pc) {
    const n = pc.numbers;
    const expect = Math.round(((n.best_bid_pml - n.my_median_realised_sell_pml) / n.my_median_realised_sell_pml) * 100);
    assert(expect === n.pct_bid_vs_my_sell, 'price_context pct is consistent with its bid/own-median numbers',
      `computed=${expect} obs=${n.pct_bid_vs_my_sell}`);
    // and the own median it quotes is really the caller's own
    const mine = (await runScoped(ctx,
      `SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY oc.buying_price_per_ml)::numeric,0) m
         FROM order_completed oc JOIN wateroffer wo ON wo.id=oc.wateroffer
        WHERE wo.seller=$1 AND wo.sale=$2 AND wo.sellingregion=$3 AND oc.date_deleted IS NULL`,
      [uid, n.is_permanent, n.region_id]))[0];
    assert(N(mine.m) === N(n.my_median_realised_sell_pml),
      'price_context own-median equals the caller\'s own realised median', `tool=${n.my_median_realised_sell_pml} raw=${mine.m}`);
  } else {
    console.log('  --   (no price_context with own sell history to cross-check)');
  }

  // ---- unused_approval: flagged regions really had no sale this season ----
  const seasonStart = seasonStartOf(out.current_season);
  const unused = out.observations.filter((o: any) => o.type === 'unused_approval');
  let unusedOk = true;
  for (const o of unused) {
    const r = (await runScoped(ctx,
      `SELECT count(*)::int n FROM order_completed oc JOIN wateroffer wo ON wo.id=oc.wateroffer
        WHERE wo.seller=$1 AND oc.date_deleted IS NULL AND wo.sellingregion=$2 AND ${SEASON_CASE}=$3`,
      [uid, o.numbers.region_id, seasonStart]))[0];
    if (r.n !== 0 || !(Number(o.numbers.largest_approved_licence_ml) > 0)) unusedOk = false;
  }
  assert(unusedOk, `every unused_approval region (${unused.length}) is approved>0 with 0 sales in ${out.current_season}`);

  // ---- open_orders: count matches independent query ----
  const oo = out.observations.find((o: any) => o.type === 'open_orders');
  const rawOpen = (await runScoped(ctx,
    `SELECT count(DISTINCT ol.id)::int n FROM order_listing ol
      WHERE ol.owner=$1 AND (ol.deleted IS NULL OR ol.deleted=false) AND ol.date_completed IS NULL
        AND ol.quantity_avelable>0 AND ol.date_expired>=$2`, [uid, ctx.asof]))[0];
  const toolOpen = oo ? oo.numbers.open_sell_orders + oo.numbers.open_buy_orders : 0;
  assert(toolOpen === rawOpen.n, 'open_orders count matches independent query', `tool=${toolOpen} raw=${rawOpen.n}`);

  console.log(`  observations: ${out.observations.map((o: any) => o.type).join(', ')}`);
  return { out, json };
}

async function main() {
  const stuartCtx = await resolveCallerContext(STUART);
  const bethCtx = await resolveCallerContext(BETH);

  // description must still define observations[] as factual observations of the data (the
  // presentation-rule/not-advice clauses were removed with the rest of the advisor-logic prose)
  const def = buildToolDefs(stuartCtx).find((t) => t.name === 'get_my_opportunities');
  assert(!!def, 'get_my_opportunities is registered in the tool collection');
  const desc = String(def?.description ?? '');
  assert(/factual observation/i.test(desc), 'description defines observations as factual observations');

  const S = await runFor('STUART', STUART, stuartCtx, BETH, bethCtx.account!);
  const B = await runFor('BETH', BETH, bethCtx, STUART, stuartCtx.account!);

  // cross check: the two clients' history profiles are genuinely distinct
  assert(JSON.stringify(S.out.history_profile.by_direction) !== JSON.stringify(B.out.history_profile.by_direction),
    'the two clients have distinct history_profiles (no shared/leaked state)');

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks - failed}/${checks} checks`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
