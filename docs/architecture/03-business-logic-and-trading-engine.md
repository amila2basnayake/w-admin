# 03 — Business Logic, the Trading Engine, Web Services & Jobs

Scope: `crm/waterfind.com.au`. This is the heart of the system. Stack adds: Spring AOP (AspectJ),
Quartz 1.8.3 + `java.util.Timer`.

## (a) Layering — everything funnels through one facade

```
HTTP entry → Action → WaterfindDelegate → *Bo (business object) → *Dao → Hibernate → PostgreSQL
```

Three parallel front ends share the same business core: **Struts Actions**
(`src/com/waterfind/action/**`), **GWT-RPC servlets** (`src/com/waterfind/gwt/**` is ~860 files total;
the server-side impls in `src/com/waterfind/gwt/server/**` are ~48; 40+ servlets under `/gwt/*`), and
minimal **DWR**.

### The central facade: `WaterfindDelegate`
`src/com/waterfind/server/WaterfindDelegate.java` — **~383 KB, ~996 public methods**, hundreds of
`@Autowired` BOs. Class-annotated `@Transactional(readOnly=false, propagation=REQUIRES_NEW) public
class WaterfindDelegate implements MetricsDelegate, MyobDelegate`. Actions obtain it via:

```java
protected WaterfindDelegate delegate = com.waterfind.Waterfind.getWaterfindDelegate();
```

It mostly forwards to BOs. **`WaterfindDelegateAspect`** (`src/com/waterfind/server/WaterfindDelegateAspect.java`,
`@Aspect`) wraps every public delegate method: marks the `ServiceRequest`/`ServiceResponse`
boundary, logs long-running ops (>5 s → `PROCESS_LOG`), on `@AfterThrowing` calls
`delegate.reportError(...)`, and inspects `ServiceResponse.isRollbackOnly()` re-throwing
`UnrecoverableServiceException` to force a Spring rollback. **So the delegate boundary == the
transaction boundary == the error-reporting boundary.**

### Business objects (`*Bo`)
`src/com/waterfind/business/**` (335 files, by domain: `orders`, `trade`, `core`, `marketevents`,
`myob`, `email`, `user`, `loyalty`, `allocation`, `damstorage`, `phonesystem`, `salesmanager`,
`jobscheduler`, `remotetrading`, …). `@Service`, extend `business/WaterfindBusinessObject` (shared
helpers: formatting, email/SMS, velocity, `ServiceRequest` access). **They are very fat** —
`OrderListingBo` 326 KB, `ApprovalProcedureBo` 274 KB, `TradeAlertBo` 155 KB. These big classes are
the real "modules."

### Cross-cutting request/response context
`com.waterfind.server.ServiceRequest` / `ServiceResponse` are **thread-local** holders carrying
paging criteria, the logged-in `UserCredentialsDto`, a `MessageQueue<Message>` for deferred email,
manual-sale buyer/seller ids, the rollback flag, and a delegate-nesting count. This is how the
business layer reads "who is logged in" and "queue or send email now" without parameters. **Note for
us:** background threads / out-of-request callers must set these up themselves.

## (b) THE TRADING / MARKET ENGINE

Two coupled engines plus a settlement path, mostly in `business/orders/` and `business/trade/`.

### Domain concepts
- **Listing / order** = `OrderListing` (`core/order/OrderListing.java`) → `BuyOrderListing` /
  `SellOrderListing`: price-per-ML, available quantity, split rule, delivery date (forward orders),
  region, property/licence, fees, and an `OrderRegion` set (regions it may trade into).
  "Invitation for offers" listings are display-only and excluded from auto-clearing.
- **TenderOffer** = a negotiated proposal; **WaterOffer** (`core/WaterOffer.java`) = the resulting
  concrete trade going to settlement/billing; `CompletedOrders` wraps both sides.
- **Trade rules** = `RegionTradingRelationship` (RTR) + `StateTradingRelationship` (STR): whether
  region A may trade with B and at what exchange rate. `RegionTradingRelationship.getRtr(from, to,
  isSale)` returning null → `WaterfindErrors.ERROR_NO_RTR`, trade rejected.

