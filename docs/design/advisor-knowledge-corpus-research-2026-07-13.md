# AI Advisor knowledge corpus — sourcing research (2026-07-13)

Research into which authoritative public documents to ingest next into
`services/ai-advisor/knowledge/`, given the 26-doc corpus that exists today. Method: domain-expert
gap enumeration + multi-agent web research with adversarial claim verification + four targeted
URL-verification passes (all URLs checked 13-14 Jul 2026; fetch caveats at the end). Priorities:
P1 must-have, P2 should-have, P3 nice-to-have. Target paths follow the existing corpus layout.

## Headline finding

The single biggest gap is the **Commonwealth water-market conduct regime created by the Water
Amendment (Restoring Our Rivers) Act 2023** — none of it is in the corpus, all of it is now in
force, and it regulates Waterfind directly:

| Date | What commenced | Enforcer |
|---|---|---|
| 1 Jul 2024 | Trade-form completeness + 5-year price/reason records (Part 7A ss 135M/135N); grandfathered tagged-entitlement exemption (Basin Plan s 12.23(2)) removed | IGWC |
| 1 Jul 2025 | Water Markets Intermediaries Code phase 1 (conduct obligations + most trust accounting) | ACCC |
| 1 Oct 2025 | Code phase 2 (client ledgers, broking accounts, record-keeping) | ACCC |
| 1 Jul 2026 | Insider trading + market manipulation prohibitions (Water Act ss 101JG/JH/JJ/JK); water-markets-decision announcement rules; Water Markets Data Standards 2026 | ACCC (IGWC handover ended) |
| 1 Jul 2027 | Data-provider pre/post-trade reporting (ss 135F/135H) — deferred, NOT 2026 | IGWC |

Compliance note for the advisor itself: the Code covers "giving specific advice about trading in
water rights" while providing a covered service, **including advice given for free**. Specific
trade advice emitted by the AI advisor plausibly falls under the Code's conduct obligations.
Scope limits to encode: MDB water resources only (non-Basin QLD activity is outside the Code);
fee/commission is the general trigger. Penalties: Code breaches up to 600 penalty units
(~$218,400); manipulation/insider trading up to 2,000 units (~$728,000) for individuals.

## Corrections to the EXISTING corpus (do before adding new docs)

| Doc | Correction |
|---|---|
| `cth/water-act-2007-overview`, `cth/basin-plan-2012-overview` | Pre-2023 regime described. Restoring Our Rivers Act 2023 (No. 111, assent 7 Dec 2023) amended both: 450 GL recovery deadline now 31 Dec 2027, SDLAM projects to 31 Dec 2026, buybacks re-enabled, conduct/data provisions added. |
| `cth/basin-plan-2012-water-trading-rules`, `cross/interstate-trade-mechanics` | Grandfathered tagged-entitlement exemption removed 1 Jul 2024 — tags now uniformly subject to allocation trade restrictions. Long-term tagged-use restrictions have applied since 30 Nov 2021; Lower Broken Creek exemption expired 30 Jun 2026. |
| `cross/barmah-choke.md` | MDBA now frames the restriction as "Barmah Narrows"; 2026-27 opening downstream-trade balance ~24 GL (~14 GL less than 2025-26). |
| `cth/accc-water-market-charge-rules.md` | Reconcile naming/scope: the operative instrument is the **Water Charge Rules 2010** (F2011L00058; compilation F2020C00877, 1 Jul 2020 — consolidated the former Termination Fees Rules 2009 + Infrastructure Rules 2010). Ensure termination fees (10x cap) are covered or add the P1 doc below. |
| `qld/*` | RDMW no longer exists — water sits with the Department of Local Government, Water and Volunteers (Oct 2024 machinery-of-government change). Dealing rules live under the **Water Regulation 2016 (Qld)** (not 2018) + plan-level water management protocols + operations manuals. |

## P1 — must-ingest (new docs)

