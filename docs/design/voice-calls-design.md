# Voice calls (Inbound + Outbound phases) — design

Status: build design for the two contracted call phases. Branch `feat/voice-calls`, module
`services/ai-advisor/src/voice/`. Supersedes the "out of local scope" stance of
`voice-telephony-architecture.md` for everything that does not need Waterfind provisioning; that memo's
auth stance (OTP/knowledge, never voice biometrics) and staged rollout are kept.

## 1. Contract map

| Bid bullet | Where it lands | Local status |
|---|---|---|
| **Inbound** Retell integration, cloned Waterfind voice | `voice/ws.ts` (Retell Custom-LLM WebSocket), `scripts/voice-setup.ts` (agent provisioning); voice id is config | Built; clone = config value once recordings exist |
| Customer identification + account context at call start | `voice/identity.ts`: caller-ID candidate lookup on `call_details`, self-identification tool, OTP / knowledge step-up; context via the existing tenant-scoped tools | Built (dev DB has masked mobiles → `AIADVISOR_VOICE_TEST_CALLERS` map for demos) |
| Voice-confirmed trade flow with read-back of volume, zone, price | `voice/tools.ts`: existing `prepare_*` + new `confirm_prepared_order`, server-side affirmation check on the caller's last utterance, `no_interruption_allowed` read-back | Built |
| Hand-off to human broker on escalation triggers | `escalate_to_broker` (voice variant): durable escalation + CRM `broker_action` task, then Retell `transfer_number` (cold; warm-whisper unsupported for custom-LLM agents) or callback capture | Built; live transfer needs a number |
| **Outbound** Retell + cloned voice for dialing | `voice/outbound.ts` dialer via `create-phone-call` | Built; blocked on `from_number` |
| Four flows: trade opportunity, order confirmation, market alert, broker follow-up | `voice/flows.ts` — per-flow purpose script, data allowance, end conditions | Built |
| 1 agnostic webhook + 1 integrated platform trigger | `POST /voice/outbound` (bearer secret, idempotency key); order-placed poller (`pending_order.status='placed'`) → `order_confirmation` flow | Built (dial gated by kill switch) |
| AI disclosure + consent capture (Spam Act, DNC Register) | Disclosure preamble on every outbound call, "is now a good time", `record_do_not_call` tool, consent basis stored per request; suppression checked before dial | Built; DNCR washing needs Waterfind's DNCR account |
| Suppression list + call outcome logging | `voice_suppression`, `voice_call` + `voice_call_event`; Retell webhooks (`call_ended`/`call_analyzed`) close the record; `GET /voice/calls` for staff | Built |

## 2. Architecture

```
Caller (PSTN or browser web-call)
  ⇄ Retell (telephony, STT, TTS, barge-in, recording, voicemail detection)
      ⇄ wss://<public>/voice/llm/<WS_TOKEN>/<call_id>   Custom-LLM WebSocket  (voice/ws.ts)
      → POST /voice/webhooks/retell                     call_started/ended/analyzed (voice/webhooks.ts)
Sidecar voice module
  session.ts   per-call state machine + audit events (voice_call, voice_call_event)
  agent.ts     Anthropic Messages API streaming loop (NOT the Agent SDK — see §3), tools, tier gates
  identity.ts  caller-ID candidate, self-identification, OTP, knowledge factors
  tools.ts     voice-only tools + wrapped existing tenant-scoped tools
  outbound.ts  request queue, guards (suppression / hours / flag / idempotency), dialer, order trigger
  flows.ts     outbound flow scripts
  routes.ts    /voice/* HTTP surface
```

One agent, two front doors: the phone path reuses the hard limits + guardrails text, tenant scoping (RLS via
`CallerCtx`), `preparePendingOrder`/`confirmPendingOrder`, `prepareEscalation`/`confirmEscalation`,
`resolveBroker`, `insertBrokerAction`, output redaction. Nothing new gets execution authority.

## 3. Why the voice loop calls the Messages API directly

The chat surface runs the Agent SDK (`query()` spawns a CLI process per turn — seconds of overhead
before the first token). A phone turn needs first audio in ~1 s. So `voice/agent.ts` runs a lean
streaming tool loop on `@anthropic-ai/sdk` (already a transitive dependency; now pinned explicitly),
with:
- the same tool **handlers** (SDK `tool()` defs expose `handler` + zod shape → `z.toJSONSchema`),
- the chat advisor's READ FIRST hard limits and Security & governance rules, composed from the
  fragments `advisor.ts` exports (`hardLimitsBlock`, `HARD_LIMITS_COMMON`, `guardrailsHint('voice')` —
  rule 3 verbatim, rules 1/2/4/5 in phone wording) around the voice-specific persona
  (`personas/advisor-voice-v1.md`: spoken style, call order, read-back protocol, OTP flow, hand-off);
  `agent.ts composeVoicePersona()` is the one composition both backends use via `buildSystem()`,