### Matching abstraction (Strategy + Facade)
- `business/orders/ActiveOrderFacade.java` (abstract) — uniform mask over the four matchable things:
  `OrderListing`, `WaterOffer`, `Wateralert`/trade-rule, `OrderRegion` (each has a `*ActiveOrderFacade`
  wrapper). Exposes `isBuyOrder()`, `isOpen()`, `isTradeTarget()`, `getAllowedTradeRegions()`, etc.
- `business/orders/OrderMatchingPolicy.java` (abstract) — the matching **strategy**.
  `getMatchingPolicy(listing, tolerances)` returns `FindAllOrdersForRegionPolicy` (region),
  exact-match `FindSellersForNewBuyerPolicy` / `FindBuyersForNewSellerPolicy` (tolerances null), or
  fuzzy `NotifySellersOfNewBuyerPolicy` / `NotifyBuyersOfNewSellerPolicy` (tolerances given). It holds
  the **matching predicates**: `canTradeOnPrice` (buyer ≥ seller, rounded to cents to dodge float
  error), the `canTradeOnVolume*` family (four split/no-split permutations), and
  `canTradeOnForwardDeliveryDate`.
- `business/orders/OrderMatch.java` — value object `(toOrder, fromOrder, bidirectional, fuzzy,
  tolerances)`; `equals/hashCode` use only to/from so duplicate notifications are suppressed.

### Engine 1 — auto-clearing / order matching (continuous-clearing)
Entry: **`OrderListingBo.orderMatchingForOrder(...)`** (`business/orders/OrderListingBo.java:6546`).
1. Loads the listing, calls the business overload.
2. Loops `orderMatchingItr(...)` (`:6614`) while matches keep being made / count changes (stops when
   stable or `quantityAvelable` hits 0) — keeps clearing the new listing against the resting book.
3. `orderMatching(listing)` (`:6676`): gets candidate `OrderRegion`s via
   `tradeAlertBo.findingMatchingOrderRegions(...)`, builds `BillingDetails` per candidate via
   `waterfindInvoiceProcessing.getMarketPriceForOrder(...)`, and **sorts the book** with
   `compareBillingDetails(...)` (`:6735`): best price → larger volume → non-split → shorter transfer
   → earliest `datePlaced` (**price-time-volume priority**).
4. `orderMatchingItr` takes the top match → `completeOrder(...)` (`:4717`) → `orderNow(...)` (`:4818`).

### The clearing transaction: `OrderListingBo.orderNow(...)` (`:4818`) — the single most important method
```java
@LockMarket
@Transactional(readOnly = false, propagation = Propagation.REQUIRES_NEW)
public TenderOffer orderNow(...)
```
Re-fetches Hibernate objects under the new tx; re-checks each listing isn't already completed
(`getDateCompleted()!=null` → `ERROR_PARCEL_NOT_AVAILABLE`); resolves from/to region + isSale; loads
the RTR (rejects if none); reconciles price & quantity (`offer/order/OrderPricePerMLAndQty.java`,
throws `ERROR_PRICE_NOT_MATCH` / `ERROR_NOT_ENOUGH_WATER`); handles dual-listings (price re-derived
per region); creates `TenderOffer` + `WaterOffer` + `CompletedOrders`, copying reseller
fees/commission/accepted-terms onto each side; for remote parcels sets the thread-local message-queue
so notifications defer until commit.

### Market concurrency control — `@LockMarket` (critical constraint)
`business/LockMarket.java` + `business/MarketLockAspect.java` (`@Aspect`). The aspect holds **one
process-wide fair `ReentrantLock`** and `@Before`/`@After` lock/unlock around any `@LockMarket`
method. **The entire market is serialized through a single in-JVM lock — only one trade clears at a
time, app-server-wide** (no timeout — it waits forever). `orderNow` uses `REQUIRES_NEW` so the DB tx
**commits before the lock releases**, preventing double-sells. **Clearing is single-node and
single-threaded.** A microservice that mutates the market must call a `@LockMarket` business method —
it cannot safely bypass this.

