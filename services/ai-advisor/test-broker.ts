// Brokerage-layer test: scope enforcement, pending-order lifecycle, ownership chokepoints,
// and a REAL crossing trade through the CRM engine (sell rests -> buy auto-clears against it).
//
// Requires: PG up, Resin CRM up on :81 (the JSP seam), sidecar NOT required (module-level).
//   npx tsx test-broker.ts
//
// Uses two real snapshot clients:
//   A = Stuart (uid 119063, account 666157)  — licence 2447507 in region 311325 (15.8 ML, approved)
//   B = Beth   (uid 2725534)                 — licence 124376304 in region 311325 (4736 ML, approved)

import { resolveCallerContext, runScoped, type CallerCtx } from './src/data-db';
import { buildToolDefs } from './src/data-tools';
import { buildBrokerToolDefs } from './src/broker-tools';
import {
  preparePendingOrder, prepareWithdrawal, confirmPendingOrder, cancelPendingOrder,
  getOwnedPendingOrder, listOrders, listOwnOpenOrders, reconcileUnknownOrders,
  confirmEscalation, sessionEpoch, bumpSessionEpoch, ScopeViolation,
} from './src/brokerage';
import { NotFound } from './src/conversations';
import { query } from './src/db';

const UID_A = 119063;   // stuart@hodgefarms.com.au
const UID_B = 2725534;  // beth.ashworth@vewh.vic.gov.au
const REGION = 311325;  // 1A CENTRAL GOULBURN IRRIGATION AREA - LOW R

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
async function expectScope(name: string, fn: () => Promise<any>, needle?: string) {
  try { await fn(); ok(name, false, 'no error thrown'); }
  catch (e: any) {
    const isScope = e instanceof ScopeViolation;
    const matches = !needle || String(e.message).toLowerCase().includes(needle.toLowerCase());
    ok(name, isScope && matches, String(e.message).slice(0, 90));
  }
}

const ctxA = await resolveCallerContext(UID_A);
const ctxB = await resolveCallerContext(UID_B);
console.log('A:', JSON.stringify(ctxA), '\nB:', JSON.stringify(ctxB), '\n');

// ---- 1. scope violations at prepare time -------------------------------------------
console.log('-- scope violations --');
await expectScope('sell in a region with no holdings is refused',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: 999999999, isPermanent: false, volumeMl: 1, pricePerMl: 100 }),
  'no water rights');
await expectScope('buy anchored to a region with no holdings is refused',
  () => preparePendingOrder(ctxA, { side: 'BUY', regionId: 999999999, isPermanent: false, volumeMl: 1, pricePerMl: 100 }),
  'no water rights');
await expectScope('over-volume sell is refused',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 100000, pricePerMl: 100 }),
  'exceeds');
await expectScope('non-positive volume is refused',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 0, pricePerMl: 100 }),
  'positive');
await expectScope('withdrawing an order you do not own is refused',
  () => prepareWithdrawal(ctxA, 1),
  'not an open order of yours');

// ---- 2. pending lifecycle: prepare -> cancel; ownership chokepoint -------------------
console.log('\n-- pending lifecycle & cross-user isolation --');
const p1 = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 150 });
ok('prepare stores a pending order', p1.status === 'pending' && p1.property_id != null, `id=${p1.id} property=${p1.property_id}`);
ok('validation snapshot recorded', p1.validation?.licence?.approved === true);

// user B cannot see, confirm or cancel A's pending order
try { await getOwnedPendingOrder(p1.id, UID_B); ok('IDOR: B cannot read A pending order', false); }
catch (e) { ok('IDOR: B cannot read A pending order', e instanceof NotFound); }
try { await confirmPendingOrder(ctxB, p1.id, true); ok('IDOR: B cannot confirm A pending order', false); }
catch (e) { ok('IDOR: B cannot confirm A pending order', e instanceof NotFound); }
try { await cancelPendingOrder(UID_B, p1.id); ok('IDOR: B cannot cancel A pending order', false); }
catch (e) { ok('IDOR: B cannot cancel A pending order', e instanceof NotFound); }

// T&C gate
await expectScope('confirm without T&C acceptance is refused',
  () => confirmPendingOrder(ctxA, p1.id, false), 'terms');

const c1 = await cancelPendingOrder(UID_A, p1.id);
ok('A can cancel own pending order', c1.status === 'cancelled');
const c1b = await confirmPendingOrder(ctxA, p1.id, true);
ok('cancelled order cannot be confirmed after the fact', c1b.status === 'cancelled');

// expiry
const pExp = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 150 });
await query(`UPDATE pending_order SET expires_at = now() - interval '1 minute' WHERE id=$1`, [pExp.id]);
const listedAfter = await listOrders(UID_A);
ok('overdue pending orders are lazily expired', listedAfter.find((o) => o.id === pExp.id)?.status === 'expired');
const cExp = await confirmPendingOrder(ctxA, pExp.id, true);
ok('expired order cannot be confirmed', cExp.status === 'expired');

// ---- 3. the real thing: sell rests, buy auto-clears against it ----------------------
console.log('\n-- real engine: crossing trade --');
const sell = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 150 });
const sellDone = await confirmPendingOrder(ctxA, sell.id, true);
ok('A sell placed through the CRM engine', sellDone.status === 'placed' && !!sellDone.crm_order_id,
  `crm_order=${sellDone.crm_order_id} cleared=${sellDone.cleared_trades} err=${sellDone.error ?? ''}`);

const rest = await query(
  `SELECT ol.owner, ol.order_type, ol.quantity_avelable, ol.date_completed FROM public.order_listing ol WHERE ol.id=$1`,
  [sellDone.crm_order_id]);
ok('sell listing rests on the book, owned by A',
  rest.rows[0]?.owner === UID_A && rest.rows[0]?.order_type === 'S' && rest.rows[0]?.date_completed == null);

