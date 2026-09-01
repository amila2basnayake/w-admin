# Broker Advisory Data Map

> **What this is.** A complete map of the data in the Waterfind CRM database that a water-rights
> broker needs to advise a customer on the most effective trades — *what is stored and where*, down
> to `table.column`, with the join paths, data-quality traps, access-control rules, and gaps.
>
> **Why it's framed this way.** This is **build input** for a broker-advisory capability: it
> inventories every field we could surface, judges how clean it is, names the source of truth, and
> flags what's missing or unreliable. It is not a UI spec.
>
> **How it was produced (ground truth).** Every claim was verified against the **live loaded
> database** `waterfind-db` (PostgreSQL 9.6, `localhost:5432`, from `.env`) — a production-derived
> dump (384/387 tables loaded), data current to **~2026-06-19** — cross-referenced with the
> Hibernate mappings (`crm/waterfind.com.au/src/com/waterfind/**`) and the column inventory
> `_dbwork/db_columns.tsv`. Row counts and value ranges below are real, from that DB.
>
> Companion files: **[`advisory-toolkit.sql`](./advisory-toolkit.sql)** (ready-to-run parameterized
> queries) and **[`worked-example.md`](./worked-example.md)** (the whole map run end-to-end against
> one real client). Background: `docs/architecture/02-domain-and-data-tier.md`.

---

## 1. The advisory question, decomposed

To answer *"what are the most effective trades for this customer?"* a broker needs ten things.
Each maps to a part of the schema:

| # | Broker needs to know… | Primary tables | Domain (§) |
|---|---|---|---|
| 1 | **Who** the customer is, who acts for them, what they consent to | `waterfind_user`, `registry_user`, `tag_extension` | §3 Identity |
| 2 | **What they hold** that can be traded (volume, product, region) | `property` (+ Licence component), external registers | §4 Holdings |
| 3 | **Where** that water can trade to, and at what conversion | `region`, `region_trading_relationship`, `state_trading_relationship` | §5 Tradability |
| 4 | **Who's on the other side now** — live counter-orders & standing demand | `order_listing`, `order_region`, `wateralert` | §6 Opportunity |
| 5 | **What's it worth** — comparable settled prices | `order_completed`→`wateroffer`, `external_sales` | §7 Price |
| 6 | **What they net** after fees/commission/GST | `waterfind_fees`, `waterfind_commission_index`, `client_payment` | §8 Economics |
| 7 | **Who may see this data** (per-client access control) | `tenant_to_user`, `access_type` | §9 Access control |
| 8 | **What we've done for them** — service & loyalty context | `broker_service_history`, `loyalty_account` | §8.4 Engagement |
| 9 | **How much water they'll actually get** — seasonal allocation outlook & drivers | `water_allocation_reading`, `dam_reading`, `soi_monthly_reading` | §7.5 Seasonal |
| 10 | **Settlement progress & counterparty risk** | `approval_procedure`, `dispute` | §8.5 Other signals |

### The core join skeleton

The single most important fact for any query: a **customer is a `waterfind_user` row** (the person),
but almost everything hangs off the **account = `registry_user`**. The owner of a holding is **not**
`property.property_user` (that column is 100 % NULL) — it is reached via `registry_user`:

```
waterfind_user (the person; :client_id, subclass='W')
  └─ .registry_user ─────────────► registry_user            ← THE ACCOUNT / hub for everything
        ├─ property.registry_user = registry_user.id        → holdings (§4)
        │     └─ property.region → region                   → market the holding sits in (§5)
        ├─ tenant_to_user.registry_user = registry_user.id  → ACCESS GATE (§9)
        ├─ region_of_interest.registry_user                 → markets they watch
        ├─ tag_extension.client = registry_user.id          → live broker assignment
        └─ broker_service_history.client_registry_user      → service history (§8.4)
  ── as a trader, the person id is used directly: ──
  wateroffer.seller / .buyer = waterfind_user.id            → their settled trades (§7)
  client_payment.client      = waterfind_user.id            → their net proceeds (§8)
  order_listing.owner        = waterfind_user.id            → orders they placed (§6)
```

> **Trap:** `property.registry_user → registry_user.primary_contact_user → waterfind_user` is the
> *primary contact* of the holding account. A person's own holdings are most simply
> `property.registry_user = (that person's) waterfind_user.registry_user`. The two agree for a
> single-contact account; use the account (`registry_user`) as the anchor, not the person.

