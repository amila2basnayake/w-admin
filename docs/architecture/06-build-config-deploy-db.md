# 06 — Build, Configuration, Deployment & Database

Verified against the SVN checkouts at `Iteration45`, rev 25467. Paths relative to `crm/` unless
absolute.

## Toolchain (pinned — match exactly or it won't build)

- **Apache Ant 1.8.1 running on Java 7** (Zulu 7 stand-in for jdk-7u80). All `javac` compile
  `source="1.6" target="1.6"`. `ant build-webapp` succeeds in ~33 min on this combo (per
  `../../onboarding_log.md`).
- Drive builds with `ANT_HOME=…/apache-ant-1.8.1` + `JAVA_HOME=<Zulu7>` — the machine `ANT_HOME`
  points at Ant 1.10 and **must be overridden**.
- **No Maven/Gradle for the app.** Dependencies are **vendored jars** in `lib/` (runtime),
  `webapp/WEB-INF/lib/` (runtime, for webapp projects), `lib-dev/` (build-only), `lib-src/` (sources).
  Heavy duplication, no shared lib dir (e.g. `log4j-1.2.15.jar` appears ~10 times).

## Build system & inter-project order

**Master build:** `waterfind.com.au/build.xml`, default `all` = `build-webapp, gwt-compile`.

Key targets:
- **`build-webapp`** (line ~994) = `copy-dirs, compile, gwt-compile, merge-properties`.
- **`compile`** (line ~809) depends on **`compile-dependents`** (line ~797) — the heart of
  inter-project wiring: `make-servicemodel` → `make-datascraper` → `make-myobservice` →
  `make-notificationservice`, then datascraper's `make-dataimport`. Each `make-*` has a
  `check-*-built` guard (`<available file="…-${host}.jar"/>`) and only rebuilds if the jar is missing
  (`<ant dir="../<Project>" inheritAll="false" target="all|dist"/>`).
- **`gwt-compile`** (line ~277): forks ~50 separate GWT `Compiler` JVMs in parallel (600m heap each),
  one per module, output to `build-${host}/waterfind/gwt/`. `gwt-prepare` token-substitutes
  `@USER_AGENTS@` into `*.gwt.xml` from `conf/gwt/`.
- **`merge-properties`** (line ~967): `<echoproperties>` resolves `waterfind.*`, `mail.*`,
  `jdbc-waterfind.*`, `hibernate.*`, `log4j.*` into
  `build.web.classes/com/waterfind/configuration/waterfind.properties`. Every sub-project does the
  equivalent (`datascraper.properties`, `data-import.properties`, `myob.properties`,
  `notificationservice.properties`, `pbxapp.properties`).

**Effective build order:**
```
WaterfindServiceModel → dataimport → datascraper
                      → MyobService
                      → NotificationService (needs WaterfindServiceModel)
   all jars → waterfind.com.au (compile + GWT + assemble)
   pbxapp builds independently (no jar dep on the others)
```

**The 5 siblings are statically bundled into the monolith.** The main `compile` target copies all
dependent jars into `build.web.lib`; `build-dev/waterfind/WEB-INF/lib/` contains
`dataimport-dev.jar, datascraper-dev.jar, myobservice-dev.jar, notificationservice-dev.jar,
waterfindservicemodel-dev.jar` — 164 jars total (the 5 siblings + ~159 third-party); classes are both
exploded under `WEB-INF/classes` and jarred.

**`${host}` vs `${server}` naming gotcha:** the main app, WaterfindServiceModel, NotificationService,
pbxapp use `${host}` (default `dev`); **datascraper, dataimport and MyobService use `${server}`**
(default `dev`). Cross-`<ant>` calls pass both, so jars line up as `*-dev.jar`. The `host` value
selects which `server-<host>.properties` is loaded.

**Ivy** is partial/legacy — only `NotificationService/{ivysettings.xml, ivy-client.xml}` (the
SVN-backed Ivy repo for publishing a `notification-service-client` jar). Not wired into the default
build flow. The dominant convention is vendored jars.

### Load-bearing pinned versions
- **`postgresql-8.2-506.jdbc3.jar`** (PG 8.2 / JDBC3 era) — dataimport, pbxapp, waterfind.com.au.
- GXT `gxt-3.0.1.jar`/`gxt-chart-3.0.1.jar`; GWT `gwt-user.jar`/`gwt-dev.jar` (unversioned, = 2.5).
- Struts `1.3.10`; Hibernate `hibernate3.jar` + **`hibernate-c3p0-3.6.0.Final.jar`** (the real pool);
  Spring `spring.jar` + `spring-context-support-2.5.6.jar`; Shiro `shiro-all-1.2.3.jar`; Velocity
  `velocity-dep-1.4.jar`; Quartz `quartz-all-1.8.3.jar`; POI 3.15; JFreeChart 1.0.19; SVNKit 1.8.14.
- **No Proxool jar** despite `*.proxool.*` property names (pooling is c3p0; the proxool block in
  `build.properties` is commented out).

## Configuration system