const buy = await preparePendingOrder(ctxB, { side: 'BUY', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 150 });
const buyDone = await confirmPendingOrder(ctxB, buy.id, true);
ok('B buy placed through the CRM engine', buyDone.status === 'placed' && !!buyDone.crm_order_id,
  `crm_order=${buyDone.crm_order_id} cleared=${buyDone.cleared_trades} err=${buyDone.error ?? ''}`);
ok('buy AUTO-CLEARED against A\'s resting sell', (buyDone.cleared_trades ?? 0) >= 1,
  `cleared=${buyDone.cleared_trades}`);

const trade = await query(
  `SELECT oc.id, oc.buying_quantity, oc.buying_price_per_ml, wo.buyer, wo.seller, wo.id AS wateroffer
     FROM public.order_completed oc JOIN public.wateroffer wo ON wo.id = oc.wateroffer
    WHERE oc.buy_order_listing = $1 OR oc.sell_order_listing = $2 OR wo.buyer = $3
    ORDER BY oc.id DESC LIMIT 1`,
  [buyDone.crm_order_id, sellDone.crm_order_id, UID_B]).catch(async () => {
    // column names differ across iterations — fall back to the wateroffer linkage only
    return query(
      `SELECT oc.id, oc.buying_quantity, oc.buying_price_per_ml, wo.buyer, wo.seller, wo.id AS wateroffer
         FROM public.order_completed oc JOIN public.wateroffer wo ON wo.id = oc.wateroffer
        WHERE wo.buyer = $1 AND wo.seller = $2 AND oc.date_deleted IS NULL
        ORDER BY oc.id DESC LIMIT 1`, [UID_B, UID_A]);
  });
const t = trade.rows[0];
ok('settlement row exists: B bought from A at $150/ML for 1 ML',
  !!t && t.buyer === UID_B && t.seller === UID_A
    && Number(t.buying_price_per_ml) === 150 && Number(t.buying_quantity) === 1,
  t ? `wateroffer=${t.wateroffer}` : 'no trade row found');

const sellAfter = await query(
  `SELECT date_completed FROM public.order_listing WHERE id=$1`, [sellDone.crm_order_id]);
ok('A\'s sell listing is marked completed', sellAfter.rows[0]?.date_completed != null);

// ---- 3b. AI Advisor CRM note written back on placement (seam side-effect) -----------
// After a successful action the seam records a plain-text Contact Note on the client's account,
// authored by the dedicated AI Advisor user (id = the server-side wf.ai.note-author-id). It is
// best-effort and disabled when that property is not configured (or the JSP/delegate build has
// not been deployed yet), so a missing note is reported as INFO, not a failure.
console.log('\n-- AI Advisor CRM contact note (seam side-effect) --');
const noteRows = await query(
  `SELECT note, COALESCE(client_service,false) AS client_service
     FROM public.contact
    WHERE registry_user = $1 AND subclass = 'C'
      AND note LIKE 'AI Advisor: SELL order placed%'
      AND note LIKE '%orderListingId=' || $2::text || '.%'
    ORDER BY id DESC LIMIT 1`,
  [ctxA.account, sellDone.crm_order_id]);
if (noteRows.rowCount && noteRows.rows[0]) {
  const n = noteRows.rows[0];
  ok('placement wrote a plain-text AI Advisor note on the account (clientService=false, no HTML)',
    n.client_service === false && !/[<>]/.test(n.note), n.note.slice(0, 90));
} else {
  console.log('  INFO  no AI Advisor note for this placement — set wf.ai.note-author-id\n' +
              '        (db/note-author-seed.sql) and deploy the rebuilt seam to enable note write-back');
}

// ---- 4. withdrawal of an own resting order ------------------------------------------
console.log('\n-- withdrawal (own resting order) --');
const sell2 = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1.5, pricePerMl: 9999 });
const sell2Done = await confirmPendingOrder(ctxA, sell2.id, true);
ok('A places a second sell (absurd price, will rest)', sell2Done.status === 'placed', `crm_order=${sell2Done.crm_order_id}`);

const openOrders = await listOwnOpenOrders(ctxA);
ok('get_my_open_orders sees the resting order', openOrders.some((o: any) => o.order_listing_id === sell2Done.crm_order_id));

await expectScope('B cannot prepare withdrawal of A\'s listing',
  () => prepareWithdrawal(ctxB, sell2Done.crm_order_id!), 'not an open order of yours');

const wd = await prepareWithdrawal(ctxA, sell2Done.crm_order_id!);
const wdDone = await confirmPendingOrder(ctxA, wd.id, false);   // withdrawals need no T&C tick
ok('A withdraws own resting order via the engine', wdDone.status === 'placed');
const wdCheck = await query(`SELECT deleted FROM public.order_listing WHERE id=$1`, [sell2Done.crm_order_id]);
ok('listing soft-deleted in the CRM', wdCheck.rows[0]?.deleted === true);

// ---- 5. double-confirm race guard ----------------------------------------------------
console.log('\n-- double-confirm guard --');
const p3 = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9998 });
const [r1, r2] = await Promise.all([
  confirmPendingOrder(ctxA, p3.id, true),
  confirmPendingOrder(ctxA, p3.id, true),
]);
// The invariant: exactly ONE CRM order exists no matter how the confirms interleave. The
// losing confirm may observe the transient 'executing' state — what matters is the DB.
const finalP3 = await getOwnedPendingOrder(p3.id, UID_A);
const crmIds = new Set([r1.crm_order_id, r2.crm_order_id, finalP3.crm_order_id].filter(Boolean));
const listingCount = await query(
  `SELECT count(*)::int AS n FROM public.order_listing
    WHERE owner = $1 AND price_per_ml = 9998 AND (deleted IS NULL OR deleted = false)`, [UID_A]);
ok('simultaneous confirms place exactly one CRM order',
  finalP3.status === 'placed' && crmIds.size === 1 && listingCount.rows[0].n === 1,
  `final=${finalP3.status} crm=${finalP3.crm_order_id} listings@9998=${listingCount.rows[0].n}`);