---

## 2. Inventory at a glance (live row counts)

The advisory-relevant core, with real counts from `waterfind-db`:

| Concept | Table | Rows | Notes |
|---|---|---|---|
| People (clients/staff/leads) | `waterfind_user` | 94,606 | single-table; `subclass` discriminator |
| Accounts | `registry_user` | 86,080 | the access/broker/holdings hub |
| Holdings | `property` | 112,658 | embeds Licence; `sub_type` = product |
| Markets | `region` | 1,980 (1,558 live) | → `state` → `territory` |
| **Tradability matrix** | `region_trading_relationship` | 59,026 | directional, 63 % suspended |
| State-level gate | `state_trading_relationship` | 5,683 | 79 % suspended; seasonal window |
| Orders (book) | `order_listing` | 108,221 | `order_type` B/S; liveness is derived |
| Order→region fan-out | `order_region` | 3,954,898 | matchability index |
| Standing rules | `wateralert` | 3,357 | latent demand/supply |
| **Settled trades** | `order_completed` | 25,683 | price history; →`wateroffer` |
| Offers | `wateroffer` | 39,100 | carries region/buyer/seller/perm |
| External comparable sales | `external_sales` | 469,807 | arms-length, live to 2026 |
| Fee rate card | `waterfind_fees` | 662 | per state×product; **not** date-versioned |
| Commission ledger (charged) | `waterfind_commission_index` | 67,919 | per-trade, per-side |
| Itemised billing | `waterfind_billing` | 241,779 | per-trade fee lines |
| Trust ledger (audited) | `waterfind_trust_account` | 70,690 | ISO-9001 money trail |
| Net proceeds out | `client_payment` | 20,066 | `description='settlement'` |
| **Access control** | `tenant_to_user` | 85,583 | app-layer multi-tenancy |
| Service history | `broker_service_history` | 991,019 | per client×date |
| Loyalty | `loyalty_account` | 68,806 | points balance |
| **Seasonal allocation %** | `water_allocation_reading` | 6,287 | per-region % of entitlement; 850 regions; to 2026‑02 |
| Allocation→region map | `water_allocation_region` | 890 | links an allocation to its regions |
| Dam storage (driver) | `dam_reading` | 1.2 M | coarse: `dam.location_region` ~97 % null |
| Climate outlook | `soi_monthly_reading` | 1,806 | SOI; national; to 2026‑06 |
| Settlement workflow | `approval_procedure` | 30,749 | trade approval `progress` 0–100 |
| Dispute / counterparty risk | `dispute` | 9,303 | →`wateroffer`; fault party→user |
| Per-client crop mix | `registry_user_commodity` | 17,860 | drives water demand |
| Lease / carryover EOIs | `eoi_lease` / `eoi_carryover` | 268 / 97 | latent demand beyond the book |

---

## 3. Customer identity, relationships & consent

**Tables:** `waterfind_user` (person), `registry_user` (account), `waterfind_user_type`→`access_type`
(role), `tag_extension` (broker↔client), `region_of_interest`, `contact` (2.75 M interaction log),
`user_phone_number`, `prospective_data`/`prospective_contact` (leads).

**Columns that matter:**

| `table.column` | Tells the broker | Source |
|---|---|---|
| `waterfind_user.subclass` | Record type: **`W`** = real trading user (76,504), `C` = contact (10,036), `P` = prospect (5,395), `N` = newsletter, `E` = external broker. **A client = `subclass='W'`.** | `core/WFContactUser.hbm.xml` |
| `waterfind_user.first_name / last_name / company_name / salutation / job_title` | Identity | hbm `regContactName` |
| `waterfind_user.abn / acn / crn` | Business identifiers; `crn` = client reference (≈31 % filled) | hbm `regTradingDetails` |
| `waterfind_user.licence_holder / volume_traded / irrigated_area / premium_user` | Trader profile (⚠ `volume_traded` is often 0 — unreliable) | hbm |
| `waterfind_user.banned / buyer_approved / date_approved / crm_locked` | Status flags | hbm `loginDetails` |
| `waterfind_user.usertype → waterfind_user_type.access_id → access_type.name` | **Staff vs client.** `admin`/`sales` = staff/broker; `user`/`client` = trading client. **Do not use `subclass` for this.** | join, verified |
| `registry_user.primary_contact_user → waterfind_user` | Account's primary person (99.97 % filled) | `core/.../RegistryUser.hbm.xml` |
| `registry_user.primary_contact_sales / secondary_contact_sales → waterfind_user` | **Assigned broker** (only ~9.5 % of accounts have one) | hbm |
| `registry_user.*_notification_optin / campaign_optin / sms_*_optin` | **Consent** — must respect before contacting | hbm `SubscriptionDetails` |
| `registry_user.deleted` | Soft-delete — filter out | hbm |
| `tag_extension.broker / client / current_expiry` | **Live broker assignment** (broker=staff `waterfind_user`, client=`registry_user`) | `hibernate/TagExtension.java` |
| `region_of_interest.registry_user / region` | Markets the account watches | `hibernate/RegionOfInterest.java` |

