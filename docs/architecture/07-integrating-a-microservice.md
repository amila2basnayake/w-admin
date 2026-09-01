# 07 — Integrating Our Microservice: the Playbook

This consolidates the integration findings from docs 01–06 into a single decision guide. It assumes
we honour `CLAUDE.md`: **match the exact legacy stack** (Java 6/7, Ant 1.8.1, PG 8.2, Resin 3.1.7a,
Spring 2.5, Hibernate 3) — no Spring Boot, no JPA, no modern Quartz, no newer JDBC driver.

## Step 0 — pick the integration shape

The codebase already contains four patterns. Pick by what the service needs:

| Pattern | Example in repo | Use when |
|---|---|---|
| **In-process jar + IoC delegate** | MyobService (`MyobApi` + `MyobDelegate`) | Pure API client, no independent lifecycle, must reach CRM data through the host. |
| **In-process jar (config-switched)** | NotificationService, datascraper, dataimport | A capability the monolith calls on its hot path; can also stand alone. |
| **Standalone WAR + HTTP-RPC + shared secret** | **pbxapp** (`/secure/pbx`) | A genuine separate process/host, its own lifecycle, possibly its own DB. **This is the template for "our microservice."** |
| **Web-tier `@JsonAction`** | 155 existing actions | A browser-driven, request-scoped call from an existing screen. |

**Recommended default for a new microservice: model on pbxapp** — a Resin 3.1.7a WAR on its own host
with a `/secure/<name>` HTTP-RPC endpoint authenticated by `waterfind.shared-secret`, plus a matching
`XxxProxy` + `XxxRPCServlet` pair in the monolith. Borrow NotificationService's **JSON-over-POST**
contract style and (if the monolith must also call us in-process) its **Ivy client-jar** publishing.
**Do not introduce JAX-WS/SOAP** — nothing inbound here uses it.

## Step 1 — create the project (build)

Add an SVN project `crm/<NewService>/` with `build.xml` modeled on `crm/pbxapp/build.xml` (WAR) or
`crm/MyobService/build.xml` (jar-only). Mirror the established targets:
`clean / make-dirs / compile (source=1.6 target=1.6, forked) / jar / merge-properties / build-webapp
/ release / scp-prod`, and the `check-local-properties → load-local-properties → load-properties`
chain.

Vendor dependencies into `lib/` (runtime) + `lib-dev/` (build-only), **reusing the pinned jars
already in-tree** (`postgresql-8.2-506.jdbc3.jar`, `log4j-1.2.15.jar`, `hibernate3.jar`,
`spring.jar`, `commons-*`, `shiro-all-1.2.3.jar`) rather than newer versions.

If the monolith must compile/call us **in-process**, register in `crm/waterfind.com.au/build.xml`:
add `<property name="<newservice>" location="../<NewService>"/>`, a `check-<new>-built` + `make-<new>`
pair, add `make-<new>` to **`compile-dependents`** (~line 797), and add the jar to
**`dependents.classpath`** (~line 112) so it lands in `build-dev/waterfind/WEB-INF/lib`. If we depend
on the shared model, copy NotificationService's `make-servicemodel` pattern.

## Step 2 — define the contract

- **Java interface** as the real contract (like `MyobApi` / `INotificationService`); the servlet is
  just transport. If others embed our types, publish a **client jar** to the SVN-backed Ivy repo
  (`ivy-client.xml` + `ivysettings.xml`, `fm.last.ivy.plugins.svnresolver.SvnResolver`), keeping
  DTOs/interfaces in it and implementations out.
- **Wire format:** JSON via Gson `UPPER_CAMEL_CASE` (match `WaterfindServiceModel`'s
  `util/json/JSONUtils` so payloads are platform-consistent). Prefer **JSON-over-POST** (the more
  modern of the two existing styles).
- **If we adopt the shared model** (doc 04): consume `IUserCredentials` for identity, return
  `PagingResponse`/accept `PagingCriteria` for lists, use `RPCDate` for browser-facing dates, and
  shape the service interface like `IAssetRegisterService` (extend `IService`; `IResultSet<T>`,
  `ISearchCriteria`, `ICreateCriteria`). This is optional — 4 of 6 satellites stay self-contained.

## Step 3 — wire into the monolith

Two mechanisms, by deployment shape:

- **Remote HTTP (pbxapp precedent — preferred for a separate process):** add an `XxxProxy`
  (`@Service`) under `crm/waterfind.com.au/src/com/waterfind/webservices/<svc>/`, modelled on
  `PhoneSystemProxy.sendRemoteAction`, reading the endpoint URL from config
  (`waterfind.<svc>.secure-url`) and appending `shared-secret`. Add an `XxxRPCServlet` under
  `servlet/` + a `web.xml` mapping (`/services/<svc>` or `/secure/<svc>`) for callbacks. Invoke the
  proxy through `WaterfindDelegate` (add a method there) so it's reusable across the web tier —
  remember the delegate boundary is the transaction + error boundary.
- **In-process bean + delegate callback (MYOB precedent):** declare the service as a Spring bean in
  `src/spring-context.xml` with `init-method`, and have `WaterfindDelegate` implement our
  `XxxDelegate` callback so the jar can reach CRM persistence without depending on it.

For a browser-driven call from an existing screen, the lightest seam is a new **`@JsonAction`** (doc
01) that calls our proxy and `writeJsonResponse(...)`.

## Step 4 — data

- **Prefer our own database** (pbxapp precedent: a dedicated `pbxapp` DB). Use the established stack:
  `BasicDataSource` from `jdbc-waterfind.*` → `AnnotationSessionFactoryBean` (`PostgreSQLDialect`,
  `packagesToScan`) → `HibernateTransactionManager` → `@Service @Transactional` BOs over a generic
  `CoreDao<E>`. Generate entities via `generate-hbm-pojos` if we want DB-first POJOs.