### Engine 2 — trade-alert / "water alert" matching (the fuzzy notification engine)
`business/orders/TradeAlertBo.java` (`@Service`, 155 KB) — the "trade rules" engine that matches
*rules* (`Wateralert` + `WaterAlertTolerances`) and resting orders to **notify** clients (not
auto-clear). Key methods: `findingMatchingOrderRegions(...)` (`:3338`, also used by Engine 1),
`filterOrders(...)` (`:3554`, builds an `OrderMatchingPolicy`, fuzzy → loads active tolerances),
`doOrdersMatch(...)` (`:3634`, region allow-list + not-expired + forward-date + policy price/volume
checks), and the `notifyClientsOfNewOrderListing(...)` / `notifyWaterAlertOfExistingOrders(...)`
senders that write `WateralertHistory` rows (tolerances recorded → auditable). De-dup via
`OrderMatch.equals`.

### Settlement / billing
`business/core/WaterOfferBo.java` handles negotiated-offer + post-clear settlement (many `@LockMarket`
methods, e.g. `acceptOffer(...)`, `acceptCounterOffer(...)`). On completion fires
`notifyTradeCompletedListeners(wo)` → the `business/trade/TradeCompletedListener.java` interface
(implemented as an in-process pub/sub over a `CopyOnWriteArrayList` held in `WaterOfferBo`).
Downstream: `business/trade/WaterfindBillingBo.java`,
`business/trade/ApprovalProcedureBo.java` (the **regulatory transfer/approval workflow** — fees,
stamp duty, PDF terms), `AuthorityPaymentBo`/`ClientPaymentBo`, MYOB sync, and
`business/trade/VicAuditBo.java` (Victorian audit).

### Remote / inter-exchange trading
`OrderListingBo.processRemoteTrade(...)` (~`:5500`) → `RemoteMarketService.getInstance()
.getRemoteTrader(regionId)` → `remoteTrader.performTrade(criteria)` (currently `MILMarketTrader` over
HTTP/JSON). Results reconciled, persisted via `remoteTradeHistoryBo`, unfilled portion re-listed.

## (c) Web services & API inventory

**Key fact:** `webapp/WEB-INF/sun-jaxws.xml` is **empty** — the CRM exposes **no JAX-WS SOAP
endpoints**. Inbound RPC = GWT-RPC + Struts `@JsonAction` JSON + raw servlets. SOAP/EWS is
**outbound only**.

### Inbound — GWT-RPC servlets (trading-relevant, mapped in `web.xml`)
| URL | Impl |
|---|---|
| `/gwt/trade` | `gwt.server.trade.TradeServiceImpl` |
| `/gwt/intenttotrade` | `gwt.server.trade.IntentToTradeServiceImpl` |
| `/gwt/tradingrelationships` | `gwt.server.trade.TradingRelationshipsServiceImpl` |
| `/gwt/order/order`, `/gwt/order/ordernow` | `gwt.server.order.OrderServiceImpl`, `OrderNowServiceImpl` |
| `/gwt/clientcrm` | `gwt.server.crm.ClientCRMServiceImpl` |
| `/gwt/region/region`, `/gwt/wmi`, `/gwt/loyaltyaccount`, `/gwt/phone` | region / market-info / loyalty / phone |

### Inbound — raw servlets (the integration callback surface)
| URL | Servlet | Purpose |
|---|---|---|
| `/services/remoteTrade` | `servlet.RemoteTradeServlet` | callbacks from remote markets (MNet SMS) |
| `/services/dataScraper` | `servlet.DataScraperServlet` | datascraper trigger/results |
| `/services/jobScheduler` | `servlet.JobSchedulerServlet` | job scheduler control |
| `/secure/pbx` | `servlet.phonesystem.PhoneSystemRPCServlet` | inbound PBX events (shared-secret) |
| `/services/pbxpolling` | `servlet.phonesystem.PhoneSystemAsyncServlet` | comet/long-poll phone events |
| `/myob` | `myob.servlet.MyobAuthServlet` | MYOB OAuth callback |
| `/services/MigrateUsers` | `servlet.user.UserMigrationServlet` | user migration |

