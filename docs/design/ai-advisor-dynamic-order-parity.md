# Design memo — AI Advisor: Dynamic Order System parity

> Status: **PROPOSED** · Branch: `feat/water-advisor-chat` · Date: 2026-07-07
> Builds on `ai-brokerage.md` (order execution via the HMAC JSP seam + explicit-confirm gate).

## WHAT

Bring the advisor's brokerage surface to parity with the CRM admin page's **"Dynamic Order
System"** section (`crm/waterfind.com.au/webapp/jsp/admin/registry/segments/user-reg-details.body.jsp:1604-1640`),
decomposed into independently shippable slices:

| Slice | Capability | Size | Verdict | Status |
|---|---|---|---|---|
| A | Fee-schedule surfacing (read-only tool) | S | Build first | BUILT 2026-07-08, verified |
| B | Forward orders (delivery-dated) | M | Build second | BUILT 2026-07-08, verified |
| C | Split parcels (min/max parcel size) | M | Defer | BUILT 2026-07-08 (deferral overridden), verified |
| D | Send-to-client one-click no-login accept | L | Do not build | not built |

> Outcome: A+B+C shipped together on `feat/ai-advisor-order-parity`. Verified live:
> `test-broker.ts` 59/59 (fee cells match the CRM admin endpoint for both test users; forward
> refusals/placement/`date_of_delivery`/24-region temp-forward-sell listing; split partial fill,
> valid remainder rests, sub-min remainder auto-cancelled), `test-e2e-broker.mjs` 15/15 (live
> agent quotes real fees from the tool, prepares a forward by natural language),
> `e2e/broker.js` 8/8 (FORWARD card banner + delivery date + disclosures in the real chat UI),
> `test-tools.ts` 21/21 + RLS probes. Slice A fee resolution note: the CRM resolves state fees
> via `state_fee_structure_state`, NOT the legacy `waterfind_fees.state` column — the tool
> mirrors the former. Follow-up RESOLVED 2026-07-08: `estimate_net_proceeds` was rebuilt to price
> from the caller's OWN contracted schedule (fee agreement, else the sell region's state rate
> card via `state_fee_structure_state`) — it previously used the median of OTHER clients'
> actually-charged commissions (cross-client rate exposure + wrong numbers, found by the chat
> pilot: $937 vs the correct $868 on 5 ML @ $200). `waterfind_commission_index` SELECT is now
> REVOKED from `ai_advisor_ro` outright. Verified: `test-broker.ts` 70/70, `test-tools.ts` 21/21,
> live chat replay of the pilot ask quotes $120 commission / $868 net.

Everything else on the broader CRM order surface — Order Now against a specific resting listing,
fast clearing, financed orders, dual listing, invitations-for-offers — is **explicitly not
covered** by this memo (unchanged from `ai-brokerage.md` "Known limits").

## WHY

Brokers use the Dynamic Order System section for one workflow: pre-fill an order for a client
(buy/sell, forward/spot, perm/temp, volume, price, optional split) with the client's fee schedule
in view, then fire a one-click accept link at the client by SMS/email. The advisor already covers
the self-service half of that (spot buy/sell/withdraw with a human-confirm card); closing the gap
means clients in chat can transact the same order shapes brokers offer them, and see the same
fees, without a broker phone call.

## Verified CRM anatomy (and two research corrections)

| Fact | Where |
|---|---|
| Section UI: Buy/Sell, Forward/Spot, Perm/Temp, Vol, Price, Split(+vol), ACTIVATE; fee table perm/temp x buy/sell + fee-change mailto | `user-reg-details.body.jsp:1604-1640`; fees populated from Buyer/Seller Perm/Temp structures at `:868-890` |
| ACTIVATE → `openAddOrder()` (`:1155`) → popup `/dynamic-order-form-send.html` (staff completes licence/regions there) | `user-reg-details.body.jsp:1155-1191`; `struts-config.xml:5677` |
| Staff submit `/add-dynamic-order-submit` persists `DynamicOrderDetails` (`:193`), generates T&C doc, sends link by SMS/email (`:238-240`) | `AddDynamicOrderFormSubmitAction.java`; entity `hibernate/DynamicOrderDetails.java:23-108` (table `dynamic_order_details`) |
| Client link = `/oo.html?u=<uid>&doi=<dynamicOrderId>`; accept posts `/dynamic-order-submit` (no login) gated by a **4-digit SMS code**, then `addNewDynamicOrderListingNoLogin` | `OrderListingBo.sendClientOrder:8797-8830`; `DynamicOrderFormSubmitAction.java:135,139-141`; code check `OrderListingBo:8654` |
| The no-login accept takes volume/price/licence **from the request**, not only from the stored `DynamicOrderDetails` | `DynamicOrderFormSubmitAction.java:37-58` |

Corrections to earlier research (do not propagate the old claims):

- **Forward orders do NOT route through `addNewFutureOrder`.** That delegate method
  (`OrderServiceImpl.java:121` → `FutureOrderBo.java:84`) writes a staff-only `future_order`
  register row (pre-order expression of interest), never a live listing. Forward exchange orders
  are ordinary `OrderListing`s with a non-null `deliveryDate`, created via the same
  `addNewOrderListing` the seam already calls (`AddOrderListingDetailsDto.java:30`;
  `OrderListingBo:6676-6685`).
