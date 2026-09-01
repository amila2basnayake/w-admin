-- Projects: user-defined folders that group conversations (ChatGPT-style), with optional
-- per-project instructions applied to every chat inside the project. Same isolation posture as
-- schema.sql: keyed by the CRM waterfind_user.id, never references public.*.

CREATE TABLE IF NOT EXISTS ai_advisor.project (
  id           bigserial   PRIMARY KEY,
  user_id      bigint      NOT NULL,               -- CRM waterfind_user.id (from the verified token)
  name         text        NOT NULL,
  instructions text,                               -- optional, injected into every chat in the project
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_user_updated_idx
  ON ai_advisor.project (user_id, updated_at DESC);

-- Deleting a project keeps its chats — they fall back to ungrouped.
ALTER TABLE ai_advisor.conversation
  ADD COLUMN IF NOT EXISTS project_id bigint REFERENCES ai_advisor.project(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS conversation_project_idx
  ON ai_advisor.conversation (project_id);
