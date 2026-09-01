# 05 — Satellite Services (ingestion + standalone)

The five non-model satellites split into a **data-ingestion subsystem** (dataimport + datascraper)
and three **standalone integration services** (MyobService, NotificationService, pbxapp). All are
Ant + SVN, Java 1.6, log4j 1.2.15, deployed under Resin 3.1. These are the closest analogs to our
planned microservice — pbxapp especially.

---

## Part A — Data ingestion: `dataimport` + `datascraper`

Tightly coupled: **`dataimport`** is the validate+persist engine (and owns the Hibernate model for
ingested data), **`datascraper`** is the fetch+parse layer on top of it. Both are compiled into and
driven by the monolith.

### `dataimport` (396 Java files) — the import/persistence engine

- **Purpose:** does **not** fetch anything. It's a **CSV/bean → validate → persist** library that is
  the single shared write-path for ingested data. The breadth is the `ImportType` enum in
  `crm/dataimport/src/com/waterfind/data/imp/DataImportDelegate.java` (28 types, each with a
  documented CSV format): market/sales (`EXTERNAL_SALES`, `WF_FAIR_PRICE`, `PROPERTY_TRANSFER`,
  `WATERX_TRANSACTION`), hydrology/climate (`DAM_STORAGE_DATA`, `SNOW_SENSOR_DATA`, weather, `SOI_MONTHLY`),
  water-rights (`WMA_REGISTER_LICENCE`, `ALLOCATION_DATA`), trade rules
  (`REGION_TRADING_RELATIONSHIP`, `STATE_TRADING_RELATIONSHIP`), CRM (`USER`, `PROSPECTIVE_CLIENTS`,
  `COMMODITY*`).
- **Execution model:** **not standalone** — no `main()`. A Spring-managed library consumed in-process
  by (1) datascraper and (2) the monolith (manual CSV upload via
  `action/dataimport/DataImportUploadFileAction.java` → `business/dataimport/DataImportRunner.java`).
  It boots its own Spring container lazily: `DataImportServiceLocator` (singleton extending
  `ClassPathXmlApplicationContext`, loads `data-import-context.xml`); `DataImportDelegate.getInstance()`
  pulls the delegate bean.
- **Pipeline:** `DataImportDelegate` (`@Transactional` façade; `importBeanList`, `importCsvData`, plus
  typed DAO getters scrapers use for lookups) → `business/DataImportBo` (router; 28-arg `@Autowired`
  constructor; dispatches each bean by `getImportType()`; prepare-all → prepare-each → take-on-each →
  post-import, flushing every 50 records) → per-type `business/<domain>/*Bo extends
  ImportBusinessObject<Dto>` (CSV deserialize via **JSefa**, the `check*` validation framework, then
  `takeOn`). DTOs in `dto/<domain>/`; DAOs (63 files) extend `dao/CoreDao.java` (generic
  `HibernateDaoSupport`); **262 annotated Hibernate POJOs** in `hibernate/`.
- **Data in/out:** in = `List<DataImportDto>` or CSV; out = **directly to the CRM PostgreSQL DB via
  Hibernate** in a Spring tx (NOT via the core's web services). Wiring in
  `crm/dataimport/src/data-import-context.xml` (`BasicDataSource` + `AnnotationSessionFactoryBean`
  scanning `com.waterfind.data.imp.hibernate` + `HibernateTransactionManager`). It reads/writes the
  **same tables** as the core (a second Hibernate mapping over production), and the core even imports
  dataimport's POJOs directly (e.g. `WaterfindFairPrice`).
- **Build/config:** `build.xml` (default `all`=`clean`+`dist`) → `build/dataimport-<server>.jar`.
  Config is **merged at build time** (`merge-properties` layers `build.properties` +
  `server-<server>.properties` + optional `local-server-<server>.properties` → `data-import.properties`
  in the jar) — so the **DB URL is baked into the jar per environment**. Driver pinned
  `postgresql-8.2-506.jdbc3.jar`; CSV via `jsefa-0.9.2`.

### `datascraper` (76 Java files under src/) — the fetch/parse layer

- **Purpose:** fetches market, water-rights, and climate data from external sources, parses it, hands
  DTOs/CSV to `dataimport`. Sources (hardcoded URLs): AUS state registers (NSW
  `registers.water.nsw.gov.au`, VIC `waterregister.vic.gov.au`, SA `apps.waterconnect.sa.gov.au`,
  Murray Irrigation), competitor exchanges (WaterX, RuralCo, Watermove, Waterpool), climate (BOM,
  MDBA live river CSVs, weatherzone), commodity (IMF, Wisconsin dairy), and later USA sources
  (California CDEC, NOAA, Nevada/NM/Utah). Several modern scrapers no longer scrape HTML — they call
  an **internal scraper microservice** at
  `waterfind-prod-…elb.amazonaws.com:9102/data-scraper/...` returning JSON (parsed with Gson). *(That
  ELB-fronted JSON service is itself a precedent for "scraping extracted into a separate service.")*
- **Execution model (three coexist):** (1) **production path** — scrapers are instantiated and
  `.scrape()`-called from the monolith's `servlet/timertasks/` (43 timer-task classes) via
  `core/scheduletaskmanager/ScraperTaskDispatcher` (java.util.Timer) — i.e. **in-process inside the
  main webapp**; (2) datascraper's own Quartz webapp (`build-webapp.xml`, servlet `ScraperScheduler`
  at `/services/dataScraper`) — **dormant**, all `addDataScraperJob(...)` calls are commented out;
  (3) ad-hoc `main()` methods + the admin "secret script" panel.
