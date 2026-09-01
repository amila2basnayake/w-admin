-- Waterfind AI Advisor — outbound call campaigns (the "Call Campaigns" CRM page).
-- A campaign is a brief (flow + payload) plus a call list. Launching it does NOT dial: a feeder
-- (src/voice/campaigns.ts) paces the list into ai_advisor.voice_outbound_request a few at a time
-- (max_concurrent per campaign, calling hours, schedule), and the existing dialer + guards + retries
-- (src/voice/outbound.ts) do the rest. Per-member live state is DERIVED from the request and its call
-- (never copied back), so there is one source of truth for "what happened on that call".

CREATE TABLE IF NOT EXISTS ai_advisor.voice_campaign (
  id              bigserial   PRIMARY KEY,
  name            text        NOT NULL,
  flow            text        NOT NULL,                  -- trade_opportunity | market_alert | broker_followup
  payload         jsonb       NOT NULL DEFAULT '{}',     -- the brief: message, broker_name, region, callback_number
  filter          jsonb,                                 -- last list-builder filter used (for the record)
  status          text        NOT NULL DEFAULT 'draft',  -- draft | running | paused | completed | cancelled
  scheduled_for   timestamptz,                           -- NULL = as soon as launched (inside calling hours)
  max_concurrent  int         NOT NULL DEFAULT 3,        -- calls in flight at once for this campaign
  created_by      bigint      NOT NULL,                  -- staff waterfind_user.id
  created_by_name text,
  launched_at     timestamptz,
  launched_by     bigint,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_campaign_status_idx ON ai_advisor.voice_campaign (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_advisor.voice_campaign_member (
  id                  bigserial   PRIMARY KEY,
  campaign_id         bigint      NOT NULL REFERENCES ai_advisor.voice_campaign(id) ON DELETE CASCADE,
  client_uid          bigint      NOT NULL,              -- waterfind_user.id (the account's primary contact)
  client_name         text,                              -- snapshot at add time
  company             text,
  to_number           text,                              -- E.164 as resolved when fed (NULL until then)
  status              text        NOT NULL DEFAULT 'pending', -- pending | queued | skipped | cancelled
  skip_reason         text,
  outbound_request_id bigint,                            -- voice_outbound_request.id once fed
  feed_count          int         NOT NULL DEFAULT 0,    -- times fed (pause/resume re-feeds with a new idempotency key)
  added_by            bigint,
  added_at            timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, client_uid)
);
CREATE INDEX IF NOT EXISTS voice_campaign_member_campaign_idx ON ai_advisor.voice_campaign_member (campaign_id, status, id);
CREATE INDEX IF NOT EXISTS voice_campaign_member_request_idx ON ai_advisor.voice_campaign_member (outbound_request_id);

-- The list builder aggregates licences per ACCOUNT for hundreds of accounts at once (volume, zones,
-- state/zone filters). The CRM's property table (112k rows) has an index on region but NONE on
-- registry_user, so each per-account lookup was a full scan — minutes per search. One plain btree
-- index on a CRM table; it is the only change this feature makes outside the ai_advisor schema.
CREATE INDEX IF NOT EXISTS property_registry_user_idx ON public.property (registry_user);
