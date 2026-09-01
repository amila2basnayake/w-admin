-- Waterfind AI Advisor — user feedback on the tool and on individual replies (beta programme).
-- 'inaccuracy' rows point at the exact assistant message being disputed (message_id), so the team
-- can join back to ai_advisor.message and read the reply in its full conversation context.
-- 'general' rows are free-text product feedback from the header button. Read via SQL for now
-- (no broker-facing surface); nothing here is broker- or client-visible.

CREATE TABLE IF NOT EXISTS ai_advisor.feedback (
  id              bigserial   PRIMARY KEY,
  user_id         bigint      NOT NULL,   -- CRM waterfind_user.id (from the verified token)
  conversation_id bigint      REFERENCES ai_advisor.conversation(id) ON DELETE SET NULL,
  message_id      bigint      REFERENCES ai_advisor.message(id) ON DELETE SET NULL,
  kind            text        NOT NULL CHECK (kind IN ('inaccuracy', 'general')),
  body            text,                   -- the user's free-text comment (may be null for a bare flag)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_created_idx ON ai_advisor.feedback (created_at DESC);
