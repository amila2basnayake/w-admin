# AI Advisor per-client flag

## What

Per-client, default-ON boolean `ai_advisor` on `waterfind_user`, same shape as the existing
`premium_user` flag. Broker/admin can toggle it from the registry user page; when OFF, the AI
Advisor entry in the client's userhome is hidden.

## Why

Gate the AI Advisor surface per client without Stripe/subscription semantics. Default ON so every
existing and new client keeps access unless a broker turns it off.

## Behaviour

- New column `waterfind_user.ai_advisor boolean NOT NULL DEFAULT true` — Postgres backfills existing
  rows to `true` and defaults new rows `true` (same technique as `registry_user.campaign_optin`).
- Entity/DTO/credentials fields default to `true` to match.
- Admin toggle saves via a dedicated action (no Stripe), layered like the premium path.
- Userhome hides the AI Advisor sidebar item when the flag is false (UI-visibility only).

## Where the code lives

The CRM (`crm/waterfind.com.au`) is an SVN working copy and is **gitignored** in this repo, so the
source edits cannot be committed to git here. The full change is captured as a reviewable patch in
`ai-advisor-flag.diff` — all 12 files (10 modified + 2 new). The patch is reconstructed to show only
this change (purely additive); it deliberately excludes unrelated concurrent edits already present
in the shared SVN working copy (another agent's in-progress seam work on `userhome.jsp` etc.).
Apply/commit to the CRM via SVN separately (`Iteration46` branch).

## Files changed (in the CRM SVN checkout)

| File | Change |
|---|---|
| `sql/schema/REV46-20260707/SchemaUpdate_1.sql` | NEW. `ALTER TABLE waterfind_user ADD COLUMN ai_advisor boolean NOT NULL DEFAULT true;` |
| `src/com/waterfind/core/WFContactUser.hbm.xml` | Map `aiAdvisor` -> column `ai_advisor` (`not-null="true" default="true"`). |
| `src/com/waterfind/core/WFContactUser.java` | Field `private Boolean aiAdvisor = Boolean.TRUE;` + getter/setter. |
| `src/com/waterfind/dto/registryuser/RegistryUserInformationDto.java` | Field `aiAdvisor` (default true) + `isAiAdvisor`/`setAiAdvisor`. |
| `src/com/waterfind/business/admin/RegistryUserInformationBo.java` | Read `activeUser.getAiAdvisor()` and set on the DTO, next to `premiumUser`. |
| `src/com/waterfind/dto/user/UserCredentialsDto.java` | Session field `aiAdvisor = true` + `isAiAdvisor`/`setAiAdvisor`. |
| `src/com/waterfind/business/core/WaterfindUserBo.java` | Propagate into login credentials; new `updateWaterfindUserAiAdvisor(...)`. |
| `src/com/waterfind/server/WaterfindDelegate.java` | New `updateWaterfindUserAiAdvisor(...)` delegating to the BO. |
| `src/com/waterfind/action/ChangeAiAdvisorStatusAction.java` | NEW. `@JsonAction` + `@AccessRestriction(USER_ADMIN, USER_BROKER, USER_SALES)` (tightened from the premium action's USER_ANY — no self-service rationale here); reads `waterfindUserId`/`aiAdvisor`, calls the delegate, writes JSON. No Stripe. |
| `webapp/WEB-INF/struts-config.xml` | Map `/change-ai-advisor-status` -> `ChangeAiAdvisorStatusAction`. |
| `webapp/jsp/admin/registry/segments/user-reg-details.body.jsp` | "AI Advisor" fieldset (Enabled/Disabled radios), pre-check JS, `changeAiAdvisorStatus()` AJAX. |
| `webapp/jsp/userhome/userhome.jsp` | `isAiAdvisor` from credentials; wrap the AI Advisor sidebar `<li>` in `<% if(isAiAdvisor){ %>`. |

## Verification

- Compile not run: the sanctioned toolchain (JDK 6/7 + pinned Ant 1.8) is absent in this
  environment; only JDK 1.8 is present and the bundled Ant will not launch under it. Per the repo
  rule against version substitution, the build was not run on JDK 1.8.
- Static review instead: types/imports check out; new getter/setter/field/method names match the
  premium references; hbm and struts-config parse as well-formed XML; JSP EL property `aiAdvisor`
  resolves to `isAiAdvisor()`; admin radio ids/form-name/AJAX URL cross-checked against the premium
  toggle; only one credentials-propagation site exists and it was mirrored.

## Enforcement (added 2026-07-10)

The original change gated UI visibility only, from the login-time session credential — so a
broker's toggle did not bite on a live session, and `/ai-advisor.html` + the sidecar stayed
reachable by direct URL/token. Now enforced at three layers:

| Layer | Behaviour when `ai_advisor = false` |
|---|---|
| `ai-advisor.jsp` (both CRM trees + git seam copy) | Fresh flag read per page load via `Waterfind.getWaterfindDelegate().getUserCredentials(uid)` (session value as fallback). Renders a "Reach out for access" card — same style + `/submit-activation-request.html` flow as the Premium Water Data promo (`pageType=ai-advisor` routes to the admin team), with the client's servicing-broker contact when tagged. No token minted; `?token=1` returns 403. |
| `userhome.jsp` (both CRM trees) | AI Advisor sidebar entry now always visible (premium pattern); the page itself decides chat vs gate, so the stale session flag no longer matters. |
| Sidecar (`services/ai-advisor`) | Middleware after `requireAuth` checks `waterfind_user.ai_advisor` (30s cache, default-ON on lookup failure) and returns 403 `advisor_disabled` — kills tokens minted before the disable (30-min TTL). SPA reloads into the gate on that error. |

Verified live (Stuart, uid 119063): mid-session toggle flips chat/gate immediately in both
directions; sidecar 403 for disabled, 200 for enabled clients.

Note: live HTTP suites (`test-acceptance.mjs`, `test-redteam.mjs`, `test-e2e-*.mjs`) mint tokens
as Stuart and will 403 while his flag is off; re-enable him before running them. Offline suites
call the tool modules directly and are unaffected.