- Sidecar confirm endpoint is `server.ts:352` (not `:253`); pipeline `brokerage.ts:293-343`.

## Current advisor surface and its hard limits

Tools `prepare_buy_order` / `prepare_sell_order` / `prepare_order_withdrawal`
(`services/ai-advisor/src/broker-tools.ts:50-102`) stage `ai_advisor.pending_order` rows; the
human confirms (`server.ts:352` → `brokerage.ts:293-343`) → HMAC seam
`services/ai-advisor/crm-seam/ai-broker-exec.jsp` (ops `place` `:208`, `withdraw` `:324`).
Seam hard-codes: `split:false` (`:271`), `hasAllocation:false` (`:275`), `dualListing:false`
(`:276`), no forward/delivery date (`deriveTradableRegions` passes `false`/`null`, `:140`), fees
auto-applied from the property's state-based structure (`applyFees:118-131`), identity self-only
from the signed token.

## Slice analysis

### A — Fee-schedule surfacing (read-only)

| What | Where |
|---|---|
| New read-only tool `get_my_fee_schedule` (perm/temp x buy/sell: $ fee + %), mirroring the section's fee table | `src/data-tools.ts` (data tool, not a broker tool — no pending-order model change) |
| Data source: same structures the admin page renders (Buyer/Seller Perm/Temp `FeeStructureProperties`), i.e. the state-based fees the seam already applies | RLS-scoped SQL on `waterfind_fees` (as `estimate_net_proceeds` already does, `data-tools.ts:279-308`); verify per-client overrides against the `/admin-add-registry-user-fees.html` path before shipping |
| Fee-change request: surface as advice text ("contact your broker"), not a tool | mirrors the section's mailto; no write surface |

Risk: **Low** — read-only, no seam change, no CRM path invoked. Size: **S**.

### B — Forward orders

| What | Where |
|---|---|
| Optional `delivery_date` (dd/MM/yyyy) on `prepare_buy_order`/`prepare_sell_order`; validate future-dated, sane horizon | `broker-tools.ts` schema + `brokerage.ts` prepare validation |
| `pending_order.delivery_date` column; confirmation card shows "FORWARD — delivery dd/MM/yyyy" prominently | `db/brokerage.sql`, chat card CSS/JS |
| Seam `place` accepts `deliveryDate`, sets `dto.setDeliveryDate`, calls `deriveTradableRegions` with `isForward=true` + the date | `ai-broker-exec.jsp:140,265-299` |
| CRM path unchanged: same `addNewOrderListing` (`OrderListingBo:6519`), which sets `deliveryDate` (`:6676-6685`) | no new delegate method |

Risk: **Medium**, because forwards are not "spot plus a date":

- Temp forward **sells auto-list into ALL tradable regions**, ignoring `selectedRegions`
  (`OrderListingBo:6749-6770`) — wider blast radius than the single-anchor-region spot rule the
  advisor enforces today; the card must disclose this.
- Forwards **bypass STR/RTR** in `checkTradability` (doc `08` Part 4e) — one fewer engine-side
  guardrail.
- **Forwards never auto-clear** (verified during implementation, 2026-07-08):
  `TradeAlertBo.canTradeOnForwardDeliveryDates` (:4010) excludes forward-vs-forward pairs outright
  and forward-vs-spot fails `OrderMatchingPolicy.canTradeOnForwardDeliveryDate` (:249, null buyer
  date returns false) — the same-day `DateUtils.isSameDay` branch is unreachable dead code. Forward
  listings REST on the book; the same-day-capable predicates live in the notification policies
  (`NotifyBuyersOfNewSellerPolicy`/`NotifySellersOfNewBuyerPolicy`), i.e. counterparties get water
  alerts and accept manually. The confirm card and tool description must (and now do) disclose
  "rests until a counterparty accepts".
- Settlement uses the **forward deposit-fraction payment schedule**
  (`WaterfindInvoiceProcessing`, doc `08` Part 5 step 8) — financing/deposit semantics need a
  human answer before launch (open question below). Financed orders themselves stay out of scope.
- Matching of effective/forward listings is also driven hourly by `FutureOrderAutoMatchingTask`
  (doc `08` Part 1c) — outcome may arrive after the chat turn; the existing system-note
  propagation already handles late results.

Size: **M**.

### C — Split parcels (defer)

| What | Where |
|---|---|
| `allow_split` + `min_split_quantity` / `max_split_parcel_size` on prepare tools | `broker-tools.ts`, `pending_order` columns |
| Seam stops hard-coding `split:false`; sets DTO fields | `ai-broker-exec.jsp:270-271`; `AddOrderListingDetailsDto:11-13`; `OrderListingBo:6693-6701` |

