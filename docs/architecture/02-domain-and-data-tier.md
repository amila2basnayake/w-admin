# 02 — Domain Model & Data / Persistence Tier

Scope: `crm/waterfind.com.au`. Stack: **Spring 2.5 + Spring-ORM Hibernate 3 (Core + Annotations),
c3p0 pool, PostgreSQL 8.2** (`PostgreSQLDialect`). Config is **entirely programmatic via Spring —
there is no `hibernate.cfg.xml`.**

## The first structural fact: entities live in THREE packages, two authoring styles

| Package | Count | Mapping style | Authored how |
|---|---|---|---|
| `com.waterfind.core` (+ subpkgs) | 243 `.java`, **168 `.hbm.xml`** | hand-written XML (`Foo.hbm.xml` next to `Foo.java`) | forward / code-first, hand-maintained |
| `com.waterfind.hibernate` | 203 `.java` (201 `@Entity`) | JPA annotations on the class | **DB-first, reverse-engineered** by `hbm2java` |
| `com.waterfind.dto` | 636 `.java` | plain POJOs, **no persistence** | wire/transfer objects (see §6) |

Both `core` (XML) and `hibernate` (annotated) entities load into the **same SessionFactory** and
reference each other across packages (e.g. `core/OrderListing.hbm.xml` has `<many-to-one
class="com.waterfind.hibernate.ClientAuthority">`). Wired in one bean — `src/spring-context.xml`:

```xml
<bean id="sessionFactory"
      class="org.springframework.orm.hibernate3.annotation.AnnotationSessionFactoryBean">
  <property name="mappingLocations"><value>classpath:com/waterfind/**/*.hbm.xml</value></property>
  <property name="packagesToScan" value="com.waterfind.hibernate"/>
</bean>
```

Some concepts are **duplicated** across styles (e.g. `core/WaterAlert.java` table `wateralert` vs
`hibernate/Wateralert.java`). **Always check which package/style an entity uses before editing.**

## (a) The water-trading data model

The business matches buyers and sellers of water across regulated regions. The central spine:

```
                 State (NSW/VIC/SA…)
                   ▲
   Region ◀── self-ref topology (top_up, carryover, allocation, entitlement, tagged, parent)
   (REGION)        │
     │   ▲         └── RegionTradingRelationship (REGION_TRADING_RELATIONSHIP) ← THE TRADE-RULE MATRIX
     │   │              from_region → to_region, exchangeRate, rule, sale, suspended, wef, T&Cs
     │   └── StateTradingRelationship (cross-state rules)
     │
   Property (PROPERTY) ── region ──▶ Region
     │  embeds Licence component (quantity, licence_number, field1..field50, spot/futures perms)
     │  self-ref: top_up, carryover, allocation, entitlement, tagged (water-product linkage)
     │
   WFContactUser (WATERFIND_USER)  ← abstract, SINGLE-TABLE inheritance, discriminator col "subclass"
     ├─ OnlineUser (registered trader) ├─ WaterfindUser (staff/broker) ├─ ProspectiveUser (lead) …
     │  (embeds components: ContactName, ContactDetails, Address, TradingDetails, LoginDetails)
     │
   OrderListing (ORDER_LISTING)  ← abstract, discriminator col "order_type"
     ├─ B = BuyOrderListing   ├─ S = SellOrderListing
     │  quantity, pricePerMl, split, sale, dualListing, season, expiryDate, fees…
     │  ── property ──▶ Property   set regionList ──▶ OrderRegion (regions the order is valid in)
     │
   CompletedOrders (ORDER_COMPLETED)  ← the MATCHED / settled trade
     │  ── waterOffer ──▶ WaterOffer   ── buy/sellOrderListing ──▶ OrderListing  + exchangeRate
     │
   WaterAlert (wateralert)  ← standing buy/sell RULE ("notify/auto when market matches")
        ── region/property/user, quantity, minSplit, pricePerMl, orderType, sale, expiryDate
```

Key objects → where they map (cite these to find a field):

- **Client / customer / staff** → `core/WFContactUser.hbm.xml` (table `WATERFIND_USER`). One table,
  all user types via the `subclass` discriminator. This is the "~15,000 clients" table.
- **Market / trading area** → `core/Region.hbm.xml` (`REGION`); tradability between regions →
  `core/RegionTradingRelationship.hbm.xml` (`REGION_TRADING_RELATIONSHIP`, with `exchangeRate`,
  `rule`, `suspended`). This pair is "the hundreds of open markets."
