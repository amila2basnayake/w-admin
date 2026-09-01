# AI Advisor Required Information

## 1. Document knowledge base

Regulations:

| Document set                                                | Changes                    | Source            |
| ----------------------------------------------------------- | -------------------------- | ----------------- |
| MDB Basin Plan trading rules (Ch. 12), SDL summaries        | Per amendment              | MDBA              |
| State trading rules (NSW, Vic, SA, Qld — per valley/system) | Per water year             | State authorities |
| Carryover rules per valley (limits, spill, parking)         | Every water year           | State authorities |
| IVT and annual trade-limit rules (4% cap etc.)              | Per water year + in-season | MDBA / states     |
| Register approval processes & settlement timeframes         | Rare                       | State registers   |

Waterfind internal:

| Document set                                     | Changes      | Source         |
| ------------------------------------------------ | ------------ | -------------- |
| Water rights expertise                           | Rare         | Tom Recordings |
| Terms of trade                                   | Per revision | Legal          |
| Trust-account, settlement & dispute process docs | Rare         | Compliance     |
| Broker playbooks/guidelines                      | Occasional   | Brokerage      |

Market context:

| Document set                           | Changes              | Source             |
| -------------------------------------- | -------------------- | ------------------ |
| Historical market commentary / reports | Monthly, append-only | Waterfind analysts |

## 2. Dynamic data (loaded as-needed)

Already available:

| Item                                                           | Source                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| Client profile, broker, access class                           | `waterfind_user`, `registry_user`, `tenant_to_user`         |
| Holdings (product, volume, region, permissions)                | `property`                                                  |
| Estimated seasonal allocation                                  | entitlement × `water_allocation_reading` (estimate only)    |
| Trade history + net proceeds                                   | `order_completed`, `wateroffer`, `client_payment`           |
| Settlement progress (Waterfind's workflow, not the register's) | `approval_procedure`                                        |
| Disputes                                                       | `dispute`                                                   |
| Engagement / service history                                   | `broker_service_history`, `loyalty_account`                 |
| Open orders + AI-proposed orders                               | `order_listing`, `ai_order`                                 |
| Region lookup, tradability matrix                              | `region_trading_relationship`, `state_trading_relationship` |
| Matchable counter-orders, liquidity                            | `order_listing`, `order_region`, `wateralert`               |
| Price bands                                                    | `order_completed`, `external_sales`                         |
| Allocation % and trajectory                                    | `water_allocation_reading` (ingested copy, lags)            |
| Climate drivers                                                | `soi_monthly_reading`, `dam_reading` (coarse, lags)         |
| Net-proceeds estimate                                          | `waterfind_fees`, `waterfind_commission_index`              |

Unavailable or missing from dev DB:

| Item                                     | Authoritative source                               | Status                                                                                         |
|:---------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Credited water-account balances          | State registers (WaterNSW, Vic Water Register, SA) | Not built                                                                                      |
| Current allocation announcements         | State authorities                                  | Reliant on manual entry?                                                                       |
| IVT status and net-trade balances        | MDBA / states                                      | Not built                                                                                      |
| Delivery constraints (Barmah Choke etc.) | MDBA, water corporations                           | Not built                                                                                      |
| Live climate/storage                     | BoM, storage operators                             | Partial — datascraper auto-feeds dam/SOI/rainfall in prod, but dam→region mapping is ~97% null |

## 3. Example Questions Set

A collection of questions that you'd like the AI advisor to be able to answer effectively. This list doesn't have to be comprehensive, but should have at least 2-3 questions on common subjects.

Maintained as [`advisor-question-suite.md`](advisor-question-suite.md) — 55 questions across 15
subjects (holdings, allocation, valuation, timing, buy-side, fees, tradability, arbitrage, history,
settlement, disputes, carryover, regulation, guardrails, brokerage), each with a "good answer looks
like" pass criterion. Recorded multi-turn runs against real client data:
[`agent-test-conversations.md`](agent-test-conversations.md). A blind-scored variant:
[`advisor-question-suite-blind.md`](advisor-question-suite-blind.md).