| Target path | Document / instrument | Publisher | Sources (verified) |
|---|---|---|---|
| `cth/restoring-our-rivers-act-2023` | Water Amendment (Restoring Our Rivers) Act 2023 (No. 111 of 2023) + DCCEEW reform overview | Cth / DCCEEW | legislation.gov.au/C2023A00111 ; dcceew.gov.au/water/policy/restoring-our-rivers-act ; dcceew.gov.au/sites/default/files/documents/overview-water-market-reforms-water-amendment-act-2023.pdf ; .../implementation-water-market-reform-roadmap-3-years-on.pdf |
| `cth/water-markets-intermediaries-code` | Water Markets Intermediaries Code (Part 5, Water Regulations 2008) + statutory trust accounting (Part 5, Water Act 2007); regs made 26 Jun 2025; phases 1 Jul / 1 Oct 2025 | ACCC / DCCEEW | accc.gov.au/business/industry-codes/water-markets-intermediaries-code (+ "intermediaries and services covered" subpage) ; dcceew.gov.au/water/policy/markets/reform/water-markets-intermediaries-code-statutory-trust-accounting-obligations |
| `cth/water-market-conduct-prohibitions` | Insider trading + market manipulation prohibitions (Water Act ss 101JG/JH/JJ/JK), in force 1 Jul 2026; decision-announcement obligations | ACCC / DCCEEW | accc.gov.au/by-industry/water/water-markets-integrity/water-markets-manipulation-prohibitions (note: "Part 5A" heading unverified against a post-Jul-2026 compilation — cite section numbers) |
| `cth/water-markets-data-reforms` | BOM as data custodian; Water Markets Data Standards 2026 (F2026L00890); Water Markets Information Regs 2026 (F2026L00833); Water Markets Decisions Regs 2026 (F2026L00313); provider reporting deferred to 1 Jul 2027 | BOM / DCCEEW | bom.gov.au/resources/water-information-requirements/water-market-reforms ; wm.bom.gov.au (new decisions portal — verify from an AU connection) |
| `cth/water-market-rules-2009` | Water Market Rules 2009 — IIO transformation (irrigation right -> tradeable entitlement) | ACCC-made / DCCEEW | legislation.gov.au/F2009L02424/latest (in force; last compiled 2012) ; accc.gov.au/by-industry/water/water-market-rules |
| `cth/water-charge-rules-2010` | Water Charge Rules 2010 — termination fees (capped 10x fixed volumetric access charges), infrastructure charges | ACCC | legislation.gov.au/F2011L00058/latest (F2020C00877) ; accc.gov.au/by-industry/water/water-charge-rules ; ACCC Jul 2022 additional-termination-fees guidance PDF |
| `cth/mdb-agreement` | Murray-Darling Basin Agreement (Water Act 2007, Sch 1) — state water shares, SA entitlement flow, River Murray operations | Cth / MDBA | legislation.gov.au/C2007A00137/latest (compilation C2026C00270, 26 Jun 2026) ; mdba.gov.au "How River Murray water is shared" + "Murray-Darling Basin Agreement" pages |
| `cth/commonwealth-environmental-water-holder` | CEWH (name unchanged; site moved to /cewh): Trading Framework (Dec 2025), Water Management Plan 2025-26, holdings | DCCEEW | dcceew.gov.au/cewh ; .../cewh/manage-water/water-trading/publications/water-trading-framework-dec25 ; .../cewh/manage-water/basin/water-holdings |
| `cth/inspector-general-water-compliance` | IGWC role post-1 Jul 2026: Basin Plan/WRP compliance + trade-data obligations; ACCC = conduct regulator | IGWC | igwc.gov.au ; igwc.gov.au/who-we-are/about-us |
| `cross/trading-zones-reference` | Canonical zone map: names/codes, connectivity, current declaration | DEECA / MDBA | VIC zones declaration (s 6B Order, Vic Gazette No. S 613, 20 Nov 2023: gazette.vic.gov.au/gazette/Gazettes2023/GG2023S613.pdf) ; waterregister.vic.gov.au/water-trading/trading-rules ; MDBA interstate trade page |

## P2 — should-ingest