// cleanup: withdraw it
if (finalP3.crm_order_id) {
  const wd3 = await prepareWithdrawal(ctxA, finalP3.crm_order_id);
  await confirmPendingOrder(ctxA, wd3.id, false);
}

// ---- 6. fee schedule (slice A: read-only get_my_fee_schedule) ------------------------
console.log('\n-- fee schedule (slice A) --');
function parseTool(res: any) { try { return JSON.parse(res.content[0].text); } catch { return res?.content?.[0]?.text; } }
async function callTool(defs: any[], name: string, args: any) {
  const d = defs.find((t: any) => t.name === name);
  if (!d) throw new Error('no such tool: ' + name);
  return parseTool(await d.handler(args, {}));
}
const feesA = await callTool(buildToolDefs(ctxA), 'get_my_fee_schedule', {});
const feesB = await callTool(buildToolDefs(ctxB), 'get_my_fee_schedule', {});
const quadrants = ['buy_permanent', 'buy_temporary', 'sell_permanent', 'sell_temporary'];
ok('A: all four fee cells returned, none null',
  feesA.rows?.length === 4 && quadrants.every((q) =>
    feesA.rows.some((r: any) => r.quadrant === q && r.waterfind_fee_aud != null && r.brokerage_pct != null)),
  JSON.stringify(feesA.rows?.map((r: any) => [r.quadrant, r.waterfind_fee_aud, r.brokerage_pct])));
// Values verified against the CRM's own /get-fees-for-registry-user.html for these snapshot users.
ok('A resolves his client-specific agreement (matches CRM admin page)',
  feesA.rows.every((r: any) => r.source === 'client-specific agreement') &&
  feesA.rows.find((r: any) => r.quadrant === 'sell_temporary')?.waterfind_fee_aud === '100.00' &&
  feesA.rows.find((r: any) => r.quadrant === 'sell_permanent')?.waterfind_fee_aud === '1500.00');
ok('B falls back to the state rate card (matches CRM admin page)',
  feesB.rows.every((r: any) => r.source === 'state rate card') &&
  feesB.rows.find((r: any) => r.quadrant === 'sell_temporary')?.waterfind_fee_aud === '200.00' &&
  feesB.rows.find((r: any) => r.quadrant === 'buy_permanent')?.waterfind_fee_aud === '1500.00');
ok('cross-user isolation: B\'s schedule is B\'s, not A\'s (server-bound account, no id parameter)',
  feesB.rows.find((r: any) => r.quadrant === 'sell_temporary')?.waterfind_fee_aud !==
  feesA.rows.find((r: any) => r.quadrant === 'sell_temporary')?.waterfind_fee_aud);

// estimate_net_proceeds must price from the caller's OWN contracted schedule (pilot bug:
// it used the median of OTHER clients' charged commissions) and expose no cross-client rates.
const estA = await callTool(buildToolDefs(ctxA), 'estimate_net_proceeds',
  { region_id: REGION, is_permanent: false, volume_ml: 5, price_per_ml: 200 });
const eA = estA.rows?.[0];
ok('A\'s estimate = his contracted $100 + 2% (5 ML @ $200 -> comm $120, net $868)',
  eA?.basis === 'client fee agreement' && eA?.est_waterfind_commission === '120.00' &&
  eA?.est_gst_on_commission === '12.00' && eA?.est_net_proceeds_excl_gov_fees === '868.00',
  JSON.stringify(eA));
const estB = await callTool(buildToolDefs(ctxB), 'estimate_net_proceeds',
  { region_id: REGION, is_permanent: false, volume_ml: 5, price_per_ml: 200 });
const eB = estB.rows?.[0];
ok('B\'s estimate falls back to the VIC rate card ($200 + 3% -> comm $230, net $747)',
  eB?.basis === 'state rate card' && eB?.est_waterfind_commission === '230.00' &&
  eB?.est_net_proceeds_excl_gov_fees === '747.00', JSON.stringify(eB));
ok('estimate exposes no cross-client rate fields',
  eA != null && !('eff_brokerage_pct' in eA) && !('charged_sample_sides' in eA));
try {
  await runScoped(ctxA, 'SELECT count(*) FROM waterfind_commission_index', []);
  ok('advisor role is REVOKED from waterfind_commission_index', false, 'query succeeded');
} catch (e: any) {
  ok('advisor role is REVOKED from waterfind_commission_index',
    /permission denied/i.test(String(e.message)), String(e.message).slice(0, 60));
}

// ---- 7. forward orders (slice B) ------------------------------------------------------
console.log('\n-- forward orders (slice B) --');
const FWD_DATE = '01/03/2027';           // within the 24-month horizon
const FWD_DATE_OTHER = '01/04/2027';     // a different delivery date (must NOT match)
await expectScope('past delivery date is refused',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 100, deliveryDate: '01/01/2020' }),
  'future');
await expectScope('impossible delivery date is refused',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 100, deliveryDate: '31/02/2027' }),
  'real date');
await expectScope('delivery date beyond the horizon is refused',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 100, deliveryDate: '01/01/2035' }),
  'too far');

const fwdSell = await preparePendingOrder(ctxA,
  { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 8123, deliveryDate: FWD_DATE });
ok('forward sell prepared with delivery_date stored', fwdSell.delivery_date === FWD_DATE);
ok('card payload carries the multi-region forward disclosure',
  typeof fwdSell.preview?.forward_note === 'string' && /ALL tradable regions/.test(fwdSell.preview.forward_note));

const fwdSellDone = await confirmPendingOrder(ctxA, fwdSell.id, true);
ok('forward sell placed through the CRM engine', fwdSellDone.status === 'placed', `crm_order=${fwdSellDone.crm_order_id} err=${fwdSellDone.error ?? ''}`);
const fwdListing = await query(
  `SELECT date_of_delivery IS NOT NULL AS is_forward, to_char(date_of_delivery,'DD/MM/YYYY') AS dd
     FROM public.order_listing WHERE id=$1`, [fwdSellDone.crm_order_id]);