- **Trade / order** → `core/order/OrderListing.hbm.xml` (`ORDER_LISTING`) → `BuyOrderListing` /
  `SellOrderListing`; a settled match → `core/order/CompletedOrders.hbm.xml` (`ORDER_COMPLETED`).
- **Trade rule / water alert** → `core/WaterAlert.hbm.xml` (`wateralert`) — the "tens of thousands
  of active trade rules." Related: `hibernate/Wateralert.java`, `WateralertHistory.java`,
  `IntentToTrade.java`, `WaterAlertTolerances.java`.
- **Licence** → embedded `<component>` inside `Property` (50 generic `field*` columns for registry
  variability + spot/futures permissions). External registry licence →
  `core/nrmregister/Licence.hbm.xml` (`EXT_NRM_LICENCE`) with `Licensee` and `Allocation`.
- **Allocation / entitlement** → linked `Property` rows (`allocation`/`entitlement`/`carryOver`/
  `top_up`/`tagged` self-refs are the different water products) + `core/WaterAllocationRegion` +
  `ext_nrm_allocation`.
- **Account / fees / receipt / payment** → `hibernate/CashFloatAccount.java` (+ `*Region`,
  `*Transaction`), `hibernate/ClientPayment.java`, `hibernate/AuthorityPayment.java`,
  `core/AuthorityFees.hbm.xml`, `core/externalbilling/ExternalFees.hbm.xml`. Commission/fees also
  live on `OrderListing`.

**What a mapped entity looks like:**
- XML (`core/order/OrderListing.hbm.xml`): `<id name="id" type="long"><generator class="native"/></id>`,
  `<discriminator column="order_type" type="string"/>` driving `<subclass discriminator-value="B"…>`,
  scalar `<property>`s with explicit `<column>`, `<many-to-one>`, and `<set cascade="save-update"
  inverse="true">` collections. Components inlined (Property embeds Licence ≈ 90 columns).
- Annotated (`hibernate/ClientAuthority.java`): header "Generated by Hibernate Tools … hbm2java",
  `@Entity @Table(name="client_authority", schema="public")`, `@Id @GeneratedValue`,
  `@ManyToOne(fetch=FetchType.LAZY) @JoinColumn(...)`, `@Temporal(TIMESTAMP)`. Getter-based access.

**ID strategy:** `<generator class="native"/>` / `@GeneratedValue` everywhere → on PostgreSQL this
resolves to the **global `hibernate_sequence`** (`production-schema.sql` ~line 823). A legacy
`hibernate_unique_key` HiLo table also exists (~line 836). IDs are `bigint`/`long` — **not** per-table
`serial`.

## (b) Persistence architecture

**DAO layer — one God base class.** `src/com/waterfind/dao/CoreDao.java` (2,794 lines),
`abstract CoreDao<E> extends HibernateDaoSupport`. Provides generic CRUD + query helpers via
`HibernateTemplate`:
- CRUD: `insert`, `insertOnly`, `insertNonTransactional` (opens its own session — see gotchas),
  `saveOrUpdate`, `update`, `fetch(id)` (load), `fetchAll`, `delete`, `deleteAndFlush`, `exists`,
  `flushAndEvict`, `flushAndClear`.
- Querying = primarily **Hibernate Criteria** (`DetachedCriteria.forClass(getTargetClass())`) with a
  large `addRestriction(...)` library, projections, and **built-in paging** that reads thread-local
  `PagingCriteria`/`ServiceResponse`.
- **HQL** via `findByQuery` / `executeBatchUpdate`; **native SQL** via `findBySqlQuery` /
  `updateBySqlQuery`. All three flavours are in use.

Concrete DAOs are thin: `@Repository("xDao")`, extend `CoreDao<E>` (or a mid-base like
`dao/OrderDao.java`), override `getTargetClass()`, add `findByXxx`. **335 `@Repository` DAOs**,
component-scanned (`<context:component-scan base-package="com.waterfind"/>`). Convenience holder:
`src/com/waterfind/server/WaterfindDaoAccess.java`.

