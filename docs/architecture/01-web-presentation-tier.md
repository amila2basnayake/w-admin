# 01 — Web / Presentation Tier & Request Flow

Scope: the front end of the monolith at `crm/waterfind.com.au`. Frameworks: **Struts 1.3.10**
(Commons-Chain request processing) + **JSP** + Struts **Tiles 1.3.10** (barely used) +
**GWT 2.5 / GXT 2.x & 3.0.1** + **DWR 2** + a vestigial **JSF** island. Served by Resin 3.1.7a.

## The one thing to internalise first

There is no single discipline — the code is **two generations layered on top of each other**, and
the **package prefix is the reliable signal of era**:

- **Legacy:** raw `org.apache.struts.action.Action` subclasses under `com.waterfind.admin.*`,
  `com.waterfind.user.*`, `com.waterfind.offer.*`; the deprecated `struts-config-external.xml`.
- **Modern:** `WaterfindAction` base class, classes under `com.waterfind.action.*`, `@JsonAction`,
  GWT.

There are two parallel `admin` trees (`com.waterfind.action.admin` modern vs `com.waterfind.admin`
legacy) and two `user` locations. Always check the prefix.

## (a) Request lifecycle, end to end

For an authenticated page request `GET /admin-new-user-approval.html`:

1. **Resin** matches `*.html` → the `StrutsAction` servlet (`org.apache.struts.action.ActionServlet`)
   in `crm/waterfind.com.au/webapp/WEB-INF/web.xml`.
2. **Filter chain** (note: filters use Resin-specific `<url-regexp>` exclusions, not portable
   `<url-pattern>`):
   - `shiroFilter` (Spring `DelegatingFilterProxy`) — Shiro plumbing, **empty chain defs, gates
     nothing**.
   - `GzipFilter` — gzips responses (excludes `.cache.html`, `dwr`, images, some reports).
   - `SecurityFilter` (`com.waterfind.webservices.security.SecurityFilter`) — **misnamed; no auth.**
     Sets `Cache-Control: no-cache` on POSTs and enforces an **IP blocklist**
     (`Waterfind.isBlockedIPAddress`, HTTP 503 if blocked). `authorised` is hardcoded `true` with a
     `// TODO : check security…`.
   - `SiteMetricsFilter` — request metrics.
   - **`HibernateFilter`** (`com.waterfind.WaterfindHibernateThreadFilter` →
     `src/com/waterfind/server/WaterfindHibernateThreadFilterDelegate.java`) — **the load-bearing
     filter.** Opens a Spring-managed Hibernate transaction (open-session-in-view), then calls
     **`Waterfind.validateAccessRestriction(request)`** — *this is where authorization actually
     happens*: it resolves the Struts `ActionConfig`, reflectively reads the action's
     `@AccessRestriction`, and validates the session user's type/roles; on denial it forwards to a
     redirect path. Closes the session afterward; forwards to `/error.html` on exception. A sibling
     `NoTransactionJspFilter` handles a few read-heavy URLs (e.g. `active-trade.jsp`).
3. **Struts `ActionServlet`** runs the Commons-Chain pipeline from
   `webapp/WEB-INF/chain-config.xml` (catalog `struts`): `SelectLocale` → `SelectAction` →
   `CreateActionForm` → `PopulateActionForm` (binds request params onto the `ActionForm`) →
   `ValidateActionForm` (only if mapping has `validate="true"`, usually off) → `CreateAction` →
   `ExecuteAction`.
4. **Action executes.** `WaterfindAction.execute()` (template method) runs the preamble — seed the
   thread-local `ServiceRequest` with the user, load `UserCredentialsDto` from session, login check
   (`isLoginRequired()`), CRM-lock check — then calls the subclass hook
   `executeWaterfindAction(...)`, which casts the form, calls `delegate.someMethod(...)`, sets DTOs
   on the form, and returns `mapping.findForward("success")`.
5. **`process-view` chain** → `TilesPreProcessor` then `PerformForward`. ~99% of forwards point at a
   raw `/jsp/...jsp` and dispatch directly; only ~6 `.`-prefixed forwards resolve via Tiles.
6. **JSP renders**, hand-including its own chrome: `styleRef.jsp`, `waterfindHeaderRef.jsp`, a
   contextual menu JSP, `waterfindFooterRef.jsp`. Role visibility via `<waterfind:admin>` /
   `<waterfind:loggedin>` tags reading `UserCredentialsDto` off the session. Response is gzipped.

For a **GWT screen**: steps 1–6 produce a thin host JSP that loads one `*.nocache.js` module; the
browser then makes **GWT-RPC POSTs to `/gwt/*`** hitting a `*ServiceImpl extends WaterfindRPCServlet`
(same filters, but **not** the Struts pipeline). For an **AJAX/JSON** call: a `@JsonAction extends
WaterfindAction` writes JSON to the response and returns `null`.