| Target path | Document | Key sources / notes |
|---|---|---|
| `cth/accc-water-markets-inquiry-2021` | ACCC MDB Water Markets Inquiry — Final Report (Mar 2021, 29 recs) + Quinlivan "Water market reform: final roadmap report" (Oct 2022, 23 recs) | accc.gov.au/.../murray-darling-basin-water-markets-inquiry-2019-21/final-report ; dcceew.gov.au/sites/default/files/documents/water-market-reform-final-roadmap-report.pdf. The "why" behind the reform layer. |
| `cth/basin-plan-2026-review` | 2026 Basin Plan Review — consultation closed 1 May 2026 (~2,500 submissions); initial SDL assessment released; final report to governments Dec 2026 | mdba.gov.au/water-management/2026-basin-plan-review (+ discussion paper, "What we heard"). Settings may change — advise clients accordingly. |
| `cth/water-recovery-buybacks` | Voluntary Water Purchase Program (450 GL): 169.8 GL recovered as at mid-2026; southern limit 300 GL (Nov 2025); northern EOI (Mar-Apr 2026) under evaluation; deadline 31 Dec 2027 | dcceew.gov.au/water/policy/water-recovery/government-water-purchasing/voluntary-restoring-our-rivers ; 450 GL Implementation Plan (Mar 2026) + RoR Trading Strategy (Feb 2026) PDFs. Structural entitlement-price driver. |
| `cross/water-resource-plans` | WRPs — the Basin Plan accreditation layer over WSPs; 33 total; 4 NSW plans unaccredited/withdrawn (Gwydir SW, Gwydir Alluvium, Namoi SW, Namoi Alluvium) | mdba.gov.au/water-management/basin-plan/water-resource-plans (+ list page) |
| `vic/delivery-shares` | Delivery shares: ML/day entitlement, tied to land, termination = 10x annual access fee; GMW transfer rules (same system, 0.1 ML/day/ha cap, zone matrix) | waterregister.vic.gov.au/water-entitlements/about-entitlements/delivery-shares ; g-mwater.com.au/water-operations/water-trading/delivery-share-trading-rules ; GMW price list (casual use, indicative termination fees ~$28k-52k per ML/day). DEECA delivery-share review active — monitor. |
| `vic/victorian-environmental-water-holder` | VEWH — Seasonal Watering Plan 2026-27 + Allocation Water Trading Strategy 2026-27 (allocation-only trader) | vewh.vic.gov.au (plan + strategy pages verified live) |
| `nsw/dealing-principles-trade-approval` | Access Licence Dealing Principles Order 2004 (amended Dec 2025); WaterNSW trade application forms/fees; processing KPIs (allocation trades 90% in 5 bd intrastate / 10 bd interstate / 20 bd with SA; 71Q 90% in 20 days); WAL Register Reform Act 2024 staged from 31 Oct 2025 | legislation.nsw.gov.au/view/html/inforce/current/sl-2004-0433 ; waternsw.com.au/customer-services/ordering-and-trading/trading-water ; .../applications-and-fees ; .../trade-statistics |
| `vic/trade-process-mechanics` | VWR allocation trading + water share transfers + annual above-cap trade openings (7-hour window, randomisation; Jul 2025 procedure change); consolidated Water Trading Rules for Declared Water Systems (1 Jul 2024) | waterregister.vic.gov.au/water-trading/allocation-trading ; .../water-share-trading ; .../allocation-trading/trade-opening-processes ; .../trading-rules |
| `sa/trade-application-process` | DEW approval process: forms by prescribed area; strike date/price on forms; allocation-transfer guaranteed processing = third Friday in June | environment.sa.gov.au/.../buying-and-selling-water ; .../water-licence-and-permit-forms (extend existing `sa-water-trade-approvals` if it lacks process detail) |
| `qld/dealings-and-seasonal-assignment` | Permanent dealings (approval vs registration on Water Allocations Register at Titles Queensland) vs seasonal assignments (ROL-holder consent, ops-manual rules); Sunwater Water Exchange | business.qld.gov.au/.../water-markets/allocation-dealings ; .../water-markets/seasonal ; sunwater.com.au/water-for-sale/water-trading ; Water Regulation 2016 (Qld) |
| `cross/tagged-trades` | Tagged entitlement mechanics standalone: MDBA Tagging Protocol 2010; VIC tagged-use restrictions; grandfathered-exemption removal 1 Jul 2024 | VWR news item on grandfathered removal ; mdba.gov.au/water-use/water-markets/interstate-water-trade |
| `cross/exchange-rates-and-adjustments` | Interstate allocation trade is 1:1 (rate conservatively 1.0 into SA; no per-trade conveyance deduction — losses handled in river ops); MDBA exchange-rate declarations; bulk water trade adjustments | mdba.gov.au/.../interstate-water-trade ; .../exchange-rate-declarations ; .../bulk-water-trade-adjustments-trials |
| `vic/goulburn-to-murray-trade-rule` | Goulburn-to-Murray annual trade limit + lower-Goulburn operating rules (effective 1 Jul 2022; IVT delivery no longer opens new trade room) | waterregister.vic.gov.au/water-trading/trading-rules/goulburn-to-murray-trade-review |
| `cross/settlement-registration-timing` | Expectations table: NSW KPIs above; SA third-Friday-June guarantee; VIC via water corporations; QLD registration vs approval paths; NSW season close (16 Jun 2026, no backdating) | Derived from the NSW/SA/VIC/QLD sources above |
| `nsw|vic|sa/groundwater-trading` | Groundwater trade: NSW per-WSP dealing rules (impact-assessment referrals to DCCEEW from 1 Oct 2025, $362.02 charge); VIC s 51 take-and-use licence trading; SA per-wells-area WAP transfer principles | waternsw trading page ; waterregister.vic.gov.au/water-trading/take-and-use-licence-trading ; SA forms page |
| `cth/national-water-agreement` | NWI 2004 + new National Water Agreement: Cth has signed; replaces NWI per jurisdiction as states sign (no state signature confirmed as of Jul 2026) | dcceew.gov.au/water/policy/policy/nwi ; .../policy/national-water-agreement |
| `cross/market-data-sources` | Reference doc codifying the authoritative data/analysis landscape (table below) | — |

