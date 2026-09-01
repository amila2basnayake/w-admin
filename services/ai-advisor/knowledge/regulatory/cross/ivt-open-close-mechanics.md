---
id: cross-ivt-open-close-mechanics
title: Inter-valley transfer (IVT) accounts — open/close mechanics
jurisdiction: CROSS
instrument: Goulburn-to-Murray trade rule (long-term rules from 1 July 2022); NSW Murrumbidgee IVT arrangements
source_urls:
  - https://waterregister.vic.gov.au/about/news/218-understanding-goulburn-to-murray-trade-limit
  - https://waterregister.vic.gov.au/water-trading/allocation-trading
  - https://www.waterregister.vic.gov.au/water-trading/allocation-trading/trade-opening-processes
  - https://www.waterregister.vic.gov.au/water-trading/market-insights/trade-opportunities
  - https://www.waterregister.vic.gov.au/about/news/504-post-trade-summary-and-report-for-july-2025-trade-openings-now-available
  - https://www.waternsw.com.au/customer-services/ordering-and-trading/murrumbidgee-ivt
as_at: 2026-07-13
summary: How IVT accounts cap net trade out of a tributary valley into the Murray, and when trade opens and closes.
---

# Inter-valley transfer (IVT) accounts — open/close mechanics

## What an IVT account is

An IVT account tracks the volume of water **owed** from a tributary system to the Murray as a
result of net trade out of the valley. Water traded out creates a delivery obligation the river
manager (MDBA) must later meet from the tributary; the account caps how much can be owed at once.

## Goulburn -> Murray (verified, Victorian Water Register)

- **Limit:** trade is not allowed from the **Goulburn, Campaspe, Broken and Loddon** to the
  Victorian Murray, or to NSW and SA, **if more than 200 GL is owed to the Murray**.
- The balance grows from: volume still owed from the previous year; **seasonal allocation increases
  on previously traded water** (worked example from the Register: at 90% allocation 95 GL owed; at
  100%, 106 GL); and new out-trades during the season.
- The balance falls when the MDBA delivers water from the IVT account to meet Murray commitments,
  when carryover spills, or via back-trade.
- **Long-term rules from 1 July 2022:** delivery of water from the Goulburn IVT account **no
  longer opens new trade opportunity**. Instead, Goulburn-to-Murray/interstate allocation trade
  opportunity is released via **three annual announcements: 1 July, 15 October and 15 December**;
  after 15 December only back-trade creates additional opportunity. Confirmed still operating in
  2025-26 (the 15 December 2025 opening was the third of three scheduled).
- **How openings run:** competitive trade openings use a fixed **7-hour submission window** (e.g.
  7:00 am - 2:00 pm) with a **randomised processing order**. Since the **July 2025** openings,
  "Trade Remaining Balance" applications are **no longer randomised** (a change from the
  Oct/Dec 2024 events).
- Tagged water use counts against the same limit (see `cross-interstate-trade-mechanics`).

## Murrumbidgee -> Murray (NSW, verified via WaterNSW)

- The Murrumbidgee IVT account is operated **between limits of 0 GL and 100 GL**; the +100 GL cap
  is the volume that can physically be transferred out of the valley via Balranald in one year
  without excessive transmission losses. Transfers that would push the account outside 0-100 GL
  are not normally approved (case-by-case exceptions).
- Reverse trade (Murray -> Murrumbidgee) is allowed with a commensurate reduction in required IVT
  delivery, but the **net trade volume must remain positive from the Murrumbidgee towards the
  Murray**, reflecting one-way river flow.
- **Queue:** applications lodged while the IVT is closed are held in a queue for up to **7 days
  after IVT closure** and processed in order if opportunity arises.
- Daily account balance and open/closed trade status are published by WaterNSW.

## General open/close pattern

| State | Trigger to CLOSE | Trigger to OPEN |
|---|---|---|
| Vic (Goulburn group) | Account reaches the 200 GL owed limit | The three fixed annual announcements (1 Jul / 15 Oct / 15 Dec) release opportunity; back-trade also nets off |
| NSW (Murrumbidgee) | Account reaches its upper limit (100 GL) | Delivery of IVT water / back-trade reduces the balance below the limit; queued applications processed in order |

IVT status is inherently **seasonal and can flip quickly** — always verify the live account balance
and open/closed status against the current-season announcement before advising on an inter-valley
trade. Live status: Victorian Water Register "Trade opportunities" page (Goulburn group; the old
/trading-limits URL is dead) and the WaterNSW Murrumbidgee IVT page.

## Gaps

- A 190 GL operating trigger (vs the 200 GL limit) appears in some Goulburn arrangements but was
  not confirmed from a fetched page; treat 200 GL as the confirmed limit.
- Operating specifics for other tributary IVTs beyond the grouped Goulburn rule were not verified.
