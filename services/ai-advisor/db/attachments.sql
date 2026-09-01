-- AI Advisor — user-uploaded attachments (images / PDFs / text files fed to the model).
-- Same isolated ai_advisor schema; bytes live in PG (bytea) so there is no separate file store.
-- user_id is the CRM waterfind_user.id from the verified token; conversation/message bind on send.

CREATE TABLE IF NOT EXISTS ai_advisor.attachment (
  id              bigserial   PRIMARY KEY,
  user_id         bigint      NOT NULL,
  conversation_id bigint      REFERENCES ai_advisor.conversation(id) ON DELETE CASCADE,
  message_id      bigint      REFERENCES ai_advisor.message(id) ON DELETE CASCADE,
  filename        text        NOT NULL,
  mime            text        NOT NULL,
  kind            text        NOT NULL CHECK (kind IN ('image','pdf','text')),
  size_bytes      integer     NOT NULL,
  sha256          text        NOT NULL,
  data            bytea       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachment_user_idx    ON ai_advisor.attachment (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS attachment_message_idx ON ai_advisor.attachment (message_id);