**Layered properties, resolved at build time** (Ant `<loadproperties>`, first definition wins):
1. `local-server-${host}.properties` (gitignored per-dev override, from `.sample`) — loaded **first**.
2. `server-${host}.properties` — the environment tier.
3. `build.properties` — defaults (lowest precedence).

The flattened result is `<echoproperties>`'d into `com/waterfind/configuration/<project>.properties`
and read at runtime by Spring. `copy-dirs` also `@DB-URL@`-substitutes the resolved
`jdbc-waterfind.proxool.driver-url` into `*-context.xml`/`*.properties`. **There is no runtime config
server; per-environment artifacts differ.**

### Environment tiers (`-Dhost=<x>` selects the file)

| Tier | File | DB url | Region/theme | Notes |
|---|---|---|---|---|
| **dev** | `server-dev.properties` | `…//192.168.5.190/waterfind-wfdev` | aus | `resin.path=c:/resin-3.1.7a/`; scrapers & taskmanager **off**; `is-redundant=true` (set via `local-server-dev.properties`, not the tier file) |
| **test** | `server-test.properties` | `…//192.168.5.190/waterfind-wfdev` | aus | host `wfdev.internal.waterfind.com.au`; `is-redundant=true`; taskmanager **on** (inherited default) |
| **prod (AUS)** | `server-prod.properties` | `…//localhost/waterfind` | aus, ML/GST | `gwt.compile.style=OBF`; remote.trading=true; `my.waterfind.com.au` |
| **prod (USA)** | `server-prod-usa.properties` | `…//localhost/waterfind-1` | **usa**, AF/Tax, °F | `online.waterfindusa.com`; remote.trading=false; taskmanager **off** |
| **warm** | `server-warm.properties` | `…//localhost/waterfind` | aus | `is-redundant=true` — AUS hot standby |

### Setting categories (`build.properties`, ~530 lines)
- **DB:** `jdbc-waterfind.proxool.driver-url` (main app/NS/datascraper) vs `jdbc-waterfind.driver-url`
  (dataimport/pbxapp); `hibernate.dialect=PostgreSQLDialect`.
- **Resin/paths:** `resin.path`, `resin.log.path`, `file.docs.path`, ~60 `waterfind.file.*` document
  dirs, a large log4j block (per-concern rolling files + SMTP-on-ERROR appenders).
- **Email/SMS:** `mail.host`, `waterfind.sms.*`; in NotificationService `waterfind.notfications.smtp.*`
  (SendGrid) / `…sms.*` (ClickSend). ⚠️ live creds committed.
- **Finance/MYOB:** `myob.waterfind.enabled`, account numbers; `waterfind.email.finance`.
- **Inter-service:** `waterfind.phone-server.secure-url=https://…:4433/secure/pbx`,
  **`waterfind.shared-secret`** (server-to-server RPC auth), `waterfind.mil.url` (MIL proxy :9090).
- **Feature flags:** `waterfind.is-redundant-server` (true on test/warm via their tier files, and on
  dev only via the `local-server-dev.properties` override → suppresses outbound email/SMS, shows a red
  banner), `waterfind.taskmanager` (scheduler — default **true**, explicitly disabled only on dev and
  prod-USA; so it resolves to **on** for test, prod-AUS **and warm**, not AUS-prod alone — warm
  suppresses the side-effects via `is-redundant-server`),
  `waterfind.scrape.auto`, `waterfind.remote.trading`, `waterfind.server.path`,
  `waterfind.webapp.theme` (aus|usa), unit types (`waterfind.water.unit.type` ML/AF).

**Topology implication:** the tiers reveal a **multi-region, multi-node** deployment — primary AUS prod
(`my.waterfind.com.au`, DB `waterfind`), a **warm/redundant** AUS standby, a separate **USA**
deployment (`waterfindusa.com`, DB `waterfind-1`, AF/Tax units), plus dev/test. The `is-redundant`
flag in three tiers confirms a hot-standby pattern (relevant to the client's regulated-uptime
profile).

## Deployment & runtime topology

**Resin version:** ships and expects **Resin 3.1.7a**, bundled at
`waterfind.com.au/webserver/resin-3.1.7a/` (config `webserver/resin-3.1.7a/conf/resin.conf`). The
onboarding docs say 3.1.10; the bundled 3.1.7a is what the build references
(`webserver/build.xml resin.dir=resin-3.1.7a`, dev `resin.path=c:/resin-3.1.7a/`). **Flagged
discrepancy.**

**Deploy mechanism — `waterfind.com.au/webserver/build.xml`** (default `release`):
- Builds for a numbered server (`-DserverId=1..4`), DB `${db.base.url}${database.name}`
  (`db.base.url=jdbc:postgresql://127.0.0.1/waterfind-` → server 1 = DB `waterfind-1`).
- `dist` copies the bundled Resin tree and token-substitutes `resin.conf`'s
  `@PORT_RANGE@`/`@APP_PATH@`: `webserver/server-1.properties` sets `port.range=110` → Resin HTTP on
  **port 11000** (`@PORT_RANGE@00`); watchdog/JMX/JDWP on 110xx. `@APP_PATH@` → `<document-directory>`
  = `/home/waterfind/${serverId}/waterfind.com.au`.