**"Who is the broker for this client?" has no single source of truth** — it must be *derived*:
`registry_user.primary_contact_sales` (assigned), an un-expired `tag_extension`
(`current_expiry > now()`, only ~243 live in the dump), and the broker named on the trade
(`waterfind_billing` "Brokerage Fee (Name)" / `order_listing.logged_in_creator`) can all disagree.

**Data quality:** `subclass='W'` is ~81 % of users and mixes clients with staff — split with
`access_type.name`. `client_authority` (26,823 rows) is **misleadingly named**: it is a *staff-side*
permission grant log, **not** a client's list of authorities — don't use it for the customer.
`registry_user.primary_contact_sales` is sparse (8,187/86,080).

---

## 4. Holdings & eligibility (what they can trade)

**Tables:** `property` (the holding; embeds the Licence component), `property_ownership` (fractional
owners), `property_mortgage` (encumbrances), plus external registers (`ext_nrm_licence/licensee/
allocation`, `licence_nsw/vic/sa*`, `wma_register_*`, `vic_water_licenses*`).

**Columns that matter:**

| `table.column` | Tells the broker | Source / check |
|---|---|---|
| `property.registry_user` | **Owner link** (100 % populated). `property.property_user` is **100 % NULL — do not use.** | verified |
| `property.region → region` | The market/zone the holding sits in (NOT NULL) | `core/Property.hbm.xml` |
| `property.quantity` (double, ML) | Headline volume on the holding/product row. 65,825 live rows > 0; mean 346 ML | hbm Licence |
| `property.sub_type` | **The water product:** `REG` registration/entitlement-on-register (75 k rows, 27.5 M ML), `ALL` allocation, `ENT` entitlement, `CAR` carryover, `TOP` top-up, `TAG` tagged, `MAX` max3 | hbm:277 |
| `property.{allocation,entitlement,carryover,top_up,tagged,max3}` → `property.id` | Self-ref FKs: a `REG` parent points to each product's own child row (which carries its own `sub_type` + `quantity`). **Don't sum across parent+children — double counts.** | hbm:250-270 |
| `property.licence_number / wal / property_no` | Licence identity (88,372 filled) | hbm:175 |
| `property.permission_spot_temp / _spot_perm / _futures_temp / _futures_perm` (bool) | Whether the holding may be offered into spot/futures × temp/perm markets | hbm:228-239 |
| `property_ownership.proportion` | Fractional share (⚠ only 11,735/237,117 rows set it) | `core/PropertyOwnership.hbm.xml` |
| `property_mortgage.property` | Encumbrance flag (7,750 properties) | table |
| `property.field1 … field50` | **Generic, untyped, region-dependent registry fields. Mostly empty strings (not NULL). Do not rely on any `fieldN` as a stable attribute.** | hbm; verified |

**Eligibility logic:** tradable holdings = `deleted IS NOT TRUE AND sold IS NOT TRUE AND
quantity > 0`. Product type drives which market side applies: **permanent = entitlement (a sale),
temporary = allocation (a lease)**.

**Data quality:** `REG` rows often hold the licence identity while the tradable ML sits on a child
product row — never blindly `SUM(quantity)`. External register coverage is partial (only ~14 k
properties match `ext_nrm_licence`, which is SA-only). **Float accounts are NOT per-client wallets**
— `water_float_account` (1 row) / `cash_float_account` (2 rows) are a Waterfind operator pool, so a
client's tradable cash balance is **not** readable here (a real gap — see §10).

---

## 5. Markets & tradability rules (where & at what conversion)