## (b) Layer-by-layer

### Web config — `webapp/WEB-INF/`
- **`web.xml`** (Servlet 2.3) — declares `StrutsAction` (`*.html`, loads
  `struts-config.xml,struts-config-external.xml` + `chain-config.xml`); 46 GWT-RPC servlets under
  `/gwt/*` (+ a `/gwt/*` file-servlet catch-all); `dwr-invoker` at `/dwr/*`; vestigial `FacesServlet` at `/jsf/*.jsf`; Cewolf charts at
  `/cewolf/*`; many one-off servlets — `/services/dataScraper`, `/services/jobScheduler`,
  `/services/remoteTrade` (MNet SMS reply hook), `/services/pbxpolling`, `/secure/pbx`, `/myob`
  (MYOB OAuth callback), `ImageLoaderServlet` at `/waterfind-images/*`, `FileLoaderServlet` at
  `/waterfind-files/*`.
- **`struts-config.xml`** — **10,852 lines**: 1,560 `<action>`s, 244 `<form-bean>`s, 2,335
  `<forward>`s. The heart of URL routing. Two global forwards, both → `/login.html`: `login` and
  `admin-login-failer`.
- **`struts-config-external.xml`** — **DEPRECATED** ("no new mappings"); the external/reseller
  portal.
- **`chain-config.xml`** — the Commons-Chain RequestProcessor emulation.
- **`tiles-definitions.xml`** — tiny (4 page defs + 1 base). Tiles is essentially unused.
- **`dwr.xml`** — exposes one application class: `admin.licenceregistry.TerritoryStateRegionDAO`
  (JS `regionSelectDAO`) for cascading state/region dropdowns, plus `java.util.Date` (JS `JDate`) and
  two `State`/`Region` converters. Runs `debug=true` (minor info leak).

### Action layer
- **Base: `src/com/waterfind/action/WaterfindAction.java`** (`abstract extends Action`, **404
  subclasses**). Subclasses override `executeWaterfindAction(...)`, not `execute()`. Owns constants
  `LOGGED_IN_USER_ATTRIBUTE = "waterfind_user"`,
  `LOGGED_IN_USER_CREDENTIALS_ATTRIBUTE = "waterfind_user_credentials"`, the facade field
  `protected WaterfindDelegate delegate`, and `writeJsonResponse(response, obj)`. Hooks:
  `isLoginRequired()` (default **false** — login is opt-in per action), `isErrorPage()`,
  `getDefaultPagingCriteria()`.
- **~340 legacy actions** extend raw Struts `Action.execute(...)` directly (e.g.
  `src/com/waterfind/admin/AddStateAction.java`; the auth actions in `src/com/waterfind/user/`:
  `LogonAction`, `CheckLoggedInAction`, `ForwardUserHomeAction`).
- **`@JsonAction` (155 use-sites)** — the modern AJAX/JSON pattern (the REST-ish seam): read params,
  call `delegate.xxx()`, `writeJsonResponse(...)`, `return null`. Example
  `src/com/waterfind/action/DeleteIntentAction.java`.
- **DispatchAction is essentially absent** (one `LookupDispatchAction`).
- ℹ️ The annotation `com.waterfind.annotation.JsonAction` is **not** in this project's tree (only
  `AccessRestriction.java` is in `com.waterfind.annotation` here). It is **not** a checkout gap: the
  annotation lives in `WaterfindServiceModel` (`src/com/waterfind/annotation/JsonAction.java`, an
  empty marker) and is supplied via the bundled `waterfindservicemodel-<host>.jar` — which is why the
  155 `@JsonAction` imports resolve and the build succeeds. (By contrast, `@AccessRestriction` lives
  only here.)

### Form / validation / taglibs
- **Base: `src/com/waterfind/form/WaterfindForm.java`** (`extends ActionForm`, **not**
  `ValidatorForm`). Forms are **stringly-typed** (dates as 3 String fields, booleans as Strings) and
  double as DTO carriers for the JSP. Scattered across `src/com/waterfind/form/**`, plus ~140 under
  `admin/**` and ~25 under `user/**`.
- **The Struts Validator framework is NOT used.** Validation is hand-rolled: `form.validate()`
  overrides (178 files) and manual `saveErrors(request, errors)` inside actions (403 calls in 203
  files) for business-rule checks.
