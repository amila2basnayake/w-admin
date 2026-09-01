-- Waterfind AI Advisor — own schema in the existing PG 9.6 `waterfind-db`.
-- Isolated from `public`; own sequences; keyed by the CRM waterfind_user.id (a plain bigint,
-- NOT a FK to the regulated tables). Never references public.* — no coupling, no tenant leak.

CREATE SCHEMA IF NOT EXISTS ai_advisor;

CREATE TABLE IF NOT EXISTS ai_advisor.conversation (
  id             bigserial   PRIMARY KEY,
  user_id        bigint      NOT NULL,                 -- CRM waterfind_user.id (from the verified token)
  title          text        NOT NULL DEFAULT 'New chat',
  sdk_session_id text,                                 -- Claude Agent SDK session id for straight-line resume
  archived       boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_user_updated_idx
  ON ai_advisor.conversation (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_advisor.message (
  id              bigserial   PRIMARY KEY,
  conversation_id bigint      NOT NULL REFERENCES ai_advisor.conversation(id) ON DELETE CASCADE,
  role            text        NOT NULL CHECK (role IN ('user','assistant','system')),
  content         text        NOT NULL,
  parent_id       bigint,                              -- previous message on this branch (edit/regenerate)
  active          boolean     NOT NULL DEFAULT true,   -- false = superseded by an edit/regenerate branch
  meta            jsonb,                               -- {toolUses, model, usage, error}
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_conversation_idx
  ON ai_advisor.message (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS ai_advisor.user_settings (
  user_id             bigint PRIMARY KEY,               -- CRM waterfind_user.id
  theme               text   NOT NULL DEFAULT 'light',
  custom_instructions text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Optional least-privilege role (run as a superuser once). The service can also connect as
-- `waterfind` scoped to this schema if role creation is unavailable in dev.
-- DO $$ BEGIN
--   IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_advisor_svc') THEN
--     CREATE ROLE ai_advisor_svc LOGIN PASSWORD 'change-me';
--   END IF;
-- END $$;
-- GRANT USAGE ON SCHEMA ai_advisor TO ai_advisor_svc;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai_advisor TO ai_advisor_svc;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ai_advisor TO ai_advisor_svc;