ok('CRM listing has the delivery date set', fwdListing.rows[0]?.is_forward === true && fwdListing.rows[0]?.dd === FWD_DATE,
  JSON.stringify(fwdListing.rows[0]));
const fwdRegions = await query(
  `SELECT count(*)::int AS n FROM public.order_region WHERE order_listing=$1 AND (deleted IS NULL OR deleted=false)`,
  [fwdSellDone.crm_order_id]);
ok('temp forward sell listed into ALL tradable regions (multi-region)', fwdRegions.rows[0].n > 1, `regions=${fwdRegions.rows[0].n}`);
const fwdNote = await query(
  `SELECT note FROM public.contact WHERE added_by=1410835977 ORDER BY id DESC LIMIT 1`);
ok('client note discloses FORWARD + delivery date',
  /^AI Advisor: FORWARD \(delivery 01\/03\/2027\) SELL order placed/.test(fwdNote.rows[0]?.note ?? ''),
  (fwdNote.rows[0]?.note ?? '').slice(0, 80));

// Mismatched delivery date must NOT clear against A's resting forward sell.
const fwdBuyOther = await preparePendingOrder(ctxB,
  { side: 'BUY', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 8123, deliveryDate: FWD_DATE_OTHER });
const fwdBuyOtherDone = await confirmPendingOrder(ctxB, fwdBuyOther.id, true);
ok('forward buy with a DIFFERENT delivery date rests (no cross-date match)',
  fwdBuyOtherDone.status === 'placed' && (fwdBuyOtherDone.cleared_trades ?? 0) === 0,
  `cleared=${fwdBuyOtherDone.cleared_trades}`);

// ENGINE SEMANTICS (verified in TradeAlertBo.canTradeOnForwardDeliveryDates): forward listings
// NEVER auto-clear at placement — forward-vs-forward pairs are excluded outright and
// forward-vs-spot fails the policy date check, so the same-day branch is unreachable. Forwards
// rest on the book; counterparties are alerted and accept manually (Order Now / broker flow).
const fwdBuyMatch = await preparePendingOrder(ctxB,
  { side: 'BUY', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 8123, deliveryDate: FWD_DATE });
const fwdBuyMatchDone = await confirmPendingOrder(ctxB, fwdBuyMatch.id, true);
ok('forward buy with the SAME delivery date also RESTS (forwards never auto-clear; engine semantics)',
  fwdBuyMatchDone.status === 'placed' && (fwdBuyMatchDone.cleared_trades ?? 0) === 0,
  `cleared=${fwdBuyMatchDone.cleared_trades}`);
const fwdSellStill = await query(
  `SELECT date_completed, deleted FROM public.order_listing WHERE id=$1`, [fwdSellDone.crm_order_id]);
ok('the resting forward sell is still open after the same-date buy',
  fwdSellStill.rows[0]?.date_completed == null && fwdSellStill.rows[0]?.deleted !== true);

// Withdraw every forward listing this section placed (all rest by design).
for (const [who, po] of [[ctxB, fwdBuyOtherDone], [ctxB, fwdBuyMatchDone], [ctxA, fwdSellDone]] as const) {
  if (po.crm_order_id) {
    const wdF = await prepareWithdrawal(who, po.crm_order_id);
    await confirmPendingOrder(who, wdF.id, false);
  }
}
const fwdLeft = await query(
  `SELECT count(*)::int AS n FROM public.order_listing
    WHERE id = ANY($1) AND (deleted IS NULL OR deleted = false)`,
  [[fwdBuyOtherDone.crm_order_id, fwdBuyMatchDone.crm_order_id, fwdSellDone.crm_order_id].filter(Boolean)]);
ok('forward listings withdrawable via the existing withdrawal path (all cleaned up)', fwdLeft.rows[0].n === 0);

// ---- 8. split parcels (slice C) -------------------------------------------------------
console.log('\n-- split parcels (slice C) --');
await expectScope('split without min_split_quantity is refused',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 3, pricePerMl: 100, split: true }),
  'positive min_split_quantity');
await expectScope('min split above the order volume is refused',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 3, pricePerMl: 100, split: true, minSplitQuantity: 5 }),
  'cannot exceed');
await expectScope('split params without allow_split are refused',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 3, pricePerMl: 100, minSplitQuantity: 1 }),
  'only apply');
await expectScope('max parcel below min split is refused',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 3, pricePerMl: 100, split: true, minSplitQuantity: 2, maxSplitParcelSize: 1 }),
  'at least min_split_quantity');

// (a) partial fill leaves a VALID remainder that keeps resting.
const splitSell = await preparePendingOrder(ctxA,
  { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 3, pricePerMl: 8223, split: true, minSplitQuantity: 1 });
ok('split sell prepared with split fields stored',
  splitSell.split === true && Number(splitSell.min_split_quantity) === 1);
ok('card payload carries the partial-fill disclosure',
  typeof splitSell.preview?.split_note === 'string' && /CANCELS the remainder/.test(splitSell.preview.split_note));
const splitSellDone = await confirmPendingOrder(ctxA, splitSell.id, true);
ok('split sell placed through the CRM engine', splitSellDone.status === 'placed', `crm_order=${splitSellDone.crm_order_id} err=${splitSellDone.error ?? ''}`);
const splitListing = await query(
  `SELECT split, min_split_quantity FROM public.order_listing WHERE id=$1`, [splitSellDone.crm_order_id]);
ok('CRM listing is a split parcel (min 1 ML)',
  splitListing.rows[0]?.split === true && Number(splitListing.rows[0]?.min_split_quantity) === 1);
const splitNote = await query(`SELECT note FROM public.contact WHERE added_by=1410835977 ORDER BY id DESC LIMIT 1`);
ok('client note discloses SPLIT + min fill',
  /^AI Advisor: SPLIT \(min 1 ML\) SELL order placed/.test(splitNote.rows[0]?.note ?? ''),
  (splitNote.rows[0]?.note ?? '').slice(0, 70));

