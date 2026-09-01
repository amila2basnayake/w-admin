-- =====================================================================================
--  AI Advisor data access — least-privilege read-only role + RLS backstop
-- =====================================================================================
--  Isolation model (curated-tools-only build):
--    1. The advisor only calls typed tools; each PRIVATE query binds the caller's ids
--       (from the verified token) server-side — the model never supplies an id.
--    2. Those queries run as this NON-superuser, SELECT-only role on an explicit table
--       allowlist (no writes, bounded surface).
--    3. RLS on the crown-jewel private table `property` (and the water-mgmt tables) is a
--       DB-enforced backstop: even a buggy query cannot cross tenants.
--    4. Market/reference tools select NO per-client identity columns (de-identified).
--  The CRM app connects as superuser `waterfind`, which BYPASSES RLS → zero app impact.
-- =====================================================================================

-- 1. Role -------------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_advisor_ro') THEN
    CREATE ROLE ai_advisor_ro LOGIN PASSWORD 'ai_ro_local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

GRANT CONNECT ON DATABASE "waterfind-db" TO ai_advisor_ro;
GRANT USAGE ON SCHEMA public TO ai_advisor_ro;

-- 2. Explicit SELECT allowlist (least privilege) ---------------------------------------
--    Only the tables the curated tools read. NOT "GRANT SELECT ON ALL".
GRANT SELECT ON
  waterfind_user, registry_user, waterfind_user_type, access_type, tenant_to_user,
  property, region, state, territory,
  region_trading_relationship, state_trading_relationship,
  order_listing, order_region, wateralert, wateralert_region,
  order_completed, wateroffer, external_sales,
  -- price-history sources (get_price_history_series): accepted tenders + WaterX comparables.
  -- Aggregate-only in the tool; tenderoffer rows are reachable but the curated queries never
  -- select counterparty identity columns.
  tenderoffer, waterx_transaction, waterx_region,
  waterfind_fees, client_payment,
  fees_registry_user, state_fee_structure_state,
  loyalty_account, broker_service_history, broker_action, region_of_interest,
  water_allocation, water_allocation_region, water_allocation_reading,
  soi_monthly_reading, dam, dam_reading,
  approval_procedure, dispute, dispute_at_fault_party,
  registry_user_commodity, commodity, eoi_lease, eoi_carryover,
  market_event, market_event_region,
  water_float_account, water_float_account_transaction,
  -- account-setup review (get_my_account_setup): licence owner records + the terms-of-use catalogue
  property_ownership, terms_of_use
TO ai_advisor_ro;

-- waterfind_commission_index (other clients' actually-charged commissions) is deliberately
-- NOT granted: the advisor must only ever see the caller's own contracted fee schedule.
REVOKE SELECT ON waterfind_commission_index FROM ai_advisor_ro;

-- 3. RLS backstop on the crown-jewel private table -------------------------------------
--    `property` = a client's holdings. Scoped to the caller's account (registry_user),
--    read from the per-request GUC `ai.account`. GUC unset -> NULL -> no rows (fail closed).
ALTER TABLE property ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_property_own ON property;
CREATE POLICY ai_property_own ON property FOR SELECT TO ai_advisor_ro
  USING (registry_user = NULLIF(current_setting('ai.account', true), '')::bigint);

-- Licence owner records (names, ABNs, bank details columns exist on the table): reachable only
-- through a property the caller's account owns — the same GUC scope as `property` itself.
ALTER TABLE property_ownership ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_property_ownership_own ON property_ownership;
CREATE POLICY ai_property_ownership_own ON property_ownership FOR SELECT TO ai_advisor_ro
  USING (EXISTS (SELECT 1 FROM property p WHERE p.id = property_ownership.property
                    AND p.registry_user = NULLIF(current_setting('ai.account', true), '')::bigint));

-- Same backstop for the client's private fee agreement (get_my_fee_schedule).
ALTER TABLE fees_registry_user ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_fees_own ON fees_registry_user;
CREATE POLICY ai_fees_own ON fees_registry_user FOR SELECT TO ai_advisor_ro
  USING (registry_user = NULLIF(current_setting('ai.account', true), '')::bigint);

-- (Water-management private tables get the same treatment once inventoried — see
--  grants-rls-wamp.sql, applied after the portal data model is confirmed.)

-- 4. Sanity: confirm the role cannot see another client's holdings without the GUC.
--    (Run manually as ai_advisor_ro: SELECT count(*) FROM property;  -> 0 rows.)
