-- Spend ledger: one row per billable vendor event (src/spend.ts), read by the AI Trainer's Costs
-- tab. Vendor-reported figures (Agent SDK total_cost_usd, Retell call cost) carry estimated = false;
-- OpenAI audio/TTS and Messages-API token usage are priced from list rates and carry estimated = true.
--
-- Depends on message/conversation, call_note, kb_refresh_item and voice_call: the backfill below
-- pulls the cost columns those tables already had into the ledger, once — `ref` is unique, so
-- re-running this file (db:init applies every file every time) adds nothing twice.
CREATE TABLE IF NOT EXISTS ai_advisor.spend (
  id         bigserial   PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  source     text        NOT NULL,       -- chat|assist|titler|call_note_stt|call_note_draft|dictation|tts|voice_call|voice_agent|trainer_chat|trainer_annotate|kb_refresh
  vendor     text        NOT NULL,       -- anthropic|openai|retell
  model      text,
  cost_usd   numeric(12,6),              -- NULL = quantity known, no rate for it
  estimated  boolean     NOT NULL DEFAULT false,
  quantity   numeric(14,3),
  unit       text,                       -- seconds|chars|tokens
  ref        text,                       -- unique event key, e.g. message:123 / voice_call:7
  user_id    bigint                      -- CRM waterfind_user.id when the event belongs to someone
);
CREATE UNIQUE INDEX IF NOT EXISTS spend_ref_uidx ON ai_advisor.spend (ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS spend_at_idx ON ai_advisor.spend (at DESC);
CREATE INDEX IF NOT EXISTS spend_source_at_idx ON ai_advisor.spend (source, at DESC);

-- Backfill: chat turns (message.meta.costUsd, written since the first release).
INSERT INTO ai_advisor.spend (at, source, vendor, cost_usd, estimated, ref, user_id)
SELECT m.created_at,
       CASE WHEN c.assist_client_uid IS NOT NULL THEN 'assist' ELSE 'chat' END,
       'anthropic', (m.meta->>'costUsd')::numeric, false, 'message:' || m.id, c.user_id
  FROM ai_advisor.message m JOIN ai_advisor.conversation c ON c.id = m.conversation_id
 WHERE m.role = 'assistant' AND (m.meta->>'costUsd') ~ '^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$'
ON CONFLICT (ref) WHERE ref IS NOT NULL DO NOTHING;

-- Backfill: call-note drafting (vendor-reported) and its transcription (estimated from the audio
-- length at the diarizing model's list rate — the billed seconds were not recorded historically).
INSERT INTO ai_advisor.spend (at, source, vendor, model, cost_usd, estimated, ref, user_id)
SELECT coalesce(ready_at, updated_at), 'call_note_draft', 'anthropic', models->>'note', cost_usd, false, 'call_note:' || id || ':draft', staff_user_id
  FROM ai_advisor.call_note WHERE cost_usd IS NOT NULL
ON CONFLICT (ref) WHERE ref IS NOT NULL DO NOTHING;
INSERT INTO ai_advisor.spend (at, source, vendor, model, cost_usd, estimated, quantity, unit, ref, user_id)
SELECT coalesce(ready_at, updated_at), 'call_note_stt', 'openai', coalesce(models->'stt'->>0, 'gpt-4o-transcribe-diarize'),
       round((audio_seconds / 60.0) * CASE coalesce(models->'stt'->>0, 'gpt-4o-transcribe-diarize') WHEN 'gpt-4o-mini-transcribe' THEN 0.003 ELSE 0.006 END, 6),
       true, audio_seconds, 'seconds', 'call_note:' || id || ':stt:' || coalesce(models->'stt'->>0, 'gpt-4o-transcribe-diarize'), staff_user_id
  FROM ai_advisor.call_note WHERE audio_seconds IS NOT NULL AND audio_seconds > 0 AND ready_at IS NOT NULL
ON CONFLICT (ref) WHERE ref IS NOT NULL DO NOTHING;

-- Backfill: knowledge auto-refresh, one row per agent verification.
INSERT INTO ai_advisor.spend (at, source, vendor, cost_usd, estimated, ref)
SELECT at, 'kb_refresh', 'anthropic', cost_usd, false, 'kb_refresh_item:' || id
  FROM ai_advisor.kb_refresh_item WHERE cost_usd IS NOT NULL
ON CONFLICT (ref) WHERE ref IS NOT NULL DO NOTHING;

-- Backfill: phone calls (Retell's combined cost: platform + telephony; the model side is separate).
INSERT INTO ai_advisor.spend (at, source, vendor, cost_usd, estimated, quantity, unit, ref, user_id)
SELECT coalesce(ended_at, started_at), 'voice_call', 'retell', cost_usd, false, duration_seconds, 'seconds', 'voice_call:' || id, client_uid
  FROM ai_advisor.voice_call WHERE cost_usd IS NOT NULL
ON CONFLICT (ref) WHERE ref IS NOT NULL DO NOTHING;
