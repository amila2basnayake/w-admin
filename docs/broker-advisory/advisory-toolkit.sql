-- =====================================================================================
--  Broker Advisory Toolkit  —  parameterized queries for the Waterfind CRM database
-- =====================================================================================
--  Companion to data-map.md. Every query is verified against the live `waterfind-db`
--  (PostgreSQL 9.6, production-derived dump current to ~2026-06-19).
--
--  HOW TO RUN
--    export PGPASSWORD=password
--    PSQL=C:/Programs/PostgreSQL/9.6/bin/psql.exe
--    "$PSQL" -U postgres -h localhost -p 5432 -d waterfind-db \
--        -v client_id=2026296  -v account_id=2026297 \
--        -v region_id=515       -v is_permanent=false \
--        -v tenant_id=1         -v asof="'2026-06-15'"  -v months=6 \
--        -f advisory-toolkit.sql
--
--  PARAMETERS (psql :variables)
--    :client_id     waterfind_user.id of the customer (the PERSON; subclass 'W')
--    :account_id    registry_user.id  of the customer (the ACCOUNT; = wu.registry_user)
--    :region_id     region.id of a holding's market
--    :is_permanent  true = permanent/entitlement (a SALE), false = temporary/allocation (a LEASE)
--    :tenant_id     caller's tenant (1 = "Waterfind" — the only tenant in this dump)
--    :asof          liveness cut-off date. USE A SNAPSHOT DATE — the dump is historical, so
--                   now() returns almost no "live" orders. e.g. '2026-06-15'
--    :months        look-back window for price history (e.g. 6)
--
--  CONVENTIONS BAKED IN (see data-map.md):
--    * owner link is property.registry_user  (property.property_user is 100% NULL)
--    * liveness of an order is DERIVED (no status column)
--    * tradability needs BOTH the RTR and its STR gate (ignoring STR over-reports ~26%)
--    * use medians not means; filter soft-deletes; classify staff via access_type, not subclass
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- Q0. WHO IS THIS CLIENT  — identity + account + assigned broker + ACCESS-CONTROL GATE
--     The EXISTS clause is the multi-tenancy gate every read must carry (§9).
-- -------------------------------------------------------------------------------------
SELECT wu.id, wu.subclass, wu.first_name, wu.last_name, wu.company_name, wu.abn, wu.crn,
       at.name                              AS access_class,      -- 'user'/'client' vs 'admin'/'sales'
       ru.id                                AS account_id,
       ru.deleted                           AS account_deleted,
       br.id                                AS broker_user_id,    -- assigned broker (often NULL)
       br.first_name || ' ' || br.last_name AS broker_name,
       ttu.tenant, ttu.access_level
FROM   waterfind_user wu
JOIN   registry_user  ru   ON ru.id  = wu.registry_user
LEFT   JOIN waterfind_user_type wut ON wut.id = wu.usertype
LEFT   JOIN access_type at  ON at.id = wut.access_id
LEFT   JOIN waterfind_user br ON br.id = ru.primary_contact_sales
JOIN   tenant_to_user ttu ON ttu.registry_user = ru.id
WHERE  wu.id = :client_id
  AND  EXISTS (SELECT 1 FROM tenant_to_user g                     -- <-- ACCESS GATE
               WHERE g.registry_user = ru.id
                 AND g.tenant = :tenant_id
                 AND g.access_level >= 0);


-- -------------------------------------------------------------------------------------
-- Q1. WHAT DO THEY HOLD  — tradable holdings by water product & market (§4)
--     Filters to genuinely tradable rows; shows spot/futures permission flags.
-- -------------------------------------------------------------------------------------
SELECT p.region                       AS region_id,
       r.name                         AS market_zone,
       p.sub_type                     AS product,                 -- REG/ALL/ENT/CAR/TOP/TAG/MAX
       count(*)                       AS n_holdings,
       round(sum(p.quantity)::numeric, 1) AS total_ml,
       bool_or(p.permission_spot_temp)    AS spot_temp_ok,
       bool_or(p.permission_spot_perm)    AS spot_perm_ok,
       bool_or(p.permission_futures_temp) AS fut_temp_ok,
       bool_or(p.permission_futures_perm) AS fut_perm_ok