- **Taglibs:** large home-grown **`waterfind.tld`** (`webapp/WEB-INF/tld/waterfind.tld`, ~70
  handlers in `src/com/waterfind/taglib/`). Key tags: `<waterfind:paginglinks>` (list pagination),
  `<waterfind:nocachejs>` (embeds a GWT module — **enforces one module per page**), and
  role-conditional include tags (`<waterfind:admin>`, `<waterfind:loggedin>`, `<waterfind:direct>`)
  over `RoleConditionTag`/`DelegateTagSupport`. Single message bundle
  `src/com/waterfind/messages.properties` (English only).

### View layer
- **~1,112 `*.jsp`** under `webapp/` (most are bundled third-party JS; hand-written app JSPs number
  in the low hundreds), organised by feature under `webapp/jsp/`: `admin/` (~467, largest),
  `sales/`, `common/`, `market/` + `market-original/` (current + superseded trading UI),
  `external/`, `userhome/`/`brokerhome/` (GWT host pages), `mobile/`, `graph/`/`dash/`, `ajax/`.
- **Tiles is barely used** (~6 forwards). The real layout system is convention: every content JSP
  hand-includes `styleRef.jsp` + `waterfindHeaderRef.jsp` + `waterfindFooterRef.jsp` (the `*Ref`
  dispatchers branch internal-vs-external on `UserCredentialsDto.isExternal()`).
- **Navigation is static JSP markup gated by role tags** — not a data-driven menu. Top nav is
  hard-coded `<ul id="navmenu-h">` in `webapp/jsp/waterfindHeader.jsp`. The
  `src/com/waterfind/menu/` package is **misnamed** — it holds two public enquiry-form actions, not
  nav.
- **JSF is dead config** (`FacesServlet` mapped, no `faces-config.xml`, no `.xhtml`).

### GWT
- **GWT 2.5.0**, with **GXT 2.x (`com.extjs.gxt`) and GXT 3.0.1 (`com.sencha.gxt`) inherited
  simultaneously** in `src/com/waterfind/gwt/Resources.gwt.xml`.
- Split: `src/com/waterfind/gwt/client/` (entry points, widgets, RPC sync/async interfaces under
  `client/widget/<feature>/`, GXT MVC under `client/mvc/`) and `src/com/waterfind/gwt/server/<feature>/`
  (the `*ServiceImpl`s). **No `shared/` package** — shared serializable objects are the separate
  `src/com/waterfind/dto/` package, whitelisted into the compiler by `src/com/waterfind/dto/Dto.gwt.xml`.
- **Base servlet: `src/com/waterfind/gwt/server/WaterfindRPCServlet.java`** (`extends
  RemoteServiceServlet`). `getDelegateAndInitRequest()` checks the session
  (`checkExpiredSession()` throws if no `waterfind_user_credentials`, unless `isAnonService()`),
  seeds `ServiceRequest`, returns the shared `WaterfindDelegate`. `doUnexpectedFailure` returns
  **HTTP 504** on expired session → client redirects to login.
- RPC endpoint URLs are wired **in code** (e.g.
  `FutureOrderListEntryPoint.SERVICE_END_POINT = "/gwt/order/order"`, must match the `web.xml`
  mapping by hand). GWT-driven screens: sales dashboard, user search, fee structures, dispute
  register, organisations, trading relationships, client CRM panel, order screens, modern
  user/broker homepages. Everything else is server-rendered JSP.

### DWR
Minimal/vestigial — only `TerritoryStateRegionDAO` for region dropdowns. Superseded by GWT-RPC and
`@JsonAction`.

### Security / auth — two systems, only one live
- **Authentication** = manual **unsalted MD5** compare in `src/com/waterfind/user/LogonAction.java`
  (legacy) and `WaterfindUserBo.login(...)` (modern, used by
  `src/com/waterfind/action/user/LoginAction.java`). On success, session attributes `waterfind_user`
  (the `Long` id) and `waterfind_user_credentials` (`UserCredentialsDto`) are set.
- **Login enforcement** = the session check in `WaterfindAction.execute()`, **opt-in** via
  `isLoginRequired()` (default false; overridden in ~137 actions, the large majority returning true).
  So most security-sensitive actions *do* opt in — the real risk is the *new* action whose author
  forgets to, not that the app is broadly unguarded.
- **Authorization** = the **`@AccessRestriction`** annotation
  (`src/com/waterfind/annotation/AccessRestriction.java`), enforced in the Hibernate filter via
  `Waterfind.validateAccessRestriction()` → `UserRoleBo.hasAccess(...)` /
  `UserCredentialsDto.hasRole(...)`.