- **Pipeline:** `data/scraper/DataScraperImpl.java` (abstract base; `takeOnData(...)` /
  `takeOnCsvData(...)` route to `DataImportDelegate.getInstance()`) → per-source scrapers under
  `data/scraper/<domain>/` (e.g. `sales/nsw/NswGovWmaSiteScraper`, `dam/BOMDamStorageSiteScraper`,
  `sales/ruralco/RuralCoScraper`). Networking in `com/waterfind/net/` (`HttpJobService` — queued
  multithreaded HttpClient). Parsing: **Jsoup** (HTML), **Gson** (JSON), **POI** (Excel), JSefa (CSV).
- **Data in/out:** in = HTTP/HTTPS (+ internal DB reads via dataimport DAOs for "importer" classes);
  out = **never opens its own DataSource** — writes go through dataimport's DAO/delegate layer.
  Most go through the validating import pipeline (`importBeanList`/`importCsvData`), but note some
  scrapers (e.g. `licence/NSWLicenceScraper`) call `dao.saveOrUpdate(...)` directly on a
  dataimport-owned DAO, **bypassing** the `check*` validation framework — so the "fetch/parse vs
  validate/persist" split isn't airtight. Errors route to a `SCRAPER_ERRORS` log4j logger with an
  **SMTPAppender** to `developers@nowmarketservices.com`.
- **Build/config:** `build.xml` (jar, auto-builds `../dataimport` first) + `build-webapp.xml`
  (standalone WAR → `deploy/datascraper-<host>.zip`). `build.properties` holds the Quartz cron, an
  **outbound HTTP proxy** (`218.30.35.86:8080`, read by `ScraperScheduler.init()`), and full log4j.
  ⚠️ **A live SendGrid API key is committed in `build.properties`.** DB connection inherited from the
  embedded dataimport jar.

---

## Part B — Standalone services: `MyobService`, `NotificationService`, `pbxapp`

Headline: these three are **not built the same way** — they span three deployment models, and only
**pbxapp** is a true independently-deployed service.

| | MyobService | NotificationService | pbxapp |
|---|---|---|---|
| Build output | plain JAR | **WAR + client JAR** | WAR |
| Runtime | **in-process** in the monolith (Spring bean) | **dual**: in-process JAR **and** standalone WAR with HTTP endpoint | **separate Resin host** |
| Exposed API | a Java interface (`MyobApi`) only | Java interface (`INotificationService`) + JSON-over-HTTP servlet | shared-secret HTTP-RPC servlet (GET) |
| DB access | none (delegates to core via callback) | none | **own PostgreSQL `pbxapp` DB** |
| Uses ServiceModel | no | **yes** | no |

### MyobService — MYOB accounting integration

- **Purpose:** thin Java client over the **MYOB AccountRight cloud REST API**. Manages two company
  files — **General** and **Trust** (the audited trust account) — as `CompanyFileCredentials`. JSON
  over HTTPS (commons-httpclient 3.1 + Gson), HTTP Basic per company-file
  (`x-myobapi-cftoken`/`x-myobapi-version: v2`).
- **Contract:** a plain Java interface **`com.waterfind.myob.MyobApi`** (impl `MyobService`). No
  servlet/SOAP/WSDL. Ops (each takes `CompanyFileCredentials` first): `addNewCustomer`,
  `getSales/getOrders/getInvoices`, `addNewOrder`/`convertOrderToInvoice`,
  `addNewSale`/`addNewProfessionalSale`, `getJobs/addNewJob`, `getAccounts`, `getTaxCodes`,
  `addNewSpendMoneyTxn`, `addNewPayment`.
