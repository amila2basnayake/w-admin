# Worked Example — the data map, run end-to-end on one real client

> Proof that the [data map](./data-map.md) and [toolkit](./advisory-toolkit.sql) actually answer the
> advisory question. Every figure below is a live query result from `waterfind-db` (the
> production-derived dump, current to ~2026-06-19). Run yourself:
>
> ```sh
> "$PSQL" -U postgres -h localhost -p 5432 -d waterfind-db \
>   -v client_id=2026296 -v account_id=2026297 -v region_id=515 -v is_permanent=false \
>   -v tenant_id=1 -v asof="'2026-06-15'" -v months=6 -v volume=100 -v price_per_ml=300 \
>   -f advisory-toolkit.sql
> ```
>
> **Why this client:** `waterfind_user.id = 2026296` — **Kyle Egan / Njernda Aboriginal
> Corporation**, a genuine Victorian trading client (`subclass='W'`, `access_level=0`) with 11 active
> holdings, 57 completed sells, and 48 settlements — enough to exercise every domain. (Emails in the
> dump are all sanitized to `demo@waterfind.com.au`; the name, holdings and trades are real.)

---

## 1 · Who they are  (Q0 — identity + access gate)

| field | value |
|---|---|
| person | Kyle Egan — Njernda Aboriginal Corporation |
| `waterfind_user.id` / `registry_user.id` | 2026296 / 2026297 |
| access class | `user` (a trading client, not staff) |
| assigned broker (`primary_contact_sales`) | **none** — NULL |
| tenant / access_level | 1 ("Waterfind") / 0 (client) |

The `EXISTS (… tenant_to_user …)` gate in Q0 is what makes this read tenancy-safe (§9 of the map).
Note the **assigned-broker field is empty** even though this client trades constantly — the actual
servicing broker has to be *derived* (we recover it in §6: it was **Dion Martin**, named on the trade's
brokerage line).

---

## 2 · What they hold  (Q1 — tradable holdings)

~**970 ML** of high/low-reliability water on the register, across two VIC systems:

| market (region_id) | product | ML | spot temp/perm |
|---|---|---|---|
| 7 VIC MURRAY (BARMAH→SA) GMW – HIGH R (**515**) | REG | 372.0 | t / t |
| 1A GREATER GOULBURN – HIGH R (1165601) | REG | 193.1 | t / t |
| 3 LOWER GOULBURN – HIGH R (509) | REG | 187.5 | t / t |
| 1A GREATER GOULBURN – LOW R (1165602) | REG | 87.0 | t / t |
| 7 VIC MURRAY (BARMAH→SA) GMW – LOW R (311341) | REG | 85.2 | t / t |
| 3 LOWER GOULBURN – LOW R (311339) | REG | 45.4 | t / t |

All `sub_type='REG'` (registration / entitlement-on-register); each can be traded as **permanent**
(sell the entitlement) or have its seasonal **allocation** (temporary) traded. Spot permissions are
all on. Their largest single position is **372 ML in region 515**, so we centre the advice there.

---

## 3 · Where that water can trade  (Q2 — tradability)

From region 515, trading the **temporary** product, there are **72 currently-tradable destination
markets** — after applying both the RTR `suspended` filter and the **STR state-gate** (without the
STR gate the count is inflated). All at **1:1 conversion** (`exchangerate = 1.0`). Destinations span
the whole southern connected system: SA River Murray zones, the NSW Murray (above/below Barmah
Choke), Murray Irrigation Ltd, Lower Darling, and every GMW/LMW Victorian district.

Each carries a **seasonal window** (`state_trading_relationship.from_date/to_date`, e.g. `1/07`→
`25/04` or `1/07`→`13/06`) — bare day/month strings with no year (a known gap; §10 of the map). The
free-text `rule` HTML on each relationship is **display-only**, never a matching input.

---

## 4 · The live market for their main holding  (Q3/Q4 — liquidity, asof 2026-06-15)

| metric (region 515, temp, buy side) | value |
|---|---|
| live BUY orders matchable | **27** |
| total bid depth | **5,635 ML** |
| best bid | **$420 / ML** |

