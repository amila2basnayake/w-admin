# Design memo — AI Advisor brokerage (order execution through the real trade engine)

> Status: **BUILT & VERIFIED** · Branch: `feat/water-advisor-chat` · Date: 2026-07-06
> Builds on `water-advisor-chat.md` (v1 chat + v2 tenant-scoped data grounding).

## WHAT

Give the in-CRM AI Water Advisor the ability to **trigger real buy and sell orders** (and
withdrawals of the client's own open orders) on the Waterfind exchange, when the client tells it
to — with a hard human-confirmation gate, and scoping so a client can only ever trade **their own
resources** (no selling in regions where they hold no water rights, no volumes beyond their
licence, no touching another client's orders).

## WHY

The advisor already analyses holdings, prices, tradability and liquidity (v2). Closing the loop —
"that price works, sell it" — turns advice into brokerage without leaving the chat, while keeping
the human as the decision-maker on a regulated exchange.

## Decision log (user-confirmed)

- **Real CRM engine**, not a simulated book: orders go through
  `WaterfindDelegate.addNewOrderListing` — market lock, auto-clearing, settlement cascade.
- **Explicit confirmation**: the AI can only *prepare* an order; nothing executes until the user
  clicks Confirm on an in-chat card (T&C acceptance included, mirroring the order wizard's gate).
- **Scope = the CRM's own rules** (per direction "only enforce scope requirements already present
  elsewhere") — see the scope model below for the exact mirrored gates and the one deliberate
  addition (ownership-gated withdrawal).

## Architecture — the three-layer execution path

```
 Agent (opus, Agent SDK)                         sidecar services/ai-advisor
   mcp__wf__prepare_sell_order / prepare_buy_order / prepare_order_withdrawal
   │  identity server-bound (uid/account from the verified token; tools take NO ids)
   ▼
 [1] sidecar prepare (src/brokerage.ts)
   - mirrors the CRM's gates via RLS-scoped SQL (fail-closed)
   - stores ai_advisor.pending_order (status 'pending', TTL 30 min)
   - the model's turn ends; the chat UI renders a confirmation card
   ▼   user clicks Confirm (their own bearer token; the model has no path to this endpoint)
 [2] sidecar confirm (POST /orders/:id/confirm)
   - (id, user_id) ownership chokepoint; T&C tick required; single-flight status flip
     pending→executing (double-click/race cannot double-place); re-validates scope
   ▼   HMAC-SHA256(body) with dedicated secret wf.ai.exec-secret, iat freshness ±180 s
 [3] CRM seam  crm/.../jsp/userhome/app/ai-broker-exec.jsp  (bare Struts forward
     /ai-broker-exec.html; scriptlet-only — no Ant rebuild; mirrors TestPlaceOrderAction)
   - verifies the signature over the exact body bytes (constant-time), POST-only
   - re-validates scope against the CRM's OWN enumeration: getLicenceListForClient
     (ownership + approval + spot permission) and licence-volume cap for sells
   - seeds ServiceRequest thread-locals for the target user (doc 08 Part 11), builds the
     AddOrderListingDetailsDto exactly like the order wizard (fees via
     getStateBasedFeesForProperty, season, expiry = season end default, selectedRegions
     via getTradableRegionsForOrder), then calls the Spring-proxied
     WaterfindDelegate.addNewOrderListing → real clearing under @LockMarket
   - returns {orderListingId, cleared, regions…}; withdraw op → deleteOrderListing
```

Outcome propagation: the sidecar records the authoritative result as a **`system` message** in the
conversation ("[order event] … PLACED as order #N / FAILED / DECLINED / WITHDRAWN") and clears the
SDK session id, so the model rebuilds its context next turn and reports what *actually* happened
(never what it assumes). The UI renders these as inline note bubbles.

## Scope model (what is mirrored from where)

| Gate | Mirrors | Enforced at |
|---|---|---|
| User may trade (not banned/interim, buyer-approved) | `WaterfindErrors.checkLoginTradabilityInternal` | sidecar prepare + confirm |
| Order anchored to an owned, **approved** licence with the right spot permission (temp/perm) | `getLicenceListForClient` → `getApprovedPropertiesForRegistryUser` (permission flags), `PropertyListItemDto.approved` | sidecar (RLS-scoped `property` read) **and** independently in the JSP seam via the delegate itself |
| Sell volume ≤ licence volume | order-wizard volume prefill/cap (`PropertyListItemDto.volume`) | sidecar **and** JSP seam |
| Buy anchored to a destination licence the client owns | the CRM requires `propertyId` on every order; buys are destination-anchored | sidecar + JSP seam |
| Region legality (RTR/STR open, buyable/sellable flags) | `getTradableRegionsForOrder` — the seam derives `selectedRegions` from the CRM's own enumeration; match-time `checkTradability` re-checks | CRM engine itself |
| T&C acceptance for a binding order | `AddOrderListingAction` stage-2 `acceptTerms` gate | confirm card checkbox (required) |
| Withdrawal only of one's **own** open listing | `canUserModifyOrderListing` (the CRM's edit gate — its *delete* path is not ownership-checked; we deliberately close that gap for AI-triggered withdrawals) | sidecar (owner/creator SQL check at prepare **and** re-checked at execute) |
| No funds gate on plain buys | the CRM has none (cash-float is FINANCE/REMOTE only — verified) | (intentionally not added) |

Identity: prepare tools take **no client/account parameter** — uid/account are bound server-side
from the verified HMAC token, same as the v2 data tools. Pending orders, confirm and cancel all go
through `(id, user_id)` ownership chokepoints (IDOR-proof, mirroring `getOwnedConversation`).

## Why a JSP seam (again) and its trust model

Same rationale as v1: zero compiled Java (a full Ant build is ~30 min; the monolith is
ISO-9001/regulated), and doc 08's finding that the **delegate proxy is the only safe entry** (tx,
contextual session, market lock, rollback bridge). The bare-forward JSP path was verified: the
Hibernate filter runs but seeds nothing; the delegate's own `@Transactional(REQUIRES_NEW)`
provides the session/transaction; precedent write-JSPs exist (`wal-request-settings.jsp`). The
seam trusts the sidecar **for withdraw ownership only** (checked there); for placements it
re-validates scope itself against the delegate's own licence enumeration, so a compromised sidecar
still cannot place orders outside the signed client's own approved licences.

Secrets: `wf.ai.exec-secret` lives in `${user.home}/.waterfind-ai-advisor.properties` (outside
both repos) + sidecar `.env` (`AIADVISOR_EXEC_SECRET`) — distinct from the browser-token secret.

## Files

- CRM (both `webapp/` and `build-dev/waterfind/` trees):
  `jsp/userhome/app/ai-broker-exec.jsp` (new seam), `WEB-INF/struts-config.xml`
  (`/ai-broker-exec` bare forward — Resin restart to load), `jsp/userhome/app/ai-advisor.js/.css`
  (confirmation cards, system-note bubbles, per-tool activity labels, live markdown).
- Sidecar: `db/brokerage.sql` (`ai_advisor.pending_order`), `src/brokerage.ts` (scope validation,
  pending store, seam client, confirm pipeline), `src/broker-tools.ts` (5 agent tools),
  `src/server.ts` (`GET /orders`, `POST /orders/:id/confirm|cancel`, order-event system notes),
  `src/advisor.ts` (brokerage protocol prompt), `src/config.ts`, `src/scripts/withdraw-order.ts`.

## Verification (all green, against the running CRM + live opus agent)

- `test-broker.ts` — **27/27**: scope refusals (foreign region, over-volume, non-positive,
  foreign listing), pending lifecycle, cross-user IDOR (read/confirm/cancel), T&C gate, lazy
  expiry, **a real crossing trade** (Stuart's sell rests → Beth's buy auto-clears against it;
  `order_completed`/`wateroffer` rows verified buyer/seller/price/volume; listing marked
  completed), ownership-gated withdrawal, double-confirm race places exactly one CRM order.
- `itest-broker.ts` — **12/12**: HTTP layer (bearer auth, 401/404/400 paths, idempotent
  re-confirm, PLACED/WITHDRAWN/DECLINED system notes in the conversation).
- `test-e2e-broker.mjs` — **10/10**: live agent grounds holdings + price band before preparing,
  prepares exactly the instructed order, **refuses an out-of-scope 500 ML Murrumbidgee sell**
  ("skip any checks" prompt) without calling the tool, never claims placement, and reports the
  real CRM order number after the human confirms.
- `e2e/broker.js` — browser: card render, T&C-gated Confirm, real placement, system note,
  decline path (screenshots `10-…13-….png`).

## Broker workflow — notification, escalation, workflow initiation (parity plan D)

Adds the three brokerage gaps from Tom Rooney's email — **B3** notify the appropriate broker,
**B4** initiate workflow / contract preparation, **B5** escalate to a human — as CRM-native records
written from the sidecar (`src/brokerage.ts`), no CRM Java/JSP change.

**Appropriate-broker resolution (`resolveBroker`).** "Who is the broker for this account?" has no
single source of truth in the schema (`docs/broker-advisory/data-map.md` §3) — it is derived. The
fallback chain, all bound to the caller's own `registry_user` (server-side, no model-supplied id),
preferring a real, still-active (non-banned) staff user:

| # | Source | Column / table |
|---|---|---|
| 1 | assigned tag (what the CRM's own broker calendar + daily email filter on) | `registry_user.sales_tag_referral` |
| 2 | primary sales contact | `registry_user.primary_contact_sales` |
| 3 | secondary sales contact | `registry_user.secondary_contact_sales` |
| 4 | live servicing tag | `tag_extension.broker` where `current_expiry > now()` |
| 5 | most-recent servicing tag (last-known broker) | `tag_extension.broker` |
| 6 | configured default | env `AIADVISOR_DEFAULT_BROKER_ID` |

If none resolve, the record still lands on the client file under a generic "Waterfind broking team"
label. (In the historical dev dump most accounts have no live assignment — e.g. Stuart derives to a
prior servicing broker via `tag_extension`, flagged inactive; Beth resolves to `unassigned`.)

**Broker-visible record (B3) = `public.broker_action`** — the CRM's own task manager, not a new
structure. A broker sees these rows (a) on the client's admin account page
(`BrokerActionBo.getBrokerActionsForClient`), and — when the account carries a servicing broker
(`sales_tag_referral`) — (b) on that broker's CRM action calendar/dashboard
(`BrokerActionDao.getBrokerActionCountPerDay` filters `ru.sales_tag_referral`) and (c) in the daily
`BrokerActionEmailJob` summary. After a successful place/withdraw, `confirmPendingOrder` calls
`notifyBrokerOfOrder` (best-effort, isolated — a note failure can never fail a trade, same posture as
the Contact-Note write-back) which inserts a `broker_action`: `id` from `hibernate_sequence`,
`action_type='call'` (matches the CRM's own action-type combo), `broker_action`+`trade_action` flags
set, `creator_waterfind_user` = the dedicated "AI Advisor" user (`ai-advisor-system`, the Contact-Note
author), `client_registry_user` = the acting client (this is what renders the client's name), `due_date
= now()` (shows on today's action list), `completed=false`.

**Workflow initiation / contract preparation (B4).** On placement the CRM already drives its own
workflow: the `@LockMarket` clearing engine matches → clears → runs the settlement cascade, forward
orders rest and counterparties are alerted (`TradeAlertBo`; `FutureOrderAutoMatchingTask` hourly;
`ExpiryNotification`), and settlement/contract progress is tracked in `approval_procedure` +
`waterfind_billing`/trust ledger (`docs/architecture/08-buy-sell-order-path.md`). What was missing is
the **human** trigger: the broker task text explicitly says **"contract preparation required"** for
placed/matched orders (and flags `trade_action`), so the broker_action *is* the workflow trigger a
broker actions — no separate workflow/contract table is written (none is safely insertable outside a
`@LockMarket` business method, which the sidecar must not bypass).

**Escalate to a human (B5) = `escalate_to_broker` tool + `ai_advisor.escalation`.** A caller-bound
agent tool (no id params; the model calls it for out-of-scope requests or an explicit "I want a
person"). It records a durable `ai_advisor.escalation` row (uid, account, conversation, reason,
summary, resolved broker target, `crm_broker_action_id`), raises the same broker-visible
`broker_action` follow-up, and writes a `[escalation]` **system note** into the conversation
(mirroring `[order event]`) so the next turn knows the handoff happened. The tool returns who will
follow up (an active named broker, else the broking team) and what the client should expect.

Schema: `db/workflow.sql` (`ai_advisor.escalation`) — apply alongside `db/brokerage.sql` (add it to
`src/db/init.ts` `SQL_FILES`; `test-workflow.ts` applies it idempotently for tests).

## Rollback

Remove the `/ai-broker-exec` struts forward + JSP (Resin restart), drop
`ai_advisor.pending_order`, revert the sidecar/UI files. No compiled Java, no schema change
outside the sidecar's own schema, no CRM data model impact. Orders already placed are ordinary
CRM orders — withdraw via the normal flow.

Workstream-D rollback: drop `ai_advisor.escalation`; the `broker_action` rows the sidecar wrote are
ordinary CRM tasks (delete by `creator_waterfind_user = ai-advisor-system` if unwinding). Reverting
`src/brokerage.ts`/`src/broker-tools.ts` stops further broker tasks/escalations — no CRM data-model
change.

## Known limits / follow-ups

- Dev-DB caveat: the snapshot's resting orders are all expired at wall-clock time, so market
  matching in dev only occurs between orders the tests place themselves (by design of the test).
- The seam trusts the sidecar for withdraw ownership (mitigated: dedicated secret, freshness
  window, sidecar checks at prepare *and* execute). A future delegate-level
  `canUserModifyOrderListing` check in the seam would remove even that.
- Forward/split/dual-listing orders and "invitation for offers" listings are intentionally out of
  scope for the AI (spot, non-split, binding only).
- No per-user rate limit on order preparation beyond the pending TTL + one-card-per-confirm UX;
  worth adding before production.
