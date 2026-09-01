# AI Advisor bug sweep — 2026-07-10

Six-area parallel review of `feat/advisor-parity` (sidecar core, brokerage execution, data tools,
forecast/extdata/knowledge, voice/attachments, CRM JSP integration). Every BLOCKER/HIGH finding
below was independently re-verified against the code before inclusion. TypeScript compiles clean.

## Release blockers

| # | Defect | Where | Trigger / impact |
|---|---|---|---|
| B1 | Duplicate real-order risk: the CRM seam has no idempotency key and errors after placement are recorded as `failed` | `src/brokerage.ts:365-382, 445-449`; `ai-broker-exec.jsp` (post-placement `getOrderListingSummary` inside the same try) | Seam call aborts at 120 s while the market lock queues it, or the JSP throws after `addNewOrderListing` — order is LIVE, sidecar marks `failed`, chat says placement failed, user re-confirms → duplicate real order. Fix: signed idempotency key (`pending_order.id`) deduped in the JSP; treat timeout/transport errors as `unknown` and reconcile before allowing retry; JSP must return success-with-id once placed. |
| B2 | Advisor kill switch fails OPEN and caches the fail-open verdict | `src/data-db.ts:64-80` | Any RO-DB error → `enabled = true`, cached 30 s. A broker-disabled client regains full access (incl. order confirm) for the outage + 30 s. Unknown uid (deleted user, live token) also → enabled. Fix: fail closed (503) on lookup error; deny unknown uid; never cache the error path. |
| B3 | No `pool.on('error')` on either pg pool — an idle-client error crashes the whole sidecar | `src/db.ts:11`, `src/data-db.ts:8` | Postgres restart / network blip with idle pooled connections → unhandled `'error'` event → process exits, all clients down, in-flight SSE turns dropped. |
| B4 | Sell-side holdings gate is per-order, not aggregate — a client can oversell the same licence | `src/brokerage.ts:112-134`; JSP scope gate (~line 323) | 100 ML licence → confirm 100 ML sell twice → 200 ML resting against 100 ML of water. Engine's double-sell guard only stops the same listing clearing twice. Fix: subtract the client's open sell listings on the property in both gates. |

## High

