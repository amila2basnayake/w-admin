-- Waterfind AI Advisor — Workstream D: broker workflow & escalation (CEO parity plan B3/B4/B5).
-- Sidecar-owned durable record of escalations to a HUMAN broker (B5). The broker-VISIBLE record
-- lives in the CRM's own task manager, public.broker_action (the table brokers see on the client
-- file and on their daily action list / broker-action email) — written by the sidecar after an
-- order event or an escalation (see src/brokerage.ts). This table tracks the escalation itself:
-- who asked, why, from which conversation, which "appropriate broker" was resolved, and the id of
-- the broker_action task that was raised. It never mirrors CRM tables; it augments them.
--
-- Apply alongside db/brokerage.sql (or via test-workflow.ts, which applies it idempotently).

CREATE TABLE IF NOT EXISTS ai_advisor.escalation (
  id                   bigserial   PRIMARY KEY,
  user_id              bigint      NOT NULL,   -- CRM waterfind_user.id (the client, from the verified token)
  account_id           bigint,                 -- registry_user.id resolved server-side (may be null)
  conversation_id      bigint      REFERENCES ai_advisor.conversation(id) ON DELETE SET NULL,
  reason               text        NOT NULL,   -- short reason/category the model supplied
  summary              text,                   -- the model's summary of what the client needs
  broker_user_id       bigint,                 -- resolved "appropriate broker" waterfind_user.id (may be null)
  broker_name          text,                   -- denormalised broker display name for the record
  broker_source        text,                   -- how it was resolved: assigned-tag / primary-sales /
                                               --   secondary-sales / active-tag / recent-servicing /
                                               --   default / unassigned
  crm_broker_action_id bigint,                 -- public.broker_action.id raised for this escalation (broker-visible task)
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS escalation_user_idx ON ai_advisor.escalation (user_id, created_at DESC);

-- Confirm-before-send lifecycle (mirrors pending_order): the model can only PREPARE an escalation
-- ('pending'); the CRM task is raised when the client clicks Confirm on the in-chat card
-- ('confirmed'), or never ('declined'). A confirmed escalation the client withdraws becomes
-- 'cancelled' and its CRM task is completed+annotated. Pre-existing rows were raised without the
-- confirm step, hence the 'confirmed' default; new rows are inserted as 'pending' explicitly.
ALTER TABLE ai_advisor.escalation ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'confirmed';
ALTER TABLE ai_advisor.escalation ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE ai_advisor.escalation ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
