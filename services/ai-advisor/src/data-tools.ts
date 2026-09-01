import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { runScoped, type CallerCtx } from './data-db';
import { buildBrokerToolDefs, BROKER_TOOL_NAMES } from './broker-tools';
import type { OnBehalf } from './brokerage';
import { buildExtdataToolDefs, EXTDATA_TOOL_NAMES } from './extdata-tools';
import { buildForecastToolDefs, FORECAST_TOOL_NAMES } from './forecast-tools';

// Curated, read-only data-grounding tools. Queries are the verified advisory-toolkit.sql (Q0–Q16),
// with the traps baked in (discriminators, soft-deletes, medians, STR gate, :asof). PRIVATE tools
// bind the caller's ids server-side (never from the model) and run under RLS; MARKET tools take a
// region/product and return de-identified aggregates (no counterparty identities).

function R(rows: any[], extra?: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(extra ? { ...extra, rows } : rows) }] };
}

// Shared caveat for the windowed market tools — appended to each description so "no rows" is never
// read as "no market": empty results are a window artefact until cross-checked.
const WINDOWED_NOTE =
  ' Results are bounded by the as-of date and lookback window: an empty result means no rows in the ' +
  'requested window, which is not the same as no market.';

// Kept in sync with the tools below — used to build the exact allowlist (mcp__wf__<name>).
export const WF_TOOL_NAMES = [
  'get_my_profile', 'get_my_holdings', 'estimate_my_seasonal_allocation', 'get_my_trade_history',
  'get_my_settlement_progress', 'get_my_disputes', 'get_my_engagement', 'get_my_context', 'get_my_account_setup',
  'find_region', 'get_region_tradability', 'get_matchable_orders', 'get_market_liquidity',
  'get_price_band', 'get_market_reference', 'get_price_history_series', 'get_region_allocation', 'get_allocation_trajectory',
  'get_climate_drivers', 'estimate_net_proceeds', 'get_my_fee_schedule', 'get_market_events', 'get_my_water_account',
  'get_my_opportunities',
  ...BROKER_TOOL_NAMES,
  ...EXTDATA_TOOL_NAMES,
  ...FORECAST_TOOL_NAMES,
] as const;