| # | Defect | Where | Impact |
|---|---|---|---|
| H1 | `get_matchable_orders` returns the WORST 40 prices to a buyer (sort is `DESC` for both sides); `get_market_liquidity` reports `max()` as `best_price_per_ml` on the buy side | `src/data-tools.ts:195, 210` | 61 regions currently have >40 live asks — cheapest asks silently truncated; 169 regions report the most expensive ask as "best". Client-facing wrong prices. |
| H2 | `estimate_my_seasonal_allocation` double-counts entitlement where a region has >1 allocation program (join fan-out before `sum`), and misses the `p.sold` filter | `src/data-tools.ts:85-93` (inherited from toolkit Q11) | Verified exactly 2x in affected regions (40 regions, ~1,577 accounts). Fix in `advisory-toolkit.sql` too. |
| H3 | `get_my_trade_history` duplicates trades paid in instalments (row-level `client_payment` join) | `src/data-tools.ts:104` | 90 current trades affected; summed gross/ML double-counts; duplicates eat the LIMIT. |
| H4 | `escalate_to_broker` claims "a follow-up task has been raised" even when the CRM insert was skipped or threw | `src/broker-tools.ts:178-191`; `src/brokerage.ts:587-589, 675-677` | Client told a human will follow up; nobody notified. Branch the reply on `crmBrokerActionId == null`. |
| H5 | Order can list into regions the user never confirmed (`getTradableRegionsForOrder` defaults, all selected) | `ai-broker-exec.jsp:416-424` | Confirmed card shows one region; order can match in zones the user never saw. Constrain to the anchor region or show the set on the card. |
| H6 | Contact-note / broker_action audit trail is silently best-effort | `ai-broker-exec.jsp:172-206`; `src/brokerage.ts:631-633` | Trades can execute with no CRM file record; regulated/audited business. Return note status through the seam, persist it, alert on failure. |
| H7 | Seam replay window: no nonce/jti, freshness only ±180 s, plaintext `http://localhost:81` default | `ai-broker-exec.jsp:237-243`; `src/config.ts:55` | Captured request re-places an order for up to 3 min. B1's idempotency key also closes this. |
| H8 | WS-B allocation cross-check is dead code — snapshot shape never matches, so `snapshot_cross_check` is always null | `src/forecast-tools.ts:95-108` vs `knowledge/data/allocations.json` (`announcements` array) | Advertised divergence guardrail silently does nothing. Map region → state/valley or remove. |
| H9 | Water-year rollover corrupts the allocations snapshot: refresh overwrites pct/as_at but never `season`/`stage` | `src/scripts/refresh-extdata.ts:147-166` | First refresh after next season's opening determinations writes new numbers under `season 2026-27 / opening`. Refuse on season mismatch. |
| H10 | "Final (end-of-season) %" is actually "last reading" — `finalMos` computed, never checked | `src/forecast-tools.ts:151-165` | Sparse seasons systematically understate finals → skews analogue distributions and dry/median/wet terciles. |
| H11 | Forecast tools treat the last recorded trade as "now" (no wall-clock staleness check); entitlement tool fabricates `data_as_at = <year>-12-31` (can be a future date) | `src/forecast-tools.ts:411-417, 509-521, 644` | Years-old prices anchored and projected as current; tool states a data date five months in the future. |
| H12 | Crash instead of refusal when an allocation series has zero readings | `src/forecast-tools.ts:229-234` | `seasons[len-1]` undefined → TypeError, turn dies. |
| H13 | Attachment caps contradict: 16 MB allowed per message, 15 MB prompt-embed budget — first send can silently drop a file, and the model then asks the user to re-attach (which can never work) | `src/attachments.ts:9-11`; `src/server.ts:79-99`; `src/advisor.ts:115` | Make `MAX_MESSAGE_BINARY_BYTES <= PROMPT_EMBED_BUDGET_BYTES` or exempt the current message. |
| H14 | Hands-free voice can transcribe the advisor's own TTS audio and auto-send it as a real user turn (Listen buttons active during capture; `speakStop` never cancels the mic) | `crm-seam/ai-advisor.js:988, 1012, 1058` | A spoken reply becomes the next user message — can reach the brokerage path. Cancel the mic in `vqStart`/`speak`. |
| H15 | User `custom_instructions` are appended to the system prompt AFTER the guardrail blocks | `src/advisor.ts:146-151` | 4,000 chars of user text in the most privileged, most recent slot — direct attack on the information-not-advice rule. Wrap as untrusted preferences, place before guardrails. |
| H16 | Order confirm/cancel bypass the per-conversation turn lock — an in-flight turn's `done` handler rewrites the session id and the "[order event]" note never reaches the model | `src/server.ts:397-406` vs `:217` | Model can later deny the order exists or prepare a duplicate. Reject/queue confirm while `activeConvTurns.has(convId)`. |

## Medium

