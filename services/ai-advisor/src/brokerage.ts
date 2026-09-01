import crypto from 'node:crypto';
import { query } from './db';
import { runScoped, type CallerCtx } from './data-db';
import { NotFound, addMessage, setSessionId } from './conversations';
import { config } from './config';

// Brokerage layer. Split of responsibilities:
//   - The AI's prepare_* tools call preparePendingOrder(): validate the request against the
//     caller's OWN resources (RLS-scoped reads mirroring the CRM's licence/tradability rules)
//     and store a 'pending' row. The model can never execute anything.
//   - The chat UI's Confirm button calls confirmPendingOrder() with the USER's bearer token:
//     re-validate, then execute through the CRM's real trade engine via the HMAC-signed JSP
//     seam (/ai-broker-exec.html), which independently re-checks scope against the CRM's own
//     licence enumeration before calling WaterfindDelegate.addNewOrderListing.
//   - Broker-assist (Client Rail): the same two steps, run by verified STAFF for the client. ctx is
//     still the CLIENT (scope/validation/placement identical); the staff member is carried as
//     `onBehalf` and recorded on the row, the CRM note and the broker task (attribution only).
// Every pending-order access goes through the (id, user_id) ownership chokepoint.

export type Side = 'BUY' | 'SELL' | 'WITHDRAW';