This is the heart of "which trades are even possible." **Tables:** `region` → `state` → `territory`
(the market hierarchy), `region_trading_relationship` (RTR, the rule matrix),
`state_trading_relationship` (STR, the gate).

| `table.column` | Tells the broker | Source / check |
|---|---|---|
| `region.id / name` | Market identity. `name` is unique and encodes zone + priority class (e.g. "7 VIC MURRAY (BARMAH TO SA) GMW - HIGH R"). No short code. | `core/Region.hbm.xml` |
| `region.state → state.territory` | Jurisdiction (e.g. "VIC - IRRIGATION DISTRICTS") | verified join |
| `region.{temp,perm}_buyable/_sellable` | Per-product market-side flags | hbm `tradeType` |
| `region_trading_relationship.from_region / to_region` | **Directional**: a row = "a holder in `from_region` may sell into `to_region`" | hbm, NOT NULL |
| `region_trading_relationship.exchangerate` (double) | **The conversion factor.** buyer_qty = seller_qty × rate; buyer_$/ML = seller_$/ML ÷ rate. 99 % of rows = `1.0`; the rest 0.4–1.61. **Note the misspelled column name.** Fully populated (0 nulls). | hbm `exchangeRate` |
| `region_trading_relationship.sale` (bool) | **Product axis**: `true` = permanent/entitlement, `false`/null = temporary/allocation. Lookups key on `(from_region, to_region, sale)`. | hbm |
| `region_trading_relationship.suspended` (bool) | Region-pair trading off. **63 % of rows (37,393) are suspended.** | hbm |
| `region_trading_relationship.rule / donor_to_*_rule` | **Free-text HTML contract prose (1,098 distinct), NOT a coded rule.** Display only — never a matching input. | verified |
| `region_trading_relationship.str → state_trading_relationship` | Links to the governing state rule | hbm |
| `state_trading_relationship.suspended` | **A hard gate** — **79 % suspended**; flips ~5,625 otherwise-active RTRs to non-tradable | hbm |
| `state_trading_relationship.from_date / to_date` | **Seasonal window** as bare `dd/mm` strings (no year; can wrap, e.g. `1/7`→`22/6`) | hbm |

**To answer "can a holder in region X trade product Y into region Z, at what conversion?":**
1. Find the RTR where `from_region = X AND to_region = Z AND sale = (Y is permanent)`.
2. Tradable only if `rtr.suspended` is not true **AND** its STR (`rtr.str`) is not suspended **AND**
   today is within the STR season window.
3. Conversion = `rtr.exchangerate`.

> **Critical correction to the architecture overview:** the **`exchange_rate` table (13,414 rows) is
> foreign currency (USD/INR)** for the commodity-price charts — it has **nothing** to do with water
> conversion. The live water rate is the `exchangerate` *column* on the RTR row. The dated
> `region_exchange_rate_history` table exists but is **empty**, so the RTR scalar is the current rate.

**Data quality:** a query that ignores the STR gate **over-reports tradability by ~26 %**. 115 active
RTRs have a NULL `str` (orphaned). `region.metric` is uniformly `false` (a dormant legacy gate).

---

## 6. Live opportunity — orders, standing rules & liquidity

**Tables:** `order_listing` (the book), `order_region` (matchability index, 3.95 M rows),
`wateralert` (standing rules), `wateroffer`/`tenderoffer` (in-flight offers), `intent_to_trade`.

**`order_listing` — there is NO status column; liveness is derived** (authoritative definition from
`dao/OrderListingDao.java`):
```
(deleted IS NULL OR deleted = false)      -- deleted is two-valued: 't' or NULL only
AND date_completed IS NULL                -- not yet filled
AND quantity_avelable > 0                 -- remaining ML  (misspelled column!)
AND (date_effective IS NULL OR date_effective <= :asof)
AND date_expired >= :asof                 -- validity window end (NOT an "expired" event flag)
```

| `table.column` | Tells the broker | Source |
|---|---|---|
| `order_listing.order_type` | **Side**: `B` buy (31,191), `S` sell (77,030). Discriminator. | hbm |
| `order_listing.quantity / quantity_avelable` | Original / **remaining** ML | hbm |
| `order_listing.price_per_ml` | Limit price | hbm |
| `order_listing.sale` | Product: true=permanent, false=temporary | hbm |
| `order_listing.season` | Irrigation season year — engine matches same season | hbm |
| `order_listing.property → region / owner` | Placing holding's market / placing user | hbm |
| `order_region.order_listing / region` | **The matchability index** — each order fanned out to every region it's valid in (avg 36.6 regions/order). Find matchable orders by `order_region.region IN (reachable set)`. | `OrderRegion.java` |
| `wateralert.order_type / sale / quantity / price_per_ml / user_id` | A standing buy/sell rule = **latent demand/supply**; regions live in `wateralert_region` | `core/WaterAlert.hbm.xml` |