### Market data & analysis landscape (for `cross/market-data-sources` + data-tools workstream)

| Source | Cadence | Notes |
|---|---|---|
| Victorian Water Register (waterregister.vic.gov.au) | continuous; determinations fortnightly | Best public price tape: allocation trade prices dashboard, trade opportunities (live IVT/limit status), weekly water report, market insights |
| WaterNSW: Public Register, iWAS (iwas.waternsw.com.au), WaterInsights | continuous | iWAS live and current; AWDs are published by NSW DCCEEW (water.dcceew.nsw.gov.au), not WaterNSW |
| MDBA: River Murray weekly report, Basin water in storage, riverdata.mdba.gov.au | weekly / daily | System state driving allocation + IVT expectations |
| BOM wm.bom.gov.au (new water markets portal) + Water Data Hub | continuous from 1 Jul 2026 | Central feed of allocation/carryover/trade-opening decisions Basin-wide; Waterfind is likely an obligated data provider from 1 Jul 2027 |
| Ricardo (formerly Aither) Water Markets Report | annual (2025 = 12th ed., Aug 2025) | aither.com.au/water-markets-report ; Entitlement Index monthly but no stable public URL post-rebrand |
| DCCEEW Water Entitlement Market Overview Price Report (by Ricardo) | monthly | Official entitlement price marks by product/valley (e.g. Apr 2026 edition) |
| ABARES Water Market Outlook | STALE — latest standalone Apr 2023 | Not quarterly; water commentary now inside quarterly Agricultural Commodities Report. Verify before citing. |
| BOM Australian Water Markets Report | PAUSED at 2021-22 | Explicitly on hold for the reform program; ABARES did NOT take it over. Do not present as current. |
| ABS Water Account, Australia | annual (latest 2023-24) | "Water use on Australian farms" (ABS, not ABARES) DISCONTINUED at 2020-21 — cite Water Account instead |
| BOM climate: ENSO wrap-up / Climate Driver Update; seasonal streamflow forecasts (bom.gov.au/water/ssf) | fortnightly; monthly | Primary allocation-outlook inputs |
| SA DEW River Murray flow report (via WaterConnect); Sunwater announced allocations; Business Qld announced entitlements | weekly; per water year | State-level operational feeds |

## P3 — nice-to-have

- `cross/drought-critical-human-water-needs` — CHWN priority, qualification of rights, zero-allocation precedents (2007-08, 2019-20). MDBA "Special accounting — water sharing in dry times".
- `cross/salinity-management` — BSM2030, salinity registers/credits, trade-approval impacts in sensitive zones.
- `cross/first-nations-water` — Aboriginal Water Entitlements Program; growing holder class, limited trade impact today.
- `nsw/floodplain-harvesting` — licensed 2021-2023; northern-Basin supplementary/GS dynamics.
- `cross/demand-drivers` — permanent plantings, crop cycles (context for why price trends hold).
- Menindee Lakes 480 GL control trigger; The Living Murray entitlements — operational edge cases.

## Open questions (for Waterfind / next steps)

1. Does AI-generated specific trade advice constitute a covered intermediary service under the
   Code? No ACCC guidance on automated advice found — worth a direct query (watercode@accc.gov.au).
   Meanwhile, encode Code conduct obligations as advisor guardrails.
2. Waterfind's data-provider obligations under Part 7A from 1 Jul 2027 (ss 135F/135H) — business
   compliance question, not just corpus content.
3. Do Waterfind's existing audited trust accounts qualify for a prescribed state-law exception to
   the Commonwealth trust-accounting framework?
4. Unverified details: "Part 5A" heading (post-Jul-2026 Water Act compilation not yet available);
   CEWO label formally retired vs de-emphasised; CEWH Water Management Plan 2026-27 not yet found;
   NWA state signatures.
5. The pending Waterfind-internal corpus (`knowledge/README.md`) remains blocked on Waterfind
   supplying documents — trust-account/AML material belongs there, not in `regulatory/`.

## Fetch caveats

dcceew.gov.au, agriculture.gov.au, mdba.gov.au, legislation.nsw.gov.au and bom.gov.au/climate
block or throttle non-Australian automated fetchers (403/timeouts). Those URLs were confirmed via
Wayback snapshots and search indexing; verify by browser (or from an AU connection) during
ingestion. All legislation.gov.au, accc.gov.au, waterregister.vic.gov.au, waternsw.com.au,
environment.sa.gov.au, business.qld.gov.au, g-mwater.com.au, vewh.vic.gov.au and sunwater.com.au
URLs were fetch-confirmed live.