export interface PendingOrder {
  id: number;
  user_id: number;
  account_id: number;
  conversation_id: number | null;
  side: Side;
  is_permanent: boolean;
  region_id: number | null;
  region_name: string | null;
  property_id: number | null;
  volume_ml: string | null;
  price_per_ml: string | null;
  expiry: string | null;
  delivery_date: string | null;
  split: boolean;
  min_split_quantity: string | null;
  max_split_parcel_size: string | null;
  target_order_id: number | null;
  status: string;
  validation: any;
  preview: any;
  crm_order_id: number | null;
  cleared_trades: number | null;
  error: string | null;
  note_written: boolean | null;     // seam wrote the CRM trade-file contact note (H6; null = unverified)
  broker_notified: boolean | null;  // broker_action follow-up raised (H6; null = unverified)
  reconciled_at: string | null;     // when an 'unknown' outcome was resolved from the order book
  tc_accepted_at: string | null;
  staff_user_id: number | null;     // broker-assist: staff who prepared/confirmed for the client (null = the client themselves)
  staff_name: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

/**
 * Broker-assist (Client Rail): the verified STAFF member acting for the client. Recorded on the
 * pending row, in the CRM trade-file note and on the broker follow-up task, so every order that
 * did not come from the client's own click is attributed to the person who did click. The order
 * itself is still scoped, validated and placed exactly as the client's own would be (ctx = client).
 */
export interface OnBehalf { staffUid: number; staffName: string; }

export class ScopeViolation extends Error {
  constructor(msg: string) { super(msg); this.name = 'ScopeViolation'; }
}

// ---- scope validation (mirrors the CRM's own gates) --------------------------------

/**
 * Mirror of WaterfindErrors.checkLoginTradabilityInternal: banned / interim / not
 * buyer-approved users cannot trade. (Terms-of-use acceptance is handled by the explicit
 * T&C tick on the confirm card, mirroring the order wizard's acceptTerms gate.)
 */
export async function checkUserTradable(ctx: CallerCtx): Promise<void> {
  const rows = await runScoped(ctx,
    `SELECT COALESCE(banned,false) AS banned, COALESCE(interim,false) AS interim,
            COALESCE(buyer_approved,false) AS buyer_approved
       FROM waterfind_user WHERE id = $1`, [ctx.uid]);
  const u = rows[0];
  if (!u) throw new ScopeViolation('Your user record could not be resolved.');
  if (u.banned) throw new ScopeViolation('This account is not permitted to trade (banned).');
  if (u.interim) throw new ScopeViolation('This account is interim and not yet permitted to trade.');
  if (!u.buyer_approved) throw new ScopeViolation('This account is not yet approved for trading.');
}

/**
 * Find the caller's licence (property) anchoring an order in a region, mirroring the CRM's
 * getLicenceListForClient gates: owned by the caller's account, not deleted/sold, APPROVED
 * (date_approved), and carrying the spot permission flag for the product. For SELL the
 * licence must cover the requested ML AFTER subtracting the client's already-open sell
 * orders on it (aggregate oversell gate, B4) — the wizard's per-order volume cap alone lets
 * two 100 ML sells pass against one 100 ML licence.
 *
 * Committed-volume semantics (B4): committed = SUM(ol.quantity) — what was LISTED — over the
 * client's open sell listings on the licence for the same product (ol.sale = isPermanent),
 * excluding withdrawn (deleted), completed (date_completed) and expired (date_expired past)
 * listings. We count ol.quantity, NOT quantity_avelable: a partially-filled open listing's
 * cleared portion is water already sold, and the CRM does NOT decrement property.quantity at
 * clearing (doc 08 Part 3 — only order_listing.quantity_avelable shrinks; licence volumes are
 * reconciled administratively). Counting the full listed quantity therefore covers both the
 * resting remainder and the already-cleared portion of every open listing, which is the
 * conservative choice that cannot oversell.
 * Runs under RLS: the property table can only ever return the caller's own rows.
 */
export async function findAnchorLicence(
  ctx: CallerCtx,
  regionId: number,
  isPermanent: boolean,
  side: 'BUY' | 'SELL',
  volumeMl: number,
): Promise<{ property_id: number; region_id: number; region_name: string; volume: number; product: string; committed_open_sell_ml: number }> {
  const permFlag = isPermanent ? 'p.permission_spot_perm' : 'p.permission_spot_temp';
  const rows = await runScoped(ctx,
    `SELECT p.id AS property_id, p.region AS region_id, r.name AS region_name,
            COALESCE(p.quantity,0) AS volume, p.sub_type AS product,
            COALESCE(c.committed,0) AS committed_open_sell_ml
       FROM property p JOIN region r ON r.id = p.region
       LEFT JOIN LATERAL (
         SELECT sum(ol.quantity) AS committed
           FROM public.order_listing ol
          WHERE ol.property = p.id AND ol.order_type = 'S' AND ol.sale = $3
            AND (ol.deleted IS NULL OR ol.deleted = false)
            AND ol.date_completed IS NULL
            AND (ol.date_expired IS NULL OR ol.date_expired >= now())
       ) c ON true
      WHERE p.registry_user = $1 AND p.region = $2
        AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE
        AND p.date_approved IS NOT NULL
        AND ${permFlag} IS TRUE
      ORDER BY (COALESCE(p.quantity,0) - COALESCE(c.committed,0)) DESC, p.quantity DESC NULLS LAST`,
    [ctx.account, regionId, isPermanent]);
  if (!rows.length) {
    // Distinguish "no rights at all" from "not approved/permitted" for a useful message.
    const any = await runScoped(ctx,
      `SELECT count(*)::int AS n FROM property p
        WHERE p.registry_user = $1 AND p.region = $2 AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE`,
      [ctx.account, regionId]);
    if ((any[0]?.n ?? 0) === 0) {
      throw new ScopeViolation(
        `You hold no water rights in region ${regionId} — orders can only be anchored to a licence you own. ` +
        `Use get_my_holdings to see your tradable regions.`);
    }
    throw new ScopeViolation(
      `Your licence(s) in region ${regionId} are not approved (or lack the ` +
      `${isPermanent ? 'permanent' : 'temporary'} spot-trading permission), so this order cannot be placed.`);
  }
  if (side === 'SELL') {
    // B4: available-to-sell = approved licence volume minus what is already committed to the
    // client's OPEN sell orders on that licence (see the committed-volume semantics above).
    const availOf = (r: any) => Number(r.volume) - Number(r.committed_open_sell_ml);
    const best = rows.find((r: any) => availOf(r) >= volumeMl);
    if (!best) {
      const byVolume = [...rows].sort((a: any, b: any) => Number(b.volume) - Number(a.volume))[0];
      const maxVol = Number(byVolume.volume);
      if (maxVol >= volumeMl) {
        // The licence itself is big enough — open sell orders are what block it. Say so.
        const committed = Number(byVolume.committed_open_sell_ml);
        const avail = Math.max(0, maxVol - committed);
        throw new ScopeViolation(
          `Sell volume ${volumeMl} ML exceeds what is left to sell on your licence in ${byVolume.region_name}: ` +
          `it holds ${maxVol} ML but ${committed} ML is already committed to your open sell orders, ` +
          `leaving ${avail} ML available. Placing this would OVERSELL the licence — withdraw an open ` +
          `sell order first (see get_my_open_orders) or reduce the volume.`);
      }
      const max = maxVol;
      // If unapproved volume would have covered it, say so — "you hold 250 ML" vs "0 ML sellable"
      // is exactly the confusion a holdings view without approval status creates.
      const unapproved = await runScoped(ctx,
        `SELECT round(coalesce(max(p.quantity),0)::numeric,1) AS max_ml
           FROM property p
          WHERE p.registry_user = $1 AND p.region = $2
            AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE AND p.date_approved IS NULL`,
        [ctx.account, regionId]);
      const unappMax = Number(unapproved[0]?.max_ml ?? 0);
      throw new ScopeViolation(
        `Sell volume ${volumeMl} ML exceeds your largest APPROVED holding in ${rows[0].region_name} ` +
        `(${max} ML). You cannot sell more than you hold on a single approved licence.` +
        (unappMax >= volumeMl
          ? ` You do hold a ${unappMax} ML licence there that is still awaiting approval — it cannot be ` +
            `traded until Waterfind approves it; ask your broker about its approval status.`
          : ''));
    }
    return best;
  }
  return rows[0];
}

/** Price context for the confirmation card (recent settled band in the region+product). */
export async function priceContext(ctx: CallerCtx, regionId: number, isPermanent: boolean) {
  const rows = await runScoped(ctx,
    `SELECT count(*)::int AS trades, round(min(oc.buying_price_per_ml)::numeric,0) AS min_pml,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY oc.buying_price_per_ml)::numeric,0) AS median_pml,
            round(max(oc.buying_price_per_ml)::numeric,0) AS max_pml
       FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
      WHERE oc.date_deleted IS NULL AND wo.sellingregion = $1 AND wo.sale = $2
        AND oc.date_accepted >= now() - interval '12 months'`,
    [regionId, isPermanent]);
  return rows[0] ?? null;
}

/**
 * The caller's own live CRM order listings (owner-scoped, mirrors "my active orders").
 * Also used as the ownership gate for withdrawals — the CRM's delete path is not
 * ownership-checked, so the sidecar enforces the CRM's edit-gate rule (creator/owner only).
 */
export async function listOwnOpenOrders(ctx: CallerCtx) {
  return runScoped(ctx,
    `SELECT ol.id AS order_listing_id, ol.order_type AS side, ol.sale AS is_permanent,
            round(ol.quantity_avelable::numeric,1) AS ml_available, ol.price_per_ml,
            ol.season, ol.date_placed::date AS placed, ol.date_expired::date AS expires,
            r.name AS home_region, p.region AS region_id
       FROM order_listing ol
       LEFT JOIN property p ON p.id = ol.property
       LEFT JOIN region r ON r.id = p.region
      WHERE (ol.owner = $1 OR ol.logged_in_creator = $1)
        AND (ol.deleted IS NULL OR ol.deleted = false) AND ol.date_completed IS NULL
      ORDER BY ol.date_placed DESC LIMIT 50`,
    [ctx.uid]);
}

async function assertOwnListing(ctx: CallerCtx, orderListingId: number) {
  const rows = await runScoped(ctx,
    `SELECT ol.id, ol.order_type AS side, ol.sale AS is_permanent, ol.price_per_ml,
            round(ol.quantity_avelable::numeric,1) AS ml_available, r.name AS region_name, p.region AS region_id
       FROM order_listing ol
       LEFT JOIN property p ON p.id = ol.property
       LEFT JOIN region r ON r.id = p.region
      WHERE ol.id = $1 AND (ol.owner = $2 OR ol.logged_in_creator = $2)
        AND (ol.deleted IS NULL OR ol.deleted = false) AND ol.date_completed IS NULL`,
    [orderListingId, ctx.uid]);
  if (!rows.length) {
    throw new ScopeViolation(
      `Order listing ${orderListingId} is not an open order of yours — only your own open orders can be withdrawn.`);
  }
  return rows[0];
}

// ---- pending-order store ------------------------------------------------------------

/** Lazily expire overdue pending rows for this user (no background sweeper needed). */
async function expireOverdue(userId: number): Promise<void> {
  await query(
    `UPDATE pending_order SET status='expired', decided_at=now()
      WHERE user_id=$1 AND status='pending' AND expires_at < now()`, [userId]);
}

export async function getOwnedPendingOrder(id: number, userId: number): Promise<PendingOrder> {
  const r = await query<PendingOrder>(
    `SELECT * FROM pending_order WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (r.rowCount === 0) throw new NotFound('order not found');
  return r.rows[0];
}

export async function listOrders(userId: number, conversationId?: number, statuses?: string[]): Promise<PendingOrder[]> {
  await expireOverdue(userId);
  const cond: string[] = ['user_id = $1'];
  const params: any[] = [userId];
  if (conversationId) { params.push(conversationId); cond.push(`conversation_id = $${params.length}`); }
  if (statuses?.length) { params.push(statuses); cond.push(`status = ANY($${params.length})`); }
  const r = await query<PendingOrder>(
    `SELECT * FROM pending_order WHERE ${cond.join(' AND ')} ORDER BY created_at DESC LIMIT 50`, params);
  return r.rows;
}

export interface PrepareArgs {
  side: 'BUY' | 'SELL';
  regionId: number;
  isPermanent: boolean;
  volumeMl: number;
  pricePerMl: number;
  expiry?: string | null;        // dd/MM/yyyy
  deliveryDate?: string | null;  // dd/MM/yyyy; non-null = FORWARD order
  split?: boolean;               // allow the parcel to trade in partial fills
  minSplitQuantity?: number | null;    // ML; required when split (smallest acceptable fill)
  maxSplitParcelSize?: number | null;  // ML; optional cap per fill (omit/0 = no cap)
  conversationId?: number | null;
  onBehalf?: OnBehalf | null;    // broker-assist: the staff member staging this for the client
}

function validateSplit(args: PrepareArgs): void {
  if (!args.split) {
    if (args.minSplitQuantity != null || args.maxSplitParcelSize != null) {
      throw new ScopeViolation('min_split_quantity/max_split_parcel_size only apply when allow_split is true.');
    }
    return;
  }
  const min = args.minSplitQuantity;
  if (min == null || !(min > 0)) {
    throw new ScopeViolation('allow_split requires a positive min_split_quantity (the smallest fill you will accept).');
  }
  if (min > args.volumeMl) {
    throw new ScopeViolation('min_split_quantity cannot exceed the order volume.');
  }
  const max = args.maxSplitParcelSize;
  if (max != null && max !== 0 && max < min) {
    throw new ScopeViolation('max_split_parcel_size must be 0 (no cap) or at least min_split_quantity.');
  }
}

// Forward horizon: the CRM engine accepts any future delivery date (past dates it silently clamps
// to today); we refuse past dates outright and cap the horizon so the AI cannot stage a far-future
// forward nobody can settle sensibly.
const FORWARD_HORIZON_MONTHS = 24;

/** Strict dd/MM/yyyy -> Date (local midnight), or null if malformed/impossible. */
function parseDdMmYyyy(s: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return d.getFullYear() === Number(yyyy) && d.getMonth() === Number(mm) - 1 && d.getDate() === Number(dd)
    ? d : null;
}

function validateDeliveryDate(deliveryDate: string): void {
  const d = parseDdMmYyyy(deliveryDate);
  if (!d) throw new ScopeViolation('delivery_date must be a real date in dd/MM/yyyy format.');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (d.getTime() <= today.getTime()) {
    throw new ScopeViolation('delivery_date must be in the future — forward orders need a future delivery date.');
  }
  const horizon = new Date(today); horizon.setMonth(horizon.getMonth() + FORWARD_HORIZON_MONTHS);
  if (d.getTime() > horizon.getTime()) {
    throw new ScopeViolation(
      `delivery_date is too far out — forward orders are limited to ${FORWARD_HORIZON_MONTHS} months ahead.`);
  }
}

/** Validate scope and store a pending BUY/SELL awaiting the user's explicit confirmation. */
export async function preparePendingOrder(ctx: CallerCtx, args: PrepareArgs): Promise<PendingOrder> {
  if (ctx.account == null) throw new ScopeViolation('No registry account is linked to this login.');
  if (!(args.volumeMl > 0) || !(args.pricePerMl > 0)) {
    throw new ScopeViolation('Volume and price must both be positive.');
  }
  if (args.expiry && !/^\d{2}\/\d{2}\/\d{4}$/.test(args.expiry)) {
    throw new ScopeViolation('expiry must be dd/MM/yyyy.');
  }
  if (args.deliveryDate) validateDeliveryDate(args.deliveryDate);
  validateSplit(args);
  await checkUserTradable(ctx);
  await reconcileUnknownOrders(ctx.uid);  // resolve any stuck placements before judging duplicates
  const anchor = await findAnchorLicence(ctx, args.regionId, args.isPermanent, args.side, args.volumeMl);
  // B1: while an identical placement is UNCONFIRMED, refuse to stage a same-parameters twin.
  await assertNoUnresolvedTwin(ctx.uid, null, {
    side: args.side, isPermanent: args.isPermanent, regionId: anchor.region_id,
    volumeMl: args.volumeMl, pricePerMl: args.pricePerMl,
  });
  const band = await priceContext(ctx, anchor.region_id, args.isPermanent);

  const validation = {
    checked_at: new Date().toISOString(),
    user_tradable: true,
    licence: {
      property_id: anchor.property_id, region_id: anchor.region_id, region_name: anchor.region_name,
      approved: true, spot_permission: true, licence_volume_ml: Number(anchor.volume), product: anchor.product,
      ...(args.side === 'SELL' ? {
        open_sell_committed_ml: Number(anchor.committed_open_sell_ml),
        available_to_sell_ml: Number(anchor.volume) - Number(anchor.committed_open_sell_ml),
      } : {}),
    },
    volume_within_licence: args.side === 'BUY' ? null : true,
  };
  const forwardTempSell = !!args.deliveryDate && args.side === 'SELL' && !args.isPermanent;
  const preview = {
    gross_value: Math.round(args.volumeMl * args.pricePerMl * 100) / 100,
    recent_12m_price_band: band,
    note: 'Fees/regions are finalised by the CRM engine at placement; net proceeds exclude government fees.',
    ...(args.deliveryDate ? {
      forward_note: 'FORWARD order — water delivers on ' + args.deliveryDate +
        '. Forward orders REST on the market until a counterparty accepts them (they never clear ' +
        'automatically at placement), and settlement follows the forward deposit/payment schedule, ' +
        'not spot settlement.' +
        (forwardTempSell
          ? ' NOTE: a forward SELL of allocation is listed across ALL tradable regions for that delivery date, not just ' +
            (anchor.region_name ?? 'the anchor region') + '.'
          : ''),
    } : {}),
    ...(args.split ? {
      split_note: 'SPLIT parcel — this order can trade in PARTIAL fills of at least ' +
        args.minSplitQuantity + ' ML' +
        (args.maxSplitParcelSize ? ' (max ' + args.maxSplitParcelSize + ' ML per fill)' : '') +
        '. It may settle as several separate trades, and if a partial fill leaves less than ' +
        args.minSplitQuantity + ' ML remaining, the engine CANCELS the remainder automatically ' +
        '(with an email notification). Non-split counterparties are matched ahead of split ones.',
    } : {}),
  };

  const r = await query<PendingOrder>(
    `INSERT INTO pending_order
       (user_id, account_id, conversation_id, side, is_permanent, region_id, region_name,
        property_id, volume_ml, price_per_ml, expiry, delivery_date,
        split, min_split_quantity, max_split_parcel_size, validation, preview, expires_at,
        staff_user_id, staff_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now() + ($18 || ' minutes')::interval,
             $19, $20)
     RETURNING *`,
    [ctx.uid, ctx.account, args.conversationId ?? null, args.side, args.isPermanent,
     anchor.region_id, anchor.region_name, anchor.property_id, args.volumeMl, args.pricePerMl,
     args.expiry ?? null, args.deliveryDate ?? null,
     !!args.split, args.split ? args.minSplitQuantity : null,
     args.split ? (args.maxSplitParcelSize ?? null) : null,
     JSON.stringify(validation), JSON.stringify(preview),
     String(config.pendingOrderTtlMin),
     args.onBehalf?.staffUid ?? null, args.onBehalf ? staffLabel(args.onBehalf) : null]);
  return r.rows[0];
}

/** Validate ownership and store a pending WITHDRAW awaiting confirmation. */
export async function prepareWithdrawal(
  ctx: CallerCtx, orderListingId: number, conversationId?: number | null, onBehalf?: OnBehalf | null,
): Promise<PendingOrder> {
  const listing = await assertOwnListing(ctx, orderListingId);
  const r = await query<PendingOrder>(
    `INSERT INTO pending_order
       (user_id, account_id, conversation_id, side, is_permanent, region_id, region_name,
        volume_ml, price_per_ml, target_order_id, validation, expires_at, staff_user_id, staff_name)
     VALUES ($1,$2,$3,'WITHDRAW',$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' minutes')::interval, $12, $13)
     RETURNING *`,
    [ctx.uid, ctx.account ?? 0, conversationId ?? null, listing.is_permanent,
     listing.region_id ?? null, listing.region_name ?? null,
     listing.ml_available, listing.price_per_ml, orderListingId,
     JSON.stringify({ checked_at: new Date().toISOString(), listing_owned: true, listing_side: listing.side }),
     String(config.pendingOrderTtlMin),
     onBehalf?.staffUid ?? null, onBehalf ? staffLabel(onBehalf) : null]);
  return r.rows[0];
}

/** Single-line, length-capped staff name for the ledger, CRM note and broker task. */
function staffLabel(b: OnBehalf): string {
  return plain(b.staffName, 120) || 'Waterfind staff';
}

// ---- execution via the CRM seam -------------------------------------------------------

/**
 * The seam call yielded NO definitive outcome: timeout, network failure, or an unparseable
 * response. The CRM may have completed the operation AFTER we stopped waiting (the market
 * lock can queue the request behind clearing), so this must NEVER be treated as "failed" —
 * the pending order goes to status 'unknown' and reconciliation resolves it from the order
 * book (B1). Only a well-formed JSP {"status":"failed"} is a definitive, safe-to-retry failure.
 */
export class SeamUnknownOutcome extends Error {
  constructor(msg: string) { super(msg); this.name = 'SeamUnknownOutcome'; }
}

async function callSeam(payload: Record<string, unknown>): Promise<any> {
  const body = JSON.stringify({ iat: Math.floor(Date.now() / 1000), ...payload });
  const sig = crypto.createHmac('sha256', config.execSecret).update(body, 'utf8').digest('base64url');
  let res: Response;
  let text: string;
  try {
    res = await fetch(config.crmBase + '/ai-broker-exec.html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WFAI-Signature': sig },
      body,
      signal: AbortSignal.timeout(120_000),   // the market lock can queue us behind clearing
    });
    text = await res.text();
  } catch (e: any) {
    throw new SeamUnknownOutcome(`no response from the trading system: ${e?.message ?? e}`);
  }
  let parsed: any;
  try { parsed = JSON.parse(text); }
  catch { throw new SeamUnknownOutcome(`CRM seam returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (parsed && parsed.status === 'success') return parsed;
  if (parsed && parsed.status === 'failed') {
    throw new Error(parsed.message || `CRM seam failed (HTTP ${res.status})`);
  }
  throw new SeamUnknownOutcome(`unrecognised CRM seam response (HTTP ${res.status}): ${text.slice(0, 200)}`);
}

/**
 * A client told the phone assistant not to call them: record it in the CRM the way a broker would —
 * a Contact Note on the file and "Include in Campaigns" switched off (registry_user.campaign_optin),
 * via the exec seam's `optout` op. The sidecar's own suppression list is updated by the caller of this
 * before it is called; this is the CRM-side half, reported per part. Throws on a definitive seam
 * failure / unknown outcome — callers treat it as best-effort.
 */
export async function recordOptOutInCrm(input: { clientUid: number; accountId: number | null; note: string; idemKey: string }): Promise<{ noteWritten: boolean; campaignOptinOff: boolean }> {
  const r = await callSeam({ op: 'optout', clientId: input.clientUid, accountId: input.accountId ?? 0, idemKey: input.idemKey, note: plain(input.note, 900) });
  return { noteWritten: r.noteWritten === true, campaignOptinOff: r.campaignOptinOff === true };
}

// ---- H16: per-conversation session epoch ---------------------------------------------
// Order events null the conversation's SDK session id so the next turn rebuilds context and
// SEES the authoritative "[order event]" note. A turn that was already streaming when the
// event landed would otherwise rewrite its (now stale) session id in its done handler and
// resurrect the pre-event context. The epoch is bumped by every order-event write; pumpTurn
// captures it at turn start and skips its session write if it changed mid-turn.
const sessionEpochs = new Map<number, number>();
export function sessionEpoch(convId: number): number { return sessionEpochs.get(convId) ?? 0; }
export function bumpSessionEpoch(convId: number): void { sessionEpochs.set(convId, sessionEpoch(convId) + 1); }

function describePo(po: PendingOrder): string {
  if (po.side === 'WITHDRAW') return `withdrawal of order #${po.target_order_id}`;
  return `${po.side} ${po.volume_ml} ML ${po.is_permanent ? 'entitlement' : 'allocation'} `
    + `@ $${po.price_per_ml}/ML in ${po.region_name ?? `region ${po.region_id}`}`;
}

/** Reconciliation's order-event write: system note + fresh session next turn (epoch-guarded). */
async function recordReconcileEvent(po: PendingOrder, text: string): Promise<void> {
  if (!po.conversation_id) return;
  try {
    bumpSessionEpoch(po.conversation_id);
    await addMessage(po.conversation_id, 'system', text, { meta: { pendingOrderId: po.id, status: po.status } });
    await setSessionId(po.conversation_id, null);
  } catch (e: any) {
    console.warn('[brokerage] could not record reconciliation event:', e?.message ?? e);
  }
}

// ---- B1: reconciliation of unconfirmed placements --------------------------------------

/** How long we keep answering "still unconfirmed" before concluding the CRM never got it.
 *  Must comfortably exceed the 120 s seam timeout plus worst-case market-lock queueing. */
const RECONCILE_FAIL_GRACE_MS = 15 * 60_000;
/** An 'executing' row older than this means the sidecar died mid-confirm — same as unknown. */
const EXECUTING_STALE_MS = 5 * 60_000;

function syntheticCtx(po: PendingOrder): CallerCtx {
  return { uid: po.user_id, account: po.account_id ?? null, premium: false, accessClass: null, subclass: null, asof: config.asof };
}

/**
 * Resolve this user's 'unknown' pending orders (and 'executing' rows old enough that the
 * process must have died mid-confirm) against the CRM's own order book — the same database
 * the trade engine writes, so it is authoritative:
 *   - a matching, unclaimed order_listing placed since decided_at  -> the order IS live: 'placed'
 *   - no match and the grace window has passed                     -> it never reached the market: 'failed'
 *   - no match within the grace window                             -> still 'unknown' (the JSP may
 *     still be queued behind the market lock; judging now could call a live order failed)
 * Each resolution writes the authoritative "[order event] RECONCILED..." system note.
 */
export async function reconcileUnknownOrders(userId: number): Promise<PendingOrder[]> {
  const stuck = await query<PendingOrder>(
    `SELECT * FROM pending_order
      WHERE user_id = $1
        AND (status = 'unknown'
             OR (status = 'executing' AND decided_at < now() - ($2 || ' milliseconds')::interval))`,
    [userId, String(EXECUTING_STALE_MS)]);
  const resolved: PendingOrder[] = [];
  for (const po of stuck.rows) {
    try {
      const r = await reconcileOne(po);
      if (r) resolved.push(r);
    } catch (e: any) {
      console.error(`[brokerage] reconciliation failed for pending order ${po.id}:`, e?.message ?? e);
    }
  }
  return resolved;
}

async function reconcileOne(po: PendingOrder): Promise<PendingOrder | null> {
  const ageMs = po.decided_at ? Date.now() - new Date(po.decided_at).getTime() : Number.MAX_SAFE_INTEGER;

  if (po.side === 'WITHDRAW') {
    const r = await query(
      `SELECT COALESCE(deleted, false) AS deleted, date_completed FROM public.order_listing WHERE id = $1`,
      [po.target_order_id]);
    const row = r.rows[0];
    if (row?.deleted === true) {
      await query(
        `UPDATE pending_order SET status='placed', crm_order_id=$3, reconciled_at=now(), error=NULL
          WHERE id=$1 AND user_id=$2 AND status IN ('unknown','executing')`,
        [po.id, po.user_id, po.target_order_id]);
      const done = await getOwnedPendingOrder(po.id, po.user_id);
      await recordReconcileEvent(done,
        `[order event] RECONCILED: the earlier UNCONFIRMED ${describePo(po)} did go through — ` +
        `order #${po.target_order_id} is withdrawn from the market.`);
      return done;
    }
    if (row && row.date_completed != null) {
      await query(
        `UPDATE pending_order SET status='failed', reconciled_at=now(),
                error='Reconciled: the listing traded/completed before the withdrawal reached it — it can no longer be withdrawn.'
          WHERE id=$1 AND user_id=$2 AND status IN ('unknown','executing')`, [po.id, po.user_id]);
      const done = await getOwnedPendingOrder(po.id, po.user_id);
      await recordReconcileEvent(done,
        `[order event] RECONCILED: the earlier UNCONFIRMED ${describePo(po)} did NOT happen — ` +
        `order #${po.target_order_id} traded before the withdrawal reached it.`);
      return done;
    }
    if (ageMs > RECONCILE_FAIL_GRACE_MS) {
      await query(
        `UPDATE pending_order SET status='failed', reconciled_at=now(),
                error='Reconciled: the listing is still open on the market — the withdrawal never reached it. It is safe to request the withdrawal again.'
          WHERE id=$1 AND user_id=$2 AND status IN ('unknown','executing')`, [po.id, po.user_id]);
      const done = await getOwnedPendingOrder(po.id, po.user_id);
      await recordReconcileEvent(done,
        `[order event] RECONCILED: the earlier UNCONFIRMED ${describePo(po)} never reached the market — ` +
        `order #${po.target_order_id} is still open. It is safe to request the withdrawal again.`);
      return done;
    }
    return null;
  }

  // BUY/SELL: look for the order the seam would have placed — same client, licence, side,
  // product, volume and price, placed at/after the confirm, and not already claimed by any
  // other pending_order row. date_placed is a CRM-local timestamp; cast decided_at to the
  // session-local timestamp and allow 2 min of clock skew.
  const m = await query(
    `SELECT ol.id
       FROM public.order_listing ol
      WHERE (ol.owner = $1 OR ol.logged_in_creator = $1)
        AND ol.property = $2
        AND ol.order_type = $3
        AND ol.sale = $4
        AND abs(ol.quantity - $5::float8) < 0.001
        AND abs(ol.price_per_ml - $6::float8) < 0.001
        AND ol.date_placed >= ($7::timestamptz)::timestamp - interval '2 minutes'
        AND NOT EXISTS (SELECT 1 FROM pending_order q WHERE q.crm_order_id = ol.id)
      ORDER BY ol.date_placed ASC, ol.id ASC
      LIMIT 1`,
    [po.user_id, po.property_id, po.side === 'SELL' ? 'S' : 'B', po.is_permanent,
     Number(po.volume_ml), Number(po.price_per_ml), po.decided_at]);
  const hit = m.rows[0];
  if (hit) {
    const cleared = await query(
      `SELECT count(*)::int AS n FROM public.order_completed oc
        WHERE oc.buy_order_listing = $1 OR oc.sell_order_listing = $1`, [hit.id]);
    await query(
      `UPDATE pending_order SET status='placed', crm_order_id=$3, cleared_trades=$4, reconciled_at=now(), error=NULL
        WHERE id=$1 AND user_id=$2 AND status IN ('unknown','executing')`,
      [po.id, po.user_id, hit.id, cleared.rows[0]?.n ?? 0]);
    const done = await getOwnedPendingOrder(po.id, po.user_id);
    // The seam's post-placement note/summary state is unknowable here — ask the broker to verify.
    const notified = await notifyBrokerOfOrder(syntheticCtx(done), done, 'placed', done.crm_order_id, done.cleared_trades ?? 0,
      { reconciled: true });
    await query(`UPDATE pending_order SET broker_notified=$3 WHERE id=$1 AND user_id=$2`, [po.id, po.user_id, notified]);
    await recordReconcileEvent(done,
      `[order event] RECONCILED: the earlier UNCONFIRMED ${describePo(po)} WAS in fact placed — it is live ` +
      `on the market as order #${done.crm_order_id}. Do not place it again. The CRM trade-file note may be ` +
      `missing for it; the broker has been asked to verify.`);
    return done;
  }
  if (ageMs > RECONCILE_FAIL_GRACE_MS) {
    await query(
      `UPDATE pending_order SET status='failed', reconciled_at=now(),
              error='Reconciled: no matching order reached the market — the placement did not happen. It is safe to place the order again.'
        WHERE id=$1 AND user_id=$2 AND status IN ('unknown','executing')`, [po.id, po.user_id]);
    const done = await getOwnedPendingOrder(po.id, po.user_id);
    await recordReconcileEvent(done,
      `[order event] RECONCILED: the earlier UNCONFIRMED ${describePo(po)} never reached the market — ` +
      `it was NOT placed. It is safe to prepare it again if the client still wants it.`);
    return done;
  }
  return null;
}

/**
 * B1: refuse to stage/execute a BUY/SELL that is parameter-identical to a placement whose
 * outcome is still unresolved — confirming it could double-place real money.
 */
async function assertNoUnresolvedTwin(
  userId: number, excludeId: number | null,
  p: { side: Side; isPermanent: boolean; regionId: number | null; volumeMl: number; pricePerMl: number },
): Promise<void> {
  if (p.side === 'WITHDRAW') return;
  const r = await query(
    `SELECT id FROM pending_order
      WHERE user_id = $1 AND status = 'unknown'
        AND side = $2 AND is_permanent = $3
        AND region_id IS NOT DISTINCT FROM $4
        AND volume_ml = $5 AND price_per_ml = $6
        AND ($7::bigint IS NULL OR id <> $7)
      LIMIT 1`,
    [userId, p.side, p.isPermanent, p.regionId, p.volumeMl, p.pricePerMl, excludeId]);
  if (r.rowCount) {
    throw new ScopeViolation(
      `An identical ${p.side} order (pending order #${r.rows[0].id}) is still UNCONFIRMED — its earlier ` +
      `placement got no definitive response from the trading system and may already be live. Refusing to ` +
      `risk a duplicate. It will be reconciled automatically; check back shortly.`);
  }
}

/**
 * Execute a pending order after the user's explicit confirmation. Single-flight via a
 * conditional status flip (pending -> executing), so a double-click cannot double-place.
 */
export async function confirmPendingOrder(
  ctx: CallerCtx, id: number, tcAccepted: boolean, onBehalf?: OnBehalf | null,
): Promise<PendingOrder> {
  await expireOverdue(ctx.uid);
  await reconcileUnknownOrders(ctx.uid);  // resolve any stuck placements before executing more
  const po = await getOwnedPendingOrder(id, ctx.uid);
  if (po.status !== 'pending') return po;              // idempotent: caller sees final state
  if (po.side !== 'WITHDRAW' && !tcAccepted) {
    throw new ScopeViolation('You must accept the terms and conditions to place this order.');
  }
  // B1: refuse while a parameter-identical placement is still unresolved (possible duplicate).
  await assertNoUnresolvedTwin(ctx.uid, id, {
    side: po.side, isPermanent: po.is_permanent, regionId: po.region_id,
    volumeMl: Number(po.volume_ml), pricePerMl: Number(po.price_per_ml),
  });

  // Broker-assist: the person who clicks Confirm is the accountable one — recorded even when a
  // different staff member staged the proposal (the conversation shows who asked).
  const staffUid = onBehalf?.staffUid ?? null;
  const staffName = onBehalf ? staffLabel(onBehalf) : null;
  const flip = await query(
    `UPDATE pending_order SET status='executing', decided_at=now(),
            tc_accepted_at = CASE WHEN $3 THEN now() ELSE tc_accepted_at END,
            staff_user_id = COALESCE($4, staff_user_id), staff_name = COALESCE($5, staff_name)
      WHERE id=$1 AND user_id=$2 AND status='pending' AND expires_at >= now()
      RETURNING id`, [id, ctx.uid, tcAccepted, staffUid, staffName]);
  if (flip.rowCount === 0) return getOwnedPendingOrder(id, ctx.uid); // raced/expired
  if (onBehalf) { po.staff_user_id = staffUid; po.staff_name = staffName; }
  // Who did this, for the CRM trade-file note the seam writes and the broker task below.
  const actor = po.staff_name ? `${po.staff_name} (Waterfind staff) for the client` : 'the client';

  try {
    let resp: any;
    if (po.side === 'WITHDRAW') {
      await assertOwnListing(ctx, po.target_order_id!);         // re-check at execute time
      resp = await callSeam({
        op: 'withdraw', clientId: ctx.uid, orderListingId: po.target_order_id,
        // B1/H7: the pending row id is the idempotency key — the seam dedupes on it, so a
        // replayed/retried request returns the ORIGINAL outcome and never executes twice.
        idemKey: String(po.id),
        reason: `Withdrawn by ${actor} via the AI Advisor`,
        // The client's account, for the CRM note the seam writes back (re-validated server-side).
        ...(ctx.account != null ? { accountId: ctx.account } : {}),
      });
      await query(
        `UPDATE pending_order SET status='placed', crm_order_id=$3, note_written=$4 WHERE id=$1 AND user_id=$2`,
        [id, ctx.uid, po.target_order_id, resp.noteWritten === true]);
      const notified = await notifyBrokerOfOrder(ctx, po, 'withdrawn', po.target_order_id, 0,
        { noteWritten: resp.noteWritten === true });
      await query(`UPDATE pending_order SET broker_notified=$3 WHERE id=$1 AND user_id=$2`, [id, ctx.uid, notified]);
    } else {
      // Re-validate scope at execute time (holdings can change between prepare and confirm).
      await checkUserTradable(ctx);
      await findAnchorLicence(ctx, po.region_id!, po.is_permanent, po.side, Number(po.volume_ml));
      if (po.delivery_date) validateDeliveryDate(po.delivery_date); // still a valid future forward date
      // H5: the confirmation card showed exactly ONE region (the anchor), so the seam must
      // list into exactly that region — EXCEPT the forward temp SELL, whose card explicitly
      // disclosed "listed across ALL tradable regions" (preview.forward_note); only that case
      // keeps the CRM-derived multi-region set.
      const forwardTempSell = !!po.delivery_date && po.side === 'SELL' && !po.is_permanent;
      resp = await callSeam({
        op: 'place', clientId: ctx.uid,
        idemKey: String(po.id),
        propertyId: String(po.property_id), quantity: String(po.volume_ml),
        pricePerMl: String(po.price_per_ml), isBuy: po.side === 'BUY',
        isPermanent: po.is_permanent, isListing: false,
        ...(forwardTempSell ? {} : { regionIds: [po.region_id] }),
        // The client's account, for the CRM note the seam writes back (re-validated server-side).
        ...(ctx.account != null ? { accountId: ctx.account } : {}),
        // Broker-assist: named on the CRM trade-file note ("Placed by X (Waterfind staff) ...").
        ...(po.staff_name ? { placedBy: actor } : {}),
        ...(po.expiry ? { expiry: po.expiry } : {}),
        ...(po.delivery_date ? { deliveryDate: po.delivery_date } : {}),
        ...(po.split ? {
          split: true,
          minSplitQuantity: String(po.min_split_quantity),
          ...(po.max_split_parcel_size ? { maxSplitParcelSize: String(po.max_split_parcel_size) } : {}),
        } : {}),
      });
      await query(
        `UPDATE pending_order SET status='placed', crm_order_id=$3, cleared_trades=$4, note_written=$5
          WHERE id=$1 AND user_id=$2`,
        [id, ctx.uid, resp.orderListingId ?? null, resp.cleared ?? 0, resp.noteWritten === true]);
      const notified = await notifyBrokerOfOrder(ctx, po, 'placed', resp.orderListingId ?? null, resp.cleared ?? 0,
        { noteWritten: resp.noteWritten === true });
      await query(`UPDATE pending_order SET broker_notified=$3 WHERE id=$1 AND user_id=$2`, [id, ctx.uid, notified]);
    }
    return getOwnedPendingOrder(id, ctx.uid);
  } catch (e: any) {
    if (e instanceof SeamUnknownOutcome) {
      // NOT a failure: the order may be live. Park as 'unknown' for reconciliation; the error
      // text is what the confirm card shows the user, so it must be honest about the ambiguity.
      await query(
        `UPDATE pending_order SET status='unknown', error=$3 WHERE id=$1 AND user_id=$2 AND status='executing'`,
        [id, ctx.uid,
         ('Placement status UNCONFIRMED — the trading system did not respond in time. The order may or may ' +
          'not be on the market. Do NOT place it again; it will be reconciled automatically and the outcome ' +
          'reported here. (' + String(e?.message ?? e) + ')').slice(0, 1000)]);
    } else {
      await query(
        `UPDATE pending_order SET status='failed', error=$3 WHERE id=$1 AND user_id=$2 AND status='executing'`,
        [id, ctx.uid, String(e?.message ?? e).slice(0, 1000)]);
    }
    return getOwnedPendingOrder(id, ctx.uid);
  }
}

export async function cancelPendingOrder(userId: number, id: number): Promise<PendingOrder> {
  await getOwnedPendingOrder(id, userId);
  await query(
    `UPDATE pending_order SET status='cancelled', decided_at=now()
      WHERE id=$1 AND user_id=$2 AND status='pending'`, [id, userId]);
  return getOwnedPendingOrder(id, userId);
}

// ---- broker workflow: notification, escalation, workflow initiation (Workstream D) --------
//
// The CRM already tells staff what an order did through its own task manager: public.broker_action.
// A broker sees these rows (a) on the client's admin account page (getBrokerActionsForClient), and,
// when the client account carries a servicing broker (registry_user.sales_tag_referral), (b) on that
// broker's CRM action calendar/dashboard and (c) in the daily BrokerActionEmailJob summary. So after
// an AI-driven placement/withdrawal (B3) — and for an escalation to a human (B5) — the sidecar raises
// a broker_action follow-up task on the client's file, mirroring where the JSP seam writes the Contact
// Note today, but landing in the structure brokers actually action. For placed/matched orders the task
// text says "contract preparation required", making the task the CRM-native workflow trigger (B4).
//
// "Who is the appropriate broker?" has no single source of truth in this schema — it is derived. We
// walk the account's own assignment fields, then its live/most-recent servicing tag, then a configured
// default, preferring a real, still-active (non-banned) staff user. Every read is bound to the caller's
// own account server-side (ctx.account), never a model-supplied id.

export interface BrokerTarget {
  brokerUserId: number | null;  // waterfind_user.id of the resolved broker (null = none on file)
  brokerName: string;           // display name, or a generic team label when unresolved
  source: string;               // assigned-tag | primary-sales | secondary-sales | active-tag |
                                //   recent-servicing | default | unassigned
  active: boolean;              // resolved to a real, non-banned staff user
}

const AI_SYSTEM_USERNAME = 'ai-advisor-system';
let cachedSystemAuthorId: number | undefined; // set only once resolved to a real id (positives cached)

/** The dedicated "AI Advisor" waterfind_user that authors AI-generated CRM records (broker_action
 *  creator, mirroring the Contact Note author). Overridable via env; else looked up by username.
 *  H4: only POSITIVE resolutions are cached — a miss must NOT stick, so an 'ai-advisor-system' user
 *  created after the sidecar started is picked up on the next call without a restart. */
async function systemAuthorId(): Promise<number | null> {
  if (cachedSystemAuthorId !== undefined) return cachedSystemAuthorId;
  const envId = Number(process.env.AIADVISOR_NOTE_AUTHOR_ID);
  if (Number.isFinite(envId) && envId > 0) { cachedSystemAuthorId = envId; return envId; }
  const r = await query<{ id: number }>(
    `SELECT id FROM public.waterfind_user WHERE username = $1 LIMIT 1`, [AI_SYSTEM_USERNAME]);
  const id = r.rows[0]?.id;
  if (id != null && Number(id) > 0) { cachedSystemAuthorId = Number(id); return cachedSystemAuthorId; }
  return null; // NOT cached: the user may be created later; don't pin a failed lookup for the process life
}

/** Plain, single-line, length-capped text for CRM columns that may be rendered without escaping. */
export function plain(s: string | null | undefined, max: number): string {
  return String(s ?? '').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function brokerDisplayName(row: { first_name?: string | null; last_name?: string | null; company_name?: string | null }): string {
  const person = [row.first_name, row.last_name].map((s) => (s ?? '').trim()).filter(Boolean).join(' ').trim();
  if (person) return person;
  const co = (row.company_name ?? '').trim();
  return co || 'your Waterfind broker';
}

function brokerNoteLine(b: BrokerTarget): string {
  if (b.brokerUserId != null && b.active) return `Servicing broker on file: ${b.brokerName}.`;
  if (b.brokerUserId != null) return `Servicing broker on file: ${b.brokerName} (no longer active — please reassign).`;
  return 'No servicing broker assigned on the account — please action or reassign.';
}

/**
 * Resolve the "appropriate broker" for the caller's account. Fallback chain (each candidate must
 * resolve to a real waterfind_user; an active/non-banned one is preferred over a higher-priority
 * banned one so the client is routed to a contactable person):
 *   1. registry_user.sales_tag_referral  — the tagged servicing broker the CRM's own broker
 *      calendar / daily broker-action email filter on (assigned-tag)
 *   2. registry_user.primary_contact_sales   (primary-sales)
 *   3. registry_user.secondary_contact_sales (secondary-sales)
 *   4. live tag_extension.broker (current_expiry > now), most recent (active-tag)
 *   5. most-recent tag_extension.broker — last-known servicing broker (recent-servicing)
 *   6. AIADVISOR_DEFAULT_BROKER_ID (default)
 * Returns a generic team target when nothing resolves.
 */
export async function resolveBroker(ctx: CallerCtx): Promise<BrokerTarget> {
  const generic: BrokerTarget = {
    brokerUserId: null, brokerName: 'the Waterfind broking team', source: 'unassigned', active: false,
  };
  if (ctx.account == null) return generic;

  const acct = (await query(
    `SELECT sales_tag_referral, primary_contact_sales, secondary_contact_sales
       FROM public.registry_user WHERE id = $1`, [ctx.account])).rows[0] ?? {};
  const liveTag = (await query(
    `SELECT broker FROM public.tag_extension
      WHERE client = $1 AND broker IS NOT NULL AND current_expiry > now()
      ORDER BY current_expiry DESC LIMIT 1`, [ctx.account])).rows[0];
  const recentTag = (await query(
    `SELECT broker FROM public.tag_extension
      WHERE client = $1 AND broker IS NOT NULL
      ORDER BY current_expiry DESC NULLS LAST LIMIT 1`, [ctx.account])).rows[0];
  const envDefault = Number(process.env.AIADVISOR_DEFAULT_BROKER_ID);

  const candidates: { id: number; source: string }[] = [];
  const push = (id: unknown, source: string) => {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0 && !candidates.some((c) => c.id === n)) candidates.push({ id: n, source });
  };
  push(acct.sales_tag_referral, 'assigned-tag');
  push(acct.primary_contact_sales, 'primary-sales');
  push(acct.secondary_contact_sales, 'secondary-sales');
  push(liveTag?.broker, 'active-tag');
  push(recentTag?.broker, 'recent-servicing');
  if (Number.isFinite(envDefault) && envDefault > 0) push(envDefault, 'default');
  if (!candidates.length) return generic;

  const rows = (await query(
    `SELECT wu.id, wu.first_name, wu.last_name, wu.company_name, COALESCE(wu.banned, false) AS banned
       FROM public.waterfind_user wu WHERE wu.id = ANY($1)`,
    [candidates.map((c) => c.id)])).rows;
  const byId = new Map<number, any>(rows.map((r: any) => [Number(r.id), r]));

  // Pass 1: first candidate (in priority order) that is a real, non-banned user; Pass 2: any real user.
  let chosen = candidates.find((c) => byId.get(c.id)?.banned === false)
    ?? candidates.find((c) => byId.has(c.id))
    ?? null;
  if (!chosen) return generic;
  const r = byId.get(chosen.id);
  return { brokerUserId: chosen.id, brokerName: brokerDisplayName(r), source: chosen.source, active: r.banned === false };
}

/**
 * Raise a broker-visible follow-up task on the client's CRM file (public.broker_action). Best-effort
 * for order events (never allowed to affect a trade); the escalation path checks the returned id.
 * action_type 'call' matches the CRM's own broker-action combo; creator is the AI Advisor system user
 * (client link identifies the client; the client's tagged broker, if any, routes it to their calendar).
 */
export async function insertBrokerAction(
  ctx: CallerCtx, broker: BrokerTarget, input: { title: string; description: string; tradeAction: boolean },
): Promise<number | null> {
  if (ctx.account == null) return null;
  const creator = (await systemAuthorId()) ?? broker.brokerUserId;
  if (creator == null) return null; // creator_waterfind_user is NOT NULL — cannot write without one
  const r = await query<{ id: number }>(
    `INSERT INTO public.broker_action
       (id, creator_waterfind_user, client_registry_user, due_date, action_type,
        broker_action, company_action, trade_action, infrastructure_action, title, description, completed)
     VALUES (nextval('hibernate_sequence'), $1, $2, now(), 'call', true, false, $3, false, $4, $5, false)
     RETURNING id`,
    [creator, ctx.account, input.tradeAction, plain(input.title, 250), plain(input.description, 1000)]);
  return r.rows[0]?.id ?? null;
}

/** Broker notification after a successful AI-driven order event (B3 + B4). Best-effort and isolated:
 *  a failure here can never turn a placed/withdrawn order into a failure — but it is no longer
 *  SILENT (H6): the outcome is returned so it can be persisted on the pending row and surfaced in
 *  the chat order-event message, and failures log at error level. When the CRM trade-file note is
 *  known to be missing (or unverifiable after reconciliation), the broker task says so explicitly
 *  so a human records it manually. */
async function notifyBrokerOfOrder(
  ctx: CallerCtx, po: PendingOrder, kind: 'placed' | 'withdrawn', crmOrderId: number | null, cleared: number,
  audit?: { noteWritten?: boolean; reconciled?: boolean },
): Promise<boolean> {
  try {
    const broker = await resolveBroker(ctx);
    const brokerLine = brokerNoteLine(broker);
    const noteLine = audit?.reconciled
      ? ' RECONCILED after a trading-system timeout: please VERIFY the trade-file contact note exists for this order and record it manually if missing.'
      : audit?.noteWritten === false
        ? ' The AI trade-file contact note FAILED to write - please record this trade on the client file manually.'
        : '';
    let title: string;
    let description: string;
    // Broker-assist orders name the staff member who confirmed; the client's own say "the client".
    const by = po.staff_name
      ? `by ${po.staff_name} (Waterfind staff) for the client via the AI Advisor on the client page`
      : 'by the client via the AI Advisor';
    if (kind === 'placed') {
      const s = po.side === 'BUY' ? 'BUY' : 'SELL';
      const vol = po.volume_ml != null ? Number(po.volume_ml) : null;
      const price = po.price_per_ml != null ? Number(po.price_per_ml) : null;
      title = `AI Advisor: ${s} order placed - contract preparation required`;
      description =
        `${s} ${vol ?? '?'} ML @ $${price ?? '?'}/ML` +
        (po.region_name ? `, ${po.region_name}` : '') +
        `, order #${crmOrderId ?? '?'}. Placed ${by}. ` +
        (cleared > 0
          ? `It auto-cleared ${cleared} trade${cleared === 1 ? '' : 's'} — settlement and contract preparation required. `
          : `It is resting on the market — contract preparation required when it matches. `) +
        brokerLine + noteLine;
    } else {
      const oid = crmOrderId ?? po.target_order_id;
      title = `AI Advisor: order #${oid} withdrawn - review`;
      description =
        `Order #${oid} was withdrawn from the market ${by}` +
        (po.region_name ? ` (${po.region_name})` : '') + `. ${brokerLine}${noteLine}`;
    }
    const actionId = await insertBrokerAction(ctx, broker, { title, description, tradeAction: true });
    if (actionId == null) {
      console.error(`[brokerage] broker notification NOT recorded for pending order ${po.id} (no creator/account resolvable; trade unaffected)`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error(`[brokerage] broker notification failed for pending order ${po.id} (trade unaffected):`, e?.message ?? e);
    return false;
  }
}

export type EscalationStatus = 'pending' | 'confirmed' | 'declined' | 'cancelled';

export interface Escalation {
  id: number;
  user_id: number;
  account_id: number | null;
  conversation_id: number | null;
  reason: string;
  summary: string | null;
  status: EscalationStatus;
  broker_user_id: number | null;
  broker_name: string | null;
  broker_source: string | null;
  crm_broker_action_id: number | null;
  created_at: string;
  decided_at: string | null;
  cancelled_at: string | null;
}

export interface EscalationResult {
  escalation: Escalation;
  broker: BrokerTarget;
  crmBrokerActionId: number | null;
}

export async function getOwnedEscalation(id: number, userId: number): Promise<Escalation> {
  const r = await query<Escalation>(
    `SELECT * FROM escalation WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (r.rowCount === 0) throw new NotFound('escalation not found');
  return r.rows[0];
}

export async function listEscalations(
  userId: number, conversationId?: number, statuses?: string[],
): Promise<Escalation[]> {
  const cond: string[] = ['user_id = $1'];
  const params: any[] = [userId];
  if (conversationId) { params.push(conversationId); cond.push(`conversation_id = $${params.length}`); }
  if (statuses?.length) { params.push(statuses); cond.push(`status = ANY($${params.length})`); }
  const r = await query<Escalation>(
    `SELECT * FROM escalation WHERE ${cond.join(' AND ')} ORDER BY created_at DESC LIMIT 50`, params);
  return r.rows;
}

/**
 * Stage a handoff to a HUMAN broker (B5) as a 'pending' escalation — the escalation twin of
 * preparePendingOrder. Nothing broker-visible happens here: the CRM follow-up task is raised only
 * by confirmEscalation, driven by the client's own Confirm click on the in-chat card.
 */
export async function prepareEscalation(
  ctx: CallerCtx, args: { reason: string; summary: string; conversationId?: number | null },
): Promise<{ escalation: Escalation; broker: BrokerTarget }> {
  const broker = await resolveBroker(ctx);
  const reason = plain(args.reason, 500) || 'escalation requested';
  const summary = plain(args.summary, 2000) || null;
  const ins = await query<Escalation>(
    `INSERT INTO escalation
       (user_id, account_id, conversation_id, reason, summary, broker_user_id, broker_name, broker_source, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
    [ctx.uid, ctx.account ?? null, args.conversationId ?? null, reason, summary,
     broker.brokerUserId, broker.brokerName, broker.source]);
  return { escalation: ins.rows[0], broker };
}

/**
 * Confirm a pending escalation: raise the broker-visible broker_action follow-up task on the
 * client's CRM file. The durable status flip always lands even if the CRM task write fails —
 * the caller must check crmBrokerActionId (H4) before telling the client anyone was notified.
 */
export async function confirmEscalation(ctx: CallerCtx, id: number): Promise<EscalationResult> {
  const esc = await getOwnedEscalation(id, ctx.uid);
  if (esc.status !== 'pending') throw new ScopeViolation(`escalation is ${esc.status}, not pending`);
  // Re-resolve the broker at confirm time (assignments may have changed since prepare) and persist.
  const broker = await resolveBroker(ctx);
  await query(
    `UPDATE escalation SET status='confirmed', decided_at=now(),
            broker_user_id=$3, broker_name=$4, broker_source=$5
      WHERE id=$1 AND user_id=$2 AND status='pending'`,
    [id, ctx.uid, broker.brokerUserId, broker.brokerName, broker.source]);

  let crmBrokerActionId: number | null = null;
  try {
    crmBrokerActionId = await insertBrokerAction(ctx, broker, {
      title: 'AI Advisor: escalation - client needs a human broker',
      description:
        `A client asked to be handed to a human broker via the AI Advisor. Reason: ${esc.reason}. ` +
        `Summary: ${esc.summary ?? 'n/a'}. Please follow up. ${brokerNoteLine(broker)}`,
      tradeAction: false,
    });
    if (crmBrokerActionId != null) {
      await query(`UPDATE escalation SET crm_broker_action_id = $2 WHERE id = $1`, [id, crmBrokerActionId]);
    }
  } catch (e: any) {
    // H4: never swallow a failed task write into apparent success. If the broker_action INSERT
    // itself threw, crmBrokerActionId is still null and the caller takes the "task could not be
    // raised" branch (a later failure — e.g. the denormalised link UPDATE — leaves the real id
    // intact: the task DID land). Log at error level, mirroring notifyBrokerOfOrder.
    console.error(
      `[brokerage] escalation broker task write errored for escalation ${id} ` +
      `(uid=${ctx.uid}, account=${ctx.account ?? 'none'}; escalation still recorded):`, e?.message ?? e);
  }
  return { escalation: await getOwnedEscalation(id, ctx.uid), broker, crmBrokerActionId };
}

/** Decline a pending escalation (the client chose not to send it). Nothing was ever broker-visible. */
export async function declineEscalation(userId: number, id: number): Promise<Escalation> {
  await getOwnedEscalation(id, userId);
  await query(
    `UPDATE escalation SET status='declined', decided_at=now()
      WHERE id=$1 AND user_id=$2 AND status='pending'`, [id, userId]);
  return getOwnedEscalation(id, userId);
}

export interface CancelEscalationResult {
  escalation: Escalation;
  /** A CRM task had been raised at confirm time. */
  hadTask: boolean;
  /** That task was still open and is now completed+annotated. false with hadTask=true means the
   *  broker may already have actioned (or be actioning) it — tell the client they may still hear
   *  from the team. */
  taskClosed: boolean;
}

/** Cancel a CONFIRMED escalation ("de-escalate"): close and annotate the CRM follow-up task if it
 *  is still open, so a broker does not chase a request the client has withdrawn. */
export async function cancelEscalation(userId: number, id: number): Promise<CancelEscalationResult> {
  const esc = await getOwnedEscalation(id, userId);
  if (esc.status !== 'confirmed') throw new ScopeViolation(`escalation is ${esc.status}, not confirmed`);
  const hadTask = esc.crm_broker_action_id != null;
  let taskClosed = false;
  if (hadTask) {
    try {
      const r = await query(
        `UPDATE public.broker_action
            SET completed = true,
                description = left(description || ' [Cancelled by the client via the AI Advisor - no follow-up needed.]', 1000)
          WHERE id = $1 AND completed = false`, [esc.crm_broker_action_id]);
      taskClosed = (r.rowCount ?? 0) > 0;
    } catch (e: any) {
      console.error(
        `[brokerage] could not close CRM task #${esc.crm_broker_action_id} for cancelled escalation ${id}:`,
        e?.message ?? e);
    }
  }
  await query(
    `UPDATE escalation SET status='cancelled', cancelled_at=now()
      WHERE id=$1 AND user_id=$2 AND status='confirmed'`, [id, userId]);
  return { escalation: await getOwnedEscalation(id, userId), hadTask, taskClosed };
}
