# AI Advisor — delivery status against Tom Rooney's vision email (2026-07-08)

Branch `feat/advisor-parity`. This maps every functional-test scenario in Tom's email to its current
state and the evidence for it. Staff-facing items (CRM file notes, correspondence drafting, document
workflow) are de-prioritized per direction and tracked separately at the end.

## Evidence at a glance

- **Offline suites (10):** output-guard 29/29, tools 21/21, broker 70/70, workflow 14/14,
  opportunities 37/37, forecast 38/38, extdata 52/52, knowledge (pass), tts 36/36, transcribe 12/12.
  Typecheck clean.
- **Live acceptance eval (`test-acceptance.mjs`): 8/8** of Tom's new-capability scenarios, each with
  the correct tool invoked and a grounded/cited/disclaimered answer.
- **Red-team (`test-redteam.mjs`), integrated run: 29/31** — every code-enforced and
  injection/scope/order category clean, zero secret/identifier leakage, advice-boundary the one
  residual (pending Waterfind's information-vs-advice ruling).

## Scenario status

### Regulatory Knowledge — built (public corpus), evidence live

| Tom's test | State | Evidence |
|---|---|---|
| Explain current allocation for a valley | Built | `get_allocation_announcements` + knowledge corpus; NSW/VIC/SA current-season data |
| Interpret Water Sharing Plan rules | Built | `search_knowledge` → NSW WSP docs; live probe cited WMA 2000 s21 + the Murray WSP |
| Explain carryover rules | Built (R3 live PASS) | Answer cited the NSW Murray 50%/110% account limit from the corpus |
| Compare trading rules between jurisdictions | Built (R4 live PASS) | NSW-vs-VIC side-by-side from `cross-trading-rules-comparison` |
| Summarise Basin Plan provisions | Built (R5 live PASS) | Basin Plan Ch.12 ss12.01–12.52 summary with source |

Corpus = 27 cited public-law docs (`services/ai-advisor/knowledge/regulatory/`). Waterfind-internal
knowledge (submissions, consulting, FAQs, procedures) is a separate corpus **blocked on Waterfind
supplying the documents**.

### Market Intelligence — built; forecasting shipped behind compliance framing

| Tom's test | State | Evidence |
|---|---|---|
| Current temp & permanent pricing | Built (pre-existing) | curated market tools |
| Recent transaction history | Built (pre-existing) | de-identified regional trades |
| Dam storage vs historical averages | Built (M3 live PASS) | `get_dam_storage` cited G-MW as-at 8 Jul; Hume vs 56-yr July baseline from local `dam_reading` |
| Explain recent market movements | Built (pre-existing) | price history + charts |
| Forecast allocation probabilities | Built (M5 live PASS) | `forecast_allocation` — analogue distribution, ranges, as-at caveat |
| Forecast temp prices this season | Built | `forecast_temp_price` — tercile scenario bands |
| Forecast long-term entitlement values | Built (M7 live PASS) | `forecast_entitlement_value` — CAGR + trend band + policy caveat |

Forecasts are empirical analogue distributions (allocation series to 1977), **ranges only, never a
point estimate**, with mandatory not-advice disclaimers — see `ai-advisor-forecasting.md`.

### Customer Intelligence — built

| Tom's test | State | Evidence |
|---|---|---|
| Retrieve customer trading history | Built (pre-existing) | `get_my_trade_history` |
| Identify previous buying/selling behaviour | Built | `get_my_opportunities` history profile |
| Recommend opportunities from historical activity | Built (C3 live PASS) | `get_my_opportunities` — factual observations, not-advice framing |
| Understand trading region + licence profile | Built (pre-existing) | `get_my_holdings` / `get_my_profile` |

### Brokerage — built end-to-end

| Tom's test | State | Evidence |
|---|---|---|
| Capture intention to buy/sell | Built (pre-existing) | `prepare_*` + confirm card |
| Generate draft trade request | Built | pending order + preview |
| Notify the appropriate broker | Built | order-placed → CRM `broker_action` task on the servicing broker (contract-prep flag) |
| Initiate workflow / contract preparation | Built | the broker task carries "contract preparation required" |
| Escalate complex matters to a human broker | Built (B5 live PASS) | `escalate_to_broker` → durable record + CRM task; live probe notified the real broker (Dion Martin) |

### Voice — conversation mode built; telephony scoped

| Tom's test | State | Evidence |
|---|---|---|
| Explain market conditions conversationally | Built | dictation (STT) + TTS playback + hands-free voice-mode loop |
| Receive inbound calls / Outbound engagement / Authenticate | Built (Retell phone channel, `src/voice/`); go-live needs Waterfind provisioning | `voice-calls-design.md` — websocket agent, OTP/knowledge tiers (**not** voice biometrics), read-back trade flow, escalation/transfer, outbound flows + guards; blocked: number, cloned voice, legal/consent wording, DNCR, OTP gateway, API key |
| Maintain communication style + ethical standards | Built + hardened | persona + guardrails (L8/L9) |

### Governance / jailbreak resilience (Tom named it explicitly) — built

Nine defence layers (`ai-advisor-guardrails.md`): server-bound identity, curated no-SQL tools,
least-privilege DB role + RLS, de-identified market tools, explicit-confirm brokerage,
attachment-as-data framing, sandboxed agent, hardened persona, and a **deterministic output guard**
that strips secret values and internal identifiers from the wire. Red-team 29/31 integrated.

## Open decisions for Waterfind (unblock the remaining value)

1. **Information-vs-advice ruling** — the only red-team residual (personal buy/sell call under
   pressure) and the gate on how assertive forecasting/opportunities may be. Highest priority.
2. **Knowledge corpus + owners** — supply Waterfind-internal documents (submissions, consulting,
   FAQs, procedures) to unblock that half of the knowledge base.
3. **External data licensing** — confirm BoM/MDBA/state feed access for deeper, live dam-storage and
   allocation history (current snapshots work; some gov sites block non-browser fetches).
4. **Telephony provisioning** — the 6 decision asks in the telephony memo, if voice calling proceeds.

## De-prioritized (staff-facing, parked per direction)

Auto CRM file notes after customer interactions, drafting emails/correspondence, document-collection
workflow. These imply a broker/staff-facing surface distinct from the current client-portal advisor;
not built this cycle.