**Transactions are demarcated at the facade, NOT in DAOs.** The primary boundary is the
**class-level `@Transactional(REQUIRES_NEW)` on `com.waterfind.server.WaterfindDelegate`** (the bean
every Action/GWT call funnels through — see [doc 03](./03-business-logic-and-trading-engine.md)).
`@Transactional` is otherwise rare: only ~4 files in the whole `src` tree carry it — `WaterfindDelegate`,
`business/orders/OrderListingBo.java` (the one `*Bo` that does, using `REQUIRES_NEW` on the clearing
path), `server/WaterfindHibernateThreadFilterDelegate.java`, and `servlet/user/WaterfindUserMigrator.java`.
So do **not** expect to find transaction boundaries scattered across the 244 `*Bo` classes — the base
`WaterfindBusinessObject` is not annotated, and there is no `tx:advice`/AOP XML. DAOs carry zero
`@Transactional`. `HibernateTransactionManager` + `<tx:annotation-driven>`. Plus the per-request
`WaterfindHibernateThreadFilter` (open-session-in-view) keeps a session open for the request — this
is what makes lazy loading work in JSP/GWT serialization.

**Hibernate config** (`spring-context.xml` `hibernateProperties`): `PostgreSQLDialect`,
`org.postgresql.Driver`, **`C3P0ConnectionProvider`**, `connection.autocommit = true` (notable),
`use_outer_join = true`. c3p0 pool: `min_size=40`, `max_size=100`, `acquire_increment=10`,
`timeout=14400`, `max_statements=1000`.