FROM   property p
JOIN   registry_user ru ON ru.id = p.registry_user
LEFT   JOIN region r    ON r.id  = p.region
WHERE  ru.id = :account_id
  AND  p.deleted IS NOT TRUE AND p.sold IS NOT TRUE AND p.quantity > 0
GROUP  BY p.region, r.name, p.sub_type
ORDER  BY total_ml DESC;


-- -------------------------------------------------------------------------------------
-- Q2. WHERE CAN THIS HOLDING TRADE  — all currently-tradable destination markets +
--     conversion factor, from a holding region (§5). Applies the STR gate.
-- -------------------------------------------------------------------------------------
SELECT tr.id            AS to_region_id,
       tr.name          AS to_market,
       ts.name          AS to_state,
       rtr.sale         AS is_permanent,
       rtr.exchangerate AS conversion_factor,                     -- buyer_qty = seller_qty * this
       str.from_date, str.to_date                                 -- seasonal window (dd/mm), null=always
FROM   region_trading_relationship rtr
JOIN   region tr                       ON tr.id = rtr.to_region AND tr.deleted IS NOT TRUE
JOIN   state  ts                       ON ts.id = tr.state
LEFT   JOIN state_trading_relationship str ON str.id = rtr.str
WHERE  rtr.from_region = :region_id
  AND  COALESCE(rtr.sale, false) = :is_permanent
  AND  rtr.suspended IS NOT TRUE
  AND  COALESCE(str.suspended, false) = false                     -- STR gate (drops ~26% of "active")
ORDER  BY ts.name, tr.name;


-- -------------------------------------------------------------------------------------
-- Q3. WHO'S ON THE OTHER SIDE  — live counter-orders matchable to a holding (§6).
--     Set :asof to a snapshot date (e.g. '2026-06-15'); now() yields ~nothing live.
--     This finds BUY orders (counterparties for a seller) valid in :region_id.
-- -------------------------------------------------------------------------------------
SELECT ol.id,
       ol.order_type            AS side,
       round(ol.quantity_avelable::numeric, 1) AS ml_available,
       ol.price_per_ml,
       ol.split, ol.min_split_quantity, ol.season,
       reg.name                 AS market
FROM   order_listing ol
JOIN   order_region oreg ON oreg.order_listing = ol.id AND COALESCE(oreg.deleted, false) = false
JOIN   region reg        ON reg.id = oreg.region
WHERE  oreg.region   = :region_id
  AND  ol.order_type = 'B'                                        -- opposite of a SELLER; use 'S' for a buyer
  AND  ol.sale       = :is_permanent
  AND  (ol.deleted IS NULL OR ol.deleted = false)
  AND  ol.date_completed IS NULL
  AND  ol.quantity_avelable > 0
  AND  (ol.date_effective IS NULL OR ol.date_effective <= :asof)
  AND  ol.date_expired >= :asof
ORDER  BY ol.price_per_ml DESC;                                   -- best bid first; for 'S' (asks)
                                                                  -- flip to ASC — best ask = LOWEST


-- -------------------------------------------------------------------------------------
-- Q4. HOW FAST WOULD IT CLEAR  — liquidity per reachable market for a seller (§6).
--     Live buy depth + best bid + latent standing-rule demand, per destination market.
-- -------------------------------------------------------------------------------------
WITH reachable AS (
  SELECT to_region AS region_id
  FROM   region_trading_relationship
  WHERE  from_region = :region_id
    AND  COALESCE(suspended, false) = false
    AND  sale = :is_permanent
  UNION SELECT :region_id
)
SELECT reg.id, reg.name,
       count(DISTINCT ol.id)                       AS live_buy_orders,
       round(sum(ol.quantity_avelable)::numeric)   AS buy_ml_available,
       round(max(ol.price_per_ml)::numeric, 2)     AS best_bid_per_ml,
       (SELECT count(*) FROM wateralert wa
          JOIN wateralert_region war ON war.wateralert = wa.id
         WHERE war.region = reg.id AND wa.order_type = 'B' AND wa.sale = :is_permanent
           AND (wa.date_expired IS NULL OR wa.date_expired >= :asof)) AS latent_buy_rules