- Resin runs as a **daemon** (`bin/resin`; Windows dev `win32/resin.exe`); the webapp is served
  **exploded** (not a war) from `<document-directory>`. `-Xmx8500m`, `trustStore.jks` for outbound TLS.
- **Apache httpd front end** (`webserver/httpd/conf.d/waterfind.conf`): SSL-terminates
  `my.waterfind.com.au`/`online.waterfind.com.au`, 80→443, `ProxyPass / http://localhost:11000/`.
- So: **Apache (443) → Resin (11000+) → exploded webapp → PostgreSQL.**

**Per-project deploy:**
- waterfind.com.au — exploded webapp under Resin (the monolith; bundles the 5 jars).
- NotificationService — standalone webapp (`/secure/notifications`); `scp-prod` →
  `/home/waterfind/notificationservice/deploy`. Also embedded in the monolith.
- pbxapp — standalone webapp (`/secure/pbx`:4433); `scp-prod` → `192.168.5.13:/home/waterfind/phonesystemapp/deploy`.
- datascraper — usually embedded; can run standalone via `build-webapp.xml`.
- dataimport, MyobService, WaterfindServiceModel — jars only, no standalone deploy.

## Database

- **Engine:** PostgreSQL **8.2** (driver `postgresql-8.2-506.jdbc3.jar`; `PostgreSQLDialect`). Dev
  fallback on this machine is PG 18 (8.2.4 binaries unobtainable per onboarding log).
- **Two databases:**
  1. **waterfind** (main CRM) — dev `waterfind-wfdev`, prod-AUS `waterfind`, prod-USA `waterfind-1`,
     per-node `waterfind-<serverId>`. Shared by waterfind.com.au, dataimport, datascraper, MyobService,
     NotificationService (the latter two have **no** separate DB; MyobService doesn't connect at all,
     NotificationService is stateless).
  2. **pbxapp** — separate DB (`jdbc:postgresql://localhost/pbxapp` is the prod value; dev/test point
     at `192.168.5.190/pbxapp`).
- **Schema in repo:**
  - `waterfind.com.au/sql/schema/` — incremental migrations `REV1 … REV45-HOTFIX2` + feature DDL
    (`AssetRegister.sql`, `MultiTenant.sql`) + the consolidated snapshot `production-schema.sql`
    (196 tables, ~6,860 lines). **Forward-only folders, no Flyway/Liquibase version table.**
  - `waterfind.com.au/sql/plpgsql/` — `assignCommoditiesToGroup.sql`, `assignDefaultTenants.sql`,
    `weather-stations.sql`.
  - `pbxapp/sql/schema/schema.sql`.
- **Restore procedure (from onboarding):** `createdb --encoding UTF8 --owner=waterfind
  "waterfind-<date>"` → `pg_restore -d … "wf1win"` → run `missing_tables/` SQL → run `sanitize_db.sql`
  (sanitizes PII; sets every login password to `blue49`). ⚠️ **`wf1win`, `missing_tables/`, and
  `sanitize_db.sql` are NOT in the SVN checkout** — they ship in Waterfind's DB bundle (the one hard
  blocker to a running app, per onboarding).
- **Hibernate POJO/DAO generation:** `generate-hbm-pojos` uses
  `scripts/dao-generation/{hibernate.properties, daotemplate.ftl}` to reverse-engineer entities from
  the live DB — **schema is source-of-truth, code is generated from it.** Only `waterfind.com.au`,
  `dataimport` and `pbxapp` actually carry the `scripts/dao-generation/` files; `NotificationService`
  *declares* the target but is missing those files (and its target has a copy-pasted
  `packagename=com.waterfind.pbx.hibernate`), so it would fail as-is.

## Security note (carry forward into our work as "don't repeat")

`server-prod.properties`/`build.properties` commit **live secrets in plaintext** (SendGrid key,
ClickSend key, Asterisk manager password, the PBX shared secret, the SVN-Ivy `release`/`r3l3as3`
password, FTP creds). There is **trust-all TLS** (`EasyX509TrustManager`, `SSLCertTrustModifier`) and
**unsalted MD5** passwords. `CLAUDE.md` mandates secrets in gitignored `.env` — our service must keep
credentials out of committed properties (use `local-server-<host>.properties` overrides or DB-stored
settings via a delegate, as MYOB already does for company-file creds).

### File index
- `crm/waterfind.com.au/build.xml` (master; `build-webapp`/`compile-dependents`/`gwt-compile`/
  `merge-properties` ~lines 994/797/277/967), `…/webserver/build.xml` (deploy/ports),
  `…/webserver/resin-3.1.7a/conf/resin.conf`, `…/webserver/httpd/conf.d/waterfind.conf`,
  `…/build.properties` + `server-*.properties`
- `crm/WaterfindServiceModel/build.xml`; `crm/NotificationService/{build.xml, ivysettings.xml}`;
  `crm/pbxapp/{build.xml, server-prod.properties}`; `crm/datascraper/build-webapp.xml`
- `crm/{waterfind.com.au, pbxapp}/sql/`