const partialBuy = await preparePendingOrder(ctxB,
  { side: 'BUY', regionId: REGION, isPermanent: false, volumeMl: 2, pricePerMl: 8223 });
const partialBuyDone = await confirmPendingOrder(ctxB, partialBuy.id, true);
ok('non-split buy PARTIALLY fills the split sell (2 of 3 ML)',
  partialBuyDone.status === 'placed' && (partialBuyDone.cleared_trades ?? 0) >= 1,
  `cleared=${partialBuyDone.cleared_trades}`);
const remainder = await query(
  `SELECT quantity_avelable, date_completed, deleted FROM public.order_listing WHERE id=$1`, [splitSellDone.crm_order_id]);
ok('valid remainder (1 ML >= min split) keeps resting',
  Number(remainder.rows[0]?.quantity_avelable) === 1 && remainder.rows[0]?.date_completed == null && remainder.rows[0]?.deleted !== true,
  `remaining=${remainder.rows[0]?.quantity_avelable}`);
{ // clean up the remainder
  const wdS = await prepareWithdrawal(ctxA, splitSellDone.crm_order_id!);
  await confirmPendingOrder(ctxA, wdS.id, false);
}

// (b) partial fill leaves a SUB-MIN remainder -> engine auto-cancels it (Part 3 step 10).
const splitSell2 = await preparePendingOrder(ctxA,
  { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 3, pricePerMl: 8224, split: true, minSplitQuantity: 2 });
const splitSell2Done = await confirmPendingOrder(ctxA, splitSell2.id, true);
ok('second split sell placed (3 ML, min 2)', splitSell2Done.status === 'placed');
const partialBuy2 = await preparePendingOrder(ctxB,
  { side: 'BUY', regionId: REGION, isPermanent: false, volumeMl: 2, pricePerMl: 8224 });
const partialBuy2Done = await confirmPendingOrder(ctxB, partialBuy2.id, true);
ok('buy takes 2 of 3 ML', partialBuy2Done.status === 'placed' && (partialBuy2Done.cleared_trades ?? 0) >= 1,
  `cleared=${partialBuy2Done.cleared_trades}`);
const rem2 = await query(
  `SELECT quantity_avelable, date_completed, deleted FROM public.order_listing WHERE id=$1`, [splitSell2Done.crm_order_id]);
ok('sub-min remainder (1 ML < min 2) auto-cancelled by the engine',
  rem2.rows[0]?.deleted === true && rem2.rows[0]?.date_completed != null,
  `remaining=${rem2.rows[0]?.quantity_avelable} deleted=${rem2.rows[0]?.deleted}`);

// ---- 9. approval-aware holdings & sell refusals ---------------------------------------
// Live-testing found: region 2819 (6 VIC MURRAY DARTMOUTH-BARMAH HIGH) — Stuart holds a
// 250 ML entitlement that is NOT approved, and his only approved licence there is 0 ML.
// The holdings view must expose that, and the sell refusal must explain it.
console.log('\n-- approval-aware holdings & refusals --');
const UNAPPROVED_REGION = 2819;
const holdingsA = await callTool(buildToolDefs(ctxA), 'get_my_holdings', {});
const h2819 = holdingsA.rows?.find((h: any) => Number(h.region_id) === UNAPPROVED_REGION);
ok('holdings expose approved vs total volume for the unapproved region',
  h2819 && Number(h2819.total_ml) > 0 && Number(h2819.approved_ml) === 0
    && Number(h2819.largest_approved_licence_ml) === 0,
  h2819 ? `total=${h2819.total_ml} approved=${h2819.approved_ml}` : 'region 2819 missing');
const h311325 = holdingsA.rows?.find((h: any) => Number(h.region_id) === REGION && h.product === 'REG');
ok('holdings show a positive sell cap where licences ARE approved',
  h311325 && Number(h311325.largest_approved_licence_ml) > 0,
  h311325 ? `cap=${h311325.largest_approved_licence_ml}` : 'region missing');
await expectScope('sell against unapproved volume is refused AND the refusal explains approval',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: UNAPPROVED_REGION, isPermanent: false, volumeMl: 50, pricePerMl: 9000 }),
  'awaiting approval');

// Pilot-found bug: approved 0-ML licences were invisible to get_my_holdings (quantity>0 filter),
// so the agent denied buys into regions that CAN legally anchor them (buys are volume-agnostic).
const MURRUMBIDGEE = 2549; // Stuart: approved licence 1567500, 0 ML
const h2549 = holdingsA.rows?.find((h: any) => Number(h.region_id) === MURRUMBIDGEE);
ok('holdings surface the approved 0-ML licence region as a buy anchor',
  h2549 && h2549.buy_anchor_ok === true && Number(h2549.approved_ml) === 0,
  h2549 ? `buy_anchor_ok=${h2549.buy_anchor_ok} total=${h2549.total_ml}` : 'region 2549 missing');
const zeroBuy = await preparePendingOrder(ctxA,
  { side: 'BUY', regionId: MURRUMBIDGEE, isPermanent: false, volumeMl: 2, pricePerMl: 50 });
ok('buy anchored to the approved 0-ML licence prepares fine',
  zeroBuy.status === 'pending' && zeroBuy.property_id != null, `property=${zeroBuy.property_id}`);
await cancelPendingOrder(UID_A, zeroBuy.id);
ok('and can be cancelled without placement', (await getOwnedPendingOrder(zeroBuy.id, UID_A)).status === 'cancelled');
await expectScope('selling from the 0-ML licence still refuses',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: MURRUMBIDGEE, isPermanent: false, volumeMl: 500, pricePerMl: 200 }),
  'exceeds');