FROM   reachable r
JOIN   region reg        ON reg.id = r.region_id
JOIN   order_region oreg ON oreg.region = reg.id AND COALESCE(oreg.deleted, false) = false
JOIN   order_listing ol  ON ol.id = oreg.order_listing
WHERE  ol.order_type = 'B'
  AND  ol.sale = :is_permanent
  AND  (ol.deleted IS NULL OR ol.deleted = false)
  AND  ol.date_completed IS NULL
  AND  ol.quantity_avelable > 0
  AND  (ol.date_effective IS NULL OR ol.date_effective <= :asof)
  AND  ol.date_expired >= :asof
GROUP  BY reg.id, reg.name
ORDER  BY buy_ml_available DESC NULLS LAST;


-- -------------------------------------------------------------------------------------
-- Q5. WHAT'S IT WORTH (band)  — min/median/max $/ML of settled trades, last :months (§7).
-- -------------------------------------------------------------------------------------
SELECT count(*) AS trades,
       round(min(oc.buying_price_per_ml)::numeric, 0) AS min_pml,
       round(percentile_cont(0.25) WITHIN GROUP (ORDER BY oc.buying_price_per_ml)::numeric, 0) AS p25_pml,
       round(percentile_cont(0.50) WITHIN GROUP (ORDER BY oc.buying_price_per_ml)::numeric, 0) AS median_pml,
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY oc.buying_price_per_ml)::numeric, 0) AS p75_pml,
       round(max(oc.buying_price_per_ml)::numeric, 0) AS max_pml
FROM   order_completed oc
JOIN   wateroffer wo ON wo.id = oc.wateroffer
WHERE  oc.date_deleted IS NULL
  AND  wo.sellingregion = :region_id
  AND  wo.sale          = :is_permanent
  AND  oc.date_accepted >= now() - (:months || ' months')::interval;


-- -------------------------------------------------------------------------------------
-- Q6. CURRENT MARKET REFERENCE  — settled trades + external sales + indicative price (§7).
--     (Stale indices spotprice_index/comparable_index intentionally omitted.)
-- -------------------------------------------------------------------------------------
SELECT 'settled_internal' AS source,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY oc.buying_price_per_ml)::numeric, 0) AS median_pml,
       count(*) AS n, max(oc.date_accepted)::date AS latest
FROM   order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
WHERE  oc.date_deleted IS NULL AND wo.sellingregion = :region_id
  AND  wo.sale = :is_permanent
  AND  oc.date_accepted >= now() - (:months || ' months')::interval
UNION ALL
SELECT 'external_sales',
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY es.price / NULLIF(es.quantity,0))::numeric, 0),
       count(*), max(es.saledate)::date
FROM   external_sales es
WHERE  es.from_region = :region_id AND es.sale = :is_permanent
  AND  es.price > 0 AND es.quantity > 0
  AND  es.saledate >= now() - (:months || ' months')::interval
UNION ALL
SELECT 'region_indicative',
       CASE WHEN :is_permanent THEN r.perm_ind_price ELSE r.temp_ind_price END,
       NULL,
       CASE WHEN :is_permanent THEN r.perm_ind_price_updated ELSE r.temp_ind_price_updated END::date
FROM   region r WHERE r.id = :region_id;


