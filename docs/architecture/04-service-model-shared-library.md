# 04 — `WaterfindServiceModel` (the shared contract/util library)

Path: `crm/WaterfindServiceModel` — 99 Java files under `src/com/waterfind/`. This is the shared
**model / contract / SPI + utility** library and a **GWT module**. It matters most for integration
because it is the cleanest existing place to define cross-process contracts — but note (below) that
most satellites do **not** actually use it.

## (a) What it is and who depends on it

Built by Ant into one jar: `crm/WaterfindServiceModel/build/waterfindservicemodel-<host>.jar`
(`build.xml` target `jar`). Ships its own third-party jars in `lib/` (Gson, Shiro, Spring, log4j,
BouncyCastle, iText, Velocity, jsoup, commons-*). No `test/`.

**It is NOT a clean standalone DTO jar** — it deliberately shares the `com.waterfind.*` namespace with
the webapp. Consumers add it **both** as a built jar **and** as a source path, so the two trees merge
at compile time:
- `crm/waterfind.com.au/.classpath`: `<classpathentry kind="src" path="/WaterfindServiceModel"/>`
- `crm/waterfind.com.au/build.xml` line 88 (`${servicemodel-src}` on the path) + lines 125–128 (copy
  the jar + its `lib/*.jar` into `WEB-INF/lib`).

**Actual consumers (build.xml + real imports):**

| Project | Depends? | Evidence |
|---|---|---|
| `waterfind.com.au` | **YES, heavily** | src-path + jar. Uses `ServiceLocator`, `PagingCriteria`, `PagingResponse`, `MetricsManager`, `MetricsDelegate`, `IUserCredentials`, `ITenant`, `IUserRole`. (NB: many `com.waterfind.server.*`/`webservices.*` classes the webapp imports actually live in the *webapp*, same package names, not here.) |
| `NotificationService` | **YES, trivially** | `make-servicemodel`/`compile-dependents` in build.xml; only source import found is `com.waterfind.util.io.IOUtils`. |
| `MyobService` | No | own `com.waterfind.myob.*` / `security.*` |
| `dataimport` | No | own `com.waterfind.data.imp.*` |
| `datascraper` | No | own `com.waterfind.{data.scraper,scraper,net}.*` |
| `pbxapp` | No | own `com.waterfind.pbx.*` |

**So only the core webapp (heavily) and one satellite, NotificationService (trivially), depend on it**
— the other four satellites (MyobService, dataimport, datascraper, pbxapp) were built independently
with private `com.waterfind.*` subpackages. "Integrate via the model" is a deliberate choice, not the
norm.

**It is also a GWT module** — `src/com/waterfind/ServiceModel.gwt.xml` exports the browser-safe
contract types: `user/{IUserCredentials, ITenantCriteria, ITenant, IUserRole}.java`,
`util/date/RPCDate.java`.

## (b) Package-by-package (paths under `crm/WaterfindServiceModel/src/com/waterfind/`)

- **`annotation/`** — two markers: `Immutable.java`, `JsonAction.java` (an empty marker — no
  `@Retention`/`@Target`). This is **not** a dead stub: the webapp's heavily-used `@JsonAction`
  (155 use-sites) resolves to *this* class via the bundled jar. By contrast, `@AccessRestriction`
  lives only in the webapp (not here).
- **`asset/`** — the **Asset Register contract** (water entitlements as tradable assets), mostly
  interfaces: `IAssetRegisterService.java` (`getAssetById`, `addEditAsset`, `findAssets` →
  `IResultSet<IAsset>`), `IAsset.java`, `IWaterAsset.java` (`ASSET_TYPE="WaterEntitlement"`),
  `IAssetField`, `IAssetCreateCriteria`, `IAssetSearchCriteria`; several empty placeholders
  (`IAssetOwnership`, `IAssetComment`, `IAssetAttachment`). **The most fleshed-out service contract —
  the template if we build an "asset register" service.**
- **`dto/ui/`** — `UiComponentDto` (url + initFunction) and `UiTabDto` (a dynamic UI tab descriptor).
  (The hundreds of business DTOs the webapp uses live in `waterfind.com.au`, not here.)
- **`exception/`** — `AppRequestNotStartedException` (thrown by `AppRequest` before `startRequest`).
- **`security/`** — Shiro-based primitives: `WaterfindAuthorizationInfo` (wraps roleIds + permissions
  into Shiro `WildcardPermission`s), `WaterfindSecurityManager` (singleton, bounded auth cache,
  static wildcard `isPermitted`). Permission model is `tenant:resource:action` wildcard strings.