**Liquidity read ("how fast would this clear?"):** for the customer's holding (region X, product Y,
SELL side), measure the **opposite** book reachable via `order_region`:
*coverage = Σ(opposite live `quantity_avelable` at-or-better than target price) ÷ customer volume.*
≥1 with multiple counterparties → clears immediately; <1 or one thin counterparty → expect to sit /
split / shade price. Add opposite `wateralert` volume as the latent layer.

> **Big data-quality caveat:** this is a **historical snapshot**. Strictly `now()`-live orders are
> near zero (only 233 with a future `date_expired`; 4,751 are structurally open). **Parameterize an
> `:asof` date** (e.g. `'2026-06-15'`) or relax the expiry clause, or live-market queries return
> empty. See `advisory-toolkit.sql`.

---

## 7. Price discovery & trade history (what it's worth)

**Tables:** `order_completed` → `wateroffer` (settled internal trades — the primary evidence),
`external_sales` (arms-length external comparables), `waterx_transaction`, region indicative prices.

**`order_completed` carries no region/buyer/perm of its own — they come via `wateroffer`:**

| `table.column` | Tells the broker | Source |
|---|---|---|
| `order_completed.buying_price_per_ml` | **Settled price, $/ML** (= `order_listing.price_per_ml`, corr 1.000) | `core/order/CompletedOrders.hbm.xml` |
| `order_completed.buying_quantity` | Settled volume, ML | hbm |
| `order_completed.date_accepted` | **Settlement date** (never null) | hbm |
| `order_completed.date_deleted` | Filter `IS NULL` | hbm |
| `order_completed.exchange_rate` | perm↔temp conversion applied at match (≈1.0); **not currency** | hbm |
| `order_completed.wateroffer → wateroffer.sellingregion` | The market | hbm |
| `wateroffer.sale` | true=permanent, false=temporary (verified by price split) | hbm |
| `wateroffer.seller / buyer → waterfind_user.id` | Counterparties | hbm |

Real ranges (non-deleted, n=25,681): dates **2008 → 2026-06-18** (live; ~1,200 trades in 2025);
price/ML median **$142** (temp median ~$120, perm median ~$2,300); quantity 0.38–10,000 ML.

**Index tables are STALE — do not use for a current quote:** `spotprice_index` (48 k, stops
2011-04), `comparable_index` (30 k, seasons 2003–2011), `vic_sales` (2007–2009). `commodity_price`
(28 k) is **agricultural commodities in USD, not water**.

**Region indicative prices** (`region.temp_ind_price` / `perm_ind_price`, $/ML) are a hand-curated
quick quote — but **only ~30 % of regions filled and last updated ~2022**; sanity-check against
recent trades. `region.average_ml_price` is entirely unused (0 rows).

**External comparables:** `external_sales.price` is a **total** (per-ML = `price/quantity`),
live to 2026-06-19, ~71 % usable; `waterx_transaction.price` is already per-ML, live to 2026.
`external_trading_cache` (188 k) is a **cache that links a `registry_user` to an external sale**, not
a price source.

**Deriving an "effective price"** for region R, product Y, volume V: anchor on the median of recent
settled trades (`order_completed`, last 3–6 months); corroborate with `external_sales` +
`waterx_transaction`; use indicative price only as a ballpark. Flag a quote **above the recent max**
(over-priced / hard to fill) or **below the recent min** (leaving money on the table). If the window
has <5–10 trades, widen it and warn the market is thin.

---

## 7.5 Seasonal water availability & environmental drivers

This is the **per-region quantity forecast** — how much water a region (and therefore a client) will
actually receive this season. It directly addresses what used to be the biggest gap (a client's
seasonal allocation): the **region's** announced allocation % *is* in the DB, so a client's seasonal
allocation can be **estimated** even though the exact credited balance is not.

**The allocation core (3 tables):**

