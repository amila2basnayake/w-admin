-- Waterfind AI Advisor — voice calls (Inbound + Outbound phases). Sidecar-owned records for calls the
-- advisor answers or places through Retell. Design: docs/design/voice-calls-design.md.
--
-- The CRM stays the system of record for anything broker-visible (broker_action tasks raised via
-- src/brokerage.ts, orders via the JSP seam). These tables hold the call itself: who we spoke to,
-- how far they were verified, what was said, what happened, and the audit trail around it. Audio is
-- never stored here (Retell keeps the recording; we keep its URL).

CREATE TABLE IF NOT EXISTS ai_advisor.voice_call (
  id                  bigserial   PRIMARY KEY,
  retell_call_id      text        NOT NULL UNIQUE,
  direction           text        NOT NULL,             -- 'inbound' | 'outbound' | 'web'
  flow                text,                             -- outbound flow id, or 'inbound'
  agent_id            text,
  from_number         text,
  to_number           text,
  client_uid          bigint,                           -- waterfind_user.id once identified (candidate or verified)
  account_id          bigint,                           -- registry_user.id
  identified_by       text,                             -- 'caller_id' | 'self' | 'request' | NULL
  auth_level          int         NOT NULL DEFAULT 0,   -- 0 none | 1 account data | 2 trading
  conversation_id     bigint,                           -- ai_advisor.conversation row backing pending orders/escalations
  status              text        NOT NULL DEFAULT 'connecting', -- connecting|active|ended|failed
  outcome             text,                             -- completed|transferred|callback_requested|opted_out|voicemail|no_answer|busy|failed|abandoned
  disconnection_reason text,
  outbound_request_id bigint,
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  duration_seconds    int,
  transcript          jsonb,                            -- Retell transcript_object (role/content) as finally reported
  summary             text,                             -- short post-call summary (model) — blanked by retention
  recording_url       text,
  metadata            jsonb,
  cost_usd            numeric(10,5),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_call_client_idx ON ai_advisor.voice_call (client_uid, started_at DESC);
CREATE INDEX IF NOT EXISTS voice_call_started_idx ON ai_advisor.voice_call (started_at DESC);

CREATE TABLE IF NOT EXISTS ai_advisor.voice_call_event (
  id          bigserial   PRIMARY KEY,
  call_id     bigint      NOT NULL REFERENCES ai_advisor.voice_call(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  type        text        NOT NULL,   -- identified|otp_sent|otp_verified|otp_failed|knowledge_verified|tool_call|
                                      -- order_prepared|order_readback|order_confirmed|order_failed|escalated|transferred|
                                      -- callback_requested|consent_disclosed|opted_out|turn_error|ended
  detail      jsonb
);
CREATE INDEX IF NOT EXISTS voice_call_event_call_idx ON ai_advisor.voice_call_event (call_id, at);
-- per-client hourly cap on knowledge-factor attempts (store.countKnowledgeAttemptsForClient)
CREATE INDEX IF NOT EXISTS voice_call_event_type_at_idx ON ai_advisor.voice_call_event (type, at DESC);

CREATE TABLE IF NOT EXISTS ai_advisor.voice_otp (
  id          bigserial   PRIMARY KEY,
  call_id     bigint      NOT NULL REFERENCES ai_advisor.voice_call(id) ON DELETE CASCADE,
  client_uid  bigint      NOT NULL,
  code_hash   text        NOT NULL,   -- sha256(pepper:call id:code) (AIADVISOR_VOICE_OTP_PEPPER) — the clear code is never stored
  channel     text        NOT NULL,   -- console|webhook
  sent_to     text,                   -- masked destination for the audit trail ("…4100")
  expires_at  timestamptz NOT NULL,
  attempts    int         NOT NULL DEFAULT 0,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_otp_call_idx ON ai_advisor.voice_otp (call_id, created_at DESC);
-- per-client hourly send cap (store.countOtpSendsForClient)
CREATE INDEX IF NOT EXISTS voice_otp_client_idx ON ai_advisor.voice_otp (client_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_advisor.voice_suppression (
  phone_digits text        PRIMARY KEY,   -- normalised digits (see voice/phone.ts), e.g. 61407974100
  reason       text        NOT NULL,      -- opt_out|dnc_register|staff|manual
  source       text        NOT NULL,      -- call:<retell id> | api | staff:<uid>
  created_by   bigint,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_advisor.voice_outbound_request (
  id               bigserial   PRIMARY KEY,
  idempotency_key  text        NOT NULL UNIQUE,
  flow             text        NOT NULL,   -- trade_opportunity|order_confirmation|market_alert|broker_followup
  client_uid       bigint,
  to_number        text        NOT NULL,   -- E.164
  payload          jsonb,                  -- flow-specific brief (order id, region, message ...)
  consent_basis    text        NOT NULL DEFAULT 'existing_client_relationship',
  source           text        NOT NULL,   -- 'webhook' | 'order_event' | 'staff:<uid>' | 'test'
  source_ref       text,                   -- e.g. pending_order:123 (integrated trigger dedupe)
  status           text        NOT NULL DEFAULT 'queued', -- queued|dialing|completed|failed|suppressed|skipped|cancelled
  status_detail    text,
  scheduled_for    timestamptz NOT NULL DEFAULT now(),
  attempts         int         NOT NULL DEFAULT 0,
  retell_call_id   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_outbound_source_ref_uidx ON ai_advisor.voice_outbound_request (source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS voice_outbound_status_idx ON ai_advisor.voice_outbound_request (status, scheduled_for);
-- daily caps (store.outboundCountToday / outboundCountTodayForNumber)
CREATE INDEX IF NOT EXISTS voice_outbound_client_day_idx ON ai_advisor.voice_outbound_request (client_uid, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS voice_outbound_number_day_idx ON ai_advisor.voice_outbound_request (to_number, status, updated_at DESC);