-- -------------------------------------------------------------------------------------
-- Q7. WHAT WOULD THEY NET  — prospective net-proceeds estimate for a SELLER (§8).
--     Set :volume and :price_per_ml. Brokerage is the median rate Waterfind has ACTUALLY
--     CHARGED sellers in this region+product (typically ~2-4%) — NOT the waterfind_fees rate
--     card, which understates (often quotes ~1% / a flat floor). Rate card is a FALLBACK only
--     when there is no charged history. Government/authority transfer fees are NOT included.
-- -------------------------------------------------------------------------------------
WITH charged AS (                 -- preferred: what was actually charged on recent settled sales
  SELECT percentile_cont(0.5) WITHIN GROUP (
           ORDER BY ci.commission_waterfind / NULLIF(ci.product_price,0)) AS eff_rate,
         count(*) AS sides
  FROM   waterfind_commission_index ci
  JOIN   wateroffer wo      ON wo.id = ci.wateroffer
  JOIN   order_completed oc ON oc.wateroffer = wo.id
  WHERE  wo.sellingregion = :region_id AND wo.sale = :is_permanent
    AND  ci.type = false                       -- seller side (type=true is the buyer)
    AND  COALESCE(ci.approved,false) = true AND COALESCE(ci.inactive_commission,false) = false
    AND  ci.product_price > 0 AND oc.date_deleted IS NULL
    AND  oc.date_accepted >= now() - interval '24 months'
),
card AS (                         -- fallback only (understates): the published rate card
  SELECT wf.brokerage_percentage/100.0 AS pct, wf.brokerage_initial AS flat, wf.fees AS min_fee
  FROM   region r JOIN waterfind_fees wf ON wf.state = r.state
  WHERE  r.id = :region_id AND wf.sale = :is_permanent AND wf.transfer = true
  LIMIT  1
),
calc AS (
  SELECT (:price_per_ml * :volume)::numeric AS gross, c.sides,
         CASE WHEN c.sides > 0 THEN c.eff_rate ELSE k.pct END AS eff_rate,
         (CASE WHEN c.sides > 0 THEN (:price_per_ml * :volume) * c.eff_rate
               ELSE GREATEST((:price_per_ml * :volume) * k.pct + k.flat, k.min_fee) END)::numeric AS waterfind_comm,
         CASE WHEN c.sides > 0 THEN 'actual-charged median' ELSE 'rate-card fallback' END AS basis
  FROM   charged c LEFT JOIN card k ON true
)
SELECT gross,
       basis,
       sides                                    AS charged_sample_sides,   -- low = low confidence
       round((eff_rate*100)::numeric, 2)        AS eff_brokerage_pct,
       round(waterfind_comm, 2)                 AS est_waterfind_commission,
       round(waterfind_comm * 0.10, 2)          AS est_gst_on_commission,
       round(gross - waterfind_comm * 1.10, 2)  AS est_net_proceeds_excl_gov_fees
FROM   calc;
-- Exact net = the post-settlement client_payment row (description='settlement'); see Q8.


-- -------------------------------------------------------------------------------------
-- Q8. THEIR TRADE HISTORY & REALISED NET  — what this client actually traded & received (§7/§8).
-- -------------------------------------------------------------------------------------
SELECT oc.date_accepted::date        AS trade_date,
       wo.sellingregion              AS region_id,
       wo.sale                       AS is_permanent,
       round(oc.buying_price_per_ml::numeric, 0) AS price_per_ml,
       round(oc.buying_quantity::numeric, 1)     AS ml,
       round((oc.buying_price_per_ml * oc.buying_quantity)::numeric, 0) AS gross,
       round(cp.amount::numeric, 2)  AS net_proceeds_paid                -- realised settlement
FROM   order_completed oc
JOIN   wateroffer wo  ON wo.id = oc.wateroffer
-- Settlements can be paid in instalments (>1 client_payment row per trade); pre-aggregate
-- per wateroffer so each trade stays ONE row and net_proceeds_paid = the sum of instalments.
LEFT   JOIN (SELECT wateroffer, sum(amount) AS amount
             FROM   client_payment
             WHERE  client = :client_id
               AND  lower(description) = 'settlement' AND amount > 0
             GROUP  BY wateroffer) cp ON cp.wateroffer = wo.id
WHERE  wo.seller = :client_id
  AND  oc.date_deleted IS NULL
ORDER  BY oc.date_accepted DESC
LIMIT  25;


-- -------------------------------------------------------------------------------------
-- Q9. ENGAGEMENT & VALUE  — loyalty standing + service recency + open tasks (§8.4).
-- -------------------------------------------------------------------------------------
SELECT (SELECT round(balance::numeric, 1) FROM loyalty_account WHERE owner = :client_id) AS loyalty_points,
       (SELECT max(date)::date FROM broker_service_history WHERE client_registry_user = :account_id) AS last_service,
       (SELECT count(*) FROM broker_service_history WHERE client_registry_user = :account_id)        AS lifetime_contacts,
       (SELECT count(*) FROM broker_action WHERE client_registry_user = :account_id
          AND COALESCE(completed, false) = false)                                                    AS open_broker_actions,
       (SELECT count(*) FROM region_of_interest WHERE registry_user = :account_id)                   AS regions_of_interest;