// ---- 10. B4: AGGREGATE oversell gate (open sell orders reduce available-to-sell) -------
console.log('\n-- aggregate oversell gate (B4) --');
// Available-to-sell for A's anchor licence = licence volume - SUM(quantity) of his open,
// unexpired temp sell listings on it (the same formula findAnchorLicence now enforces).
async function availableToSellA(): Promise<{ vol: number; committed: number; avail: number; property: number }> {
  const r = await query(
    `SELECT p.id AS property, COALESCE(p.quantity,0) AS vol,
            COALESCE((SELECT sum(ol.quantity) FROM public.order_listing ol
              WHERE ol.property = p.id AND ol.order_type='S' AND ol.sale=false
                AND (ol.deleted IS NULL OR ol.deleted=false) AND ol.date_completed IS NULL
                AND (ol.date_expired IS NULL OR ol.date_expired >= now())),0) AS committed
       FROM public.property p
      WHERE p.registry_user = $1 AND p.region = $2 AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE
        AND p.date_approved IS NOT NULL AND p.permission_spot_temp IS TRUE
      ORDER BY (COALESCE(p.quantity,0) - COALESCE((SELECT sum(ol.quantity) FROM public.order_listing ol
              WHERE ol.property = p.id AND ol.order_type='S' AND ol.sale=false
                AND (ol.deleted IS NULL OR ol.deleted=false) AND ol.date_completed IS NULL
                AND (ol.date_expired IS NULL OR ol.date_expired >= now())),0)) DESC
      LIMIT 1`, [ctxA.account, REGION]);
  const row = r.rows[0];
  return { property: row.property, vol: Number(row.vol), committed: Number(row.committed), avail: Number(row.vol) - Number(row.committed) };
}
const agg0 = await availableToSellA();
ok('baseline: licence has sellable headroom for the test', agg0.avail >= 2,
  `vol=${agg0.vol} committed=${agg0.committed} avail=${agg0.avail}`);

// A resting 1 ML sell must REDUCE what A can further sell by exactly 1 ML.
const aggSell = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9973 });
const aggSellDone = await confirmPendingOrder(ctxA, aggSell.id, true);
ok('resting 1 ML sell placed', aggSellDone.status === 'placed', `crm_order=${aggSellDone.crm_order_id} err=${aggSellDone.error ?? ''}`);
ok('H6: pending row records note_written + broker_notified (never silent)',
  typeof aggSellDone.note_written === 'boolean' && typeof aggSellDone.broker_notified === 'boolean',
  `note_written=${aggSellDone.note_written} broker_notified=${aggSellDone.broker_notified}`);

// H5: the placed listing's region set is EXACTLY the confirmed anchor region.
const aggRegions = await query(
  `SELECT region FROM public.order_region WHERE order_listing=$1 AND (deleted IS NULL OR deleted=false)`,
  [aggSellDone.crm_order_id]);
ok('H5: spot order listed into exactly the one confirmed region',
  aggRegions.rowCount === 1 && Number(aggRegions.rows[0].region) === REGION,
  JSON.stringify(aggRegions.rows));

const agg1 = await availableToSellA();
ok('open sell order counted as committed volume', Math.abs(agg1.avail - (agg0.avail - 1)) < 0.001,
  `avail ${agg0.avail} -> ${agg1.avail}`);
await expectScope('selling more than the REMAINING (not raw) licence volume is refused',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: agg1.avail + 1, pricePerMl: 9973 }),
  'exceeds');
const aggWithin = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: agg1.avail, pricePerMl: 9973 });
ok('selling exactly the remaining volume is allowed', aggWithin.status === 'pending',
  `avail=${agg1.avail} committed=${aggWithin.validation?.licence?.open_sell_committed_ml}`);
ok('validation snapshot exposes committed/available', aggWithin.validation?.licence?.available_to_sell_ml != null);
await cancelPendingOrder(UID_A, aggWithin.id);
{ // withdraw the resting sell: the headroom must come back
  const wdA = await prepareWithdrawal(ctxA, aggSellDone.crm_order_id!);
  await confirmPendingOrder(ctxA, wdA.id, false);
}
const agg2 = await availableToSellA();
ok('withdrawing the open order restores available-to-sell', Math.abs(agg2.avail - agg0.avail) < 0.001,
  `avail back to ${agg2.avail}`);

// ---- 11. B1: unknown outcome -> honest status -> reconciliation ------------------------
console.log('\n-- unknown outcomes & reconciliation (B1) --');
const realFetch = globalThis.fetch;

// (a) timeout -> status 'unknown', never 'failed'
const u1 = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9974 });
const u1twin = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9974 });
globalThis.fetch = (async () => { throw new Error('simulated timeout (AbortSignal)'); }) as any;
const u1done = await confirmPendingOrder(ctxA, u1.id, true);
globalThis.fetch = realFetch;
ok('seam timeout parks the order as UNKNOWN (not failed)', u1done.status === 'unknown',
  `status=${u1done.status}`);
ok('unknown status carries an honest user-facing message', /UNCONFIRMED/.test(u1done.error ?? ''),
  (u1done.error ?? '').slice(0, 80));

// while unresolved: same-parameters prepare AND confirm are blocked
await expectScope('preparing a same-parameters twin while UNCONFIRMED is refused',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9974 }),
  'UNCONFIRMED');
await expectScope('confirming a same-parameters twin while UNCONFIRMED is refused',
  () => confirmPendingOrder(ctxA, u1twin.id, true), 'UNCONFIRMED');
const uOther = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9975 });
ok('a DIFFERENT-parameters order is not blocked', uOther.status === 'pending');
await cancelPendingOrder(UID_A, uOther.id);

// within the grace window reconciliation refuses to guess
let resolved = await reconcileUnknownOrders(UID_A);
ok('within the grace window the order stays unknown (no premature verdict)',
  resolved.every((r) => r.id !== u1.id) && (await getOwnedPendingOrder(u1.id, UID_A)).status === 'unknown');