Risk: **Medium** — split interacts with the matching engine: volume predicates
`canTradeOnVolume{BothSplit,BuyerSplit,SellerSplit,NoSplit}` (doc `08` Part 4b), match priority
prefers non-split (`compareBillingDetails`, Part 2), and clearing **auto-deletes the remainder
below min split** with owner notification (Part 3 step 10, `OrderListingBo:5228-5257`). Partial
fills mean the AI must explain multi-trade outcomes and disappearing remainders correctly.
Size: **M** (most of it test surface, not code). Deferred: real but second-order client value;
build after A+B prove out.

### D — Send-to-client one-click accept (do not build)

What parity would mean: the advisor (acting for a broker) builds a `DynamicOrderDetails`, has the
CRM generate the T&C doc and send the `/oo.html?u&doi` link, and the client accepts via the
no-login `/dynamic-order-submit` path. Why not:

- **Identity-model conflict.** The advisor is deliberately self-only — identity bound from the
  caller's token, no tool takes a client id (`ai-brokerage.md` scope model). Sending orders *to
  another person* is a staff-actor feature; grafting it on breaks the invariant every existing
  scope test relies on.
- **Real security surface.** The accept endpoint is public, gated only by a guessable link plus a
  4-digit SMS code, and trusts request-supplied volume/price/licence
  (`DynamicOrderFormSubmitAction.java:37-58`). Extending AI reach into that path multiplies
  exposure on the weakest auth in the CRM.
- **Redundant human gate.** The advisor already has a stronger version of "client one-click
  accept": the in-chat confirm card behind the client's own authenticated session.
- Staff who need it have the existing CRM section; nothing is lost.

If a broker-facing advisor materialises later, revisit as its own memo with a staff identity
model. Size if built: **L**.

## Recommendation

1. **Build A** (fee schedule) — trivial, immediately useful in every brokerage conversation,
   removes a class of "what will this cost me" hallucination risk.
2. **Build B** (forward orders) — the only order *shape* in the section the advisor genuinely
   cannot place; ship behind the same confirm card with explicit forward disclosure.
3. **Defer C** (split) until A+B are verified in production use; revisit with matching-engine
   test coverage for partial fills.
4. **Do not build D** — identity-model conflict + no-login security surface; the confirm card
   already is the client-accept flow.

## Acceptance criteria

Test users: Stuart uid 119063 (licence 2447507, region 311325 Central Goulburn, 15.8 ML), Beth
uid 2725534 (4736 ML, same region). Suites: `services/ai-advisor/test-broker.ts`,
`itest-broker.ts`, `test-e2e-broker.mjs`, `e2e/broker.js` (all green today; extend, don't fork).

Slice A:
- `get_my_fee_schedule` returns all four cells (perm/temp x buy/sell, $ + %) for Stuart, matching
  what `user-reg-details.body.jsp` renders for the same user against the same DB.
- RLS: Beth's token can never read Stuart's schedule (`test-tools.ts`-style cross-user case).
- Live-agent case in `test-e2e-broker.mjs`: "what fees would I pay to sell 10 ML" answers from
  the tool, with no fabricated numbers.

Slice B:
- `test-broker.ts`: prepare with `delivery_date` stores it; confirm places a CRM listing whose
  `delivery_date` is set (verify `order_listing` row); past/absurd dates refused at prepare;
  spot orders (no date) unchanged — full existing 27 still pass.
- Temp forward sell: assert the listing's `OrderRegion` rows cover the CRM-derived all-region
  set, and the confirm card disclosed multi-region listing before confirm.
- Resting semantics: Stuart forward sell + Beth forward buy REST regardless of delivery-date
  match (forwards never auto-clear — see corrected risk note above); both withdrawable.
- `e2e/broker.js`: card shows FORWARD banner + delivery date; screenshot added.
- Withdrawal of a forward listing works via the existing `prepare_order_withdrawal`.

## Rollback / kill switch

- **Primary kill switch:** the per-client `waterfind_user.ai_advisor` flag (in progress on
  `feat/ai-advisor-flag`). Flag off = no advisor chat = no brokerage tools for that client; it
  gates all slices here with no extra work because every slice lives behind the advisor surface.
- Slice-level rollback: A is a tool-list deletion; B is revert of the seam JSP (Resin restart, no
  Ant build), one nullable sidecar column, and the tool param — placed forwards remain ordinary
  CRM listings, withdrawable normally. Same shape as `ai-brokerage.md` rollback.

## Open questions (need a human)

1. Fee approval semantics: are the state-based structures the seam applies always the
   client-final fees, or can per-client overrides (`/admin-add-registry-user-fees.html`) diverge —
   and must a fee change stay a broker-mediated request (the mailto) rather than ever an AI action?
2. Forward-order financing: is the deposit-fraction schedule acceptable for client-initiated AI
   forwards, or must forwards remain broker-mediated? What delivery-date horizon is allowed?
3. Regulatory/audit: do any state jurisdictions or the Basin Plan require different T&C documents
   or extra disclosures for forward orders placed without a broker in the loop? Is the existing
   `pending_order` + CRM action-log trail sufficient for ISO-9001 audit of AI-initiated forwards?
4. Split remainder auto-deletion: if C is ever built, who explains the deleted remainder to the
   client — the CRM email, the advisor, or both?