-- =====================================================================================
--  SEASONAL WATER OUTLOOK & RISK  (Q10–Q16) — added when per-region availability data
--  was integrated. Reuses :region_id / :account_id / :client_id / :asof. See data-map §7.5.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Q10. SEASONAL ALLOCATION FOR A REGION — the announced % of entitlement this season
--      (the per-region quantity signal). `allocation_amount` is the SYSTEM total ML, not per-client.
-- -------------------------------------------------------------------------------------
SELECT war.region, wa.title,
       round(wr.allocation_percent::numeric, 1) AS current_pct,
       round(wr.allocation_amount::numeric, 0)  AS system_total_ml,
       wr.effective_date::date                  AS as_of
FROM   water_allocation_region war
JOIN   water_allocation wa ON wa.id = war.water_allocation
JOIN   LATERAL (SELECT allocation_percent, allocation_amount, effective_date
                FROM water_allocation_reading r WHERE r.water_allocation = wa.id
                ORDER BY r.effective_date DESC LIMIT 1) wr ON true
WHERE  war.region = :region_id;                  -- a region may map to >1 allocation (HR & LR) → >1 row


-- -------------------------------------------------------------------------------------
-- Q11. CLIENT SEASONAL ALLOCATION ESTIMATE — entitlement × current region allocation %.
--      An ESTIMATE: the exact credited balance is held by the client's resource manager (GMW/state),
--      not Waterfind. 0% on low-reliability water = none allocated this season (drought signal).
-- -------------------------------------------------------------------------------------
-- Dedupe the announced % to ONE value per region BEFORE joining property: 40 regions map to
-- >1 allocation program (zone-specific + generic statewide), and a raw join fans the
-- entitlement sum out once per program (2x). Latest reading across programs wins; ties go to
-- the higher % (every observed conflict is a stale zone reading vs a newer statewide opener).
WITH region_alloc AS (
  SELECT DISTINCT ON (war.region) war.region, wr.allocation_percent
  FROM   water_allocation_region war
  JOIN   water_allocation_reading wr ON wr.water_allocation = war.water_allocation
  ORDER  BY war.region, wr.effective_date DESC, wr.allocation_percent DESC)
SELECT r.name AS market,
       round(sum(p.quantity)::numeric, 0)                                  AS entitlement_ml,
       round(max(ra.allocation_percent)::numeric, 1)                       AS alloc_pct,
       round((sum(p.quantity) * max(ra.allocation_percent) / 100)::numeric, 0) AS est_allocation_ml
FROM   property p
JOIN   region r ON r.id = p.region
LEFT   JOIN region_alloc ra ON ra.region = p.region
WHERE  p.registry_user = :account_id AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE
  AND  p.quantity > 0 AND p.sub_type = 'REG'
GROUP  BY r.name
ORDER  BY entitlement_ml DESC;


-- -------------------------------------------------------------------------------------
-- Q12. ALLOCATION TRAJECTORY — how a region's announced % moved through the season (opens ~0%, climbs).
-- -------------------------------------------------------------------------------------
SELECT wr.effective_date::date AS as_of, round(wr.allocation_percent::numeric, 1) AS pct
FROM   water_allocation_region war
JOIN   water_allocation wa ON wa.id = war.water_allocation
JOIN   water_allocation_reading wr ON wr.water_allocation = wa.id
WHERE  war.region = :region_id
  AND  wr.effective_date >= :asof::date - interval '12 months'
ORDER  BY wr.effective_date;


-- -------------------------------------------------------------------------------------
-- Q13. SETTLEMENT / APPROVAL PROGRESS — how far a client's trades are through approval (0–100).
-- -------------------------------------------------------------------------------------
SELECT ap.trade_number, ap.progress, ap.date_created::date AS created,
       (ap.progress < 100) AS still_in_progress, wo.sellingregion AS region