- **How the core calls it — in-process:** core `build.xml` bundles `myobservice-<host>.jar`; core
  `spring-context.xml` declares `<bean name="myobService" class="com.waterfind.myob.MyobService"
  init-method="configure">` injected with `myobDelegate`. Core calls it through `MyobBo` /
  `WaterfindMyobUtils`. The **`MyobDelegate`** interface (single `getMyobSettings()`) is the IoC hook
  — the jar can't read the DB, so the host implements it (`WaterfindDelegate implements …,
  MyobDelegate`). At startup `configure()` pulls live credentials from the core's DB.
- **Deploy/DB/deps:** JAR only, runs in the core JVM; **no DB of its own** (no JDBC dep). Does **not**
  depend on WaterfindServiceModel. Sensitive per-company creds come from the DB at runtime (good
  pattern) — though `build.properties` still has a stale plaintext `api-key`/`api-password`.

### NotificationService — email/SMS gateway

- **Purpose:** **email** via SMTP (SendGrid) and **SMS** via the ClickSend HTTP API. `EmailProcessor`
  (JavaMail — but ⚠️ STARTTLS and `mail.smtp.auth` are **commented out**, `PORT=25` hardcoded, so mail
  goes out **plaintext on port 25**), `SmsProcessor.sendSms()` (GET to
  `https://api.clicksend.com/http/v2/send.php`, 160-char truncation). Marketing/Gmail scaffolding
  exists but the two live processors are email + SMS.
- **Contract — two layers:** (1) Java interface **`com.waterfind.notifications.INotificationService`**
  (`submitNotification(INotification)`, `submitNotificationJob`, `getProperty`), impl
  `impl.NotificationService` (singleton, routes by `TYPE_EMAIL`/`TYPE_SMS` to processors extending
  `BaseJobProcessor` — async queue, worker pool, batching, exponential-backoff retry ×4); (2) an
  **HTTP RPC endpoint** `NotificationApiRpcServlet` mapped to **`/secure/notifications`** — `doPost`
  of a **Gson JSON** body (`UPPER_CAMEL_CASE`) → `submitNotification`. A `NotificationServiceConfigurator`
  servlet (`load-on-startup=1`) loads props + log4j first.
- **How the core calls it — in-process (not via HTTP):** `util/mail/SynchronousMailOperation.java`
  line 126 `NotificationService.getInstance().submitNotification(...)`, gated on
  `mail.host == "notificationservice"`; `util/SmsUtil.java` likewise. Core build bundles
  `notificationservice-<host>.jar`. **Same code runs both ways** — embedded in the core JVM *and* as
  a standalone WAR exposing the JSON endpoint for remote callers.
- **The Ivy client-jar model:** `ivy-client.xml` declares module `com.now / notification-service-client`
  rev `0.1`; `ivysettings.xml` uses an **SVN-backed Ivy resolver** (`fm.last.ivy.plugins.svnresolver
  .SvnResolver`) at `svn+ssh://svn.nowmarketservices.com/svn/repo/WaterfindDev/ivyrepo`
  (creds `release`/`r3l3as3`), chained **behind** Maven Central (ibiblio is queried first, the SVN
  repo is the fallback in the `<chain returnFirst="true">`). This publishes the client
  interfaces/DTOs as a versioned jar so consumers can depend on a coordinate, not source. (In
  practice the core currently consumes it via the local Ant build.)
- **Deploy/DB/deps:** WAR + deploy zip (`scp-prod` → `/home/waterfind/notificationservice/deploy`),
  Resin. **No DB** (stateless apart from in-memory queues). **Depends on WaterfindServiceModel**
  (`make-servicemodel`). ⚠️ `build.properties` commits the SendGrid key (`SG.…`) + ClickSend key in
  plaintext (the same SendGrid key is also committed in `crm/datascraper/build.properties`).

### pbxapp — Asterisk PBX / telephony integration

- **Purpose:** bridges the office **Asterisk PBX** (AMI via `asterisk-java`) to the CRM for
  screen-pops and click-to-dial. `AsteriskProxy` keeps two AMI connections (listen + originate);
  `AsteriskEventProcessor` (10-thread queue) interprets bridge/hangup/CDR/dial/transfer events and
  maps SIP channels to calls.
- **Contract — shared-secret HTTP-RPC servlet** `PbxAppRPCServlet` at **`/secure/pbx`**. GET-based:
  validates `shared-secret` against `PbxService.getWaterfindSharedSecret()` (501 on mismatch), reads
  `action`; the one inbound command is **`pbx.dial`** (params `device_id`, `callerid`, `phone_number`).
  Outbound, pbxapp calls the core's mirror endpoint with `pbx.incoming-call`, `pbx.outgoing-call`,
  `pbx.call-ended`, `pbx.incoming-call-ringing`. `PbxAppConfigurator` (`load-on-startup=1`) loads
  props/log4j then `PbxService.init()`.
