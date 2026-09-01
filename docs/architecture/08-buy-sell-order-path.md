# 08 — The Buy/Sell Order Path (programmatic trigger + complete isolation map)

> Scope: `crm/waterfind.com.au`. A complete, line-cited trace of **how a buy or sell order is
> triggered programmatically and everything it touches** — entry points, the matching/clearing
> spine, settlement/billing, notifications, remote trading, and the cross-cutting infrastructure it
> depends on. Built to answer one question: *what is the blast radius of buy/sell orders, and what
> would have to move together to isolate them?*
>
> Produced 2026-06-23 from the `Iteration45` checkout. Every claim cites a path under
> `crm/waterfind.com.au/src/com/waterfind/…`. Per the README: **trust the path over the prose —
> verify before relying on it.** Known discrepancies with the rest of the docs are called out in
> Part 12.

---

## Part 0 — TL;DR

- **One programmatic entry point matters above all others:** `WaterfindDelegate.addNewOrderListing(AddOrderListingDetailsDto)`
  (`server/WaterfindDelegate.java:4380`, `@LockMarket`). It creates a `BuyOrderListing` or
  `SellOrderListing` and, unless it's an "invitation for offers", **auto-clears it against the
  resting book in the same call**. To place-and-trade a buy/sell order from code, this is the call.
- **The single most important method** is `OrderListingBo.orderNow(...)` (`business/orders/OrderListingBo.java:4823`,
  `@LockMarket @Transactional(REQUIRES_NEW)`) — the clearing transaction that writes the trade and
  fans out to settlement, notifications, remote trading and MYOB.
- **You cannot call the BO directly.** Order operations only work through the Spring-proxied
  `WaterfindDelegate` (transaction + Hibernate session + market lock + error boundary all come from
  the proxy). A background/out-of-request caller must also populate two thread-locals
  (`ServiceRequest`/`ServiceResponse`) — see Part 11.
- **The market clears under one process-wide `ReentrantLock`** (`MarketLockAspect`). Clearing is
  single-node, single-threaded, fair, no timeout.
- **The order/trade-specific code is a tractable slice** (~a dozen BOs, ~12 entities, ~14 tables).
  But it is **welded to shared infrastructure** — the God-facade delegate, the global
  `hibernate_sequence`, app-layer multi-tenancy, billing/MYOB/approval-procedure, and the
  notification gateway. The isolation boundary is in Part 10.

---

## Part 1 — The programmatic trigger surface (every way in)

Everything funnels: **entry → `WaterfindDelegate` (proxy) → `OrderListingBo` / `WaterOfferBo` → DAOs**.
Below are all the ways the order/clearing methods get invoked.

### 1a. The delegate methods that are the real API (`server/WaterfindDelegate.java`)

| Delegate method | Line | Annot. | Forwards to | What it does |
|---|---|---|---|---|
| `addNewOrderListing(AddOrderListingDetailsDto)` | 4380 | `@LockMarket` | `OrderListingBo.addNewOrderListing` (6519→6935) | **Create buy/sell order + auto-clear.** Primary trigger. |
| `addNewOrderListingNoLogin(...)` | 4389 | — | `OrderListingBo.addNewOrderListingNoLogin` (8675) | Public order creation (no auth). |
| `addNewDynamicOrderListingNoLogin(...)` | 4398 | — | `OrderListingBo.addNewDynamicOrderListingNoLogin` (8752) | Public "dynamic" (emailed-link) order. |
| `orderNow(OrderNowCriteriaDto)` | 4297 | `@LockMarket` | `OrderListingBo.orderNow(criteria)` (4461) | Execute a trade against a specific resting listing (the "Order Now"/"Buy Now"/"Sell Now" button). |
| `addSale(AddSaleCriteriaDto)` | 4287 | `@LockMarket` | `WaterOfferBo.addSale` (1651) | Manual sale / intent-to-trade water offer. |
| `addNewFutureOrder(FutureOrderAddCriteriaDto)` | (≈1891) | — | `OrderListingBo` future-order create | Forward/future order (cleared later by a job). |
| `orderMatchingForOrder(Long)` | 4216 | — | `OrderListingBo.orderMatchingForOrder` (7346) | **Re-drive matching for an existing listing.** Used by jobs. |
| `deleteOrderListing(String,String)` | 4292 | `@LockMarket` | `OrderListingBo.deleteOrderListing` | Withdraw a listing. |
| `expireOrders()` | 4275 | `@LockMarket` | `WaterOfferBo.expireOrders` (319) | Expire stale orders/offers. |