FROM   approval_procedure ap
JOIN   wateroffer wo ON wo.id = ap.wateroffer
WHERE  (wo.seller = :client_id OR wo.buyer = :client_id) AND ap.date_deleted IS NULL
ORDER  BY ap.date_created DESC
LIMIT  15;


-- -------------------------------------------------------------------------------------
-- Q14. COUNTERPARTY / SETTLEMENT RISK — dispute history touching this client.
-- -------------------------------------------------------------------------------------
SELECT d.date_created::date AS raised, d.title, d.in_dispute, d.closed, d.legal_action
FROM   dispute d JOIN wateroffer wo ON wo.id = d.trade_number
WHERE  wo.seller = :client_id OR wo.buyer = :client_id
UNION ALL
SELECT NULL::date, 'AT-FAULT: ' || COALESCE(d.title,''), d.in_dispute, d.closed, d.legal_action
FROM   dispute_at_fault_party fp JOIN dispute d ON d.id = fp.dispute
WHERE  fp.waterfind_user = :client_id
ORDER  BY raised DESC NULLS LAST
LIMIT  20;


-- -------------------------------------------------------------------------------------
-- Q15. CLIMATE DRIVERS (BACKDROP, COARSE) — latest SOI + dam storage by state.
--      NOT per-region: dam.location_region is ~97% null, so storage is a state/national signal.
-- -------------------------------------------------------------------------------------
SELECT 'SOI ' || to_char(s.date_read,'YYYY-MM') AS metric,
       round(s.index_value::numeric, 1)         AS value          -- strongly negative = drier (El Niño)
FROM   soi_monthly_reading s ORDER BY s.date_read DESC LIMIT 1;
-- Dam storage by state (latest reading per dam):
SELECT d.aust_state, count(*) AS dams, round(avg(lr.percent_of_full_storage), 1) AS avg_pct_full
FROM   dam d
JOIN   LATERAL (SELECT percent_of_full_storage FROM dam_reading dr
                WHERE dr.dam = d.id ORDER BY dr.date_read DESC LIMIT 1) lr ON true
GROUP  BY d.aust_state ORDER BY d.aust_state;


-- -------------------------------------------------------------------------------------
-- Q16. CLIENT CONTEXT ADD-ONS — crop mix (drives water demand), latent lease/carryover EOIs.
-- -------------------------------------------------------------------------------------
SELECT 'commodity' AS kind, c.name AS detail, NULL::numeric AS volume_ml
FROM   registry_user_commodity ruc JOIN commodity c ON c.id = ruc.commodity
WHERE  ruc.registry_user = :account_id
UNION ALL
SELECT 'lease_eoi(' || CASE WHEN el.lease_in THEN 'IN' ELSE 'OUT' END || ')', el.water_type, el.volume
FROM   eoi_lease el WHERE el.waterfind_user = :client_id
UNION ALL
SELECT 'carryover_eoi(' || CASE WHEN ec.is_holder THEN 'SELL' ELSE 'BUY' END || ')', ec.region, ec.volume
FROM   eoi_carryover ec WHERE ec.waterfind_user = :client_id;


-- -------------------------------------------------------------------------------------
-- BONUS. FIND A RICH CLIENT  — sellers with holdings + settlements (used to pick the
--        worked example). Drop :client_id binding to run standalone.
-- -------------------------------------------------------------------------------------
-- WITH sellers AS (
--   SELECT wo.seller AS wu_id, count(*) AS trades, max(oc.date_accepted)::date AS last_trade
--   FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
--   WHERE oc.date_deleted IS NULL AND wo.seller IS NOT NULL
--   GROUP BY wo.seller)
-- SELECT s.wu_id, COALESCE(wu.last_name, wu.company_name) AS who, wu.registry_user AS account_id,
--        s.trades, s.last_trade,
--        (SELECT count(*) FROM property p WHERE p.registry_user = wu.registry_user
--           AND p.deleted IS NOT TRUE AND p.quantity > 0) AS holdings
-- FROM sellers s JOIN waterfind_user wu ON wu.id = s.wu_id AND wu.subclass = 'W'
-- WHERE s.trades BETWEEN 3 AND 60
-- ORDER BY s.last_trade DESC, s.trades DESC LIMIT 20;