- prompt caching on system + tools, sentence-boundary flushing to Retell, abort on barge-in,
- a per-turn "call state" block (identity, tier, prepared orders, outbound brief, staff notes, date).
Not carried over: the chat persona body itself (formatting/chart rules), WebSearch (latency),
charts/tables/attachments (no screen). The SDK backend (`agent-sdk.ts`) is the same composition.

## 4. Call session state machine

```
connecting ─call_details─▶ open ──identify──▶ candidate ──verify──▶ verified(L1) ──otp──▶ verified(L2)
    │                        │                                        │                    │
    │                        └── general info only (tier 0) ─────────┘                    │
    │                                                                 order read-back ◀────┘
    │                                                                        │ spoken yes (server-checked)
    ├── escalate ─▶ escalation record + CRM task ─▶ transfer_number | callback captured      │
    └── end_call / hangup ─▶ ended ─▶ webhook closes record (outcome, transcript, recording) ◀┘
```

Auth tiers are enforced in the **tool dispatcher**, not by prompt:

| Tier | Grants | How reached |
|---|---|---|
| 0 | market/regulatory info, region prices, allocation announcements, knowledge corpus | any caller |
| 1 | the client's own account data (`get_my_*`) | **Name confirmation — what a broker does** (decided 2026-08-27 after transcribing six real broker calls: identity on both directions is caller-ID/recognition + first name, nothing more). A caller-ID or outbound-request candidate answering yes to "Am I speaking with <first name>?" (`confirm_caller_identity`, event `identity_confirmed`), or an unrecognised caller giving name + one account detail (`identify_caller`). The two-fact check (`verify_caller_details`) remains as an optional extra when a call seems off: postcode, ABN, customer number, date of birth, email on file, at least one private, none reused from identification; 3 attempts per call, 6 per client per hour |
| 2 | prepare/confirm orders and withdrawals | OTP (possession factor) — knowledge alone never unlocks trading |

Caller-ID (`from_number`) only nominates a **candidate**; it never verifies. Ambiguous or unknown numbers
→ the agent asks for name + one identifier (`identify_caller`, which returns the first name only). Failed
verification degrades to tier 0 or a transfer, never a silent dead end. The tool set is rebuilt per
candidate and every tier>=1 tool carries the uid it was built for: a candidate switch inside ONE model
turn (confirm "no" → identify B → verify B → account tool) is refused by the dispatcher
(`REFUSED_IDENTITY_CHANGED`, retry next turn), and every wrapped handler resolves its scoping
context at CALL time, never from the build. The client's `ai_advisor` flag is re-checked every turn.
Allowlisted tool names are validated against the real tool defs at startup (`validateVoiceToolAllowlists`).

## 5. Trade flow on a call

1. Agent grounds (holdings, price band) with tier-1 tools, then `prepare_sell_order` etc. — same
   validation and scope checks as chat (`pending_order` row; the call id is in `voice_call_event`).
2. Agent **reads back** volume, zone, price (and expiry / forward date / split terms when present) with
   `no_interruption_allowed`, then asks for an explicit yes **and** T&C acceptance in one question.
3. Caller answers. Agent calls `confirm_prepared_order(pending_order_id)`. The server verifies, from
   Retell's transcript (not the model's claim): the pending order was prepared in THIS call for THIS
   candidate; the confirming utterance is a NEW caller turn (later than the prepare turn) that follows
   agent speech spoken after the prepare (anchored on the agent-utterance count at prepare, not
   transcript length); that agent speech contains the order's volume AND price figures (digits or
   English number words — `numbersInText`; filler alone is refused); it classifies as an affirmation
   with no negation/hedge/amendment; the session is tier 2. Only then
   `confirmPendingOrder(ctx, id, tcAccepted=true)` runs — same seam, same idempotency. A candidate
   switch mid-call voids prepared orders, codes and level.
4. Outcome is spoken and written as a `voice_call_event` (`order_confirmed` / `order_failed`).
Anything ambiguous ("yeah but change the price") → not an affirmation → the agent re-prepares.