5,635 ML of standing demand against a 372 ML position = **coverage ≫ 1** — this would clear
immediately, with room to place the whole holding without moving the market. (Liveness uses an
`:asof` snapshot date, because the dump is historical; a strict `now()` returns almost nothing — see
the map's §6 caveat.)

---

## 5 · What it's worth  (Q5/Q6 — price discovery)

| source | $/ML | n | as of |
|---|---|---|---|
| settled trades, region 515 temp, last 6 mo (median) | **$415** (range $370–435) | 7 | 2026-02-05 |
| `region.temp_ind_price` (indicative) | **$60** | — | **2022-09-02 (STALE)** |

This is the single sharpest lesson in the example: the **`region` indicative price ($60) is ~4 years
stale and off by ~7×.** A tool that quoted it would be catastrophically wrong. The truth is in
**recent settled trades** (`order_completed` → `wateroffer`): **~$415/ML**, corroborated by the live
best bid of **$420** from §4.

---

## 6 · What they actually traded, and netted  (Q8 + reconstruction)

Their most recent settled sale — `wateroffer 1378057014`, **2025-10-23**: **100 ML @ $300/ML** of
temporary allocation out of region 515. The full money trail reconciles end-to-end:

| line | source | amount |
|---|---|---|
| Gross (100 ML × $300) | `order_completed.buying_*` / billing `item` | $30,000.00 |
| − Waterfind brokerage (seller) | `commission_index` type=`f`; billing "Brokerage Fee (Dion Martin)" | −$800.00 |
| − GST on brokerage (10 %) | trust `gst` line | −$80.00 |
| **= Net proceeds to client** | **`client_payment` `description='settlement'` (EFT)** | **$29,120.00** |

Net realisation = **97.1 %** of gross. The buyer side independently reconciles too: $30,000 + $1,100
purchaser's fee + $110 GST + $53.80 GMW application fee = **$31,263.80** received into trust (`receipt`,
B-PAY). The servicing **broker (Dion Martin)** is recovered here from the brokerage line — *not* from
the (empty) assigned-broker field.

---

## 7 · A prospective quote — and why it's only an estimate  (Q7)

Ask the toolkit for a fresh 100 ML @ $300 sale in region 515:

| | rate-card estimate (Q7) | what was actually charged (§6) |
|---|---|---|
| Waterfind brokerage | $300 (1 % state default) | **$800 (≈2.67 %)** |
| Net proceeds | $29,670 | **$29,120** |

The rate card (`waterfind_fees`) gives a *ballpark only*: the real trade applied a higher rate via a
per-client/negotiated **override** (`fees_registry_user` / `fee_code`) whose resolution lives in
application code, not the schema (§10 gap). **An exact prospective net can't be computed from tables
alone** — it's only certain after settlement (the `client_payment` row). The estimate is directionally
right and fine for advice; flag it as an estimate.

---

## 8 · Relationship context  (Q9 — engagement)

| signal | value |
|---|---|
| loyalty points (`loyalty_account.balance`) | 13,348 |
| last service contact (`broker_service_history`) | 2026-02-05 |
| lifetime service contacts | 318 |
| open broker tasks (`broker_action` not completed) | 1 |

A high-touch, high-loyalty, actively-serviced client with one open task to follow up.

---

## 9 · The advisory synthesis

Putting the data together, the advice this client's record supports **right now**:

- **They sold too early.** Their Oct-2025 sale went at **$300/ML**; the market for the same product
  in the same zone is now **~$415–420/ML — roughly 38 % higher.**
- **They still hold 372 ML of high-reliability water in region 515** (plus ~600 ML across Goulburn).
  At the live best bid ($420), the 515 position alone is **~$156k gross** of temporary-allocation
  value this season — and **5,635 ML of live demand means it clears immediately** with no price impact.
- **Conversion is frictionless** (1:1 into 72 markets), so the decision is price/timing, not
  reachability. The high-reliability Goulburn parcels open up the same connected-system buyers.
- **Net realisation ≈ 97 %** after the fee stack; budget ~3 % (and confirm their negotiated rate,
  which historically ran ~2.7 %, above the 1 % card default).

## 10 · What the DB could *not* tell us here (gaps hit in this very example)

- **No live per-client water/cash balance** — float accounts are an operator pool, so "how much
  allocation has actually been credited to Egan this season" isn't readable; we can only see the
  registered entitlement and past trades.
- **Indicative price was stale by ~7×** — current value had to be reconstructed from trades.
- **No deterministic prospective fee** — the override that made it $800 (not $300) isn't in the
  schema.
- **No assigned broker on file** — had to be derived from the trade record.
- **Seasonal windows have no year** — `1/07`→`25/04` needs app logic to test "in season today."

Each of these is a concrete build requirement for the advisory tool, surfaced by one real client.