- **How the core calls it — symmetric HTTP-RPC over a shared secret (the cleanest two-service
  example):**
  - Core → pbxapp: `PhoneSystemProxy` (core, `@Service`) → `sendRemoteAction(...)` to
    `…/secure/pbx?action=pbx.dial&…&shared-secret=…` (fallback `https://203.122.237.217:4433/secure/pbx`).
  - pbxapp → core: `AsteriskProxy.sendRemoteAction()` GETs `waterfind.website.secure.url`
    (e.g. `https://my.waterfind.com.au/secure/pbx`).
  - Core receiving: `PhoneSystemRPCServlet` (its own `/secure/pbx`) validates the secret and dispatches
    `pbx.*` events into `PhoneSystemProxy` → comet-pushed broker screen-pop.
  No WSDL/shared interface — the contract is the agreed `action` strings + the shared secret.
- **Deploy/DB/deps:** WAR on **its own Resin host** near the PBX (`server-prod.properties`
  `resin.path=/opt/resin`; `scp-prod` → `192.168.5.13:/home/waterfind/phonesystemapp/deploy`).
  **Own PostgreSQL `pbxapp` DB**
  (`pbxapp-context.xml`: `BasicDataSource` + `AnnotationSessionFactoryBean` scanning
  `com.waterfind.pbx.hibernate` + `HibernateTransactionManager`); persists one entity `PbxLog`
  (`pbx_log`) via `PbxLogBo` → `PbxLogDao extends CoreDao<PbxLog>`. Does **not** depend on
  WaterfindServiceModel. ⚠️ Commits Asterisk manager password + shared secret.

---

## What these teach us about running standalone/background services here

1. **DB access = Spring + Hibernate over the shared CRM schema via a service-locator singleton.** The
   established way for an out-of-webapp component to touch CRM data is to depend on `dataimport`, get
   `DataImportDelegate.getInstance()`, and use its DAOs/import types — *not* raw JDBC, *not* the
   core's web services. A new service should either reuse dataimport or replicate its
   `BasicDataSource` + `AnnotationSessionFactoryBean` + `HibernateTransactionManager` wiring. Or, like
   pbxapp, use its **own** DB. Either way, **don't reach into the core DB casually** (multi-tenant
   leak risk — see doc 02).
2. **Scheduling is in-process on the main webapp, not external cron.** Production scraper scheduling
   lives in the monolith's timer tasks, gated by `waterfind.taskmanager=true` (one node). A genuinely
   independent scheduled service is a departure; the dormant datascraper Quartz webapp and the
   `:9102` ELB scraper service are the half-built precedents.
3. **Packaging = Ant jar/WAR with environment baked in at build time, deployed under Resin 3.1.** No
   runtime config server — `merge-properties` flattens the property tiers into one `.properties` file
   inside the artifact; Spring reads it off the classpath.
4. **Config conventions to copy:** per-env `server-<env>.properties` with a committed `.sample`, a
   gitignored `local-server-<env>.properties` override, `jdbc-waterfind.*` for DB,
   `waterfind.http.proxy.*` for egress, log4j with rolling file + SMTP-on-ERROR. **Do NOT copy** the
   committed secrets or trust-all TLS.
5. **Separation of concerns to emulate:** datascraper (fetch/parse, no DB) over dataimport
   (validate/persist, no HTTP) is a good template — a validated, transactional persistence façade with
   per-type validation and a user-facing error report (`DataImportResult`).

### File index
- `crm/dataimport/src/com/waterfind/data/imp/{DataImportDelegate, DataImportServiceLocator,
  business/DataImportBo, business/ImportBusinessObject, dao/CoreDao}.java`,
  `crm/dataimport/src/data-import-context.xml`, `crm/dataimport/build.xml`
- `crm/datascraper/src/com/waterfind/data/scraper/{DataScraperImpl, DataScraper}.java`,
  `…/servlet/datascraper/ScraperScheduler.java`, `crm/datascraper/{build.xml, build-webapp.xml,
  build.properties}`
- `crm/MyobService/src/com/waterfind/myob/{MyobService, MyobApi, MyobDelegate, CompanyFileCredentials}.java`
- `crm/NotificationService/src/com/waterfind/notifications/{INotificationService,
  impl/NotificationService, impl/EmailProcessor, impl/SmsProcessor, servlet/NotificationApiRpcServlet}.java`,
  `crm/NotificationService/{ivy-client.xml, ivysettings.xml, webapp/WEB-INF/web.xml}`
- `crm/pbxapp/src/com/waterfind/pbx/{PbxService, asterisk/AsteriskProxy, servlet/PbxAppRPCServlet,
  spring/PbxAppServiceLocator, business/PbxLogBo, hibernate/PbxLog}.java`,
  `crm/pbxapp/src/pbxapp-context.xml`, `crm/pbxapp/webapp/WEB-INF/web.xml`
- Core-side clients: `crm/waterfind.com.au/src/com/waterfind/{business/myob/MyobBo,
  util/mail/SynchronousMailOperation, util/SmsUtil, webservices/phonesystem/PhoneSystemProxy,
  servlet/phonesystem/PhoneSystemRPCServlet}.java`