### 1b. Inbound HTTP entry points (web tier)

| Type | File | URL / mapping | Auth | Reaches |
|---|---|---|---|---|
| Struts action | `action/trade/AddOrderListingAction.java` | `/add-order-listing` | `@AccessRestriction(USER_ANY)` (login) | `addNewOrderListing` |
| Struts action | `offer/order/OrderNowAction.java` | `/order-now` | `@AccessRestriction(BROKER,SALES,DIRECT)` | `orderNow` |
| Struts action | `offer/order/ProcessOrderNowAction.java` | `/process-order-now` | `@AccessRestriction(BROKER,SALES,DIRECT)` | `orderNow` |
| Struts action | `offer/AddSaleAction.java` | `/addSaleAction` | `@AccessRestriction(BROKER,SALES,DIRECT)` | `addSale` |
| Struts action | `action/OrderFormSubmitAction.java` | `/oo-submit` | **NO LOGIN** (`isLoginRequired()=false`) | `addNewOrderListingNoLogin` |
| Struts action | `action/DynamicOrderFormSubmitAction.java` | `/dynamic-order-submit` | **NO LOGIN** | `addNewDynamicOrderListingNoLogin` |
| Struts action | `action/trade/DeleteActiveOrderAction.java` | `/delete-active-order` | `@AccessRestriction(USER_ANY)` | `deleteOrderListing` |
| GWT-RPC | `gwt/server/order/OrderServiceImpl.java` | `/gwt/order/order` (web.xml) | session | `addNewOrderListing`, `addNewFutureOrder`, `previewTermsConditions` |
| GWT-RPC | `gwt/server/order/OrderNowServiceImpl.java` | `/gwt/order/ordernow` | session | (inherits `WaterfindRPCServlet`) |
| GWT-RPC | `gwt/server/trade/TradeServiceImpl.java` | `/gwt/trade` | session | trade/water-alert ops |
| Raw servlet | `servlet/RemoteTradeServlet.java` | `/services/remoteTrade` | **NONE** | `processClientSmsResponse` → **dormant** (SMS trading disabled 2015; creates/clears nothing today) |

> **Auth is opt-in.** A `WaterfindAction` is public unless it overrides `isLoginRequired()` / carries
> `@AccessRestriction`. The two `*NoLogin` order endpoints are intentionally public. Authorization is
> enforced at the Struts layer (`Waterfind.validateAccessRestriction()`), **not** in the BO — so any
> non-web caller of the delegate bypasses RBAC entirely.

### 1c. Automated / scheduled triggers (no human)

| Trigger | File | Cadence | Reaches | Gating |
|---|---|---|---|---|
| Forward-order auto-match | `util/timertasks/FutureOrderAutoMatchingTask.java` | hourly | `orderMatchingForOrder(Long)` | `waterfind.taskmanager=true` |
| Expiry sweep | `util/timertasks/ExpiryNotification.java` | ~15 min | `expireOrders()` | `waterfind.taskmanager=true` |
| Remote-market sync | `OrderListingBo.syncOrderListingsWithRemoteListings*` (3413) | on market load + after remote trades | `addNewOrderListing(details,false)` for new remote parcels | `!isRedundantServer()` |

Scheduler bootstrap: `WaterfindConfigurator` → `TaskDispatcherBo.startTasks()`; `waterfind.taskmanager`
defaults true, false only on `dev` and `prod-usa`.

### 1d. Internal self-triggers (within `OrderListingBo`)
- Remote partial-fill re-listing: `processRemoteTrade` calls `this.addNewOrderListing(details, false)`
  (≈5604).
- Dev/diagnostic callers around lines 8675 / 8752.

---

## Part 2 — The clearing spine (the complete code path)