// after the grace window with no matching CRM order -> definitively failed
await query(`UPDATE pending_order SET decided_at = now() - interval '20 minutes' WHERE id=$1`, [u1.id]);
resolved = await reconcileUnknownOrders(UID_A);
const u1final = await getOwnedPendingOrder(u1.id, UID_A);
ok('reconciliation resolves it FAILED once nothing can still be in flight',
  resolved.some((r) => r.id === u1.id) && u1final.status === 'failed' && /safe to place/.test(u1final.error ?? ''),
  (u1final.error ?? '').slice(0, 80));
const uAfter = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9974 });
ok('after resolution the same parameters are allowed again', uAfter.status === 'pending');
await cancelPendingOrder(UID_A, uAfter.id);
await cancelPendingOrder(UID_A, u1twin.id);

// (b) the DANGEROUS case: the CRM placed the order but the response was lost -> the old code
// called it failed (duplicate risk); now: unknown -> reconciled to PLACED with the real id.
const u2 = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9976 });
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  const res = await realFetch(...args);
  await res.text();                       // the JSP completed; the order IS live
  throw new Error('simulated response loss after completion');
}) as any;
const u2done = await confirmPendingOrder(ctxA, u2.id, true);
globalThis.fetch = realFetch;
ok('lost response after real placement -> UNKNOWN, not failed', u2done.status === 'unknown');
resolved = await reconcileUnknownOrders(UID_A);
const u2final = await getOwnedPendingOrder(u2.id, UID_A);
ok('reconciliation finds the LIVE order and resolves PLACED with its id',
  u2final.status === 'placed' && !!u2final.crm_order_id && u2final.reconciled_at != null,
  `crm_order=${u2final.crm_order_id}`);
const u2listing = await query(
  `SELECT owner, order_type, price_per_ml FROM public.order_listing WHERE id=$1`, [u2final.crm_order_id]);
ok('...and the claimed listing is the real one (A, sell, $9976)',
  u2listing.rows[0]?.owner === UID_A && u2listing.rows[0]?.order_type === 'S' && Number(u2listing.rows[0]?.price_per_ml) === 9976);
{ // cleanup
  const wdU = await prepareWithdrawal(ctxA, u2final.crm_order_id!);
  await confirmPendingOrder(ctxA, wdU.id, false);
}

// (c) classification: non-JSON -> unknown; well-formed JSP "failed" -> definitive failed
const u3 = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9977 });
globalThis.fetch = (async () => new Response('<html>proxy error</html>', { status: 502 })) as any;
const u3done = await confirmPendingOrder(ctxA, u3.id, true);
globalThis.fetch = realFetch;
ok('non-JSON seam response -> UNKNOWN (the JSP may have run)', u3done.status === 'unknown');
await query(`UPDATE pending_order SET decided_at = now() - interval '20 minutes' WHERE id=$1`, [u3.id]);
await reconcileUnknownOrders(UID_A);
ok('...and reconciles to failed (nothing was placed)', (await getOwnedPendingOrder(u3.id, UID_A)).status === 'failed');

const u4 = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9978 });
globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'failed', message: 'SCOPE: engine said no' }), { status: 200 })) as any;
const u4done = await confirmPendingOrder(ctxA, u4.id, true);
globalThis.fetch = realFetch;
ok('well-formed JSP "failed" stays a DEFINITIVE failure (safe to retry)',
  u4done.status === 'failed' && /engine said no/.test(u4done.error ?? ''));

// ---- 12. H16: order events vs in-flight turns (session-epoch primitives) ---------------
console.log('\n-- session epoch (H16) --');
const CONV = 987654321; // synthetic conversation id: the map is in-process state
const e0 = sessionEpoch(CONV);
// pumpTurn captures the epoch at turn start...
const capturedAtTurnStart = sessionEpoch(CONV);
// ...an order event lands mid-turn (recordOrderEvent bumps before nulling the session)...
bumpSessionEpoch(CONV);
ok('order event bumps the conversation epoch', sessionEpoch(CONV) === e0 + 1);
// ...so the done handler must SKIP its session write (else it would resurrect a context
// that never saw the "[order event]" note).
ok('a turn started before the event must not write its stale session id',
  sessionEpoch(CONV) !== capturedAtTurnStart);
// and a turn that saw no event writes normally
const e1 = sessionEpoch(CONV);
ok('a turn with no mid-flight event writes its session normally', sessionEpoch(CONV) === e1);

// ---- 13. escalation tool: prepare-only, and H4 honesty at confirm time ------------------
// The tool now only STAGES a pending escalation (confirm-before-send). The H4 guarantee moved to
// confirm time: an account-less login (no linked registry account) means insertBrokerAction
// returns null, so confirmEscalation reports crmBrokerActionId=null and the endpoint must not
// claim a task was raised. The durable sidecar escalation row is written at prepare.
console.log('\n-- escalation tool (prepare-only) + confirm with no raisable CRM task (H4) --');
const ctxNoAccount: CallerCtx = { ...ctxA, account: null };
async function callBrokerTool(defs: any[], name: string, args: any) {
  const d = defs.find((t: any) => t.name === name);
  if (!d) throw new Error('no such tool: ' + name);
  return parseTool(await d.handler(args, {}));
}
const noAcctTools = buildBrokerToolDefs(ctxNoAccount, null);
const escReply = await callBrokerTool(noAcctTools, 'escalate_to_broker',
  { reason: 'client requested a human', summary: 'account-less login: no CRM task can be raised' });
ok('escalate_to_broker only STAGES: pending confirmation, nothing sent',
  escReply.status === 'PENDING_CONFIRMATION' && escReply.escalation_id > 0
    && /AWAITING_USER_CONFIRMATION/.test(escReply.note ?? ''),
  `status=${escReply.status} id=${escReply.escalation_id}`);
const escRow = await query(
  `SELECT id, status, crm_broker_action_id FROM ai_advisor.escalation
     WHERE user_id = $1 AND account_id IS NULL ORDER BY id DESC LIMIT 1`, [UID_A]);
ok('the durable escalation row is written as pending (no CRM task id)',
  escRow.rowCount === 1 && escRow.rows[0].status === 'pending' && escRow.rows[0].crm_broker_action_id == null,
  `rows=${escRow.rowCount}`);
