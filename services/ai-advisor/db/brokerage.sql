-- Waterfind AI Advisor — brokerage: orders proposed by the AI, awaiting explicit user confirmation.
-- Lives in the sidecar-owned ai_advisor schema. The AI's tools can only CREATE a row here
-- (status 'pending'); EXECUTION happens only after the human clicks Confirm in the chat UI,
-- which calls the sidecar with their own bearer token. The sidecar then places the order
-- through the CRM's real trade engine (WaterfindDelegate.addNewOrderListing) via the
-- HMAC-authenticated JSP seam (/ai-broker-exec.html).

CREATE TABLE IF NOT EXISTS ai_advisor.pending_order (
  id              bigserial   PRIMARY KEY,
  user_id         bigint      NOT NULL,             -- CRM waterfind_user.id (from the verified token)
  account_id      bigint      NOT NULL,             -- registry_user.id resolved server-side at prepare time
  conversation_id bigint      REFERENCES ai_advisor.conversation(id) ON DELETE SET NULL,
  side            text        NOT NULL CHECK (side IN ('BUY','SELL','WITHDRAW')),
  is_permanent    boolean     NOT NULL DEFAULT false,  -- false = allocation (temporary), true = entitlement (permanent)
  region_id       bigint,                           -- market region of the anchoring licence/listing
  region_name     text,                             -- denormalised for display
  property_id     bigint,                           -- the licence anchoring the order (validated ours)
  volume_ml       numeric     CHECK (volume_ml IS NULL OR volume_ml > 0),
  price_per_ml    numeric     CHECK (price_per_ml IS NULL OR price_per_ml > 0),
  expiry          text,                             -- dd/MM/yyyy or NULL = CRM default (season end)
  delivery_date   text,                             -- dd/MM/yyyy FORWARD delivery date; NULL = spot
  split           boolean     NOT NULL DEFAULT false,  -- allow partial fills
  min_split_quantity    numeric,                    -- ML; smallest acceptable fill (split only)
  max_split_parcel_size numeric,                    -- ML; cap per fill, NULL/0 = no cap (split only)
  target_order_id bigint,                           -- WITHDRAW: the CRM order_listing being withdrawn
  -- lifecycle: pending -> placed | failed | cancelled | expired | unknown
  --   'executing' is transient; 'unknown' means the seam call yielded NO definitive outcome
  --   (timeout / network error / non-JSON) — the order may or may not be live. Resolved by
  --   reconcileUnknownOrders() against the CRM order book; NEVER treated as failed until then.
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','executing','placed','failed','cancelled','expired','unknown')),
  validation      jsonb,                            -- snapshot of the scope checks that passed at prepare time
  preview         jsonb,                            -- price context / estimated proceeds shown on the card
  crm_order_id    bigint,                           -- order_listing.id returned by the CRM engine
  cleared_trades  int,                              -- trades auto-cleared at placement
  error           text,                             -- failure detail (status='failed')
  note_written    boolean,                          -- seam wrote the CRM trade-file contact note (H6; NULL = unverified)
  broker_notified boolean,                          -- broker_action follow-up task raised (H6; NULL = unverified)
  reconciled_at   timestamptz,                      -- when an 'unknown' outcome was resolved from the order book
  tc_accepted_at  timestamptz,                      -- user ticked the T&C box on the confirm card
  staff_user_id   bigint,                           -- broker-assist (Client Rail): the staff waterfind_user who prepared/confirmed for the client
  staff_name      text,                             -- ... and their display name at the time (NULL = the client acted for themselves)
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  decided_at      timestamptz                       -- when the user confirmed/cancelled (or it expired)
);
CREATE INDEX IF NOT EXISTS pending_order_user_idx
  ON ai_advisor.pending_order (user_id, created_at DESC);

-- Idempotent migration for pre-existing installs (CREATE TABLE IF NOT EXISTS does not alter).
ALTER TABLE ai_advisor.pending_order ADD COLUMN IF NOT EXISTS note_written boolean;
ALTER TABLE ai_advisor.pending_order ADD COLUMN IF NOT EXISTS broker_notified boolean;
ALTER TABLE ai_advisor.pending_order ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
ALTER TABLE ai_advisor.pending_order ADD COLUMN IF NOT EXISTS staff_user_id bigint;
ALTER TABLE ai_advisor.pending_order ADD COLUMN IF NOT EXISTS staff_name text;
ALTER TABLE ai_advisor.pending_order DROP CONSTRAINT IF EXISTS pending_order_status_check;
ALTER TABLE ai_advisor.pending_order ADD CONSTRAINT pending_order_status_check
  CHECK (status IN ('pending','executing','placed','failed','cancelled','expired','unknown'));