```
delegate.addNewOrderListing(dto)                       WaterfindDelegate.java:4380  @LockMarket
  └─ OrderListingBo.addNewOrderListing(dto)            :6519 → :6935 (doAutoClearing=true)
       1. build BuyOrderListing | SellOrderListing     :7025-7029   (new <subclass>)
       2. set fields, persist listing (saveOrUpdate)
       3. order-created email + SMS (if !remote)        :7214-7290
       4. if active && !invitationForOffers:
          └─ orderMatchingForOrder(creator, orl, …)     :7370
               └─ loop orderMatchingItr(...)            :7415   (until stable / qty==0)
                    └─ orderMatching(listing)           :7485
                         ├─ getMatchingOrderRegions      → TradeAlertBo.findingMatchingOrderRegions :3338
                         ├─ listOfMatchedOrders          :7673  → WaterfindInvoiceProcessing.getMarketPriceForOrder
                         └─ sort: compareBillingDetails  :7544  (price → volume → non-split → duration → datePlaced)
                    └─ completeOrder(creator, buyer, seller, isBuy)  :4722
                         └─ orderNow(creator, buyer, seller, … 21 args)  :4823  @LockMarket @Transactional(REQUIRES_NEW)
               └─ tradeAlertBo.notifyClientsOfNewOrderListing(orl)  :7405
       5. notifyListenersOfNewListing(orl.getId())      :7333  (in-process listeners)
       6. return orl.getId()
```

**Price-time-volume priority** (`compareBillingDetails`, :7544): best net price/ML → larger volume →
non-split preferred → shorter transfer duration → earliest `datePlaced`.

---

## Part 3 — Inside the clearing transaction: `orderNow(...)` (`OrderListingBo.java:4823`)

`@LockMarket @Transactional(readOnly=false, propagation=REQUIRES_NEW)`. Step by step:

1. Re-fetch all Hibernate objects under the (intended) new tx; re-check `getDateCompleted()!=null`
   → `ERROR_PARCEL_NOT_AVAILABLE` (:4863-4878). **This re-fetch + completed-check is the real
   double-sell guard** (see Part 12 caveat).
2. Dual-listing price adjustment via `regionBo.getAdjustedPriceForRegionFees` (:4881-4894).
3. Remote-trade detection: non-blank `sellerListing.getRemoteReference()` → enable thread-local
   message queue so emails defer until commit (:4896-4904).
4. Resolve from/to region + `isSale` (:4909-4924); load `RegionTradingRelationship.getRtr(...)`;
   **null → `ERROR_NO_RTR`** (:4927-4933).
5. Create `TenderOffer` + `WaterOffer` + `CompletedOrders` (:4936-4940).
6. Reconcile price/qty via `OrderPricePerMLAndQty` (:4945); **`ERROR_PRICE_NOT_MATCH` /
   `ERROR_NOT_ENOUGH_WATER`** thrown here by the caller (:4956-4961).
7. Populate buy-side / sell-side / both-sides: regions, properties, reseller fees, commission,
   accepted T&Cs, client authority (:4967-5113); trade initiator (:5116).
8. Decrement `quantityAvelable`; persist `wo`, `to`, `co` (insert) (:5186-5214).
9. **`waterOfferBo.add(wo, to, false, true, …)`** (:5220) → settlement/billing (Part 5).
10. Update listings: `dateCompleted`, auto-delete split remainder below min split (+
    `sendDeletedNotification`, `actionLogBo.logOrderListingDeleted`) (:5228-5257).
11. `negotiationId` stamp (:5263-5274).
12. **Remote trade** if `isRemoteTrade`: `attemptRemoteTrading` (:5281-5291) (Part 7).
13. **Notifications**: `inactivateAttachedAlerts` + `notifyClientsOfNewOrderListing` +
    `sendNotificationForOrder` (:5296-5370) (Part 6).
14. Broker feedback form (≤1/6 months) (:5376-5385).
15. `sendQueuedMessages()` — flush deferred email (:5388).
16. **MYOB** `myobBo.addMyobObjects(...)` if enabled — async (:5393-5405) (Part 5.8).
17. return `TenderOffer`.

---

## Part 4 — The matching / eligibility / pricing engine

### 4a. Candidate finding + match decision — `business/orders/TradeAlertBo.java`
- `findingMatchingOrderRegions(OrderListing)` (:3338) — entry from `orderMatching`. Wraps listing in
  an `ActiveOrderFacade`, finds candidates (buy→`sellOrderListingDao`, sell→`buyOrderListingDao`),
  filters, resolves the concrete `OrderRegion` row.