### Outbound SOAP / HTTP clients — `src/com/waterfind/webservices/**` (68 files)
| External system | Client | Protocol |
|---|---|---|
| **VIC Water Register** (DEPI/DELWP WCF) — trade feasibility | `webservices.vicregistry.VicRegisterProxy` (`doTradeWithinVictoriaCheck`, `doTradeToNSWCheck`, …) | hand-built SOAP (`javax.xml.soap`), **NTLM** |
| **MIL market** (Murray Irrigation, NSW region 678) | `webservices.remotemarket.traders.MILMarketTrader` / `MILMarketScraper`, orchestrated by `RemoteMarketService` | HTTP GET `/performTrade?…`, JSON via Gson |
| **MS Exchange / Office 365** (email scraping) | `webservices.email.EmailProxy` (IndependentSoft EWS) | EWS SOAP to `outlook.office365.com` |
| **Gmail** (legacy) | `webservices.email.gmail.EmailProxy` | Gmail API |
| **BOM / NWS** weather | `webservices.resources.bom.*`, `webservices.resources.nws.*` | file/HTTP |
| **PBX** (pbxapp) | `webservices.phonesystem.PhoneSystemProxy` (`@Service`) | custom HTTP-RPC over TLS |

## (d) Background jobs

**Two schedulers coexist:** Quartz 1.x (`webservices.jobscheduler.WaterfindJobScheduler`, 3 threads —
DB-driven business/email jobs) and `java.util.Timer` (legacy — scraper + utility tasks).

**Gating:** bootstrapped in `WaterfindConfigurator` —
`if (properties.getProperty("waterfind.taskmanager").equals("true")) delegate.startTasks();`
→ `business.TaskDispatcherBo.startTasks()`. The flag defaults **true in `build.properties`** and is
explicitly **false only in `server-dev` and `server-prod-usa`** → so it resolves to **on** for
test, prod-AUS **and warm** (which inherit the default). The intent is for one live AUS node to run
jobs; the `warm` standby also has it enabled but suppresses the outbound side-effects via
`is-redundant-server=true`. **Running the schedulers on two live, non-redundant nodes double-sends
email and double-imports scraped data** — so the gating must be managed carefully across the fleet.

DB-driven scheduling tables: `SCRAPER_TASK_MANAGER` (`core.scheduletaskmanager.TaskManager`),
`SCRAPER_SCHEDULER_MANAGER` (`ScheduleManager`, the soft cross-node coordinator), `ENEWS_JOB`.

Selected jobs (paths under `src/com/waterfind/`):
- **Scrapers** (`core.scheduletaskmanager.ScraperTaskDispatcher`, Timer): WATERMOVE, MURRAY_IRR,
  DIPNR/DIPNR_PERMANENT, WATERX, MURRUMBIDGEE_WATER, VICTORIAN_WATER_REGISTER, NRM_REGISTER(_SUPP).
- **Quartz** (`servlet/timertasks/*Job`): finance/billing (`FinanceCommissionReportJob`,
  `TradeProgressReportJob`), email (`OverdueTradesEmailJob`,
  `IntentToTradeNotificationJob`, `BrokerActiveTradesEmailJob`, …), market data
  (`MarketDataServiceUpdateJob` refreshes the `webservices.data.MarketDataService` cache,
  `NswSalesScraperJob`, `EmailScraperJob`).
- **Utility Timer tasks** (`util/timertasks/*`, via `TaskDispatcherBo`): `ExpiryNotification`
  (~15 min — expires orders/offers), `TimerAuthorityInvoice` (hourly — authority invoicing),
  **`FutureOrderAutoMatchingTask` (hourly — re-runs the matching
  engine for forward orders)**, `OrderReminderTask`, `ApprovalNotifyData`, `ExpiredWaterAlert`. These
  are how the clearing engine gets re-driven on a schedule, not just on order placement.