- **`server/`** — the **integration heart**:
  - `IAppRequest.java` + `AppRequest.java` — thread-local per-request context holding a **stack of
    `IUserCredentials`** (`startRequest`/`endRequest`/`login`/`logout`/`getLoggedInCredentials`); the
    stack supports "admin impersonating a client".
  - `IAppContext.java` + `ServletAppContext.java` — abstraction over attribute get/set (decouples
    from `HttpSession`).
  - **`ServiceLocator.java`** — Spring `XmlWebApplicationContext` singleton; static
    `<E> E getService(Class<E>)` / `getBean(...)`. Expects `classpath:spring-context.xml`. The
    standard way to obtain service beans.
  - `PagingCriteria.java` (+ `SortProperty`, enum `SortDirection`), `PagingResponse.java`,
    `PagingPage.java` — the shared **pagination contract** (placed on thread-local, applied by the
    DAO layer).
- **`service/`** — thin SPI markers: `IService` (base), `INotificationService`, `IUserService`
  (`addUser`, `sendContactMessage`), `ISearchCriteria`, `ICreateCriteria`, `IRecord`,
  `IResultSet<T>`.
- **`user/`** — the most-reused identity contract: `IUserCredentials` (`getUsername`, `getUserId`,
  `isAdmin/isSales/isOnliner`, `hasRole`, `isPermitted`, `getTenants()`), `IUser` (full model),
  `ITenant`/`ITenantCriteria` (multi-tenant org), `IUserRole`, `IContactInfo` (+ name/address/email/
  phone), `IContactMessage`.
- **`webservices/`** — the model contributes only two subpackages (the webapp owns the rest):
  - `webservices/filter/ApplicationFilter.java` — servlet `Filter` that wraps each request in
    `AppRequest.startRequest(ctx)` … `endRequest()`. **The bootstrap that makes the thread-local
    request/credentials machinery work.**
  - `webservices/metrics/` — the site performance-metrics subsystem (see (d)).
- **`util/**`** — broad toolbox (see (e)).

## (c) Cross-process contracts a microservice would implement/call

1. **`server/ServiceLocator`** — fetch service beans (`getService(MyService.class)`). Requires
   `classpath:spring-context.xml`.
2. **`user/IUserCredentials`** + **`server/IAppRequest`/`AppRequest`** — the per-request identity
   contract carried thread-local (session key `"waterfind_user_credentials"`;
   `AppRequest.ATTRIBUTE_CREDENTIALS_STACK = "credentialsStack"`).
3. **`security/WaterfindAuthorizationInfo` / `WaterfindSecurityManager`** — Shiro
   `tenant:resource:action` wildcard permissions.
4. **`webservices/metrics/MetricsDelegate`** — an **SPI the host must implement** (`addSiteMetric`,
   `logPathAccessed`) and register as Spring bean **`"metricsDelegate"`**; `MetricsManager` and
   `SiteMetricsFilter` look it up by that name (via `ServiceLocator.getBean`) and inject it into the
   `DefaultMetricProcessor` subclasses (constructor injection). The cleanest "library defines
   interface, host provides persistence" example.
5. **`service/*` + `asset/IAssetRegisterService` + `service/IUserService`** — service-layer contracts
   (`IResultSet<T>`, `ISearchCriteria`, `ICreateCriteria`). Mostly marker-level; `IAssetRegisterService`
   is the fullest.
6. **GWT contract** (`ServiceModel.gwt.xml`): `IUserCredentials`, `ITenant`, `ITenantCriteria`,
   `IUserRole`, `RPCDate` (timezone-independent date for RPC).

## (d) Shared conventions to adopt

- **Request lifecycle:** register `webservices/filter/ApplicationFilter` first so the
  `AppRequest`/credentials thread-local is set up and torn down per request.
- **Metrics:** put `SiteMetricsFilter` at the top of the chain; implement `MetricsDelegate` as Spring
  bean `"metricsDelegate"`. Pipeline: `SiteMetricsFilter` → `MetricsManager` (singleton, 2 threads,
  4000-slot queue) → `MetricProcessor{Duration,FileSize,HitCounter}` → aggregate `Observation`s →
  flush every 10 min via the delegate. User actions tagged CLIENT/SALES/ADMIN by credential type.