- `filterOrders(...)` (:3554) — builds the `OrderMatchingPolicy` (fuzzy → loads active
  `WaterAlertTolerances`); includes a candidate only if both sides open, target is a trade target,
  and `doOrdersMatch`.
- `doOrdersMatch(...)` (:3634) — the **11-step gate**: not expired → forward-date compatible →
  region non-null → candidate region ∈ target's allowed regions → target region ∈ candidate's
  allowed regions → different owners → property can trade → **RTR valid (active, not suspended)** →
  **STR valid (active, not suspended, in-season window)** → volume predicate → price predicate.

### 4b. Strategy policies — `business/orders/` (pure computation)
`OrderMatchingPolicy` (factory `getMatchingPolicy`) + subclasses
`FindAllOrdersForRegionPolicy` (market view — predicates all return true),
`FindSellersForNewBuyerPolicy` / `FindBuyersForNewSellerPolicy` (exact),
`NotifySellersOfNewBuyerPolicy` / `NotifyBuyersOfNewSellerPolicy` (fuzzy, multiplier bands from
`WaterAlertTolerances`). Predicates: `canTradeOnPrice` (rounds to cents, buyer ≥ seller),
`canTradeOnVolume{BothSplit,BuyerSplit,SellerSplit,NoSplit}`, `canTradeOnForwardDeliveryDate`.

### 4c. Uniform adapter — `business/orders/ActiveOrderFacade.java` (+ `*ActiveOrderFacade` for
OrderListing, WaterOffer, Wateralert, OrderRegion, Region). `getAllAllowedRegions()` is where the
per-order allowed-region set comes from; `isOpen()` / `isTradeTarget()` gate participation.
`OrderMatch.java` is the dedupe VO (equals/hashCode on from/to only).

### 4d. Pricing
- `offer/order/OrderPricePerMLAndQty.java` — price/qty reconciliation (pure); errors thrown by the
  `OrderListingBo` caller, not here.
- `admin/fees/WaterfindInvoiceProcessing.getMarketPriceForOrder(...)` (:244) → builds
  `admin/fees/BillingDetails.java` (resolves RTR/STR, runs `OrderPricePerMLAndQty`, computes net
  price per side via `createBillingItemsForNetPricing`).

### 4e. Trade rules (DB-backed)
- `core/RegionTradingRelationship.java` → table `region_trading_relationship` (exchange rate,
  suspended, sale/permanent flag); matcher uses `regionTradingRelationshipDao.findActiveBySecondaryKey`.
- `core/StateTradingRelationship.java` → table `state_trading_relationship` (season-window string
  dates, suspended); `stateTradingRelationshipDao.findBySecondaryKey`.
- `util/errors/WaterfindErrors.checkTradability(...)` — pre-trade gate (property approved +
  ownership, STR then RTR). **Forward orders bypass STR/RTR.**

---

## Part 5 — Settlement / billing / downstream (`WaterOfferBo.add` and below)

All flows converge on **`WaterOfferBo.add(...)`** (`business/core/WaterOfferBo.java:2278`, the 9-arg
overload), reached from `orderNow` (:5220) and from offer-acceptance paths (`acceptOffer` :2228,
`acceptCounterOffer` :1880). Synchronous, in-transaction, under the market lock:

1. **Invoice number** — `waterfindAdminBo.incrementAndGetLongValue("invn")` (atomic counter in
   `WATERFIND_ADMIN`) (:2300).
2. Fast-clearing **water-float** confirm (:2316-2330).
3. **VIC form 39/43** numbering from `WaterfindAdmin` (:2340-2365).
4. Persist `TenderOffer`/`WaterOffer`; inactivate alerts (:2356-2360).
5. **Loyalty points** `loyaltyAccountBo.creditPointsForCompletedTrade` (:2419).
6. **Action log** `actionLogBo.logWaterOfferCompleted` (:2422).
7. **Approval procedure** `approvalProcedureBo.autoAddApprovalProcedure(wo)` (:2424) — clones a
   template tree into 7 `approval_procedure*` tables. **Exceptions swallowed** (cannot roll back the
   trade). `business/trade/ApprovalProcedureBo.java:578`.
