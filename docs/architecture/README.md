# Waterfind AUS CRM — Architecture Reference

> A full-pass map of the legacy Waterfind codebase, written so we know **what is where, how
> things are done, and what to watch for** before we change anything or integrate our microservice.
>
> Produced 2026-06-18 from the SVN checkouts in `crm/` (branch `Iteration45`, rev 25467). Every
> claim cites a concrete file path under `crm/…`. If a file moved, trust the path over the prose —
> verify before relying on it.

## How to use these docs

| Doc | What it covers |
|---|---|
| **README.md** (this file) | System overview, the 7-project map, runtime topology, the big cross-cutting facts, and the doc index. Start here. |
| [`01-web-presentation-tier.md`](./01-web-presentation-tier.md) | Struts/JSP/GWT/DWR front end, request lifecycle, auth, how to add a screen. |
| [`02-domain-and-data-tier.md`](./02-domain-and-data-tier.md) | The water-trading data model, Hibernate/DAO/DTO layers, the database. |
| [`03-business-logic-and-trading-engine.md`](./03-business-logic-and-trading-engine.md) | Service layer, **the trade-matching/clearing engine**, web services, background jobs. |
| [`04-service-model-shared-library.md`](./04-service-model-shared-library.md) | `WaterfindServiceModel` — the shared contract/util library and integration SPIs. |
| [`05-satellite-services.md`](./05-satellite-services.md) | dataimport, datascraper, MyobService, NotificationService, pbxapp. |
| [`06-build-config-deploy-db.md`](./06-build-config-deploy-db.md) | Ant build order, layered config, Resin/Apache deploy, multi-region topology, DB. |
| [`07-integrating-a-microservice.md`](./07-integrating-a-microservice.md) | **The playbook** — how to plug a new service in, and the constraints we must respect. |
| [`08-buy-sell-order-path.md`](./08-buy-sell-order-path.md) | **The buy/sell order path** — every programmatic trigger, the full matching→clearing→settlement spine, and the complete isolation map (what's order-specific vs shared). |
| [`../broker-advisory/data-map.md`](../broker-advisory/data-map.md) | **Broker advisory data map** — every DB field useful for advising a customer on the most effective trades (*what's stored & where*), grounded in the live DB, with runnable SQL (`advisory-toolkit.sql`) and a real worked example. Build-input for the advisory capability. |

## What this system is

Waterfind is a **double-sided water-trading exchange** ("a stock market for water"): ~15,000
clients, hundreds of open regional markets, tens of thousands of standing trade rules, across
multiple Australian state jurisdictions and the Murray–Darling Basin, plus a separate USA
deployment. The codebase is a **2010s-era legacy Java monolith** (`waterfind.com.au`, ~4,090 Java
files under `src/`, ~4,145 including tests) surrounded by six smaller SVN projects. It is EOL-stack
throughout — match versions exactly (per `CLAUDE.md`) or it will not build/run.

**Confirmed stack:** Java 6/7 · Struts 1.3.10 + JSP + Tiles · GWT 2.5 / Ext-GWT (GXT) 2.x **and**
3.0.1 · DWR 2 · Spring 2.5 (DI + AspectJ AOP + `@Transactional`) · Hibernate 3 (XML *and*
annotated mappings) · **c3p0** connection pool · Apache Shiro (configured but inert) · Quartz 1.8.3
+ `java.util.Timer` · PostgreSQL 8.2 · Ant 1.8.1 (on Java 7) · **Resin 3.1.7a** · Apache httpd front
end · SVN.

## The 7 projects at a glance

| Project | Role | Artifact | Talks to core via | Own DB? | Uses ServiceModel? |
|---|---|---|---|---|---|
| **waterfind.com.au** | The CRM monolith + master build; web UI, trading engine, scheduler ("taskmanager") | exploded webapp `build-<host>/waterfind/` | — (it *is* the core) | shared `waterfind` | yes (heavily) |
| **WaterfindServiceModel** | Shared model/contract + util library; also a GWT module | jar `waterfindservicemodel-<host>.jar` | bundled into classpath | — | — |
| **dataimport** | CSV→validate→persist engine for all ingested data (the only writer) | jar `dataimport-<server>.jar` | **in-process jar** | shared `waterfind` | no |
| **datascraper** | Fetch+parse external registry/market/weather data; depends on dataimport | jar `datascraper-<server>.jar` (+ dormant standalone webapp) | **in-process jar** | via dataimport | no |
| **MyobService** | MYOB AccountRight cloud accounting client (General + Trust books) | jar `myobservice-<server>.jar` | **in-process jar** + `MyobDelegate` callback | none | no |
| **NotificationService** | Email (SendGrid) + SMS (ClickSend) gateway | jar **and** standalone WAR (`/secure/notifications`) | **in-process jar** *or* JSON-over-HTTP | none | yes (lightly) |
| **pbxapp** | Asterisk PBX/telephony bridge (screen-pop, click-to-dial) | standalone WAR (`/secure/pbx`:4433) | **HTTP RPC + shared secret** | own `pbxapp` DB | no |

**Correction to a common assumption:** only the **core monolith** (deeply) and **one of the six
satellites — NotificationService** (trivially) depend on `WaterfindServiceModel`. MyobService,
dataimport, datascraper and pbxapp carry their *own* private `com.waterfind.*` subpackages and are
self-contained. "Integrate via the shared model" is therefore a *choice*, not the universal norm —
see doc 04 and 07.

## Runtime topology

```
                       Internet
                          │  443 (SSL terminated)
                 ┌────────▼─────────┐
                 │   Apache httpd   │  webserver/httpd/conf.d/waterfind.conf
                 │  80→443 redirect │  ProxyPass / → localhost:11000
                 └────────┬─────────┘
                          │  http :11000+   (port = <port.range>00)
                 ┌────────▼───────────────────────────────────────┐
                 │  Resin 3.1.7a app-tier  (-Xmx8500m, exploded)   │
                 │                                                 │
                 │  waterfind.com.au  (the monolith)               │
                 │   └─ statically bundles, in WEB-INF/lib:        │
                 │        waterfindservicemodel, dataimport,       │
                 │        datascraper, myobservice, notification   │
                 │   └─ runs the scraper/timer "taskmanager"       │
                 │      (only where waterfind.taskmanager=true)    │
                 └───┬───────────────┬───────────────┬─────────────┘
                     │ JDBC          │ HTTP+secret   │ HTTP+secret
            ┌────────▼───────┐  ┌────▼────────┐  ┌───▼──────────────┐
            │ PostgreSQL 8.2 │  │   pbxapp    │  │ NotificationSvc  │
            │  DB "waterfind"│  │ /secure/pbx │  │ /secure/notif.   │
            └────────────────┘  │ :4433 →AMI  │  │ →SendGrid/Click. │
                                │ own pbxapp  │  └──────────────────┘
                                │   DB        │
                                └─────────────┘
   Outbound SOAP/HTTP (consumed, not exposed): VIC Water Register (NTLM SOAP),
   MIL remote market (HTTP/JSON), MS Exchange/Office365 EWS, BOM/NOAA weather, MYOB cloud REST.
```

The **same artifacts** deploy to multiple nodes/regions, selected purely by `-Dhost=<tier>` at
**build time**: `dev`, `test`, `prod` (AUS), `prod-usa` (USA — different theme, units AF/Tax,
DB `waterfind-1`), `warm` (AUS hot standby), plus numbered servers 1–4. See doc 06.

## The ten facts that will bite us

1. **Everything funnels through one God facade.** `com.waterfind.server.WaterfindDelegate`
   (~383 KB, ~996 public methods) is *the* business entry point. Actions/GWT/tags all call
   `delegate.xxx()`. The delegate method boundary == the **transaction boundary** == the
   **error-reporting boundary** (`WaterfindDelegateAspect`). The real "modules" are a handful of
   colossal classes: `OrderListingBo` (326 KB), `ApprovalProcedureBo` (274 KB), `TradeAlertBo`
   (155 KB). See doc 03.

2. **The market clears under a single, process-wide lock.** `@LockMarket` + `MarketLockAspect`
   hold one in-JVM `ReentrantLock`; clearing methods use `@Transactional(REQUIRES_NEW)` so the DB
   commits *before* the lock releases (no double-sells). Clearing is effectively **single-node,
   single-threaded**. Anything that mutates the market must go through a `@LockMarket` business
   method — never write the trade tables directly. See doc 03.

3. **Auth is opt-in, not default.** A `WaterfindAction` is public unless it overrides
   `isLoginRequired()` → true and/or carries `@AccessRestriction` (~137 actions do override it, most
   requiring login — so the risk is the *new* action that forgets, not broad exposure). The filter
   named `SecurityFilter` does **no auth** (it's an IP blocklist). Apache Shiro is wired but inert (a
   live `DelegatingFilterProxy` sits in the chain with an empty rule set). Real authz happens in the
   Hibernate filter via `Waterfind.validateAccessRestriction()`. See doc 01.

4. **Two entity-mapping styles share one SessionFactory.** Hand-written XML mappings in
   `com.waterfind.core` (`*.hbm.xml`) **and** annotated, DB-first reverse-engineered entities in
   `com.waterfind.hibernate`. Some concepts exist in both. Check which style before editing.
   See doc 02.

5. **The DB schema is the real contract; the Java model is leaky.** Single `public` schema,
   single global `hibernate_sequence` for IDs, single-table inheritance with discriminator columns
   (`waterfind_user.subclass`, `order_listing.order_type`), **no Hibernate L2 cache**,
   timestamps are `without time zone`, and **multi-tenancy is an app-layer filter** (no DB
   isolation). A naive `SELECT *` leaks cross-client data. See doc 02.

6. **No inbound SOAP despite the "JAX-WS" label.** `sun-jaxws.xml` is empty. Inbound RPC =
   GWT-RPC + Struts `@JsonAction` JSON + a handful of raw `/services/*` and `/secure/*` servlets.
   SOAP/EWS is **outbound only** (to third parties). See docs 01 & 03.

7. **The de-facto service-call convention is HTTP-RPC with a shared secret**, not SOAP. pbxapp is
   the cleanest example (`/secure/pbx` GET with `action=` + `shared-secret`); NotificationService
   shows the JSON-POST variant (`/secure/notifications`). This is the pattern our microservice
   should follow. See docs 05 & 07.

8. **Config is resolved at build time and baked into the artifact.** Layered properties
   (`local-server-<host>` → `server-<host>` → `build.properties`) are flattened by Ant into one
   `com/waterfind/configuration/<project>.properties` on the classpath. There is no runtime config
   server. Per-environment jars differ. See doc 06.

9. **Scheduling lives in the monolith, gated per-node.** `core.scheduletaskmanager.ScraperTaskDispatcher`
   (java.util.Timer) + `servlet/timertasks/*Job` (Quartz), gated by `waterfind.taskmanager` (default
   `true`; disabled only on dev + prod-USA → on for test, prod-AUS and warm). The hourly
   `FutureOrderAutoMatchingTask` and `ExpiryNotification` re-drive the clearing engine. Running the
   schedulers on two live, non-redundant nodes double-sends email and double-imports data. See doc 03.

10. **Secrets are committed in plaintext** across several `build.properties`, `server-prod.properties`,
    `build.xml` and `ivysettings.xml` (SendGrid key, ClickSend key, Asterisk password, PBX shared
    secret, an SVN-Ivy password, FTP creds), and there is trust-all TLS (`EasyX509TrustManager`,
    `SSLCertTrustModifier`) and unsalted MD5 passwords. **Do not carry these forward** into our
    service; `CLAUDE.md` mandates secrets in gitignored `.env`. See docs 05 & 06.

## Outstanding blocker to a *running* app

Per `../../onboarding_log.md`: the build succeeds (`ant build-webapp`, ~33 min, on Zulu JDK 7 +
Ant 1.8.1), but **running** the app still needs the production DB bundle from Waterfind — the
`wf1win` dump, the `missing_tables/` SQL, and `sanitize_db.sql` (none are in SVN), plus ideally the
exact PostgreSQL 8.2.4 binaries. `sanitize_db.sql` sets every login password to `blue49`.

## Where our microservice plugs in (one-paragraph summary)

Model it on **pbxapp**: a Resin 3.1.7a WAR on its own host with (optionally) its own PostgreSQL DB,
Spring 2.5 + Hibernate 3, a `load-on-startup` configurator servlet, and a `/secure/<name>` HTTP-RPC
endpoint authenticated by `waterfind.shared-secret`. Add a matching `XxxProxy` (`@Service`) +
`XxxRPCServlet` pair to `waterfind.com.au`, invoked through `WaterfindDelegate`. Borrow
NotificationService's **JSON-over-POST** contract style and (if the monolith must call us
in-process) its **Ivy client-jar** publishing. If we touch trades/markets, go through a
`@LockMarket` business method — do not write the market tables directly. Full step-by-step in
[doc 07](./07-integrating-a-microservice.md).