- **Two role concepts:** coarse integer **user type** in `src/com/waterfind/core/OnlineUser.java`
  (`USER_DIRECT=0` client, `USER_BROKER=1`, `USER_SALES=2`, `USER_ADMIN=3`, `USER_AUTHORITY=4`, …),
  and fine-grained string **role ids** in `src/com/waterfind/business/user/UserRoles.java`
  (`SU`, `BROKER`, `TRADE_MANAGER_NSW/VIC/SA/QLD`, `FINANCE`, `CEO`, `GLOBAL_ADMIN`, …).
- **Apache Shiro is configured but enforces nothing** (`src/shiro.ini` + the `shiroFilter` bean in
  `src/spring-context.xml` have empty URL chains; `UserCredentialsDto.isPermitted(...)` hardcoded
  `false`). A half-finished migration, not the live auth.

## (c) How to add a new screen/action (modern style)

1. **Form bean** `XxxForm extends WaterfindForm` under `src/com/waterfind/form/<area>/` (String
   fields + DTO holders; optional `validate()`).
2. **Declare** `<form-bean>` in `struts-config.xml` (never the deprecated external config).
3. **Action** `XxxAction extends WaterfindAction` under `src/com/waterfind/action/<area>/`; override
   `executeWaterfindAction(...)`; call `delegate.someMethod(...)` (never touch DAOs from an action);
   annotate `@AccessRestriction(allow = {...})`; override `isLoginRequired()` → true if needed.
4. **Mapping** `<action path="/xxx" name="xxxForm" type="…XxxAction" input="…">` with `success` /
   `failure` forwards; use `redirect="true"` for post-submit (PRG).
5. **JSP** under `webapp/jsp/<area>/`; hand-include the three chrome JSPs; use struts-html/bean/logic
   + `waterfind:` tags; gate role UI with `<waterfind:admin>` etc.; `<waterfind:paginglinks>` for
   lists.
6. **Menu** — add the link by hand to the relevant menu JSP, wrapped in a role tag.
7. **AJAX/JSON instead:** annotate `@JsonAction`, `writeJsonResponse(...)`, `return null`.
8. **Rich screen:** build a GWT module (entry point, service trio, `*ServiceImpl extends
   WaterfindRPCServlet`, a `conf/gwt/Xxx.gwt.xml` inheriting `com.waterfind.gwt.Resources`, a
   `web.xml` `/gwt/...` mapping matching the entry point's `SERVICE_END_POINT`, a host JSP with
   `<waterfind:nocachejs>`).

## (d) Gotchas / landmines

- **Auth is opt-in** — a new action is world-readable unless it sets `isLoginRequired()` and/or
  `@AccessRestriction`. `SecurityFilter` gives false comfort.
- `@AccessRestriction` only fires through the Hibernate filter; endpoints excluded from its regex
  (`/gwt/*`, DWR, images, some reports) rely on `WaterfindRPCServlet.checkExpiredSession()` instead.
- **One GWT module per JSP** (`<waterfind:nocachejs>` silently drops a second — "combo boxes stop
  working").
- Filters use Resin-specific `<url-regexp>` — migrating off Resin means rewriting them.
- Tiles looks like the layout system but isn't; some `.page.*` Tiles refs in `struts-config` don't
  exist in `tiles-definitions.xml`.
- Unsalted MD5 passwords; stringly-typed forms; English-only bundle; DWR `debug=true` in prod.
- Hibernate session is filter-bound — JSP/actions that write data must go through the transactional
  filter path or the write won't persist; long work in an action holds the transaction open.

## (e) Web-tier integration seams for our microservice

In order of fit (full playbook in [doc 07](./07-integrating-a-microservice.md)):

1. **A new `@JsonAction`** — the established lightweight server-to-server seam. Read params, call an
   HTTP client to our service, `writeJsonResponse(response, dto)`. Rides the existing
   filter/session/Hibernate/`@AccessRestriction` stack, so auth + current user come free. 155
   templates exist. Front-end uses the already-loaded jQuery.
2. **A new servlet under `/services/*` or `/secure/*`** for inbound webhooks from our service —
   matches the existing convention; mind the filter exclusion regexes.
3. **A method on `WaterfindDelegate`** (calling an HTTP-client bean wired in
   `src/spring-context.xml`) — makes the integration reusable across the whole web tier in one
   place. Cleanest seam if multiple screens need it.
4. A new GWT-RPC service only if the consumer is a GWT screen — heavier; prefer `@JsonAction`.

Outbound base URLs/secrets → `com/waterfind/configuration/waterfind.properties` (loaded by Spring
`propertyConfigurer`) / `.env`, never hardcoded. Propagate identity via the session
`UserCredentialsDto` or the thread-local `ServiceRequest`. Anything touching trades/orders/licences/
trust accounts must fit the existing audit-log (`com.waterfind.log`) and approval
(`com.waterfind.approval`) machinery.