8. **Invoice processing** `doAutomatedInvoiceProcessing` → `WaterfindInvoiceProcessing.automatedInvoiceProcessing`
   (`admin/fees/WaterfindInvoiceProcessing.java:84`) — builds buyer+seller billing line items
   (water value, Waterfind/professional fees, authority fees, fast-clearing fee), broker commission
   (`WaterfindResellerBilling`), payment schedule (perm = 10%/90%; forward = deposit fractions);
   **in `finally`, sends transfer-invoice PDFs by email** to buyer/seller/admin/reseller.
9. **Commission index** `WaterfindCommissionIndex.updateWaterfindCommissionIndex` (:2436).
10. **Trade-completed listeners** `notifyTradeCompletedListeners(wo)` (:2439) →
    `TradeCompletedListener` interface; **only impl** is `business/contact/ContactBo.java:115`
    (sales-tag expiry truncation — CRM-internal, no external effect).
11. **Completed-trade staff alert** `generateTradeCompletedAlert` (:2441) — internal email.

**Billing tables:** `WATERFIND_BILLING` (client invoice lines), `WATERFIND_RESELLER_BILLING` (broker
commission), `WATERFIND_TRUST_ACCOUNT`. Amendment/settlement layer = `business/trade/WaterfindBillingBo.java`
(`storeInvoiceItems` :205 also **pushes to MYOB**; `markAuthorityChecked` :542 = auth1/auth2/settlement
sign-off).

**Not on the clearing path (deferred manual finance steps):**
`business/trade/AuthorityPaymentBo.java` (`authority_payment`), `business/trade/ClientPaymentBo.java`
(`client_payment`), `business/trade/VicAuditBo.java` (read-only CSV export). All admin-action driven.

**5.8 MYOB** — `business/myob/MyobBo.addMyobObjects(...)` (called `OrderListingBo` :5404), gated by
`isMyobEnabled()` (reads `myob_settings`). **Async** on a 5-thread `ExecutorService` (detached
objects), **outside the clearing tx**, **no outbox table** (fire-and-forget). External:
**MYOB AccountRight cloud REST** (Trust + General company files) via the `crm/MyobService/` module.
This is the riskiest external coupling.

**5.9 Broker feedback** — `business/sales/BrokerFeedbackFormBo.sendBrokerFeedbackForm` (:183) — survey
link via email/SMS; form row (`broker_feedback_form`) only on submission.

**5.10 Cash float** — `business/cashfloat/CashFloatAccountBo.java` — **only** used on FINANCE
(forward-financed) and REMOTE_MARKET branches, not plain spot clears. `reserveCashAmount` (:316) /
`confirmReservedCash` (:271); tables `cash_float_account`, `cash_float_account_transaction`,
`cash_float_account_region` (balance is derived `SUM(amount)`; `amount` is dollars, not ML).

---

## Part 6 — Notifications & alerts

> **Architectural gotcha:** despite the `*Thread` class names, `EmailMessage` and `SmsThread` extend
> `SynchronousMailOperation`; `EMailThreadRunner.startEmailOperation()` calls `operation.run()`
> **synchronously**. No threads are spawned. Every email/SMS fires **inline in the trade
> transaction**, except for remote trades where the thread-local queue defers them to commit.

| Source (file:line) | Trigger | Channel / template | Recipients |
|---|---|---|---|
| `OrderListingBo.sendNotificationForOrder` (5778) | match completed | email `order-accepted.vm`, `order-buy-sell.vm` + SMS | owner, counterparty, BCC admin/referral |
| `OrderListingBo.sendDeletedNotification` (5640) | split remainder auto-deleted | email `order-deleted.vm` | owner, BCC admin/referral |
| `OrderListingBo` add-listing block (6808 / 7214) | order created/edited | email `order-created-modified.vm` + SMS | login user, CC client, BCC admin/referral |
| `OrderListingBo.notifyListenersOfNewListing` (467) | listing added | in-process `ActiveOrderListener` | — (cache/UI) |
| `TradeAlertBo.notifyClientsOfNewOrder` (2133) | new order/alert | email `potential-order.vm` + SMS; **writes `wateralert_history`** | matched-order owners; debits loyalty points |
| `TradeAlertBo.inactivateAttachedAlerts` (1345) | before re-notify | DB only (`active=false`) | — |
| `WaterfindInvoiceProcessing.automatedInvoiceProcessing` (84) | every settle | email `transfer-invoice-{buyer,seller,admin}.vm` (+ PDFs) | buyer, seller, admin, reseller |
| `WaterOfferBo.generateTradeCompletedAlert` (2783) | every settle | internal email | staff |