| `table.column` | Meaning | Source / check |
|---|---|---|
| `water_allocation.title` | The resource/announcement, e.g. "VIC Murray (High Reliability)", "Murrumbidgee Valley (General Security)", "SA Murray Class 3" | 144 rows |
| `water_allocation_region.region / .water_allocation` | Maps an allocation → the regions it applies to (**850 regions covered**; a region can map to >1 allocation, e.g. HR & LR) | 890 rows |
| `water_allocation_reading.allocation_percent` | **The announced % of entitlement** a holder will receive this season — the headline number | double |
| `water_allocation_reading.allocation_amount` | System total ML available (NOT per-client) | double |
| `water_allocation_reading.effective_date` | Point-in-time determination; revised through the season (1977 → **2026‑02‑02**) | timestamp |

**How to read it.** The current % for a region = the **latest** `water_allocation_reading`
(max `effective_date`) for the allocation(s) it maps to. The series shows the in-season trajectory —
it opens ~0 % each July and climbs as conditions allow (e.g. Murrumbidgee GS region 670 went
4→9→15→19→21→27→**32 %** across the 2025‑26 spring; VIC Murray Low‑R is still **0 %** — a drought
signal). **Verified current reads:** SA Class 3 100 %, VIC Murray HR 100 %, Murrumbidgee GS 32 %,
VIC Murray Low‑R 0 %.

**Client seasonal allocation (the estimate this unlocks):**
`estimated allocation ML ≈ entitlement ML × current region allocation %`. This is what tells a broker
how much a client can *actually* sell without short-changing their crop — previously unanswerable
(see the Paisley Hill test). It's an **estimate**: the exact credited balance and carryover live with
the resource manager (GMW / state register), not Waterfind. Toolkit Q10–Q12.

**Environmental drivers (the "why" behind the %) — coarse/stale, use as backdrop only:**

| Table | Rows | Freshness | Caveat |
|---|---|---|---|
| `dam` / `dam_reading` | 258 / 1.2 M | to 2026‑02‑05 | `current_storage`, `percent_of_full_storage`. **`dam.location_region` is ~97 % null** → state/national signal, not per-region |
| `weather_station` / `weather_station_reading` | 229 / 5.1 M | to **2025‑06** (≈1 yr stale) | rainfall, min/max temp, evaporation, per BOM station (not region) |
| `rainfall_average_reading` | 122 K | "1900"-dated normals | climatological baseline to compare actuals against |
| `soi_monthly_reading` | 1,806 | to **2026‑06** | Southern Oscillation Index — El Niño/La Niña driver; latest −14.5 (drier). National series |

**Modelled but EMPTY in this dump (do not rely on; aggregate from raw instead):** the `warehouse_*`
per-region rollups (`warehouse_dam_storage_index_*`, `warehouse_weather_index_*`,
`warehouse_sales_index_*`, `warehouse_trades_index_*` — all 0 rows) and the snowpack tables
(`snow_sensor*`, `snow_summary` — 0 rows). `ext_nrm_allocation` (7,474) is a *different* thing —
per-licence NRM allocation volumes, not seasonal forecasts.

---

## 8. Economics — fees, commission, settlement & engagement

"Most effective trade" = best **net**. The stack that turns gross into net:

### 8.1 The fee/commission stack