## (e) How the core integrates with the 6 satellites (summary; detail in doc 05)

| Satellite | Integration style | Core-side client |
|---|---|---|
| WaterfindServiceModel | shared library (not a service) | classpath src + jar |
| MyobService | **in-process jar** | `business/myob/MyobBo.java` (`@Autowired MyobService`); async via `ExecutorService` |
| NotificationService | **in-process jar** (config switch) | `util/SmsUtil.java`, `util/mail/SynchronousMailOperation.java` (gate `mail.host == "notificationservice"`) |
| datascraper | **in-process jar** | scraper Timer tasks + `business/prospective/ProspectiveDataScraperBo.java` |
| dataimport | **in-process jar** | `business/dataimport/DataImportRunner.java` (own thread, `DataImportRegistry` progress) |
| pbxapp | **network RPC over HTTPS + shared secret** | `webservices/phonesystem/PhoneSystemProxy.java`; inbound to `/secure/pbx` |

So **4 of 6 are compiled-in jars, 1 is a true networked service (pbxapp), 1 is a shared model jar.**
No satellite uses SOAP.

## (f) Guidance for integrating our microservice (business tier)

- **Where to invoke from:** add a `@Service *Bo` under `business/<domain>/` extending
  `WaterfindBusinessObject`; `@Autowired` it into other BOs, or expose via `WaterfindDelegate` for
  Actions/GWT. Don't call services from Actions directly — go Action → `delegate` → BO. The
  transaction + error boundary is the delegate method.
- **Sync vs async idioms:** for "don't make the user wait", follow `MyobBo` —
  `ExecutorService threadPool = Executors.newFixedThreadPool(N); threadPool.submit(...)` (there is no
  Spring `@Async`/JMS). For email that must fire only on commit, use the thread-local `MessageQueue`.
  For scheduled work, add a Quartz `*Job` or a `util/timertasks` Timer task wired into
  `TaskDispatcherBo` — but it only runs where `waterfind.taskmanager=true`.
- **Wiring choices** mirror what exists: *in-process jar* (Myob/Notification/datascraper/dataimport
  pattern) or *networked RPC* (pbxapp pattern — a proxy under `webservices/<svc>/` modelled on
  `PhoneSystemProxy.sendRemoteAction`, endpoint from config, inbound servlet under `/services/` or
  `/secure/`). See doc 07.
- **Hard constraints:** market mutation behind `@LockMarket` (clearing is single-node/single-thread);
  Hibernate session is request/thread-bound (background threads need their own session handling);
  versions pinned (Quartz 1.x, Hibernate 3, Spring 2.5, Struts 1, Java 6/7) — no Spring Boot/JPA.

### File index
- Engine: `business/orders/{OrderListingBo, TradeAlertBo, OrderMatchingPolicy, OrderMatch,
  ActiveOrderFacade, Find*Policy, Notify*Policy}.java`
- Clearing/lock: `business/{LockMarket, MarketLockAspect}.java`; `OrderListingBo.orderNow` (`:4818`)
- Settlement: `business/core/WaterOfferBo.java`, `business/trade/{WaterfindBillingBo,
  ApprovalProcedureBo, VicAuditBo, TradeCompletedListener}.java`
- Facade/context: `server/{WaterfindDelegate, WaterfindDelegateAspect, ServiceRequest,
  ServiceResponse}.java`, `Waterfind.java`
- Web services: `webservices/{vicregistry/VicRegisterProxy, remotemarket/RemoteMarketService,
  remotemarket/traders/MILMarketTrader, email/EmailProxy, phonesystem/PhoneSystemProxy,
  data/MarketDataService}.java`; config `webapp/WEB-INF/{web.xml, sun-jaxws.xml, dwr.xml}`
- Jobs: `core/scheduletaskmanager/{TaskManager, ScheduleManager, ScraperTaskDispatcher}.java`,
  `business/TaskDispatcherBo.java`, `webservices/jobscheduler/WaterfindJobScheduler.java`,
  `servlet/timertasks/*Job.java`, `util/timertasks/*.java`