**Egress gateway (the choke point):** `util/mail/SynchronousMailOperation.doSend` (email) and
`util/SmsUtil.sendSms` / `SmsThread` (SMS). When `mail.host == "notificationservice"` both route to
the in-process `NotificationService` (`crm/NotificationService/`): `EmailProcessor` → SMTP
(historically SendGrid, host from config); `SmsProcessor` → POST to an internal SMS endpoint
(ClickSend is the provider behind it, not referenced in this repo). **Deferred email** uses
`ServiceRequest`'s thread-local `MessageQueue` (enabled only for remote trades at `orderNow` :4903,
flushed by `sendQueuedMessages` :5388).

---

## Part 7 — Remote / inter-exchange trading

**Outbound only, single remote market: "NSW – MIL" (Murray Irrigation), region `678`.** Triggered
when a sell listing's `remoteReference` is non-blank.

- `OrderListingBo.attemptRemoteTrading` (:5419, in clearing tx) → `processRemoteTrade` (:5494,
  **`@Transactional(REQUIRES_NEW)`** — commits independently of the clearing tx). Redundant-server
  guard returns null → trade fails.
- `webservices/remotemarket/RemoteMarketService.java` (singleton) → `MILMarketTrader.performTrade`
  (HTTP GET `{waterfind.mil.url}/performTrade?…`, Gson, **no auth, 0 retries**) and
  `MILMarketScraper.scrapeMarket` (HTTP GET `/get-data`).
- Partial/failed fill → re-list unfilled water via `addNewOrderListing(details,false)` attributed to
  the MIL trader property/owner; reserve+confirm cash float; write `remote_trade_history`.
- `syncOrderListingsWithRemoteListings*` (:3413) reconciles local `order_listing` rows (add/update/
  soft-delete) against the scraped MIL listings, capped by the REMOTE_MARKET cash-float limit.
- History: `business/remotetrading/RemoteTradeHistoryBo` → table `remote_trade_history`.
- **Inbound `/services/remoteTrade`** is **mis-named and dormant** — it's the consumer SMS-reply
  webhook (`TradeAlertBo.processClientSmsResponse`), unauthenticated, **disabled since 2015**; it
  creates/clears nothing. Treat as a separate, dead concern.

---

## Part 8 — Cross-cutting infrastructure & hard constraints

- **Market lock** — `business/LockMarket.java` (marker annotation) + `business/MarketLockAspect.java`
  (`@Aspect`): one **fair `ReentrantLock`** (`new ReentrantLock(true)`), `@Before` lock / `@After`
  unlock, **no timeout** (waits forever), reentrant. Carried by ~25 methods across `OrderListingBo`,
  `WaterOfferBo`, `ManualSaleBo`, and the delegate facade. ⇒ **clearing is serialized, single-node**.
- **Delegate boundary** — `WaterfindDelegate` is class-level `@Transactional(REQUIRES_NEW)` (:652);
  `WaterfindDelegateAspect` wraps every public method: ServiceRequest/Response setup, >5 s logging,
  `@AfterThrowing → reportError`, and the **cooperative rollback bridge** (if
  `ServiceResponse.isRollbackOnly()` → throw `UnrecoverableServiceException` → Spring rolls back).
- **Thread-locals** — `server/ServiceRequest.java` (loggedInUserId, userCredentials, paging,
  `MessageQueue`, manual-sale buyer/seller ids, nesting count, processKey) and
  `server/ServiceResponse.java` (paging response, rollbackOnly, embedded exception).
- **Session/bootstrap** — `Waterfind.java`: `getWaterfindDelegate()` (:550, returns the proxy),
  `getSession()` (:1232, Spring contextual session), `getProperties()`, `isRedundantServer()`.
  Legacy `transactionBegin/Commit` are no-ops (Spring owns the tx). Multi-tenancy is an **app-layer**
  check (`validateAccessRestriction`, Struts-level) — **no Hibernate filter, no DB isolation**.
- **AOP is proxy-based** (`<aop:aspectj-autoproxy/>`, no weaving). ⇒ **self-invocations bypass
  advice** (see Part 12).