- Internal `mcp__wf__*` tool ids streamed verbatim to the browser via `tool` SSE events, defeating the output guard's own invariant (`src/server.ts:210`).
- Raw internal error text streamed to clients on the SSE path (`src/server.ts:244`, `src/advisor.ts:262-276`); 401s echo `e.message` including config file paths (`src/auth.ts:65`, lazy `sharedSecret` getter means a missing secret doesn't stop boot).
- Hardcoded fallback password `ai_ro_local` for the RLS read-only role (`src/config.ts:39`).
- `/tts` and `/transcribe` unmetered (no per-user throttle; chat-only `acquire()` cap); client never aborts superseded TTS fetches; `/transcribe` caps bytes (25 MB ≈ 4+ h Opus) but not duration, and the route passes no abort signal/timeout upstream.
- `get_price_band` / `get_market_reference` anchor to `now()` while every other tool uses `ctx.asof` (`src/data-tools.ts:235-255`) — empty/misaligned windows on a pinned snapshot.
- `get_my_opportunities` accepts any 4-digit `season` (e.g. 2099) → confidently-worded nonsense observations (`src/data-tools.ts:586-588`).
- `estimate_net_proceeds` rate card keyed off input region's state vs `get_my_fee_schedule` keyed off first holding's state — the "same numbers" claim can diverge cross-state (`src/data-tools.ts:311-357`).
- Forecast CAGR/trend silently mixes region medians with state-pool medians at fit endpoints (`src/forecast-tools.ts:596-651`); state-pool fallback contaminates "historical" bands with current-season/self trades (`:461-465`).
- `n_prior_years` counts readings, not years — inflates once the refresher runs >1x/month (`src/extdata-tools.ts:104-116`).
- Non-atomic snapshot writes (`writeFileSync` in place) + unguarded module-level `loadJson` in extdata-tools: a truncated JSON keeps the whole sidecar from booting (`refresh-extdata.ts:32-34`, `extdata-tools.ts:25-28`).
- Advisor disable takes up to 30 s to bite on the sidecar (enabled-verdict cache); consider skipping the cache on `/orders/:id/confirm` (`src/data-db.ts:62,70`).
- Admin toggle: any staff role can toggle ANY user id; state-changing GET, no CSRF, no book scoping (`ChangeAiAdvisorStatusAction.java:36-44`).
- Unsent-upload backstop TOCTOU: ~50 concurrent uploads defeat the 20-file cap (`src/server.ts:330-331`).
- `bindAttachments` failure leaves an orphaned user message referencing never-bound files (`src/server.ts:472-474`).
- Image cap of exactly 5 MB decoded may exceed the API's base64 ingestion limit (~3.75 MB raw) — verify empirically.
- Sidecar expiry validation is regex-only (accepts 31/02/2026 and past dates) unlike `delivery_date` (`src/brokerage.ts:284-286`).
- Withdraw ownership gate relies entirely on the sidecar RO DB being the LIVE CRM DB (`ai-broker-exec.jsp` delete is unguarded by design); enforce/document the same-DB invariant; JSP should re-check owner/completion.
- Sticky empty props cache in `ai-advisor.jsp:16-27` — secret provisioned after first page hit requires a Resin restart.

## Low / nit (abridged)

- Persisted reply keeps only the last text block on interleaved text-tool-text turns (`src/advisor.ts:252`).
- `POST /conversations` accepts an unbounded title (`src/server.ts:277`); rename caps at 200.
- `systemAuthorId` caches a failed lookup forever (`src/brokerage.ts:490-498`); withdrawals recorded as status `placed`; no upper sanity cap on buy volume/price.
- Refresh script: UTC date stamping (pre-11am AEST runs stamp yesterday); regex-scraped numbers labeled high-confidence with no delta sanity check; top-level `as_at` advances over stale rows (verified live: Lake Victoria 2 months stale under a fresh headline date).
- Knowledge search has no stopword handling; `statSync` unguarded in corpus walk.
- `AIADVISOR_TTS_CHUNK_CHARS=0` infinite loop; unclosed code fence swallows the rest of TTS; `attBlobCache` object URLs never revoked.
- `ut` claim mints broker-clients as `ut=1` (broker) — harmless today, latent trap; client-clock token-expiry tracking; advisor page HTML (with token) not `no-store`; `Long.parseLong` outside try → 500 on blank param; trailing-slash defeats the raw-body carve-out (fails safe).
- `get_my_disputes` sorts at-fault rows last so LIMIT 20 evicts them first; truthiness skips `price_context` when realised median is 0; failed-ROLLBACK client released without error flag.

## Verified clean (attacked, held)

- Tenant isolation: every conversation/attachment/pending-order/data query bound to the session uid/account; no tool input selects whose data to read (verified independently by two reviewers).
- SQL injection: none — all statements parameterized. XSS: none — all render paths escape.
- HMAC posture: token verify (fixed alg, constant-time, expiry, TTL clamp) and seam signature (exact body bytes, constant-time, fail-closed on missing secret/iat) are sound.
- Confirmation architecture: no execute path without the human click; pending→executing conditional flip is single-flight; no TOCTOU on confirmed price/volume.
- Flag plumbing: enforced server-side in two independent places; NOT NULL DEFAULT true + COALESCE; no token minted while disabled; toggle role check solid (clients cannot call it).
- No path traversal in knowledge tools; all 27 corpus doc ids resolve; no prompt-injection path from the extdata refresher; port is consistently 3100 in code (the stale-sidecar issue is a running-process gotcha, not a code mismatch); webapp/ and build-dev/ copies byte-identical; Java 6/7-safe syntax throughout.