- **If we must touch the shared `waterfind` DB** (doc 02): the schema is the contract
  (`production-schema.sql` + later `REV*`), and you **must**: use `nextval('hibernate_sequence')` for
  PKs, respect discriminator columns (`waterfind_user.subclass`, `order_listing.order_type`),
  **replicate the multi-tenant access filter** (`tenant_to_user`/`access_level` — or you leak
  cross-client data), and normalize timestamps explicitly (columns are `without time zone`,
  server-local). Don't reuse `CoreDao` verbatim (its OSIV/thread-local-paging assumptions break
  outside the GWT request).
- **Do not write the trade/market tables directly** (`order_listing`, `order_completed`, `wateralert`)
  — see Step 5.

## Step 5 — respect the hard invariants

1. **Market mutation goes through `@LockMarket`.** Clearing is serialized by one process-wide
   `ReentrantLock` (`MarketLockAspect`) and uses `@Transactional(REQUIRES_NEW)` so the DB commits
   before the lock releases (no double-sells). If our service triggers a trade/clear, it must call a
   `@LockMarket` business method (e.g. via `WaterfindDelegate` → `OrderListingBo`/`WaterOfferBo`),
   **not** mutate market rows. Clearing is effectively single-node/single-threaded — design around
   that.
2. **Hibernate sessions are request/thread-bound** (`WaterfindHibernateThreadFilter`). Any background
   thread we spawn must manage its own session (see `DataImportRunner`, `MyobBo`'s `ExecutorService`).
   The business layer reads identity/paging from thread-locals (`ServiceRequest`) — set them up, or
   they're null off-request.
3. **Scheduling is one-node.** If we add scheduled work to the monolith, it runs only where
   `waterfind.taskmanager=true`. A self-scheduling standalone service avoids this but is a departure
   from current practice (the dormant datascraper Quartz webapp is the precedent).
4. **Auth is opt-in at the web tier.** Any new `@JsonAction`/servlet must set `isLoginRequired()`
   and/or `@AccessRestriction` (and add itself to the right filter exclusion regexes if it shouldn't
   run a Hibernate transaction). The `SecurityFilter` does not authenticate.
5. **Regulatory/audit fit.** Anything touching trades, orders, licences, or trust accounts must fit
   the existing audit-log (`com.waterfind.log`) and approval-workflow (`com.waterfind.approval` /
   `ApprovalProcedureBo`) machinery — this is an ISO-9001, independently-audited, multi-jurisdiction
   regulated system.

## Step 6 — config & secrets

- Provide the full tier set: `build.properties` (defaults) + `server-{dev,test,prod,prod-usa,warm}.properties`
  + a committed `local-server-dev.properties.sample`. Add a `merge-properties` target writing
  `com/waterfind/configuration/<newservice>.properties` (filter `waterfind.*`, `mail.*`,
  `jdbc-waterfind.*`, `hibernate.*`, `log4j.*` + our own prefix).
- Respect the existing flags: honour `waterfind.is-redundant-server` (suppress outbound side-effects
  on standby), gate any scheduler behind `waterfind.taskmanager`, read region/unit/theme props for
  AUS-vs-USA, and reuse `waterfind.shared-secret` for server-to-server RPC auth.
- **Break with legacy on secrets:** keep credentials out of committed `server-prod.properties`. Use
  gitignored `.env` / `local-server-<host>.properties`, or DB-stored settings fetched via a delegate
  (as MYOB does). Do not copy the trust-all TLS helpers (`EasyX509TrustManager`,
  `SSLCertTrustModifier`) or the weak `EncryptionUtils` (hard-coded key/zero IV).

## Step 7 — deploy

- Build a `web.xml` with a `<load-on-startup>` **configurator servlet** (loads props + log4j before
  beans/threads start — copy pbxapp's `PbxAppConfigurator` / NotificationService's
  `NotificationServiceConfigurator`) + the **RPC servlet** under `/secure/<name>`.
- Deploy as an exploded webapp under its own Resin 3.1.7a host (own `port.range` in a
  `webserver/server-N.properties` → Resin HTTP port `<port.range>00`), or as a context in the existing
  Resin. Add an Apache `ProxyPass /<name> http://localhost:<port>/` vhost
  (`webserver/httpd/conf.d/`) if it needs external exposure.
- log4j 1.2.15 `DailyRollingFileAppender` to `${resin.log.path}/<service>.log`, configured by the
  configurator at `load-on-startup=1` (guard with the `isLog4jConfigured()` helper so an embedding
  parent's config isn't clobbered).

## TL;DR checklist

- [ ] New `crm/<NewService>/` Ant project, Java 1.6 target, vendored pinned jars, full property tiers.
- [ ] Java-interface contract; JSON-over-POST (Gson UpperCamelCase); optional Ivy client jar.
- [ ] Standalone Resin WAR + `load-on-startup` configurator + `/secure/<name>` RPC (shared secret).
- [ ] Monolith side: `XxxProxy` (`@Service`) in `webservices/<svc>/` + `XxxRPCServlet` + a
      `WaterfindDelegate` method; optional `@JsonAction` for screen calls.
- [ ] Data: own PG DB preferred; if shared, obey `hibernate_sequence` + discriminators + tenant
      filter + TZ-less timestamps.
- [ ] Trade mutation only via `@LockMarket` business methods; background threads manage own Hibernate
      sessions.
- [ ] Auth: `isLoginRequired()`/`@AccessRestriction` on any web entry; audit/approval fit for
      regulated data.
- [ ] Secrets in `.env`/`local-*`/DB — never committed; no trust-all TLS, no weak crypto.