- **Audit/tracking** — `core/Tracking.java` (`Tracking` table; `TOBA/TOBN/TOBE/TOSA/TOSN/TOSE`
  modes + market-updated timestamps), `business/log/ActionLogBo.java` (`ActionLog` table; **skipped
  if loggedInUser is null**), `business/ProgressRegistry.java` (in-memory only; no-op without a
  processKey).
- **DI graph** — `OrderListingBo` (`@Service`) `@Autowired`s ~25 DAOs + ~28 BOs (incl.
  `TradeAlertBo`, `WaterOfferBo`, `MyobBo`, `RegionBo`, `LoyaltyAccountBo`, `ApprovalProcedureBo` via
  `WaterfindInvoiceProcessing`, `CashFloatAccountBo`, `RemoteTradeHistoryBo`, `TenantBo`, …). A
  standalone instantiation is infeasible without the full Spring context.

---

## Part 9 — Complete data footprint (DB tables)

**Order/trade core (the IN-scope tables):**
`order_listing` (STI, discriminator `order_type` B/S), `order_region`, `order_completed`,
`wateroffer`, `tenderoffer`, `wateralert`, `wateralert_history`, `water_alert_tolerances`,
`future_order`, `region_trading_relationship`, `state_trading_relationship`, `remote_trade_history`.

**Written by the settlement/finance side of a clear:**
`waterfind_billing`, `waterfind_reseller_billing`, `waterfind_trust_account`,
`approval_procedure` (+ `_milestone`, `_task`, `_assignee`, `_action`, `_recipient`,
`_action_tasks`), `cash_float_account` (+ `_transaction`, `_region`), `tracking`, `action_log`,
loyalty + commission-index tables, `waterfind_admin` (sequence counters `invn`, `vic43`).

**Shared reference data (read, owned elsewhere):**
`waterfind_user` (STI, discriminator `subclass`), `property`, `region`, `state`, `territory`,
`client_authority`, `terms_and_condition_history_item`, `myob_settings`.

**Cross-cutting:** single global `hibernate_sequence` for IDs; multi-tenancy is app-layer only.

Mapping styles are mixed: hand-written `*.hbm.xml` for `com.waterfind.core.*`
(`OrderListing`, `WaterOffer`, `TenderOffer`, `CompletedOrders`, `OrderRegion`,
`RegionTradingRelationship`, `StateTradingRelationship`) and annotated entities in
`com.waterfind.hibernate.*` (`Wateralert`, `WateralertHistory`, `WaterAlertTolerances`,
`FutureOrder`, `ClientAuthority`, `RemoteTradeHistory`). Schema source of truth:
`crm/waterfind.com.au/sql/schema/production-schema.sql`.

---

## Part 10 — The isolation map

### IN scope — order/trade-specific code that would move with the slice
- **Engine:** `business/orders/{OrderListingBo, TradeAlertBo, OrderMatchingPolicy, OrderMatch,
  ActiveOrderFacade, Find*Policy, Notify*Policy}.java`; `offer/order/OrderPricePerMLAndQty.java`.
- **Clearing/lock:** `business/{LockMarket, MarketLockAspect}.java`; `orderNow` (:4823).
- **Settlement (order-specific portions):** `business/core/WaterOfferBo.java`,
  `admin/fees/{WaterfindInvoiceProcessing, BillingDetails, TradeDetails}.java`,
  `business/trade/{WaterfindBillingBo, ApprovalProcedureBo, TradeCompletedListener}.java`.
- **Remote:** `webservices/remotemarket/**`, `business/remotetrading/RemoteTradeHistoryBo.java`.
- **Entities:** the 12 order/trade-core entities + their DAOs (Part 9).
- **Entry points:** the actions/servlets/jobs in Part 1.

### SHARED dependencies — used by orders but owned by the wider monolith (the welds)
- `server/WaterfindDelegate.java` (the God facade) + `WaterfindDelegateAspect` + `ServiceRequest`/
  `ServiceResponse` + `Waterfind.java` bootstrap.
- The Spring context, `HibernateTransactionManager`, contextual session, the global
  `hibernate_sequence`, app-layer multi-tenancy.
- Reference data: `waterfind_user`/`property`/`region`/`state`/`territory`/`client_authority`/T&Cs.
- Cross-domain BOs invoked on a clear: `MyobBo` (+ `MyobService` module), `LoyaltyAccountBo`,
  `CashFloatAccountBo`, `RegionBo`, `AdminBo`/`WaterfindAdminBo`, `ActionLogBo`, `Tracking`,
  `BrokerFeedbackFormBo`, `ContactBo`.