export function buildToolDefs(ctx: CallerCtx) {
  const TENANT = 1;
  const scoped = (sql: string, params: any[] = []) => runScoped(ctx, sql, params);
  const side = (lookingFor: 'buyers' | 'sellers') => (lookingFor === 'buyers' ? 'B' : 'S');

  const tools = [
    // ---- PRIVATE (auto-scoped to the current client) --------------------------------
    tool('get_my_profile',
      "The current client's identity, account, assigned broker and access class. Auto-scoped to the logged-in client.",
      {},
      async () => R(await scoped(
        `SELECT wu.id, wu.subclass, wu.first_name, wu.last_name, wu.company_name, wu.abn, wu.crn,
                at.name AS access_class, ru.id AS account_id, ru.deleted AS account_deleted,
                br.id AS broker_user_id, br.first_name || ' ' || br.last_name AS broker_name
           FROM waterfind_user wu
           JOIN registry_user ru ON ru.id = wu.registry_user
           LEFT JOIN waterfind_user_type wut ON wut.id = wu.usertype
           LEFT JOIN access_type at ON at.id = wut.access_id
           LEFT JOIN waterfind_user br ON br.id = ru.primary_contact_sales
          WHERE wu.id = $1
            AND EXISTS (SELECT 1 FROM tenant_to_user g WHERE g.registry_user = ru.id AND g.tenant = $2 AND g.access_level >= 0)`,
        [ctx.uid, TENANT]))),

    tool('get_my_holdings',
      "The current client's holdings by region (water product, volumes in ML, market zone, jurisdiction, " +
      'spot/futures permission flags). Auto-scoped to the logged-in client; the returned region_id feeds the ' +
      'market tools. Field semantics: only approved licences are tradable — largest_approved_licence_ml is ' +
      'the per-order sell cap (a sell anchors to one approved licence), while total_ml can include volume ' +
      'still awaiting approval. A buy needs only buy_anchor_ok=true (an approved destination licence in the ' +
      'region), so a 0 ML row with buy_anchor_ok=true can still receive bought water. market_zone is a ' +
      "trading-zone name (zones can be named after river reaches and can sit across a state border from the " +
      "client), not the client's location or governing state; au_state is the holding's jurisdiction. " +
      'product/sub_type codes (REG etc.) are internal registry facets, not scheme types: REG means ' +
      '"registered licence parent record" and does not encode regulated/supplemented vs unsupplemented supply.',
      {},
      async () => R(await scoped(
        `SELECT p.region AS region_id, r.name AS market_zone,
                substring(upper(t.name) from '^(NSW|VIC|SA|QLD|WA|TAS|NT|ACT)([^A-Z0-9]|$)') AS au_state,
                p.sub_type AS product,
                count(*) AS n_holdings, round(coalesce(sum(p.quantity),0)::numeric,1) AS total_ml,
                round(coalesce(sum(p.quantity) FILTER (WHERE p.date_approved IS NOT NULL),0)::numeric,1) AS approved_ml,
                round(coalesce(max(p.quantity) FILTER (WHERE p.date_approved IS NOT NULL),0)::numeric,1) AS largest_approved_licence_ml,
                bool_or(p.date_approved IS NOT NULL) AS buy_anchor_ok,
                bool_or(p.permission_spot_temp) AS spot_temp_ok, bool_or(p.permission_spot_perm) AS spot_perm_ok,
                bool_or(p.permission_futures_temp) AS fut_temp_ok, bool_or(p.permission_futures_perm) AS fut_perm_ok
           FROM property p JOIN registry_user ru ON ru.id = p.registry_user LEFT JOIN region r ON r.id = p.region
           -- au_state: region -> state -> territory; territory names carry the AU jurisdiction as a
           -- prefix ("NSW - RIVER LICENCES...") — same verified mapping as forecast-tools fetchAuState.
           -- region.state / market_zone are river/scheme groupings, NOT the client's state.
           LEFT JOIN state s2 ON s2.id = r.state LEFT JOIN territory t ON t.id = s2.territory
          WHERE ru.id = $1 AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE
            -- One row per registered entitlement licence. REG is the tradable parent; its
            -- ALL/ENT/CAR/TOP/TAG/MAX children are accounting facets of the SAME licence, so
            -- summing across them double-counts (data-map §property.sub_type). Genuinely separate
            -- REG parcels in a region are still kept (grouped, n_holdings > 1).
            AND p.sub_type = 'REG'
            AND (p.quantity > 0 OR p.date_approved IS NOT NULL)
          GROUP BY p.region, r.name, t.name, p.sub_type ORDER BY total_ml DESC`,
        [ctx.account]),
        { note: 'sells anchor to a single APPROVED licence (largest_approved_licence_ml = per-order sell cap); buys only need buy_anchor_ok=true, volume irrelevant' })),

    tool('estimate_my_seasonal_allocation',
      "Estimated water the current client will receive this season = their entitlement ML × the region's latest announced allocation %. An estimate; the exact credited balance is held by the resource manager. Auto-scoped.",
      {},
      async () => R(await scoped(
        `WITH region_alloc AS (
           -- One announced % per region BEFORE joining property: a region can map to >1
           -- allocation program (40 do — typically a zone-specific program plus a generic
           -- statewide one), and joining water_allocation_region raw fans the entitlement
           -- sum out once per program (2x). Dedupe to the LATEST reading across the
           -- region's programs, ties broken to the higher % — the newest announcement is
           -- the season-current number, and in this snapshot every conflict is a stale
           -- zone-specific reading vs a newer statewide season-opener (or a same-day tie).
           SELECT DISTINCT ON (war.region) war.region, wr.allocation_percent
             FROM water_allocation_region war
             JOIN water_allocation_reading wr ON wr.water_allocation = war.water_allocation
            ORDER BY war.region, wr.effective_date DESC, wr.allocation_percent DESC)
         SELECT r.name AS market, round(sum(p.quantity)::numeric,0) AS entitlement_ml,
                round(max(ra.allocation_percent)::numeric,1) AS alloc_pct,
                round((sum(p.quantity)*max(ra.allocation_percent)/100)::numeric,0) AS est_allocation_ml
           FROM property p JOIN region r ON r.id = p.region
           LEFT JOIN region_alloc ra ON ra.region = p.region
          WHERE p.registry_user = $1 AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE
            AND p.quantity > 0 AND p.sub_type = 'REG'
          GROUP BY r.name ORDER BY entitlement_ml DESC`,
        [ctx.account]), { note: 'estimate; the exact credited balance is held by the resource manager' })),

    tool('get_my_trade_history',
      "The current client's last 25 settled trades (price/ML, ML, gross, realised net proceeds). Auto-scoped.",
      {},
      async () => R(await scoped(
        `SELECT oc.date_accepted::date AS trade_date, wo.sellingregion AS region_id, wo.sale AS is_permanent,
                round(oc.buying_price_per_ml::numeric,0) AS price_per_ml, round(oc.buying_quantity::numeric,1) AS ml,
                round((oc.buying_price_per_ml*oc.buying_quantity)::numeric,0) AS gross, round(cp.amount::numeric,2) AS net_proceeds_paid
           FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
           -- Settlements can be paid in instalments (several client_payment rows per trade);
           -- pre-aggregate per wateroffer so each trade stays ONE row and net = the sum paid.
           LEFT JOIN (SELECT wateroffer, sum(amount) AS amount FROM client_payment
                       WHERE client = $1 AND lower(description)='settlement' AND amount>0
                       GROUP BY wateroffer) cp ON cp.wateroffer = wo.id
          WHERE wo.seller = $1 AND oc.date_deleted IS NULL ORDER BY oc.date_accepted DESC LIMIT 25`,
        [ctx.uid]))),

    tool('get_my_settlement_progress',
      "Approval/settlement progress (0–100) of the current client's trades. Auto-scoped.",
      {},
      async () => R(await scoped(
        `SELECT ap.trade_number, ap.progress, ap.date_created::date AS created, (ap.progress < 100) AS still_in_progress, wo.sellingregion AS region
           FROM approval_procedure ap JOIN wateroffer wo ON wo.id = ap.wateroffer
          WHERE (wo.seller = $1 OR wo.buyer = $1) AND ap.date_deleted IS NULL
          ORDER BY ap.date_created DESC LIMIT 15`,
        [ctx.uid]))),

    tool('get_my_disputes',
      "Dispute / counterparty-risk history touching the current client. Auto-scoped.",
      {},
      async () => R(await scoped(
        `SELECT d.date_created::date AS raised, d.title, d.in_dispute, d.closed, d.legal_action
           FROM dispute d JOIN wateroffer wo ON wo.id = d.trade_number WHERE wo.seller = $1 OR wo.buyer = $1
          UNION ALL
         SELECT NULL::date, 'AT-FAULT: ' || COALESCE(d.title,''), d.in_dispute, d.closed, d.legal_action
           FROM dispute_at_fault_party fp JOIN dispute d ON d.id = fp.dispute WHERE fp.waterfind_user = $1
          ORDER BY raised DESC NULLS LAST LIMIT 20`,
        [ctx.uid]))),

    tool('get_my_engagement',
      "The current client's loyalty standing, service recency, open broker tasks and watched regions. Auto-scoped.",
      {},
      async () => R(await scoped(
        `SELECT (SELECT round(balance::numeric,1) FROM loyalty_account WHERE owner = $1) AS loyalty_points,
                (SELECT max(date)::date FROM broker_service_history WHERE client_registry_user = $2) AS last_service,
                (SELECT count(*) FROM broker_service_history WHERE client_registry_user = $2) AS lifetime_contacts,
                (SELECT count(*) FROM broker_action WHERE client_registry_user = $2 AND COALESCE(completed,false)=false) AS open_broker_actions,
                (SELECT count(*) FROM region_of_interest WHERE registry_user = $2) AS regions_of_interest`,
        [ctx.uid, ctx.account]))),

    tool('get_my_context',
      "The current client's crop mix (drives water demand) and any latent lease / carryover EOIs. Auto-scoped.",
      {},
      async () => R(await scoped(
        `SELECT 'commodity' AS kind, c.name AS detail, NULL::numeric AS volume_ml
           FROM registry_user_commodity ruc JOIN commodity c ON c.id = ruc.commodity WHERE ruc.registry_user = $1
          UNION ALL
         SELECT 'lease_eoi(' || CASE WHEN el.lease_in THEN 'IN' ELSE 'OUT' END || ')', el.water_type, el.volume
           FROM eoi_lease el WHERE el.waterfind_user = $2
          UNION ALL
         SELECT 'carryover_eoi(' || CASE WHEN ec.is_holder THEN 'SELL' ELSE 'BUY' END || ')', ec.region, ec.volume
           FROM eoi_carryover ec WHERE ec.waterfind_user = $2`,
        [ctx.account, ctx.uid]))),

    tool('get_my_account_setup',
      "Account-setup completeness snapshot for the current client, for a setup/standing review. Returns: " +
      "identity (name, salutation, company name, ABN/ACN, email + validation flags, address + address_valid), " +
      "standing (account approval dates, buyer_approved, banned, crm_locked, account_deleted, access class), " +
      "commodities recorded on the account (with last edit date), newsletters (the national-newsletter flag, " +
      "per-market-zone regional e-news opt-ins derived from the client's registered licences, regions-of-interest count), " +
      "terms of use (version accepted + date vs the currently active version), and per-licence registration " +
      "completeness (market zone, licence number, volume, approval date, e-news flag, ownership records, " +
      "company owners missing an ABN). Auto-scoped to the logged-in client.",
      {},
      async () => {
        const [identity] = await scoped(
          `SELECT wu.salutation, wu.first_name, wu.middle_name, wu.last_name, wu.company_name, wu.abn, wu.acn,
                  wu.email, wu.valid_email, wu.email_validated, wu.homephone, wu.businessphone, wu.company_mobile,
                  wu.unitnumber, wu.streetnumber, wu.streetname, wu.suburb, wu.ste AS address_state,
                  COALESCE(wu.postcode_string, wu.postcode::text) AS postcode, wu.country, wu.address_valid,
                  wu.dateplaced::date AS registered_on, wu.date_approved::date AS user_approved_on,
                  wu.buyer_approved, wu.banned, wu.crm_locked, at.name AS access_class,
                  ru.deleted AS account_deleted, ru.trading_state, ru.last_commodity_edit::date AS last_commodity_edit
             FROM waterfind_user wu
             JOIN registry_user ru ON ru.id = wu.registry_user
             LEFT JOIN waterfind_user_type wut ON wut.id = wu.usertype
             LEFT JOIN access_type at ON at.id = wut.access_id
            WHERE wu.id = $1
              AND EXISTS (SELECT 1 FROM tenant_to_user g WHERE g.registry_user = ru.id AND g.tenant = $2 AND g.access_level >= 0)`,
          [ctx.uid, TENANT]);
        if (!identity) return R([], { note: 'no account row found for this client' });
        const commodities = await scoped(
          `SELECT c.name FROM registry_user_commodity ruc JOIN commodity c ON c.id = ruc.commodity
            WHERE ruc.registry_user = $1 ORDER BY c.name`, [ctx.account]);
        const [news] = await scoped(
          `SELECT COALESCE(ru.national_newsletter_optin, false) AS national_newsletter_optin,
                  (SELECT count(*) FROM region_of_interest roi WHERE roi.registry_user = ru.id) AS regions_of_interest
             FROM registry_user ru WHERE ru.id = $1`, [ctx.account]);
        const regionalNews = await scoped(
          `SELECT COALESCE(r.name, 'NO REGION SET') AS market_zone,
                  bool_or(COALESCE(p.enews_optin, false)) AS regional_enews_active, count(*) AS licences
             FROM property p LEFT JOIN region r ON r.id = p.region
            WHERE p.registry_user = $1 AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE AND p.sub_type = 'REG'
            GROUP BY r.name ORDER BY r.name`, [ctx.account]);
        const [terms] = await scoped(
          `SELECT ru.terms_date_accepted::date AS accepted_on, t_acc.name AS accepted_version,
                  t_cur.name AS current_version, t_cur.date_placed::date AS current_version_published,
                  -- by NAME, not id: each re-upload of a version is a new row and one is active,
                  -- so accepting any row of the current version's name counts as current
                  (t_acc.name IS NOT NULL AND t_acc.name = t_cur.name) AS current_version_accepted
             FROM registry_user ru
             LEFT JOIN terms_of_use t_acc ON t_acc.id = ru.terms_of_use
             LEFT JOIN LATERAL (SELECT id, name, date_placed FROM terms_of_use
                                 WHERE active IS TRUE AND date_deleted IS NULL
                                 ORDER BY date_placed DESC LIMIT 1) t_cur ON true
            WHERE ru.id = $1`, [ctx.account]);
        const licences = await scoped(
          `SELECT p.id AS licence_id, r.name AS market_zone, p.property_type,
                  COALESCE(NULLIF(p.licence_number, ''), NULLIF(p.wal, '')) AS licence_number,
                  round(COALESCE(p.quantity, 0)::numeric, 1) AS volume_ml, p.date_approved::date AS approved_on,
                  COALESCE(p.enews_optin, false) AS enews_optin,
                  (SELECT count(*) FROM property_ownership po
                    WHERE po.property = p.id AND COALESCE(po.deleted, false) = false) AS ownership_records,
                  (SELECT count(*) FROM property_ownership po
                    WHERE po.property = p.id AND COALESCE(po.deleted, false) = false
                      AND COALESCE(po.company, false) = true AND NULLIF(po.abn, '') IS NULL) AS company_owners_missing_abn
             FROM property p LEFT JOIN region r ON r.id = p.region
            WHERE p.registry_user = $1 AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE AND p.sub_type = 'REG'
            ORDER BY p.quantity DESC NULLS LAST LIMIT 60`, [ctx.account]);
        return R([], {
          identity, commodities: commodities.map((c: any) => c.name),
          newsletters: { ...news, by_market_zone: regionalNews }, terms_of_use: terms ?? null,
          licences, licences_truncated_at_60: licences.length === 60,
        });
      }),

    // ---- MARKET / REFERENCE (region-parameterized; de-identified) --------------------
    tool('find_region',
      'Look up market region ids by (partial) name. Region names encode zone + priority class, e.g. "MURRAY", "MURRUMBIDGEE", "GOULBURN".',
      { name: z.string().describe('partial region/market name to search for') },
      async (a) => R(await scoped(
        `SELECT r.id AS region_id, r.name AS market, s.name AS state
           FROM region r LEFT JOIN state s ON s.id = r.state
          WHERE r.deleted IS NOT TRUE AND r.name ILIKE $1 ORDER BY r.name LIMIT 25`,
        ['%' + a.name + '%']))),

    tool('get_region_tradability',
      'Destination regions a source region has a valid trade route to, with conversion factor and any ' +
      'recorded seasonal trading window (applies the STR season gate). Route validity is not open capacity, ' +
      'and absence of window dates is absence of data, not absence of restriction — see the note field.',
      { region_id: z.number().int().describe('source region.id (from get_my_holdings)'),
        is_permanent: z.boolean().describe('true = entitlement/permanent (a sale); false = allocation/temporary (a lease)') },
      async (a) => R(await scoped(
        `SELECT tr.id AS to_region_id, tr.name AS to_market, ts.name AS to_state, rtr.sale AS is_permanent,
                rtr.exchangerate AS conversion_factor,
                CASE WHEN str.id IS NULL THEN 'NO_WINDOW_DATA' ELSE 'WINDOW' END AS window_status,
                str.from_date, str.to_date
           FROM region_trading_relationship rtr
           JOIN region tr ON tr.id = rtr.to_region AND tr.deleted IS NOT TRUE
           JOIN state ts ON ts.id = tr.state
           LEFT JOIN state_trading_relationship str ON str.id = rtr.str
          WHERE rtr.from_region = $1 AND COALESCE(rtr.sale,false) = $2
            AND rtr.suspended IS NOT TRUE AND COALESCE(str.suspended,false) = false
          ORDER BY ts.name, tr.name`,
        [a.region_id, a.is_permanent]),
        { note: 'window_status=NO_WINDOW_DATA means the route pairing is valid but this snapshot holds no ' +
                'seasonal-window record — not that the route is open year-round; announcement-gated IVT ' +
                'routes (e.g. Goulburn→Murray) open at announced dates that are not stored here. Absence of ' +
                'a destination in these rows means no route in this snapshot, not that trade to it is ' +
                'impossible — tagged/interstate mechanisms are not represented here (the knowledge corpus ' +
                'covers IVT and interstate mechanics).' })),

    tool('get_matchable_orders',
      'Live counter-orders in a region (anonymised: prices/volumes only, no counterparty identity). Uses the snapshot as-of date.' + WINDOWED_NOTE,
      { region_id: z.number().int(),
        is_permanent: z.boolean(),
        looking_for: z.enum(['buyers', 'sellers']).describe("'buyers' if the client wants to SELL; 'sellers' if they want to BUY") },
      async (a) => R(await scoped(
        `SELECT ol.id, ol.order_type AS side, round(ol.quantity_avelable::numeric,1) AS ml_available,
                ol.price_per_ml, ol.split, ol.min_split_quantity, ol.season, reg.name AS market
           FROM order_listing ol
           JOIN order_region oreg ON oreg.order_listing = ol.id AND COALESCE(oreg.deleted,false)=false
           JOIN region reg ON reg.id = oreg.region
          WHERE oreg.region = $1 AND ol.order_type = $4 AND ol.sale = $2
            AND (ol.deleted IS NULL OR ol.deleted=false) AND ol.date_completed IS NULL AND ol.quantity_avelable > 0
            AND (ol.date_effective IS NULL OR ol.date_effective <= $3) AND ol.date_expired >= $3
          -- Best price first PER SIDE: asks ('S', client buying) cheapest-first, bids ('B',
          -- client selling) highest-first. A single DESC handed buyers the 40 WORST asks.
          ORDER BY CASE WHEN $4 = 'S' THEN ol.price_per_ml END ASC NULLS LAST,
                   ol.price_per_ml DESC LIMIT 40`,
        [a.region_id, a.is_permanent, ctx.asof, side(a.looking_for)]), { as_of: ctx.asof })),

    tool('get_market_liquidity',
      'How fast a trade would clear: live order depth, best price and latent standing-rule demand per reachable market. Aggregated. Uses the snapshot as-of date.' + WINDOWED_NOTE,
      { region_id: z.number().int(),
        is_permanent: z.boolean(),
        looking_for: z.enum(['buyers', 'sellers']).describe("'buyers' if the client wants to SELL; 'sellers' if they want to BUY") },
      async (a) => R(await scoped(
        `WITH reachable AS (
           SELECT to_region AS region_id FROM region_trading_relationship
            WHERE from_region = $1 AND COALESCE(suspended,false)=false AND sale = $2
           UNION SELECT $1)
         SELECT reg.id, reg.name, count(DISTINCT ol.id) AS live_orders,
                round(sum(ol.quantity_avelable)::numeric) AS ml_available,
                -- best price is side-dependent: lowest ask ('S') / highest bid ('B')
                round((CASE WHEN $4 = 'S' THEN min(ol.price_per_ml) ELSE max(ol.price_per_ml) END)::numeric,2) AS best_price_per_ml,
                (SELECT count(*) FROM wateralert wa JOIN wateralert_region war ON war.wateralert=wa.id
                  WHERE war.region=reg.id AND wa.order_type=$4 AND wa.sale=$2
                    AND (wa.date_expired IS NULL OR wa.date_expired >= $3)) AS latent_rules
           FROM reachable r JOIN region reg ON reg.id=r.region_id
           JOIN order_region oreg ON oreg.region=reg.id AND COALESCE(oreg.deleted,false)=false
           JOIN order_listing ol ON ol.id=oreg.order_listing
          WHERE ol.order_type=$4 AND ol.sale=$2 AND (ol.deleted IS NULL OR ol.deleted=false)
            AND ol.date_completed IS NULL AND ol.quantity_avelable>0
            AND (ol.date_effective IS NULL OR ol.date_effective <= $3) AND ol.date_expired >= $3
          GROUP BY reg.id, reg.name ORDER BY ml_available DESC NULLS LAST LIMIT 25`,
        [a.region_id, a.is_permanent, ctx.asof, side(a.looking_for)]), { as_of: ctx.asof })),

    tool('get_price_band',
      'Min / p25 / median / p75 / max $/ML of settled trades in a region+product over the last N months (aggregated).' + WINDOWED_NOTE,
      { region_id: z.number().int(), is_permanent: z.boolean(),
        months: z.number().int().min(1).default(6) },
      async (a) => R(await scoped(
        `SELECT count(*) AS trades, round(min(oc.buying_price_per_ml)::numeric,0) AS min_pml,
                round(percentile_cont(0.25) WITHIN GROUP (ORDER BY oc.buying_price_per_ml)::numeric,0) AS p25_pml,
                round(percentile_cont(0.50) WITHIN GROUP (ORDER BY oc.buying_price_per_ml)::numeric,0) AS median_pml,
                round(percentile_cont(0.75) WITHIN GROUP (ORDER BY oc.buying_price_per_ml)::numeric,0) AS p75_pml,
                round(max(oc.buying_price_per_ml)::numeric,0) AS max_pml
           FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
          WHERE oc.date_deleted IS NULL AND wo.sellingregion = $1 AND wo.sale = $2
            AND oc.date_accepted >= now() - ($3 || ' months')::interval`,
        [a.region_id, a.is_permanent, a.months]))),

    tool('get_market_reference',
      'Blended current price reference for a region+product: settled internal median + external comparables + region indicative price (aggregated).' + WINDOWED_NOTE,
      { region_id: z.number().int(), is_permanent: z.boolean(),
        months: z.number().int().min(1).default(6) },
      async (a) => R(await scoped(
        `SELECT 'settled_internal' AS source,
                round(percentile_cont(0.5) WITHIN GROUP (ORDER BY oc.buying_price_per_ml)::numeric,0) AS median_pml,
                count(*) AS n, max(oc.date_accepted)::date AS latest
           FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
          WHERE oc.date_deleted IS NULL AND wo.sellingregion = $1 AND wo.sale = $2
            AND oc.date_accepted >= now() - ($3 || ' months')::interval
          UNION ALL
         SELECT 'external_sales',
                round(percentile_cont(0.5) WITHIN GROUP (ORDER BY es.price / NULLIF(es.quantity,0))::numeric,0),
                count(*), max(es.saledate)::date
           FROM external_sales es
          WHERE es.from_region = $1 AND es.sale = $2 AND es.price > 0 AND es.quantity > 0
            AND es.saledate >= now() - ($3 || ' months')::interval
          UNION ALL
         SELECT 'region_indicative',
                CASE WHEN $2 THEN r.perm_ind_price ELSE r.temp_ind_price END, NULL,
                CASE WHEN $2 THEN r.perm_ind_price_updated ELSE r.temp_ind_price_updated END::date
           FROM region r WHERE r.id = $1`,
        [a.region_id, a.is_permanent, a.months]))),

    tool('get_price_history_series',
      'Long-run market price history for a region+product, grouped by water year (Jul–Jun, e.g. "2019-20"), ' +
      'calendar year, or month — no lookback cap. Per period: trade count, total ML, volume-weighted average ' +
      '$/ML, median/p25/p75 $/ML, and per-source counts. Unions the same three trade sources as the Premium ' +
      'dashboard charts: Waterfind-brokered trades, state-registry reported trades (NSW/VIC registers, MIL), ' +
      'and WaterX. Use for historical comparisons (e.g. a client\'s realised prices vs the market, year by ' +
      'year); for a current quote prefer get_price_band / get_market_reference. Data ends at the snapshot ' +
      'as-of date. Note: the dashboard\'s reporting exclusions (off-market flags, proxy-account dedup) are ' +
      'not applied here, so per-period figures can differ slightly from published charts.',
      { region_id: z.number().int(), is_permanent: z.boolean(),
        group_by: z.enum(['water_year', 'year', 'month']).default('water_year'),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('inclusive ISO date lower bound'),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('inclusive ISO date upper bound') },
      async (a) => {
        // period expression chosen from the zod-validated enum (never model-supplied text).
        // AU water year runs 1 Jul – 30 Jun; labelled by its start year ("2019-20").
        const groupBy = a.group_by ?? 'water_year';
        const periodExpr =
          groupBy === 'water_year'
            ? `(extract(year FROM dt) - CASE WHEN extract(month FROM dt) < 7 THEN 1 ELSE 0 END)::int::text
               || '-' || lpad((((extract(year FROM dt) - CASE WHEN extract(month FROM dt) < 7 THEN 1 ELSE 0 END)::int + 1) % 100)::text, 2, '0')`
            : groupBy === 'year' ? `to_char(dt, 'YYYY')` : `to_char(dt, 'YYYY-MM')`;
        return R(await scoped(
          // Mirrors the Premium dashboard's source union (ExternalSalesDao.createAgreedQuery):
          // dollars is the trade's TOTAL value in all three branches (tenderoffer.price and
          // external_sales.price are totals; waterx_transaction.price is per-ML, so × quantity).
          `WITH trades AS (
             SELECT tof.expirydate::date AS dt, tof.quantity::numeric AS ml, tof.price::numeric AS dollars,
                    'waterfind' AS source
               FROM tenderoffer tof JOIN wateroffer wof ON wof.id = tof.wateroffer
              WHERE tof.accepted = true AND wof.deleted = false
                AND wof.sellingregion = $1 AND wof.sale = $2
                AND tof.quantity > 0 AND tof.price > 1
             UNION ALL
             SELECT es.saledate::date, es.quantity::numeric, es.price::numeric, 'registry'
               FROM external_sales es
              WHERE es.from_region = $1 AND es.sale = $2
                AND es.quantity > 0 AND es.price > 1
             UNION ALL
             SELECT wex.date_placed, wex.quantity::numeric, (wex.price * wex.quantity)::numeric, 'waterx'
               FROM waterx_transaction wex JOIN waterx_region wreg ON wreg.id = wex.waterx_region
              WHERE wreg.waterfind_region = $1 AND wex.sale = $2
                AND wex.quantity > 0 AND wex.price > 1
           )
           SELECT ${periodExpr} AS period,
                  count(*) AS trades, round(sum(ml), 0) AS volume_ml,
                  round(sum(dollars) / NULLIF(sum(ml), 0), 0) AS vwap_pml,
                  round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY dollars / ml)::numeric, 0) AS median_pml,
                  round(percentile_cont(0.25) WITHIN GROUP (ORDER BY dollars / ml)::numeric, 0) AS p25_pml,
                  round(percentile_cont(0.75) WITHIN GROUP (ORDER BY dollars / ml)::numeric, 0) AS p75_pml,
                  count(*) FILTER (WHERE source = 'waterfind') AS n_waterfind,
                  count(*) FILTER (WHERE source = 'registry')  AS n_registry,
                  count(*) FILTER (WHERE source = 'waterx')    AS n_waterx
             FROM trades
            -- source rows carry junk dates (e.g. saledate 0016-01-14) — bound to plausible range
            WHERE dt BETWEEN DATE '1990-01-01' AND now()::date
              AND dt >= COALESCE($3::date, DATE '1990-01-01')
              AND dt <= COALESCE($4::date, DATE '2100-01-01')
            GROUP BY 1 ORDER BY 1 LIMIT 400`,
          [a.region_id, a.is_permanent, a.date_from ?? null, a.date_to ?? null]),
          { as_of: ctx.asof });
      }),

    tool('get_region_allocation',
      "A region's announced seasonal allocation % of entitlement (the headline availability number).",
      { region_id: z.number().int() },
      async (a) => R(await scoped(
        `SELECT war.region, wa.title, round(wr.allocation_percent::numeric,1) AS current_pct,
                round(wr.allocation_amount::numeric,0) AS system_total_ml, wr.effective_date::date AS as_of
           FROM water_allocation_region war JOIN water_allocation wa ON wa.id = war.water_allocation
           JOIN LATERAL (SELECT allocation_percent, allocation_amount, effective_date FROM water_allocation_reading r
                         WHERE r.water_allocation = wa.id ORDER BY r.effective_date DESC LIMIT 1) wr ON true
          WHERE war.region = $1`,
        [a.region_id]))),

    tool('get_allocation_trajectory',
      "A region's announced allocation % readings over the trailing 12 months (date + %).",
      { region_id: z.number().int() },
      async (a) => R(await scoped(
        `SELECT wr.effective_date::date AS as_of, round(wr.allocation_percent::numeric,1) AS pct
           FROM water_allocation_region war JOIN water_allocation wa ON wa.id = war.water_allocation
           JOIN water_allocation_reading wr ON wr.water_allocation = wa.id
          WHERE war.region = $1 AND wr.effective_date >= $2::date - interval '12 months'
          ORDER BY wr.effective_date`,
        [a.region_id, ctx.asof]))),

    tool('get_climate_drivers',
      'Latest monthly SOI reading (negative values indicate El Niño phase) and latest dam storage % full averaged by state.',
      {},
      async () => {
        const soi = await scoped(`SELECT 'SOI ' || to_char(s.date_read,'YYYY-MM') AS metric, round(s.index_value::numeric,1) AS value
                                    FROM soi_monthly_reading s ORDER BY s.date_read DESC LIMIT 1`);
        const dams = await scoped(`SELECT d.aust_state, count(*) AS dams, round(avg(lr.percent_of_full_storage),1) AS avg_pct_full
                                     FROM dam d JOIN LATERAL (SELECT percent_of_full_storage FROM dam_reading dr
                                       WHERE dr.dam = d.id ORDER BY dr.date_read DESC LIMIT 1) lr ON true
                                     GROUP BY d.aust_state ORDER BY d.aust_state`);
        return R([], { soi: soi[0] ?? null, dam_storage_by_state: dams, note: 'state-level aggregates; SOI is a single basin-wide index' });
      }),

    tool('estimate_net_proceeds',
      "Estimated net proceeds for a seller = gross − Waterfind brokerage from the caller's own contracted " +
      'fee schedule (their fee agreement, else the state rate card — the same numbers as get_my_fee_schedule) ' +
      '− GST on the commission. An estimate: excludes government/authority transfer fees; exact net is known ' +
      'only post-settlement. Auto-scoped.',
      { region_id: z.number().int(), is_permanent: z.boolean(),
        volume_ml: z.number().describe('ML to sell'), price_per_ml: z.number().describe('$/ML') },
      async (a) => R(await scoped(
        `WITH ov AS (
           SELECT f.* FROM fees_registry_user f
            WHERE f.registry_user = $1 AND f.deleted IS NOT TRUE
            ORDER BY f.fee_date_updated DESC NULLS LAST, f.id DESC LIMIT 1),
         card AS (
           SELECT wf2.fees AS flat, wf2.range_one AS pct
             FROM region r
             JOIN state_fee_structure_state sfss ON sfss.state = r.state
             JOIN waterfind_fees wf2 ON wf2.state_fee_structure = sfss.state_fee_structure
            WHERE r.id = $2 AND wf2.sale = $3 AND wf2.transfer = false
            LIMIT 1),
         fee AS (
           SELECT CASE WHEN ov.id IS NOT NULL THEN
                    CASE WHEN $3 THEN ov.sell_perm_fees ELSE ov.sell_temp_fees END
                  ELSE k.flat END::numeric AS flat,
                  CASE WHEN ov.id IS NOT NULL THEN
                    CASE WHEN $3 THEN ov.sell_perm_range_one ELSE ov.sell_temp_range_one END
                  ELSE k.pct END::numeric AS pct,
                  CASE WHEN ov.id IS NOT NULL THEN 'client fee agreement'
                       WHEN k.flat IS NOT NULL THEN 'state rate card'
                       ELSE 'unresolved — refer to broker' END AS basis
             FROM (SELECT 1) one LEFT JOIN ov ON true LEFT JOIN card k ON true),
         calc AS (
           SELECT ($4::numeric * $5::numeric) AS gross, fee.basis, fee.flat, fee.pct,
                  (fee.flat + ($4::numeric * $5::numeric) * fee.pct/100.0)::numeric AS waterfind_comm
             FROM fee)
         SELECT round(gross,2) AS gross, basis,
                round(flat,2) AS flat_fee_aud, round(pct,2) AS brokerage_pct,
                round(waterfind_comm,2) AS est_waterfind_commission,
                round(waterfind_comm*0.10,2) AS est_gst_on_commission,
                round(gross - waterfind_comm*1.10,2) AS est_net_proceeds_excl_gov_fees
           FROM calc`,
        [ctx.account, a.region_id, a.is_permanent, a.volume_ml, a.price_per_ml]),
        { note: "computed from the client's own contracted fee schedule; excludes government/authority fees; exact net only post-settlement" })),

    tool('get_my_fee_schedule',
      "The current client's Waterfind fee schedule — the same four cells the CRM shows staff (permanent/temporary x buy/sell: flat $ fee + brokerage %). Resolution mirrors the CRM: the client's own fee agreement if one exists, else the state rate card for their first approved holding. Read-only; fee changes are broker-mediated. Auto-scoped.",
      {},
      async () => R(await scoped(
        `WITH ov AS (
           SELECT f.* FROM fees_registry_user f
            WHERE f.registry_user = $1 AND f.deleted IS NOT TRUE
            ORDER BY f.fee_date_updated DESC NULLS LAST, f.id DESC LIMIT 1),
         st AS (
           SELECT COALESCE(rr_par.state, rr.state) AS state_id
             FROM property p
             JOIN region rr ON rr.id = p.region AND rr.sub_type = 'REG'
             LEFT JOIN property par ON par.id = p.parent
             LEFT JOIN region rr_par ON rr_par.id = par.region
            WHERE p.registry_user = $1 AND p.deleted IS NOT TRUE AND p.date_approved IS NOT NULL
            ORDER BY p.id LIMIT 1),
         q(quadrant, is_buyer, is_perm) AS (
           VALUES ('buy_permanent', true, true), ('buy_temporary', true, false),
                  ('sell_permanent', false, true), ('sell_temporary', false, false))
         SELECT q.quadrant,
                round((CASE WHEN ov.id IS NOT NULL THEN
                         CASE q.quadrant WHEN 'buy_permanent' THEN ov.buy_perm_fees
                                         WHEN 'buy_temporary' THEN ov.buy_temp_fees
                                         WHEN 'sell_permanent' THEN ov.sell_perm_fees
                                         ELSE ov.sell_temp_fees END
                       ELSE wf.fees END)::numeric, 2) AS waterfind_fee_aud,
                round((CASE WHEN ov.id IS NOT NULL THEN
                         CASE q.quadrant WHEN 'buy_permanent' THEN ov.buy_perm_range_one
                                         WHEN 'buy_temporary' THEN ov.buy_temp_range_one
                                         WHEN 'sell_permanent' THEN ov.sell_perm_range_one
                                         ELSE ov.sell_temp_range_one END
                       ELSE wf.range_one END)::numeric, 2) AS brokerage_pct,
                CASE WHEN ov.id IS NOT NULL THEN 'client-specific agreement' ELSE 'state rate card' END AS source
           FROM q
           LEFT JOIN ov ON true
           LEFT JOIN st ON true
           LEFT JOIN LATERAL (SELECT wf2.fees, wf2.range_one FROM waterfind_fees wf2
                              JOIN state_fee_structure_state sfss ON sfss.state_fee_structure = wf2.state_fee_structure
                              WHERE ov.id IS NULL AND sfss.state = st.state_id
                                AND wf2.sale = q.is_perm AND wf2.transfer = q.is_buyer
                              LIMIT 1) wf ON true
          ORDER BY q.quadrant`,
        [ctx.account]),
        { note: 'read-only; fee changes are broker-mediated. Excludes government/authority transfer fees.' })),

    // ---- Water Management portal (only market_event + the per-client water float are in THIS DB;
    //      Sites / Water Use / Budget / Calendar / Actions live in the external waterfindapp) ----
    tool('get_market_events',
      'Scheduled market events / announcements (e.g. pre-allocation announcements, campaigns). Regional, not per-client. Optional region filter.' + WINDOWED_NOTE,
      { region_id: z.number().int().optional().describe('optional region.id filter') },
      async (a) => R(await scoped(
        `SELECT me.id, me.title, me.description, me.start_date::date AS start_date, me.end_date::date AS end_date,
                me.permanent, me.source, string_agg(DISTINCT r.name, '; ') AS regions
           FROM market_event me
           LEFT JOIN market_event_region mer ON mer.market_event = me.id
           LEFT JOIN region r ON r.id = mer.region
          WHERE ($1::bigint IS NULL OR mer.region = $1)
          GROUP BY me.id, me.title, me.description, me.start_date, me.end_date, me.permanent, me.source
          ORDER BY me.start_date DESC NULLS LAST LIMIT 40`,
        [a.region_id ?? null]))),

    tool('get_my_water_account',
      "The current client's Waterfind water float account + recent ledger, if any. Sites, Water Use by Site, Site Budget, Management Calendar and Management Actions are served by the external waterfindapp and are not in this database. Auto-scoped.",
      {},
      async () => {
        const account = await scoped(
          `SELECT id, name, date_created::date AS created, fee_per_ml, fixed_fee, enabled
             FROM water_float_account WHERE waterfind_user = $1`, [ctx.uid]);
        const transactions = await scoped(
          `SELECT date::date AS date, trade_number, note, is_debit, round(amount::numeric,2) AS amount, completed
             FROM water_float_account_transaction WHERE waterfind_user = $1 ORDER BY date DESC LIMIT 25`, [ctx.uid]);
        return R([], {
          account: account[0] ?? null,
          transactions,
          note: 'Sites / Water Use by Site / Site Budget / Management Calendar / Management Actions live in the external waterfindapp, not this database.',
        });
      }),

    // ---- OPPORTUNITY CONTEXT (caller's own patterns vs their regions' current market) ----
    tool('get_my_opportunities',
      "Tenant-scoped context for a conversation about opportunities, built from the client's own historical " +
      'activity. Auto-scoped to the logged-in client. Returns three parts: history_profile (the client\'s own ' +
      'settled trade history — buy vs sell, temporary vs permanent, by region and month/season, typical volumes ' +
      'and realised $/ML); current_market (de-identified best bid/ask, recent traded median and the client\'s ' +
      'own realised medians, for the client\'s holding regions only — no counterparty identities); and ' +
      'observations[] — each a factual observation computed from the data (activity_summary, seasonal_pattern, ' +
      'price_context, unused_approval, open_orders) carrying its underlying numbers. The DB is a historical ' +
      'snapshot: the current season is derived from the latest data date and reported as data_as_at. Optional ' +
      "'season' selects the focus season for the current-season flags (e.g. '2025-26' or '2025'). product/sub_type " +
      'codes (REG etc.) are internal registry facets, not scheme types (see get_my_holdings).',
      { season: z.string().optional().describe("optional focus season for the 'this season' flags, e.g. '2025-26' or '2025'; omit to use the latest data date") },
      async (a) => {
        const num = (v: any) => (v == null ? null : Number(v));
        const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const LOOKBACK_MONTHS = 12;
        const seasonStartOf = (iso: string | null): number | null => {
          if (!iso) return null; const y = +iso.slice(0, 4), m = +iso.slice(5, 7); return m >= 7 ? y : y - 1;
        };
        const seasonLabel = (s: number) => `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
        const pct = (v: number, base: number) => (base ? Math.round(((v - base) / base) * 100) : null);
        const entLabel = (isPerm: boolean) => (isPerm ? 'permanent (entitlement)' : 'temporary (allocation)');

        // --- the client's own settled trade history (bound to the caller's uid; buy + sell) ---
        const histDir = await scoped(
          `WITH tx AS (
             SELECT 'sell'::text AS direction, wo.sale AS is_permanent, oc.date_accepted AS dt,
                    oc.buying_quantity AS ml, oc.buying_price_per_ml AS pml
               FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
              WHERE wo.seller = $1 AND oc.date_deleted IS NULL
             UNION ALL
             SELECT 'buy', wo.sale, oc.date_accepted, oc.buying_quantity, oc.buying_price_per_ml
               FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
              WHERE wo.buyer = $1 AND oc.date_deleted IS NULL)
           SELECT direction, is_permanent, count(*) AS trades,
                  round(sum(ml)::numeric,0) AS total_ml, round(avg(ml)::numeric,1) AS avg_ml,
                  round(avg(pml)::numeric,0) AS avg_realised_pml,
                  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY pml)::numeric,0) AS median_realised_pml,
                  count(DISTINCT (CASE WHEN extract(month from dt)>=7 THEN extract(year from dt) ELSE extract(year from dt)-1 END))::int AS seasons_active,
                  to_char(min(dt),'YYYY-MM-DD') AS first_trade, to_char(max(dt),'YYYY-MM-DD') AS last_trade
             FROM tx GROUP BY direction, is_permanent ORDER BY trades DESC`,
          [ctx.uid]);

        const histRegion = await scoped(
          `WITH tx AS (
             SELECT 'sell'::text AS direction, wo.sale AS is_permanent, wo.sellingregion AS region_id,
                    oc.date_accepted AS dt, oc.buying_quantity AS ml, oc.buying_price_per_ml AS pml
               FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
              WHERE wo.seller = $1 AND oc.date_deleted IS NULL
             UNION ALL
             SELECT 'buy', wo.sale, wo.sellingregion, oc.date_accepted, oc.buying_quantity, oc.buying_price_per_ml
               FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
              WHERE wo.buyer = $1 AND oc.date_deleted IS NULL)
           SELECT tx.direction, tx.is_permanent, tx.region_id, r.name AS market,
                  count(*) AS trades, round(sum(tx.ml)::numeric,0) AS total_ml,
                  round(avg(tx.pml)::numeric,0) AS avg_realised_pml,
                  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY tx.pml)::numeric,0) AS median_realised_pml,
                  count(DISTINCT (CASE WHEN extract(month from tx.dt)>=7 THEN extract(year from tx.dt) ELSE extract(year from tx.dt)-1 END))::int AS seasons_active,
                  max((CASE WHEN extract(month from tx.dt)>=7 THEN extract(year from tx.dt) ELSE extract(year from tx.dt)-1 END))::int AS last_season
             FROM tx LEFT JOIN region r ON r.id = tx.region_id
            GROUP BY tx.direction, tx.is_permanent, tx.region_id, r.name
            ORDER BY total_ml DESC LIMIT 20`,
          [ctx.uid]);

        const histGrid = await scoped(
          `WITH tx AS (
             SELECT 'sell'::text AS direction, wo.sale AS is_permanent, oc.date_accepted AS dt, oc.buying_quantity AS ml
               FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
              WHERE wo.seller = $1 AND oc.date_deleted IS NULL
             UNION ALL
             SELECT 'buy', wo.sale, oc.date_accepted, oc.buying_quantity
               FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
              WHERE wo.buyer = $1 AND oc.date_deleted IS NULL)
           SELECT direction, is_permanent,
                  (CASE WHEN extract(month from dt)>=7 THEN extract(year from dt) ELSE extract(year from dt)-1 END)::int AS season_start,
                  extract(month from dt)::int AS month, count(*) AS trades, round(sum(ml)::numeric,0) AS ml
             FROM tx GROUP BY direction, is_permanent, season_start, month`,
          [ctx.uid]);

        // --- the caller's holding regions + sell-approval flags (RLS-scoped `property`) ---
        const holdings = await scoped(
          `SELECT p.region AS region_id, r.name AS market,
                  substring(upper(t.name) from '^(NSW|VIC|SA|QLD|WA|TAS|NT|ACT)([^A-Z0-9]|$)') AS au_state,
                  round(coalesce(sum(p.quantity),0)::numeric,1) AS total_ml,
                  round(coalesce(max(p.quantity) FILTER (WHERE p.date_approved IS NOT NULL),0)::numeric,1) AS largest_approved_licence_ml,
                  bool_or(p.permission_spot_temp) AS spot_temp_ok, bool_or(p.permission_spot_perm) AS spot_perm_ok,
                  bool_or(p.permission_futures_temp) AS fut_temp_ok, bool_or(p.permission_futures_perm) AS fut_perm_ok
             FROM property p LEFT JOIN region r ON r.id = p.region
             LEFT JOIN state s2 ON s2.id = r.state LEFT JOIN territory t ON t.id = s2.territory
            WHERE p.registry_user = $1 AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE
              AND (p.quantity > 0 OR p.date_approved IS NOT NULL) AND p.region IS NOT NULL
            GROUP BY p.region, r.name, t.name ORDER BY total_ml DESC`,
          [ctx.account]);

        // --- current market in the caller's holding regions only (de-identified; recent window
        //     anchored to each region's own latest settled trade, since the snapshot is historical) ---
        const market = await scoped(
          `WITH myregions AS (
             SELECT DISTINCT p.region AS region_id FROM property p
              WHERE p.registry_user = $1 AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE AND p.region IS NOT NULL),
           perms(is_permanent) AS (VALUES (false),(true)),
           rp AS (SELECT mr.region_id, pm.is_permanent FROM myregions mr CROSS JOIN perms pm)
           SELECT rp.region_id, r.name AS market, rp.is_permanent,
             (SELECT round(max(ol.price_per_ml)::numeric,0) FROM order_listing ol
                JOIN order_region oreg ON oreg.order_listing=ol.id AND COALESCE(oreg.deleted,false)=false
               WHERE oreg.region=rp.region_id AND ol.order_type='B' AND ol.sale=rp.is_permanent
                 AND (ol.deleted IS NULL OR ol.deleted=false) AND ol.date_completed IS NULL AND ol.quantity_avelable>0
                 AND (ol.date_effective IS NULL OR ol.date_effective<=$2) AND ol.date_expired>=$2) AS best_bid_pml,
             (SELECT round(min(ol.price_per_ml)::numeric,0) FROM order_listing ol
                JOIN order_region oreg ON oreg.order_listing=ol.id AND COALESCE(oreg.deleted,false)=false
               WHERE oreg.region=rp.region_id AND ol.order_type='S' AND ol.sale=rp.is_permanent
                 AND (ol.deleted IS NULL OR ol.deleted=false) AND ol.date_completed IS NULL AND ol.quantity_avelable>0
                 AND (ol.date_effective IS NULL OR ol.date_effective<=$2) AND ol.date_expired>=$2) AS best_ask_pml,
             (SELECT count(DISTINCT ol.id) FROM order_listing ol
                JOIN order_region oreg ON oreg.order_listing=ol.id AND COALESCE(oreg.deleted,false)=false
               WHERE oreg.region=rp.region_id AND ol.order_type='B' AND ol.sale=rp.is_permanent
                 AND (ol.deleted IS NULL OR ol.deleted=false) AND ol.date_completed IS NULL AND ol.quantity_avelable>0
                 AND (ol.date_effective IS NULL OR ol.date_effective<=$2) AND ol.date_expired>=$2)::int AS live_buy_orders,
             (SELECT count(DISTINCT ol.id) FROM order_listing ol
                JOIN order_region oreg ON oreg.order_listing=ol.id AND COALESCE(oreg.deleted,false)=false
               WHERE oreg.region=rp.region_id AND ol.order_type='S' AND ol.sale=rp.is_permanent
                 AND (ol.deleted IS NULL OR ol.deleted=false) AND ol.date_completed IS NULL AND ol.quantity_avelable>0
                 AND (ol.date_effective IS NULL OR ol.date_effective<=$2) AND ol.date_expired>=$2)::int AS live_sell_orders,
             lt.latest_trade, lt.recent_trades, lt.recent_median_pml
             FROM rp LEFT JOIN region r ON r.id=rp.region_id
             LEFT JOIN LATERAL (
                SELECT to_char(mx.m,'YYYY-MM-DD') AS latest_trade,
                       count(*) FILTER (WHERE t.dt >= mx.m - ($3||' months')::interval)::int AS recent_trades,
                       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.pml) FILTER (WHERE t.dt >= mx.m - ($3||' months')::interval)::numeric,0) AS recent_median_pml
                  FROM (SELECT oc.date_accepted dt, oc.buying_price_per_ml pml
                          FROM order_completed oc JOIN wateroffer wo ON wo.id=oc.wateroffer
                         WHERE wo.sellingregion=rp.region_id AND wo.sale=rp.is_permanent AND oc.date_deleted IS NULL) t
                  CROSS JOIN (SELECT max(oc.date_accepted) m FROM order_completed oc JOIN wateroffer wo ON wo.id=oc.wateroffer
                               WHERE wo.sellingregion=rp.region_id AND wo.sale=rp.is_permanent AND oc.date_deleted IS NULL) mx
                 GROUP BY mx.m
             ) lt ON true
            ORDER BY rp.region_id, rp.is_permanent`,
          [ctx.account, ctx.asof, LOOKBACK_MONTHS]);

        // --- the caller's OWN standing (open) orders; region list trimmed to their holding regions ---
        const openOrders = await scoped(
          `WITH myregions AS (
             SELECT DISTINCT p.region AS rid FROM property p
              WHERE p.registry_user = $2 AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE AND p.region IS NOT NULL)
           SELECT ol.id, ol.order_type AS side, ol.sale AS is_permanent, ol.season,
                  round(ol.quantity_avelable::numeric,1) AS ml_available, ol.price_per_ml,
                  count(DISTINCT oreg.region)::int AS n_regions,
                  array_agg(DISTINCT oreg.region) FILTER (WHERE oreg.region IN (SELECT rid FROM myregions)) AS holdings_region_ids,
                  string_agg(DISTINCT r2.name, '; ') FILTER (WHERE oreg.region IN (SELECT rid FROM myregions)) AS holdings_markets_covered
             FROM order_listing ol
             LEFT JOIN order_region oreg ON oreg.order_listing=ol.id AND COALESCE(oreg.deleted,false)=false
             LEFT JOIN region r2 ON r2.id=oreg.region
            WHERE ol.owner = $1 AND (ol.deleted IS NULL OR ol.deleted=false) AND ol.date_completed IS NULL
              AND ol.quantity_avelable > 0 AND ol.date_expired >= $3
            GROUP BY ol.id, ol.order_type, ol.sale, ol.season, ol.quantity_avelable, ol.price_per_ml
            ORDER BY ol.order_type, ol.price_per_ml DESC`,
          [ctx.uid, ctx.account, ctx.asof]);

        // --- provenance: the snapshot is historical, so anchor "current season" to the latest data date ---
        const allFirst = histDir.map((r: any) => r.first_trade).filter(Boolean).sort()[0] ?? null;
        const allLast = histDir.map((r: any) => r.last_trade).filter(Boolean).sort().slice(-1)[0] ?? null;
        const dates = [allLast, ...market.map((m: any) => m.latest_trade), ctx.asof].filter(Boolean) as string[];
        const dataAsAt = dates.sort().slice(-1)[0] ?? ctx.asof;
        const currentSeasonStart = a.season && /\d{4}/.test(a.season)
          ? parseInt(a.season.match(/\d{4}/)![0], 10)
          : (seasonStartOf(dataAsAt) ?? seasonStartOf(ctx.asof)!);

        // sells the caller has already booked in the focus season (any product) — for unused_approval
        const sellsSeason = await scoped(
          `SELECT wo.sellingregion AS region_id, count(*)::int AS sells
             FROM order_completed oc JOIN wateroffer wo ON wo.id = oc.wateroffer
            WHERE wo.seller = $1 AND oc.date_deleted IS NULL
              AND (CASE WHEN extract(month from oc.date_accepted)>=7 THEN extract(year from oc.date_accepted)
                        ELSE extract(year from oc.date_accepted)-1 END)::int = $2
            GROUP BY 1`,
          [ctx.uid, currentSeasonStart]);

        // ---- assemble history_profile ----
        const byMonthMap = new Map<string, any>();
        for (const g of histGrid as any[]) {
          const mo = Number(g.month);
          const k = `${g.direction}|${g.is_permanent}|${mo}`;
          const e = byMonthMap.get(k) ?? { direction: g.direction, is_permanent: g.is_permanent, month: mo, month_name: MONTHS[mo], trades: 0, total_ml: 0, seasons: new Set<number>() };
          e.trades += Number(g.trades) || 0; e.total_ml += Number(g.ml) || 0; e.seasons.add(Number(g.season_start));
          byMonthMap.set(k, e);
        }
        const byMonth = Array.from(byMonthMap.values())
          .map((e) => ({ direction: e.direction, is_permanent: e.is_permanent, month: e.month, month_name: e.month_name, trades: e.trades, total_ml: Math.round(e.total_ml), seasons_active: e.seasons.size }))
          .sort((x, y) => x.direction.localeCompare(y.direction) || Number(x.is_permanent) - Number(y.is_permanent) || x.month - y.month);
        const seasonsList = Array.from(new Set((histGrid as any[]).map((g) => Number(g.season_start)))).sort((x, y) => x - y).map(seasonLabel);

        const historyProfile = {
          data_span: { first_trade: allFirst, last_trade: allLast, seasons_active: seasonsList.length },
          by_direction: (histDir as any[]).map((r) => ({
            direction: r.direction, is_permanent: r.is_permanent, trades: num(r.trades), total_ml: num(r.total_ml),
            avg_ml: num(r.avg_ml), avg_realised_pml: num(r.avg_realised_pml), median_realised_pml: num(r.median_realised_pml),
            seasons_active: num(r.seasons_active), first_trade: r.first_trade, last_trade: r.last_trade,
          })),
          by_region: (histRegion as any[]).map((r) => ({
            direction: r.direction, is_permanent: r.is_permanent, region_id: num(r.region_id), market: r.market,
            trades: num(r.trades), total_ml: num(r.total_ml), avg_realised_pml: num(r.avg_realised_pml),
            median_realised_pml: num(r.median_realised_pml), seasons_active: num(r.seasons_active),
            last_season: r.last_season != null ? seasonLabel(Number(r.last_season)) : null,
          })),
          by_month: byMonth,
          seasons_active: seasonsList,
        };

        // ---- assemble current_market (attach the caller's own realised medians per region+product) ----
        const hrIndex = new Map<string, any>();
        for (const r of histRegion as any[]) hrIndex.set(`${r.region_id}|${r.is_permanent}|${r.direction}`, r);
        const currentMarket = (market as any[]).map((m) => {
          const sell = hrIndex.get(`${m.region_id}|${m.is_permanent}|sell`);
          const buy = hrIndex.get(`${m.region_id}|${m.is_permanent}|buy`);
          return {
            region_id: num(m.region_id), market: m.market, is_permanent: m.is_permanent,
            best_bid_pml: num(m.best_bid_pml), best_ask_pml: num(m.best_ask_pml),
            live_buy_orders: num(m.live_buy_orders), live_sell_orders: num(m.live_sell_orders),
            recent_trades: num(m.recent_trades), recent_window_months: LOOKBACK_MONTHS,
            recent_median_pml: num(m.recent_median_pml), latest_trade: m.latest_trade,
            my_median_realised_sell_pml: sell ? num(sell.median_realised_pml) : null,
            my_median_realised_buy_pml: buy ? num(buy.median_realised_pml) : null,
            my_sells_here: sell ? num(sell.trades) : 0, my_buys_here: buy ? num(buy.trades) : 0,
          };
        }).filter((m) => m.best_bid_pml != null || m.best_ask_pml != null || (m.recent_trades ?? 0) > 0);

        // ---- observations (factual flags, each with its underlying numbers) ----
        const observations: any[] = [];

        // activity_summary — always, if any history
        if ((histDir as any[]).length) {
          const parts = (histDir as any[]).map((r) => `${num(r.trades)} ${r.direction === 'sell' ? 'sales' : 'purchases'} of ${entLabel(r.is_permanent)} water (${num(r.total_ml)} ML, median $${num(r.median_realised_pml)}/ML)`);
          observations.push({
            type: 'activity_summary',
            text: `On record across ${seasonsList.length} season(s) (${allFirst ?? '?'} to ${allLast ?? '?'}): ${parts.join('; ')}.`,
            numbers: { seasons_active: seasonsList.length, first_trade: allFirst, last_trade: allLast, by_direction: historyProfile.by_direction },
          });

          // seasonal_pattern — for the dominant direction+product, months recurring across recent seasons
          const dom = (histDir as any[])[0];
          const domRows = (histGrid as any[]).filter((g) => g.direction === dom.direction && g.is_permanent === dom.is_permanent);
          const domSeasons = Array.from(new Set(domRows.map((g) => Number(g.season_start)))).filter((s) => s <= currentSeasonStart).sort((x, y) => x - y);
          const windowSeasons = domSeasons.slice(-4);
          if (windowSeasons.length >= 2) {
            const wset = new Set(windowSeasons);
            const perMonth = new Map<number, { seasons: Set<number>; ml: number }>();
            for (const g of domRows) {
              const s = Number(g.season_start); if (!wset.has(s)) continue;
              const mo = Number(g.month); const e = perMonth.get(mo) ?? { seasons: new Set<number>(), ml: 0 };
              e.seasons.add(s); e.ml += Number(g.ml) || 0; perMonth.set(mo, e);
            }
            const threshold = Math.max(2, Math.ceil(windowSeasons.length * 0.6));
            const qualifying = Array.from(perMonth.entries())
              .filter(([, v]) => v.seasons.size >= threshold)
              .map(([mo, v]) => ({ month: mo, month_name: MONTHS[mo], seasons_active: v.seasons.size, total_ml: Math.round(v.ml) }))
              .sort((x, y) => x.month - y.month);
            if (qualifying.length) {
              const phr = qualifying.map((q) => `${q.month_name} (${q.seasons_active} of ${windowSeasons.length})`).join(', ');
              observations.push({
                type: 'seasonal_pattern',
                text: `In the last ${windowSeasons.length} season(s) of ${entLabel(dom.is_permanent)} ${dom.direction === 'sell' ? 'selling' : 'buying'} activity, ${dom.direction === 'sell' ? 'sold' : 'bought'} water recurrently in: ${phr}.`,
                numbers: { direction: dom.direction, is_permanent: dom.is_permanent, entitlement_type: entLabel(dom.is_permanent), seasons_window: windowSeasons.map(seasonLabel), threshold, months: qualifying },
              });
            }
          }
        }

        // price_context — current bid/ask vs the caller's OWN realised median in that region+product
        const priceCtx: any[] = [];
        for (const m of currentMarket) {
          if (m.my_median_realised_sell_pml && m.best_bid_pml != null) {
            const my = m.my_median_realised_sell_pml as number, bid = m.best_bid_pml as number, d = pct(bid, my)!;
            priceCtx.push({
              type: 'price_context',
              text: `Current best bid in ${m.market} (${entLabel(m.is_permanent)}) is $${bid}/ML, ${Math.abs(d)}% ${bid >= my ? 'above' : 'below'} your median realised sell price of $${my}/ML across ${m.my_sells_here} past sale(s) in this market.`,
              numbers: { region_id: m.region_id, market: m.market, is_permanent: m.is_permanent, best_bid_pml: bid, my_median_realised_sell_pml: my, my_sells_here: m.my_sells_here, pct_bid_vs_my_sell: d, recent_median_pml: m.recent_median_pml },
            });
          }
          if (m.my_median_realised_buy_pml && m.best_ask_pml != null) {
            const my = m.my_median_realised_buy_pml as number, ask = m.best_ask_pml as number, d = pct(ask, my)!;
            priceCtx.push({
              type: 'price_context',
              text: `Current best ask in ${m.market} (${entLabel(m.is_permanent)}) is $${ask}/ML, ${Math.abs(d)}% ${ask >= my ? 'above' : 'below'} your median realised buy price of $${my}/ML across ${m.my_buys_here} past purchase(s) in this market.`,
              numbers: { region_id: m.region_id, market: m.market, is_permanent: m.is_permanent, best_ask_pml: ask, my_median_realised_buy_pml: my, my_buys_here: m.my_buys_here, pct_ask_vs_my_buy: d, recent_median_pml: m.recent_median_pml },
            });
          }
        }
        observations.push(...priceCtx.slice(0, 8));

        // unused_approval — holding approved to sell but no sale/open sell order in the focus season
        const soldRegions = new Set((sellsSeason as any[]).map((r) => Number(r.region_id)));
        const openSellRegions = new Set<number>();
        for (const o of openOrders as any[]) if (o.side === 'S') for (const rid of (o.holdings_region_ids || [])) openSellRegions.add(Number(rid));
        const unused = (holdings as any[])
          .filter((h) => Number(h.largest_approved_licence_ml) > 0 && (h.spot_temp_ok || h.spot_perm_ok || h.fut_temp_ok || h.fut_perm_ok))
          .filter((h) => !soldRegions.has(Number(h.region_id)) && !openSellRegions.has(Number(h.region_id)))
          .sort((x, y) => Number(y.largest_approved_licence_ml) - Number(x.largest_approved_licence_ml))
          .slice(0, 8)
          .map((h) => ({
            type: 'unused_approval',
            text: `Your licence in ${h.market} is approved to sell up to ${num(h.largest_approved_licence_ml)} ML but has no completed sales or open sell orders recorded in the ${seasonLabel(currentSeasonStart)} season.`,
            numbers: { region_id: num(h.region_id), market: h.market, largest_approved_licence_ml: num(h.largest_approved_licence_ml), total_ml: num(h.total_ml), current_season: seasonLabel(currentSeasonStart), sells_this_season: 0, open_sell_orders: 0 },
          }));
        observations.push(...unused);

        // open_orders — the caller's own standing orders right now
        if ((openOrders as any[]).length) {
          const sumMl = (arr: any[]) => Math.round(arr.reduce((s, o) => s + (Number(o.ml_available) || 0), 0) * 10) / 10;
          const sells = (openOrders as any[]).filter((o) => o.side === 'S');
          const buys = (openOrders as any[]).filter((o) => o.side === 'B');
          observations.push({
            type: 'open_orders',
            text: `You currently have ${sells.length} open sell order(s) totalling ${sumMl(sells)} ML and ${buys.length} open buy order(s) totalling ${sumMl(buys)} ML.`,
            numbers: {
              open_sell_orders: sells.length, open_sell_ml: sumMl(sells), open_buy_orders: buys.length, open_buy_ml: sumMl(buys),
              orders: (openOrders as any[]).map((o) => ({ side: o.side, is_permanent: o.is_permanent, season: o.season, ml_available: num(o.ml_available), price_per_ml: num(o.price_per_ml), n_regions: num(o.n_regions), holdings_markets_covered: o.holdings_markets_covered ?? null })),
            },
          });
        }

        return R([], {
          data_as_at: dataAsAt,
          current_season: seasonLabel(currentSeasonStart),
          season_basis: a.season ? 'caller-specified' : 'latest data date (snapshot is historical)',
          history_profile: historyProfile,
          current_market: currentMarket,
          observations,
        });
      }),
  ];

  return tools;
}

// Trading-ACTION tools: order preparation + broker escalation. The broker-assist surface (staff
// chatting about a client from the CRM client page) is advice-only in v1 — no orders can be
// prepared or escalations raised on the client's behalf from there — so these are excluded while
// the read-only order-visibility tools (get_my_open_orders, get_my_ai_orders) stay available.
export const TRADE_ACTION_TOOL_NAMES = [
  'prepare_sell_order', 'prepare_buy_order', 'prepare_order_withdrawal',
  'escalate_to_broker', 'cancel_escalation',
] as const;

/** Hand-off to a human broker — meaningless on the broker-assist surface, where the person typing
 *  IS the broker. The order tools stay: a broker places and withdraws for the client from there. */
export const ESCALATION_TOOL_NAMES = ['escalate_to_broker', 'cancel_escalation'] as const;

export const WF_ASSIST_TOOL_NAMES = WF_TOOL_NAMES.filter(
  (n) => !(ESCALATION_TOOL_NAMES as readonly string[]).includes(n),
);

export function buildAdvisorMcpServer(
  ctx: CallerCtx,
  conversationId: number | null = null,
  opts: { tradeActions?: boolean; escalations?: boolean; onBehalf?: OnBehalf | null } = {},
) {
  let tools = [...buildToolDefs(ctx), ...buildBrokerToolDefs(ctx, conversationId, { onBehalf: opts.onBehalf ?? null }),
               ...buildExtdataToolDefs(ctx), ...buildForecastToolDefs(ctx)];
  if (opts.tradeActions === false) {
    tools = tools.filter((t) => !(TRADE_ACTION_TOOL_NAMES as readonly string[]).includes(t.name));
  }
  if (opts.escalations === false) {
    tools = tools.filter((t) => !(ESCALATION_TOOL_NAMES as readonly string[]).includes(t.name));
  }
  return createSdkMcpServer({
    name: 'wf',
    version: '1.0.0',
    tools,
    alwaysLoad: true,
  });
}
