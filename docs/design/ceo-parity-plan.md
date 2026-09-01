# CEO parity plan — Tom Rooney vision email (2026-07-08)

Goal: bring the AI Advisor to parity with every functional-test scenario in Tom's email,
**except the staff-facing section** (CRM file notes after interactions, correspondence drafting,
document collection workflow) which is explicitly de-prioritized. Branch: `feat/advisor-parity`
(consolidates water-advisor-chat + order-parity + trade-notes + advisor-flag).

## Gap matrix (Tom's scenarios, his words)

| # | Scenario | Status | Workstream |
|---|---|---|---|
| R1 | Explain current allocation for a nominated valley | MISSING | A + B |
| R2 | Interpret Water Sharing Plan rules for a licence | MISSING | A |
| R3 | Explain carryover rules | MISSING | A |
| R4 | Compare trading rules between jurisdictions | MISSING | A |
| R5 | Summarise relevant Basin Plan provisions | MISSING | A |
| M1 | Current temporary and permanent market pricing | BUILT (curated market tools) | — |
| M2 | Recent transaction history | BUILT (de-identified regional trades) | — |
| M3 | Dam storage vs historical averages | MISSING (data external to waterfind-db) | B |
| M4 | Explain recent market movements | BUILT (price history + charts) | — |
| M5 | Forecast allocation probabilities from historical inflows | MISSING | C (needs B data) |
| M6 | Forecast temp prices this season | MISSING | C |
| M7 | Forecast long-term entitlement values | MISSING | C |
| C1 | Retrieve customer's trading history | BUILT (`get_my_*` tools) | — |
| C2 | Identify previous buying/selling behaviour | BUILT | — |
| C3 | Recommend opportunities from historical activity | MISSING | E |
| C4 | Understand trading region + licence profile | BUILT | — |
| B1 | Capture intention to buy/sell | BUILT (`prepare_*` + confirm card) | — |
| B2 | Generate draft trade request | BUILT (pending order + preview) | — |
| B3 | Notify the appropriate broker | MISSING | D |
| B4 | Initiate workflow and contract preparation | PARTIAL (Contact Note lands in CRM; no broker task) | D |
| B5 | Escalate complex matters to a human broker | PARTIAL (advisor refuses out-of-scope; no explicit handoff) | D |
| V1 | Receive inbound customer calls | OUT OF LOCAL SCOPE — architecture doc | F |
| V2 | Outbound customer engagement | OUT OF LOCAL SCOPE — architecture doc | F |
| V3 | Authenticate customers where appropriate | OUT OF LOCAL SCOPE — doc (recommend OTP/knowledge factors, NOT voice biometrics) | F |
| V4 | Explain market conditions conversationally | PARTIAL (dictation in; no voice out) | F |
| V5 | Maintain communication style + ethical standards | BUILT (persona) + hardened by G | G |
| — | Guardrails / jailbreak resilience (named component) | PARTIAL (injection framing on attachments; no red-team suite) | G |

## Workstreams

| WS | Deliverable | Notes |
|---|---|---|
| A | `services/ai-advisor/knowledge/` corpus + `search_knowledge`/`read_knowledge_doc` tools with mandatory citations | Public instruments only (Water Act 2007, Basin Plan 2012, state Acts, WSP/WAP rules, carryover + trading rules per jurisdiction, IVT constraints). Markdown + frontmatter (jurisdiction, instrument, source URL, as-at date). Waterfind-internal corpus (submissions, consulting, FAQs) remains blocked on Waterfind — tracked separately. |
| B | Dam storage + allocation announcement/history datasets + tools | Ingested snapshots from public sources (BoM, MDBA, state registers) with provenance + as-at dates; refresh script. Not live-scraped at question time. |
| C | `forecast_*` tools: allocation-probability, seasonal temp-price scenarios, long-term entitlement trends | Historical-data scenario ranges, never point predictions; information-not-advice framing, mandatory disclaimer + methodology in every answer. Uses waterfind-db price history + WS-B allocation history. |
| D | Broker notification on order events, `escalate_to_broker` tool, workflow initiation | CRM-native: contact note exists; add broker-visible task/notification via existing CRM structures. Escalation = durable record + confirmation to client of who follows up. |
| E | `get_my_opportunities` — client's own historical patterns vs current market in their regions | Factual observations ("you sold temp in Dec the last 3 seasons; current GMW Zone 1A bid is X"), general-information framing. |
| F | Web voice mode (TTS playback + existing STT) + telephony architecture doc | Telephony (inbound/outbound, caller auth) needs Waterfind infrastructure decisions — doc only. |
| G | Red-team suite + guardrail hardening + governance doc | Prompt injection (chat/attachments), tenant escape, advice-boundary pushes, order manipulation, persona breaks. Runs against the finished A–F system. |

## Sequencing

Wave 1 (parallel): A (corpus research/build), B (data research/ingest), D (sidecar brokerage code).
Wave 2: A/B tool wiring, C (needs B), E, F.
Wave 3: G red-team over the whole, then full verification + acceptance run phrased in Tom's scenarios.

## Compliance posture (applies to C and E)

Waterfind's formal information-vs-advice ruling is still outstanding. Until it lands, forecasting
and opportunity output ship behind the strictest defensible framing: factual/historical data,
scenario ranges, explicit "not financial advice — general information only" disclaimers, and no
personalised "you should buy/sell" statements. This keeps the capability demonstrable while
remaining retractable if compliance narrows it.