- Notification gateway: `util/mail/*`, `util/SmsUtil`, `NotificationService` module.

### OUT of scope — adjacent but not triggered by clearing
- `business/trade/{AuthorityPaymentBo, ClientPaymentBo, VicAuditBo}.java` (manual post-trade finance).
- `/services/remoteTrade` SMS webhook (dormant since 2015).

### Practical isolation implication
To trade as an external/isolated service you must **either** (a) call the monolith's
`WaterfindDelegate` over RPC and let it hold the market lock (the pbxapp-style integration the
architecture docs recommend), **or** (b) replicate the entire aspect stack — market lock + delegate
transaction/error boundary + thread-local context + contextual Hibernate session + the ~12 entities
and their shared reference data — and **coordinate the lock across JVMs** (the in-JVM `ReentrantLock`
gives no cross-node safety; two live nodes clearing = double-sell). Option (b) also drags in billing,
approval-procedure, MYOB, loyalty, cash-float and the notification gateway, because `orderNow` calls
them synchronously (MYOB excepted). The clean seam is the delegate method boundary, not the BO.

---

## Part 11 — What a programmatic out-of-request caller must set up

1. Obtain the Spring `ApplicationContext` (`Waterfind.setApplicationContext(ctx)` or an initialized
   `ServiceLocator`); ensure `Waterfind` properties + `sessionFactory` are configured.
2. Per worker thread, before each op: `ServiceRequest.prepare(); ServiceResponse.prepare();` then
   **`ServiceRequest.getServiceRequest().setLoggedInUserId(userId)` — mandatory** (read at
   `addNewOrderListing` :6954 and `processOrderNow` :4602; also gates audit logging). Set
   `setUserCredentials(...)`; for manual sales set `currManualBuyerId/SellerId`. Call
   `markDelegateInvokationStart()` if bypassing the servlet filter.
3. **Invoke through `Waterfind.getWaterfindDelegate()`**, never the raw BO — otherwise no
   transaction, no thread-bound Hibernate session (`getCurrentSession()` fails), no market lock, no
   rollback bridge, no RBAC.
4. `processKey` only if driving the GWT progress bar; else leave null (progress no-ops).

The web tier does steps 1–2 automatically in `WaterfindServletFilter` + `WaterfindHibernateThreadFilter`.

---

## Part 12 — Discrepancies & things to verify

1. **The documented double-sell mechanism is more subtle than `README.md` fact #2 states.** AOP is
   proxy-based (no weaving). `completeOrder` (:4737) and `processOrderNow` (:4662) reach `orderNow`
   via a **same-class `this.` call**, which **bypasses the proxy** — so the inner
   `@Transactional(REQUIRES_NEW)` and the inner `@LockMarket` on `orderNow` **do not start a new
   transaction or re-acquire the lock** on the auto-clearing path. Double-sell safety therefore rests
   on (a) the **outer** `@LockMarket` (on `addNewOrderListing` / the delegate) serializing the whole
   operation, and (b) the in-method re-fetch + `getDateCompleted()!=null` guard (:4863-4878) — **not**
   on "the DB commits before the lock releases" at the `orderNow` level. ⇒ **Verify the relative
   advice ordering of `MarketLockAspect` vs the transaction interceptor on the *delegate* method**
   (`@Order`): the no-double-sell property requires the commit to land *before* the lock unlocks at
   the outermost `@LockMarket`+`@Transactional` boundary. This is worth a focused test.
2. **No-login order endpoints** (`/oo-submit`, `/dynamic-order-submit`) create orders without auth,
   and any direct delegate caller bypasses the Struts-layer RBAC entirely. Confirm rate-limiting /
   abuse controls before exposing.
3. **MYOB sync is fire-and-forget with no outbox** — a crash between commit and MYOB submission
   silently drops the accounting record. Confirm whether reconciliation exists.
4. **Approval-procedure creation swallows exceptions** (`WaterOfferBo` ~2424) — a cleared trade can
   silently lack its regulatory approval workflow.
5. `core/billing/Billing.setIsSales(boolean)` self-assigns (`Billing.java:249`) — likely-dead broker
   routing; flagged by the settlement trace.