**Second-level cache: effectively NONE.** No `<cache>` in any `*.hbm.xml`, no `@Cache`, no Hibernate
`ehcache.xml`. (The only EhCache present is Shiro's auth realm cache.) Reads hit the DB, modulated by
the first-level session cache. **Do not assume a shared L2 cache.**

**Connection pool — it is c3p0, NOT Proxool, despite the property names.** The active key is
`jdbc-waterfind.proxool.driver-url` (a retained misnomer) feeding `hibernate.connection.url`; all
other `jdbc-waterfind.proxool.*` keys are commented out, and there is **no Proxool jar** in-tree
(`hibernate-c3p0-3.6.0.Final.jar` is). Example URLs: `jdbc:postgresql://localhost/waterfind` (prod),
`…//192.168.5.190/waterfind-wfdev` (dev). DB user `waterfind`. The URL lives in the per-environment
`server-*.properties`, filtered into the app at build time and loaded into Spring via
`PropertyPlaceholderConfigurer` from `classpath:com/waterfind/configuration/waterfind.properties`.

## (c) How to add/change a persisted entity

### Workflow A — hand-written XML entity in `com.waterfind.core` (common case)

Add a **field**: (1) DDL migration `sql/schema/REV<n>/SchemaUpdate.sql` (and keep
`sql/schema/production-schema.sql` in sync); (2) add field+getter/setter to the `.java`; (3) add
`<property><column/></property>` to the `.hbm.xml` (auto-discovered, no registration); (4) if it
reaches the browser, add it to the relevant `dto/**` class and the inline DTO-build code.

Add an **entity**: DDL migration → new POJO `core/<pkg>/Foo.java` → new mapping `Foo.hbm.xml` →
new DAO `dao/FooDao.java` (`@Repository("fooDao") class FooDao extends CoreDao<Foo>`) → optional
`FooBo` + DTO(s) + actions. Component-scan finds the DAO/Bo automatically.

### Workflow B — DB-first annotated entity in `com.waterfind.hibernate`

These are **generated**. `build.xml` target `generate-hbm-pojos` runs `hibernatetool` against the
live DB (`scripts/dao-generation/hibernate.properties`) and: `hbm2java` regenerates annotated POJOs;
`hbmtemplate` + `scripts/dao-generation/daotemplate.ftl` regenerates a matching `<Class>Dao.java`.
So: add the table/column to the DB first, re-run the target, entity + skeleton DAO appear. Custom
`findByXxx` go after the generated comment block — **caution: regeneration can clobber custom DAO
methods.**

## (d) Gotchas

- **Two entity styles, one SessionFactory** — confirm style before editing; annotated package is
  machine-generated.
- **No Hibernate L2 cache** — don't assume cross-request entity caching.
- **`autocommit=true`** on the connection + Spring tx management is unusual; `insertNonTransactional`
  opens its own session and can write outside the surrounding transaction.
- **Transaction boundaries are on the `WaterfindDelegate` facade, not DAOs (and not most `*Bo`s)** —
  calling a DAO outside a delegate-initiated call may run with no real transaction (relying on the
  OSIV filter session). The clearing path (`OrderListingBo.orderNow`) uses `REQUIRES_NEW` (suspends
  the caller's tx → partial-commit semantics).
- **Hidden paging via thread-local** — `CoreDao` list methods silently apply paging from
  `ServiceRequest`/`PagingCriteria`; a "find all" can return one page. **A microservice reusing these
  DAOs outside the GWT request context must account for these thread-locals being null.**
- **Single global ID sequence** (`hibernate_sequence`) + legacy `hibernate_unique_key` HiLo. External
  writers must use the same sequence — `nextval('hibernate_sequence')` — not table-local serials, or
  risk PK collisions.
- **PostgreSQL 8.2 quirks** — no `ON CONFLICT`/upsert, limited window functions, no broad
  `RETURNING` conveniences; existing native SQL is written to that floor. Timestamps are
  **`timestamp without time zone`** (no TZ stored) with Hibernate `type="calendar"` — implicit local
  TZ, a real trap for any TZ-aware service.
- **Single-table inheritance** on `WATERFIND_USER` (`subclass`) and `ORDER_LISTING` (`order_type`) —
  raw queries must filter by discriminator; many columns are nullable (subclass-specific).
- **Wide / generic columns** — `PROPERTY` embeds `field1..field50`; don't treat as typed.
- **Migrations are forward-only folders** (`sql/schema/REV1 … REV45-HOTFIX2`, with many `-HOTFIX`
  and date-stamped variants), applied manually/by build — **no Flyway/Liquibase version table**.
  `production-schema.sql` (196 `CREATE TABLE`s, ~6,860 lines) is the consolidated snapshot; read it
  for the live shape, then apply later REVs.
- **Multi-tenancy is an app-layer access filter, not DB separation** — single `public` schema,
  `tenant_to_user`/`access_level` logic (`sql/schema/MultiTenant.sql`,
  `sql/plpgsql/assignDefaultTenants.sql`), enforced only in Java. **A naive `SELECT *` leaks
  cross-client data.** There are essentially no DB-side triggers/procs enforcing it.

## (e) Notes for a microservice that reads/writes this DB or shares the model

- **The schema is the contract; the Java model is leaky.** Cleanest integration is at the PG level
  against `public`. Source of truth: `crm/waterfind.com.au/sql/schema/production-schema.sql` + later
  `sql/schema/REV*/SchemaUpdate.sql`. Tables to know: `waterfind_user`, `region`,
  `region_trading_relationship`, `property`, `order_listing`, `order_completed`, `wateralert`,
  `client_authority`, `cash_float_account*`, `ext_nrm_licence/licensee/allocation`, `tenant_to_user`.
- **Respect identity generation** (`nextval('hibernate_sequence')`), **discriminator columns**, and
  **multi-tenant access control** (replicate the `tenant_to_user`/`access_level` joins, or you leak
  data). Normalize timestamps explicitly (columns are TZ-less, written server-local).
- **If you want the Java model**, the canonical mappings are the 168 `core/*.hbm.xml` + 201 annotated
  `com.waterfind.hibernate` entities. Reuse the *entities* but probably **not** `CoreDao` verbatim
  (its OSIV/thread-local-paging assumptions are baked in). Match pinned versions (PG 8.2 +
  Hibernate 3 + Spring 2.5) — a newer Hibernate reinterprets `type="calendar"`, `native` generator
  resolution, and inheritance.
- **DTOs (`com.waterfind.dto`) are NOT persistence** — they're GWT-RPC/GXT wire objects, built by
  hand inline in Bo/DAO code (no MapStruct/assembler). Define our own API contracts rather than
  depend on these UI-coupled DTOs.

### File index
- Spring/Hibernate wiring: `crm/waterfind.com.au/src/spring-context.xml`
- God DAO base: `…/src/com/waterfind/dao/CoreDao.java`; mid-base `…/dao/OrderDao.java`; example
  `…/dao/BuyOrderListingDao.java`
- DAO/entity generation: `…/build.xml` target `generate-hbm-pojos`; `…/scripts/dao-generation/{daotemplate.ftl,hibernate.properties}`
- Core trade mappings: `…/core/{Region,RegionTradingRelationship,Property,WFContactUser,WaterAlert}.hbm.xml`,
  `…/core/order/{OrderListing,CompletedOrders}.hbm.xml`, `…/core/nrmregister/Licence.hbm.xml`
- Annotated entities: `…/src/com/waterfind/hibernate/*.java`
- Transaction layer: `…/src/com/waterfind/business/**/*Bo.java`
- Schema: `…/sql/schema/production-schema.sql`, `…/sql/schema/REV*/SchemaUpdate.sql`,
  `…/sql/schema/MultiTenant.sql`, `…/sql/plpgsql/*.sql`
- DTOs: `…/src/com/waterfind/dto/**`
