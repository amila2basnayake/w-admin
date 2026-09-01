-- Broker-assist surface: advisor conversations a STAFF member holds ABOUT a client, from the CRM
-- client page. Same conversation/message tables as the client-facing chat, discriminated by
-- assist_client_uid:
--   NULL      -> the client's own advisor chat (user_id = the client)
--   NOT NULL  -> a broker-assist chat; user_id = the STAFF member who started it, assist_client_uid
--                = the client under discussion. Client-facing queries exclude these rows, so a
--                broker's working notes about a client are never visible in that client's own chat
--                history (and vice versa). Assist history is shared across staff per client — like
--                notes on the client's file — so the chokepoint is (id, assist_client_uid), not
--                (id, user_id).
ALTER TABLE ai_advisor.conversation ADD COLUMN IF NOT EXISTS assist_client_uid bigint;
-- Attribution for the shared listing ("Chris — yesterday"): the creator's display name as minted
-- into the staff token, denormalised here so listing needs no CRM join.
ALTER TABLE ai_advisor.conversation ADD COLUMN IF NOT EXISTS assist_staff_name text;

CREATE INDEX IF NOT EXISTS conversation_assist_client_idx
  ON ai_advisor.conversation (assist_client_uid, updated_at DESC)
  WHERE assist_client_uid IS NOT NULL;

-- Every staff read of a client's OWN advisor transcript (the read-only browse on the client page).
-- Client chats carry holdings, prices and personal circumstances; this is a regulated,
-- independently-audited broker, so staff access is logged rather than assumed — same posture as
-- kb_access_log (AI Trainer) for disputed replies.
CREATE TABLE IF NOT EXISTS ai_advisor.assist_transcript_access (
  id              bigserial   PRIMARY KEY,
  staff_user_id   bigint      NOT NULL,   -- who read it (verified staff token)
  client_uid      bigint      NOT NULL,   -- whose chat it is (the token's act claim)
  conversation_id bigint      NOT NULL,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assist_transcript_access_at_idx ON ai_advisor.assist_transcript_access (at DESC);