| `table.column` | Tells the broker | Source |
|---|---|---|
| `waterfind_fees` (rate card) keyed `state` × `sale` × `transfer` | `brokerage_percentage` (avg ~2 %, max 3 %), `brokerage_initial` (flat), `fees` (**min-fee floor**), tiered `range_*`/`*_fee_per_ml`, `charge_fee_ranges` switch. **Not date-versioned** — the single matching row is "current." | `core/AuthorityFees.hbm.xml` / `WaterfindFees.hbm.xml` |
| `fees_registry_user` (360 rows) | Per-client rate override (buy/sell × temp/perm) | table |
| `fee_code` (3,782) | Negotiated discount codes per user | entity |
| `waterfind_commission_index` per trade, per side | `commission_waterfind` = **$ brokerage actually charged** that side; `type` bool = buyer(t)/seller(f); `product_price` = gross. Filter `approved=true`, `inactive_commission` not true. | `WaterfindCommissionIndex.hbm.xml` |
| `waterfind_billing` per trade | Itemised lines: `item` (gross), `professional fees` (brokerage / purchaser's fee), `application` (gov fee), with `category`, `gst` bool | `WaterfindBilling.hbm.xml` |

**Net-proceeds formula (seller):**
`net = gross(P×V) − Waterfind brokerage (rate-card %, min-fee floored) − gov/authority fees − GST`.
Reconstructed and reconciled across sampled trades (see worked example: $30,000 gross → **$29,120
net**, 97.1 %).

### 8.2 Settlement & the money trail (ISO-9001 trust accounting)

- `receipt` — money **in** (buyer → Waterfind trust): `offer`, `amount`, `payment_type`.
- `waterfind_trust_account` — the **audited trust ledger** per trade: `fees`, `credit` (into/out),
  `category`, `gst`, `reconciled_id`.
- `client_payment` where **`description='settlement'`** — money **out to the client = realised net
  proceeds** (`client = waterfind_user.id`, `amount`, `payment_method`).
- `authority_payment` — payouts to water authorities.

### 8.3 Data quality (economics)

All money is **dollars** (verified). Heavy **outlier/test pollution**: `waterfind_billing` has
$1 M+ junk `item` rows; `loyalty_account` max balance is 2.5 **billion**; commission ratios average to
garbage — **always use median + `approved`/`deleted` filters**. Each trade has **2 commission rows**
(base + GST) — don't double-count. GST is an *implicit* boolean flag per line, not a stored rate.

### 8.4 Broker engagement signals

`broker_service_history` (991 k) — `client_registry_user`, `date`, `campaign_category`: how recently
/ often the client was serviced. `broker_action` (366 k) — open vs completed tasks. `loyalty_account.
balance` (+ 1.76 M-row history) — the client's information-credit/loyalty standing. `registry_user.
last_service_contact` / `service_expiry_date`. These answer "what we've done and the client's value."

---

## 8.5 Other advisory signals (settlement, risk, latent demand, crop)

Surfaced by a DB-wide sweep for advisory-relevant tables not already mapped. All verified live.

| `table.column` | Advisory value | Join | Freshness |
|---|---|---|---|
| `approval_procedure.progress` (0–100) | **How far a trade is through settlement/approval** — answers "how fast does it clear / what's still pending" | `.wateroffer` → `wateroffer.id`; `.vendor`/`.purchaser`; `.trade_number` | live to 2026‑06‑18 (30,749 rows) |
| `dispute` (+ `dispute_status`, `dispute_at_fault_party`) | **Counterparty / settlement-risk history**; `in_dispute`/`closed`/`legal_action` flags | `dispute.trade_number` → `wateroffer.id`; `dispute_at_fault_party.waterfind_user` → user | to 2024 (rare now, but real signal) |
| `registry_user_commodity` → `commodity.name` | **Per-client crop mix** (Wine Grapes, Almonds, Beef, Cotton…) — drives seasonal water demand & timing of advice | `.registry_user` → `registry_user` | static, 100 % populated |
| `eoi_lease` (`lease_in`, `volume`, `water_type`, `return_value`) | **Latent lease demand/supply** — matchable opportunity beyond the order book | `.waterfind_user` → user | to 2026‑02 (268 rows) |
| `eoi_carryover` (`is_holder`, `price_per_ml`, `volume`, `region`) | **Carryover buy/sell EOIs** — a seasonal play the holding tables don't capture | `.waterfind_user` → user; `region` is free text | to 2025‑10 (97 rows) |
| `trading_purpose_type` → `trading_purpose` | Per-client tags incl. **"Blacklisted", "Competitor", "Buyer", "Seller"** — eligibility/segmentation | `.registry_user` → `registry_user` | 981 clients |
| `salinity_trading_relationship` (`up_front`/`annual` levies, `suspended`) | Extra **tradability cost gate** for SA salinity zones | `from/to_salinity_type` → `salinity_type` | static (niche) |

Toolkit Q13–Q16. **Excluded as dead/irrelevant** (checked): `market_event` (mostly "Test"),
`press_index` (dead 2007–11), `remote_trade_history` (all rows point at a dummy property),
`vic_feasibility_check` (stale 2009–13), `water_market_group/state` (2 rows), `management_zone`
(admin), `future_order`/`treasury_rate` (empty).

---

## 9. Access control & multi-tenancy (mandatory build-input)

**There is NO database-level tenant isolation.** Single `public` schema; a naive `SELECT *` leaks
every client's data. Access is enforced **only in the app layer**, keyed on **`registry_user`**.

The predicate the CRM uses (`dao/TenantToUserDao.java`):
```sql
EXISTS (SELECT 1 FROM tenant_to_user
        WHERE registry_user = <account>.id
          AND tenant        = :tenant_id
          AND access_level >= :min_access_level)
```
- `tenant_to_user(registry_user, tenant, access_level)`. In this dump there is **one** tenant
  (`tenant.id=1`, "Waterfind", 85,583 mappings).
- `access_level`: **`0` = client/regular user** (85,479 rows), **`>=1` = staff** (104 rows).
- Object-level rule (`TenantBo.isOwnedByLoggedInUser`): a user may see a `registry_user` iff they
  **share ≥1 tenant**, with a role bypass for global admins (`access_type.name IN ('admin','sales')`).

**Any advisory service we build must replicate this join on every read** (resolve the caller's
`tenant_id`(s), constrain with the EXISTS clause), and — to scope to a broker's own book — additionally
filter `registry_user.primary_contact_sales = :broker_id` OR a live `tag_extension`. Skipping this is
a cross-client data leak.

---

## 10. Gaps — what a broker needs that the DB does *not* cleanly hold

Consolidated from all domains (each is a build risk / candidate for new data):

- **No per-client tradable cash/water wallet.** Float accounts are a Waterfind operator pool (1 water
  / 2 cash rows), not per-customer balances.
- **No live regional price index.** Every maintained per-region series died in 2011; current price
  must be re-aggregated on the fly from `order_completed` + `external_sales`.
- **No order-book snapshot / best-bid-offer / market-depth** table — must be computed from
  `order_listing` each time; no spread or volatility/trend metric stored.
- **Tradability rules are free-text HTML** (`region_trading_relationship.rule`) — carryover limits,
  tagging, inter-valley caps, MDBP-Plan constraints are prose, not machine-readable. **No quantitative
  trade caps/limits** on the matrix (it says *whether* and *at what factor*, never *how much*).
- **Seasonal windows have no year** (`dd/mm` strings, can wrap) — needs app logic to evaluate.
- **No single "current broker" field** — must be derived (assigned vs tag vs trade).
- **Fee rate card is not date-versioned**, **override resolution lives in app code**, **GST is
  implicit** — a prospective net-proceeds quote can't be computed deterministically from tables alone
  (it's exact only *after* settlement, via the `client_payment` row).
- **Allocation-% announcements — NOW PARTLY FILLED (§7.5).** The *region's* seasonal allocation % is in
  `water_allocation_reading` (to ~Feb 2026), so a client's seasonal allocation can be **estimated**
  (entitlement × %). Still missing: the *exact per-client credited balance* and **carryover caps /
  water-year reliability rules** (held by the resource manager, GMW/state), and a year on the allocation
  season. Environmental drivers exist but are coarse (dam storage ~97 % un-geocoded; weather ~1 yr stale;
  `warehouse_*` rollups & snowpack empty).
- **Lifetime trader stats unreliable** (`waterfind_user.volume_traded` often 0).

---

## 11. Data-quality & sanitization summary (read before trusting any value)

- **Sanitized dump:** **every** `waterfind_user.email` is `demo@waterfind.com.au` and all passwords
  are `blue49` (per `sanitize_db.sql`). **Names/ABNs/holdings/trades are real**; contact emails are not.
- **Historical snapshot:** "live market" queries need an `:asof` date — almost nothing passes a strict
  `now()` liveness test.
- **Discriminators, not status:** filter `waterfind_user.subclass`, `order_listing.order_type`,
  `region_trading_relationship.sale`; classify staff/client by `access_type.name`.
- **Soft-delete everywhere:** `deleted` / `sold` / `date_deleted` / `inactive_commission` — and
  `order_listing.deleted` is `'t'`/NULL only (NULL ≠ deleted).
- **Use medians, not means** (outlier/test pollution in prices, fees, loyalty).
- **The schema is the contract; the Java model is leaky** — integrate at the PG level against
  `public`, reproducing the discriminator + tenancy joins.

---

## 12. Where to go next

- Run the queries: **[`advisory-toolkit.sql`](./advisory-toolkit.sql)** — parameterized, copy-paste or
  `psql -v` runnable, one query per advisory question above.
- See it all on a real client: **[`worked-example.md`](./worked-example.md)**.
- Deeper schema/architecture context: `docs/architecture/02-domain-and-data-tier.md` and
  `03-business-logic-and-trading-engine.md` (the clearing engine).