- **Service lookup:** `ServiceLocator.getService(...)`, don't `new` services.
- **Security:** Shiro wildcard strings `tenant:resource:action`; build `AuthorizationInfo` via
  `WaterfindAuthorizationInfo`.
- **Paging:** return `PagingResponse`/`PagingPage`, accept `PagingCriteria`.
- **JSON:** Gson with `FieldNamingPolicy.UPPER_CAMEL_CASE` (see `util/json/JSONUtils`) — match it so
  payloads are wire-compatible with the rest of the platform.
- **Build:** Ant with a `<host>` (dev/test/prod) property; depend on the model via the
  `check-servicemodel-built` / `make-servicemodel` / `compile-dependents` pattern (copy the jar +
  its `lib/*.jar`).

## (e) Reusable utilities (`util/**`)

- **JSON** — `json/JSONUtils` (Gson, UpperCamelCase). Highest reuse value.
- **Date/time** — `date/DateUtil` (889 lines: parse/format, working-day math, period boundaries),
  `date/RPCDate` (TZ-safe date for GWT-RPC).
- **Currency/number** — `currency/CurrencyUtils` (BigDecimal HALF_UP to 2dp), `number/NumberUtils`,
  `bool/BooleanUtils`.
- **Encryption** — `encryption/EncryptionUtils` (BouncyCastle AES/CFB8 — **hard-coded key + zero IV,
  weak**), `encryption/MD5Utils`. ⚠️ Use only for interop with existing data; never for new secrets.
- **Net/HTTP** — `nodejs/NodeJsUtils` (POST JSON to a Node service, e.g.
  `http://host:3700/publish`), `net/SSLCertTrustModifier` (**trust-all TLS — security-sensitive**).
- **Servlet** — `servlet/ServletUtils` (typed param getters, `writeJsonResponse`, mobile detection),
  `servlet/ByteCounterServletOutputStream`.
- **HTML/PDF/image/velocity** — `html/HtmlUtils`, `html/AutomaticCssInliner` (jsoup, email),
  `pdf/PDFUtils` (725 lines, iText), `image/ImageUtils` (headless rendering), `velocity/VelocityUtils`.
- **File/IO** — `file/FileUtils`, `file/CSVUtils` (503 lines), `io/IOUtils` (the one util
  NotificationService imports), `io/DBCursor`.
- **Collections/sorting/indexing** — `list/*`, `string/WfStringUtils`, `sorting/*`,
  `index/BinaryTree*Index`, `concurrent/LockCondition`.

## (f) Recommendation — what our microservice should import/implement

To fit cleanly:
1. **Build against `waterfindservicemodel-<host>.jar`** (+ its `lib/*.jar`), following the
   `make-servicemodel`/`compile-dependents` Ant pattern; pin the same versions.
2. **Consume `IUserCredentials`** as the identity type; install `ApplicationFilter`; read the
   principal from session key `"waterfind_user_credentials"`.
3. **Resolve collaborators via `ServiceLocator`**; expose our service as a Spring bean; provide
   `classpath:spring-context.xml`.
4. **Emit metrics** by installing `SiteMetricsFilter` and **implementing `MetricsDelegate`** as bean
   `"metricsDelegate"` — the one mandatory SPI for platform-consistent observability.
5. **Authorize** with `WaterfindAuthorizationInfo` + the `tenant:resource:action` wildcard model.
6. **Speak the wire conventions:** `JSONUtils` (Gson UpperCamelCase) for JSON, `PagingCriteria`/
   `PagingResponse` for lists, `RPCDate` for browser-facing dates, `NodeJsUtils` if we call existing
   Node components.
7. **Define our contract as a `service`/`asset`-style interface** (extend `IService`; use
   `IResultSet<T>`, `ISearchCriteria`, `ICreateCriteria`), mirroring `IAssetRegisterService`.
8. **Reuse, don't reinvent** `DateUtil`, `CurrencyUtils`, `IOUtils`, `CSVUtils`, `WfStringUtils`.

⚠️ Caveats: depending on the model is a **choice** (4 of 6 satellites stay self-contained — a cleaner
boundary, like pbxapp). And **do not reuse** `EncryptionUtils` (hard-coded key/zero IV) or
`SSLCertTrustModifier` (trust-all TLS) for anything new.