const escConf = await confirmEscalation(ctxNoAccount, Number(escReply.escalation_id));
ok('H4: account-less confirm reports NO CRM task raised (caller must not claim a follow-up)',
  escConf.escalation.status === 'confirmed' && escConf.crmBrokerActionId == null);
const escCancel = await callBrokerTool(noAcctTools, 'cancel_escalation',
  { escalation_id: Number(escReply.escalation_id) });
ok('cancel_escalation de-escalates a confirmed escalation (no task to close here)',
  escCancel.status === 'CANCELLED' && escCancel.crm_task_closed === false
    && /nothing to close/i.test(escCancel.note ?? ''),
  `status=${escCancel.status}`);

// ---- 14. broker-assist: a staff member stages and confirms FOR the client ------------------
// ctx stays the client (same scope/validation/placement); `onBehalf` is attribution only — on the
// pending row, in the seam's note (placedBy) and on the broker follow-up task.
console.log('\n-- broker-assist (on behalf): attribution, same scope --');
const STAFF = { staffUid: 10, staffName: '  Test <Broker>  ' };
const staffTools = buildBrokerToolDefs(ctxA, null, { onBehalf: STAFF });
const obPrep = await callBrokerTool(staffTools, 'prepare_sell_order',
  { region_id: REGION, product: 'allocation', volume_ml: 1, price_per_ml: 9977 });
ok('staff-staged prepare -> PENDING_CONFIRMATION (same tool, same scope)', obPrep.status === 'PENDING_CONFIRMATION');
const obRow = await getOwnedPendingOrder(Number(obPrep.order.pending_order_id), UID_A);
ok('pending row is still the CLIENT\'s (user_id = client)', obRow.user_id === UID_A);
ok('...and records the staff member (uid + sanitised name)',
  obRow.staff_user_id === 10 && obRow.staff_name === 'Test Broker',
  `${obRow.staff_user_id} / ${JSON.stringify(obRow.staff_name)}`);
await expectScope('staff-staged sell is scoped exactly like the client\'s (over-volume refused)',
  () => preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 100000, pricePerMl: 100, onBehalf: STAFF }),
  'exceeds');
// Confirm through a mocked seam so nothing real is placed; capture what the seam was told.
let seamBody: any = null;
globalThis.fetch = (async (_u: any, init: any) => {
  seamBody = JSON.parse(init.body);
  return new Response(JSON.stringify({ status: 'success', orderListingId: 424242, cleared: 0, noteWritten: true }), { status: 200 });
}) as any;
const obDone = await confirmPendingOrder(ctxA, obRow.id, true, { staffUid: 1666, staffName: 'Levi Stephen' });
globalThis.fetch = realFetch;
ok('staff confirm -> placed', obDone.status === 'placed' && obDone.crm_order_id === 424242);
ok('the CONFIRMING staff member wins the attribution (the accountable click)',
  obDone.staff_user_id === 1666 && obDone.staff_name === 'Levi Stephen', `${obDone.staff_user_id} / ${obDone.staff_name}`);
ok('seam is told who placed it (for the CRM trade-file note)',
  seamBody?.op === 'place' && seamBody.clientId === UID_A && /Levi Stephen \(Waterfind staff\) for the client/.test(seamBody.placedBy ?? ''),
  seamBody?.placedBy);
const obTask = await query(
  `SELECT description FROM public.broker_action WHERE client_registry_user = $1 ORDER BY id DESC LIMIT 1`, [ctxA.account]);
ok('broker follow-up task names the staff member, not "the client"',
  /Placed by Levi Stephen \(Waterfind staff\) for the client via the AI Advisor/.test(obTask.rows[0]?.description ?? ''),
  String(obTask.rows[0]?.description ?? '').slice(0, 120));
// The client's own confirm path is untouched: no actor -> "the client", no placedBy.
const selfPrep = await preparePendingOrder(ctxA, { side: 'SELL', regionId: REGION, isPermanent: false, volumeMl: 1, pricePerMl: 9976 });
ok('client-staged row has no staff attribution', selfPrep.staff_user_id == null && selfPrep.staff_name == null);
seamBody = null;
globalThis.fetch = (async (_u: any, init: any) => {
  seamBody = JSON.parse(init.body);
  return new Response(JSON.stringify({ status: 'success', orderListingId: 424243, cleared: 0, noteWritten: true }), { status: 200 });
}) as any;
const selfDone = await confirmPendingOrder(ctxA, selfPrep.id, true);
globalThis.fetch = realFetch;
ok('client confirm sends no placedBy and stays unattributed',
  selfDone.status === 'placed' && seamBody?.placedBy === undefined && selfDone.staff_user_id == null);
const selfTask = await query(
  `SELECT description FROM public.broker_action WHERE client_registry_user = $1 ORDER BY id DESC LIMIT 1`, [ctxA.account]);
ok('client task text still says "by the client"', /Placed by the client via the AI Advisor/.test(selfTask.rows[0]?.description ?? ''));
// Withdrawal staged by staff carries the actor too (executed against the seam in itest-broker).
const wTools = buildBrokerToolDefs(ctxA, null, { onBehalf: STAFF });
const myOpen = await listOwnOpenOrders(ctxA);
if (myOpen.length) {
  const wPrep = await callBrokerTool(wTools, 'prepare_order_withdrawal', { order_listing_id: myOpen[0].order_listing_id });
  const wRow = wPrep.status === 'PENDING_CONFIRMATION' ? await getOwnedPendingOrder(Number(wPrep.order.pending_order_id), UID_A) : null;
  ok('staff-staged withdrawal records the staff member', !!wRow && wRow.staff_user_id === 10, wPrep.status);
  if (wRow) await cancelPendingOrder(UID_A, wRow.id);
} else {
  console.log('  note: no open order for A right now; staff-staged withdrawal covered by itest-broker');
}

console.log(`\nbroker tests: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