## 6. Escalation and hand-off

Triggers (persona + tool): explicit ask, out-of-scope, legal/complex structures, price negotiation,
failed auth on a sensitive ask, repeated STT failure. `escalate_to_broker` on voice = prepare +
confirm in one step (the spoken request is the confirmation), which raises the CRM `broker_action` on
the client's file with the call summary; then, if a transfer target resolves (assigned broker's business
number, else `AIADVISOR_VOICE_TRANSFER_NUMBER` — never a number the caller spoke; a caller-given number
is only ever recorded on a callback task) and calling hours allow (the weekday-only rule is the
dialer's, deliberately not applied to transfers), the response carries `transfer_number` and the
outcome is `transfer_requested`; it becomes `transferred` only when Retell's `call_ended` reports
`call_transfer`. Else the agent captures a callback (task says so, caller told the window). Retell's
custom-LLM path has no warm/whisper transfer — the CRM task is the "warm" context in v1.

## 7. Outbound

| Flow | Purpose | Data allowed before verification |
|---|---|---|
| `order_confirmation` | "your order #… was placed/filled" | none — verify (knowledge factor) first, then read the order |
| `trade_opportunity` | market condition relevant to the client's regions | region-level market data only; account specifics after verification |
| `market_alert` | allocation announcement / market event for the client's regions | public data |
| `broker_followup` | "your broker asked us to check in about …" | the payload's brief; no account data |

Guards before any dial (`outbound.ts`): kill switch `AIADVISOR_VOICE_OUTBOUND_ENABLED`, `from_number`
configured, suppression list, destination country (AU; extra codes via
`AIADVISOR_VOICE_OUTBOUND_COUNTRY_CODES`), calling-hours window in `Australia/Sydney`, client's
`ai_advisor` flag, per-client daily cap (per destination number when the request names no client),
max attempts, 7-day staleness. Every request stores its consent basis
(`existing_client_relationship` default). Call opens with the AI + recording disclosure and "is now a
good time?"; "don't call me again" → `record_do_not_call` → suppression + end. Voicemail: Retell agent
setting leaves a generic message with no account data.

Triggers: `POST /voice/outbound` (agnostic; the outbound bearer secret — which opens NOTHING else;
`{flow, client_uid|to_number, payload, idempotency_key (required), scheduled_for?}`; payload strings the
brief reads are capped/flattened and quoted as data, `callback_number` must be one of Waterfind's own
numbers or `AIADVISOR_VOICE_CALLBACK_NUMBERS`) and the integrated trigger — a poller over
`ai_advisor.pending_order` newly `placed` through the CHAT advisor (`conversation_id IS NOT NULL`; voice
builds its broker tools with no conversation, and its confirmations are on the call's event trail, so
a spoken-confirmed order is never called back minutes later; restart-safe via
`voice_outbound_request.source_ref`).

### 7a. Call campaigns (CRM "Call Campaigns" page, 2026-08-27)

Staff-built outbound lists: `src/voice/campaigns.ts` + `campaign-routes.ts` (`/voice/campaigns/*`, staff
token, BROKER/SU), `db/campaigns.sql`, CRM page `crm-seam/ai-campaigns-home.jsp` → `ai-campaigns.jsp/.js/.css`.

| Piece | Behaviour |
|---|---|
| Campaign | name, flow (`trade_opportunity` / `market_alert` / `broker_followup` — `order_confirmation` stays event-driven), payload = the brief (message, broker_name, region, callback_number from the allowlist), `scheduled_for`, `max_concurrent` (default `AIADVISOR_VOICE_CAMPAIGN_MAX_CONCURRENT` 3); status draft → running ⇄ paused → completed / cancelled |
| Member | one per account (its primary contact); snapshot name/company/number; `pending` / `queued` / `skipped` (reason) / `cancelled`; live state DERIVED from its `voice_outbound_request` + latest `voice_call` (`memberStateSql`) — never copied back |
| Eligibility | phone on file, client usertype, not banned, not suppressed, `waterfind_user.ai_advisor`, `registry_user.campaign_optin` (the CRM's "include in campaigns"); checked on add, on launch, and again at feed time |
| Feeder | every `AIADVISOR_VOICE_CAMPAIGN_POLL_MS` (15 s): for each running campaign past `scheduled_for` and inside calling hours, claim (`FOR UPDATE SKIP LOCKED`) up to `max_concurrent − in-flight` members and `requestOutboundCall` them (`idempotency_key campaign:<c>:<member>:<feed#>`, `source campaign:<c>`); completes the campaign when nothing is pending or in flight. The dialer, guards and busy/no-answer retries are untouched |
| Pause / cancel | queued-but-not-dialed requests are withdrawn (`cancelled`) and their members return to `pending` (pause) or become `cancelled` (cancel); dialing calls finish; while paused the tick keeps withdrawing retry re-queues |
| List builder | `GET /voice/campaigns/clients` — one row per account, needs ≥1 filter (search / state → zone / broker / min ML / not contacted since), ≤1000 rows, phone tails only; `campaigns.sql` adds `public.property(registry_user)` — the only index this feature adds to a CRM table |

## 8. Data model (`db/voice.sql`, schema `ai_advisor`)

| Table | Purpose |
|---|---|
| `voice_call` | one row per Retell call: direction, flow, numbers, client uid/account, auth level reached, status/outcome, transcript, summary, recording url, timings, cost |
| `voice_call_event` | audit trail: identified, otp_sent/verified, tool_call, order_readback/confirmed, escalated, transferred, consent_disclosed, opted_out, error |
| `voice_otp` | hashed codes, channel, masked destination, expiry, attempts |
| `voice_suppression` | normalised phone digits, reason, source, who |
| `voice_outbound_request` | queue: idempotency key, flow, target, payload, status, source_ref, schedule, attempts, retell call id |

Retention: `AIADVISOR_VOICE_RETENTION_DAYS` blanks transcript, summary and recording URL on the call and
the caller speech captured in events (`said`); the audit rows stay. Indexes: OTP per-client window,
outbound per-client/per-number day counts, event type+time (knowledge-attempt cap).

## 9. Security

- Every `/voice/*` route except `GET /voice/health` is 404 while `AIADVISOR_VOICE_ENABLED` is off.
- WS URL carries a secret path token; the URL's call id is authoritative: a `call_details` with another
  id is closed; an unknown call is validated against Retell (`get-call`) before any model turn; a call we
  already know must still be `active` and, if it carries any verification, is re-confirmed with Retell
  (call ongoing, same `from_number`) before that level is rehydrated; Retell's fields override the
  message's. Webhooks: `x-retell-signature` (HMAC-SHA256 over body+timestamp with the webhook-badge key,
  5-min skew) over a raw body the route reads itself (2 MB cap); trusted-IP list defaults EMPTY, and when
  set admits only UNSIGNED requests whose real source (socket peer; last X-Forwarded-For hop only when
  the peer is the loopback tunnel) is listed — a present-but-invalid signature is always rejected.
- Admin routes (`/voice/calls`, `/voice/outbound` listing/cancel/dial-now, `/voice/suppression`) take a
  CRM-minted STAFF token only (staff usertype + BROKER/SU role, fresh from the DB — `staff.ts
  hasStaffAccess`, the broker-assist rule); the outbound secret only queues outbound calls.
- Speech is untrusted input; tier gates and the affirmation check are server-side. Spoken output passes
  `redactFinal` per chunk. Tool results are truncated in context; the model never sees phone numbers of
  other users, and never sees the OTP.
- OTP: 6 digits, hashed with a server pepper (`AIADVISOR_VOICE_OTP_PEPPER`; unset warns at boot), 5-min
  TTL, 3 attempts, 3 sends per call, 6 per client per hour. Transport `webhook` (Waterfind's SMS/email
  gateway) or `console` (dev only — delivers only under `AIADVISOR_VOICE_OTP_DEV`, default on outside
  NODE_ENV=production); a webhook transport with no URL, a failed gateway call, or console without the
  dev flag all FAIL CLOSED (`transport_failed`, the caller is never told a code was sent).
- Outbound endpoint: bearer secret + idempotency; dialing kill switch default OFF.
- Demo page (`/voice/demo`) gated by `AIADVISOR_VOICE_DEMO=1` AND `AIADVISOR_VOICE_DEMO_KEY` (no key = closed; key in the POST body or bearer header, never a query string); creates Retell web calls only. `/voice/health` and `voice:setup` never print the WS URL (secret) or the webhook URL.
- Escalations/callbacks filed for an unverified candidate are labelled "UNVERIFIED caller" on the CRM task; OTP sends are capped per call and per client per hour; the OTP destination tail is only spoken when caller-ID (not a claimed name) nominated the candidate.

## 10. Failure modes

| Failure | Behaviour |
|---|---|
| Model/tool timeout (> 20 s) | apologise, offer transfer/callback; event logged |
| Barge-in mid-response | abort stream; what was already spoken stays in history as a `[cut off]` assistant turn (the caller's request is not lost on the next reconcile); the superseded turn's pending end-call/transfer flags are dropped; turns are serialised per call (a superseded turn closes its tool round first); Retell's transcript wins as the record of what was said |
| Retell reconnect / sidecar restart | `auto_reconnect` on; in-memory session reused, else rehydrated from `voice_call` (identity, level, opening-already-spoken); Retell resends the transcript |
| OTP transport down / misconfigured | `transport_failed`: tell caller; offer to have their broker place the order, or a callback; never pretend it was sent |
| Client opts out on the call | `record_do_not_call`: number → `voice_suppression` (every future AI dial refused) and, when the client is known, the exec seam's `optout` op files a Contact Note and switches the CRM's "Include in Campaigns" (`registry_user.campaign_optin`) off — the two records a broker would make; best-effort, each half reported on the `opted_out` event |
| Seam unknown outcome on confirm | same reconcile path as chat; caller told it is being verified, broker task raised |
| DB down at identify | fail closed to tier 0 |
| Retell webhook missed | sweeper closes calls still active after 3 h as `abandoned` |

## 11. The phone number (decided 2026-08-26: Twilio + Retell)

Retell sells US/CA numbers only; an AU number is bring-your-own-carrier over SIP. Chosen: a **Twilio
Australian mobile (04) number** — Business regulatory bundle (ABN/ACN + ASIC extract, address anywhere),
no Australian-resident ID needed (Telnyx's AU mobile path needs one); US$8.25/mo. Mobile rather than
local for outbound answer rates; Twilio requires a Twilio-allocated CLI for AU destinations, which this is.

| Step | Where |
|---|---|
| Buy the number (Voice + SMS) against the bundle | console.twilio.com → Phone Numbers → Buy |
| Elastic SIP trunk: origination `sip:sip.retellai.com`; termination = credential list (or IP ACL `18.98.16.120/30`); assign the number | Twilio console |
| Register with Retell + bind both agents | `.env`: `AIADVISOR_VOICE_SIP_TERMINATION_URI=<trunk>.pstn.sydney.twilio.com` (+ `_USERNAME`/`_PASSWORD`), then `npm run voice:setup -- --import +61…` |
| Caller ID | `AIADVISOR_VOICE_FROM_NUMBER=+61…` (printed by the import); dialer stays behind `AIADVISOR_VOICE_OUTBOUND_ENABLED` |

Use the Sydney-localised termination URI: Twilio routes AU→AU calls via the Sydney edge only. Per minute
on top of Retell (US$): SIP 0.004 + inbound 0.05 / outbound-to-mobile 0.075. No caller-name display exists
in AU (no CNAM; Twilio Branded Calling is US/CA/UK/DE) — "Waterfind" on the handset means the client saved
the number, so keep it permanent and send it once by SMS from the registered `Waterfind` sender ID.

## 12. Deliberately deferred / blocked

Cloned voice (recordings + ElevenLabs), live transfer test, DNCR API washing,
legal wording of the consent script, SMS/email OTP gateway credentials, recording retention policy,
CRM screen-pop for transfers, warm-whisper transfer (Retell limitation), post-call CRM contact note via
the call-notes drafter (lands after that branch merges — the transcript is stored for it).

## 13. Testing

- `npm run test:voice` (offline, ~200 checks): phone normalisation, affirmation detector, read-back
  figure parser, tier + stale-toolset gates (mid-turn candidate switch), zod validation on the Messages
  API path, allowlist validation, composed prompt, OTP lifecycle + fail-closed transport, knowledge-factor
  caps, barge-in history, sentence chunker/speech formatting, webhook signature + admission policy,
  outbound guards + request contract, transcript reconciliation, advisor-flag re-check, retention.
- `npm run test:voice-protocol` (~60 checks): a fake Retell client drives the real WS endpoint + HTTP
  surface end-to-end (call_details → identify → OTP → holdings → prepare → read-back → confirm →
  transfer → webhook), plus call-id validation/rehydration, webhook IP/signature policy and body cap,
  the kill switch, staff-only admin, and the outbound trigger contract, with a scripted model.
- `npm run itest:voice`: same driver against the live model (needs ANTHROPIC key + DB).
- Manual: `/voice/demo` web call once a Retell key exists.
