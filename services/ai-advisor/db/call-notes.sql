-- Call notes: a transcript + AI-drafted file note per phone call, drafted when the call ends and
-- filled into the CRM's own Add Comment popup when the broker opens it (the popup asks the
-- sidecar). The CRM stays the system of record for the saved comment (public.contact) — the
-- sidecar never writes there; this table holds the working product and the audit trail around it.
--
-- Audio is NEVER stored here (fetched from the PBX, transcribed, dropped). The transcript is
-- kept (AIADVISOR_CALL_NOTE_RETENTION_DAYS, default 0 = indefinitely; see call-notes/config.ts).
CREATE TABLE IF NOT EXISTS ai_advisor.call_note (
  id               bigserial   PRIMARY KEY,
  -- The PBX call id (public.contact.phonecall_id) for PBX-sourced notes; NULL for dictation/upload.
  phonecall_id     text,
  source           text        NOT NULL,            -- 'pbx' | 'dictation' | 'upload'
  contact_id       bigint,                          -- public.contact.id of the auto-logged call row
  client_uid       bigint      NOT NULL,            -- waterfind_user.id (the token's act claim)
  registry_user_id bigint,                          -- the client's account (contact.registry_user)
  staff_user_id    bigint      NOT NULL,            -- who requested the note
  staff_name       text,
  status           text        NOT NULL,            -- queued|fetching|transcribing|drafting|ready|failed
  stage_detail     text,                            -- e.g. "chunk 2/5"
  error            text,
  error_code       text,
  audio_seconds    int,
  audio_bytes      int,
  audio_channels   int,
  direction        text,                            -- 'incoming' | 'outgoing' | NULL
  call_started_at  timestamptz,
  transcript       jsonb,                           -- {segments:[{speaker,start,end,text}], text, diarized, models, warnings}
  summary          jsonb,                           -- CallNoteDraft (see summarize.ts)
  models           jsonb,                           -- {stt:[...], note:'...'}
  cost_usd         numeric(10,5),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  ready_at         timestamptz,
  -- Legacy names (first cut): kept for existing rows; the live columns are handed_off_* below.
  applied_at       timestamptz,
  applied_by       bigint,
  applied_note     text
);
-- Set when the draft was filled into the CRM's Add Comment popup (audit: draft -> comment box,
-- first time only). It is a HAND-OFF, not proof the comment was saved — the CRM never reports back.
ALTER TABLE ai_advisor.call_note ADD COLUMN IF NOT EXISTS handed_off_at   timestamptz;
ALTER TABLE ai_advisor.call_note ADD COLUMN IF NOT EXISTS handed_off_by   bigint;
ALTER TABLE ai_advisor.call_note ADD COLUMN IF NOT EXISTS handed_off_note text;   -- the text as handed over (post-edit in the rail)
UPDATE ai_advisor.call_note SET handed_off_at = applied_at, handed_off_by = applied_by, handed_off_note = applied_note
 WHERE handed_off_at IS NULL AND applied_at IS NOT NULL;
-- "Ask advisor" pastes the transcript into an assist chat as a user message. Remembered here so the
-- retention sweep can blank THAT message too when it blanks the transcript.
ALTER TABLE ai_advisor.call_note ADD COLUMN IF NOT EXISTS ask_conversation_id bigint;
ALTER TABLE ai_advisor.call_note ADD COLUMN IF NOT EXISTS ask_message_id      bigint;
ALTER TABLE ai_advisor.call_note ADD COLUMN IF NOT EXISTS ask_scrubbed_at     timestamptz;
-- Pre-drafting worker (call-notes/auto.ts): rows it created when the call ended, as opposed to
-- rows the popup created on demand.
ALTER TABLE ai_advisor.call_note ADD COLUMN IF NOT EXISTS auto           boolean NOT NULL DEFAULT false;
-- Re-draft attempts on a failed row (transient PBX/STT/model failures retry with backoff up to a
-- cap, by the worker or when the popup asks again; permanently-failed codes never retry).
ALTER TABLE ai_advisor.call_note ADD COLUMN IF NOT EXISTS draft_attempts int NOT NULL DEFAULT 0;
-- A short-lived build filed notes into the CRM itself; those columns are gone (nothing was shipped).
DROP INDEX IF EXISTS ai_advisor.call_note_unfiled_idx;
ALTER TABLE ai_advisor.call_note DROP COLUMN IF EXISTS filed_at, DROP COLUMN IF EXISTS filed_note,
                                 DROP COLUMN IF EXISTS filed_error, DROP COLUMN IF EXISTS filed_attempts;
-- One note per PBX call, whoever asked first (the second requester gets the same row).
CREATE UNIQUE INDEX IF NOT EXISTS call_note_phonecall_uidx ON ai_advisor.call_note (phonecall_id) WHERE phonecall_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS call_note_client_idx ON ai_advisor.call_note (client_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS call_note_staff_idx  ON ai_advisor.call_note (staff_user_id, created_at DESC);

-- Every staff read of a call transcript — same posture as assist_transcript_access for client chat
-- reads: a recorded call is personal data on a regulated, audited broker, so access is logged
-- rather than assumed. (No surface reads transcripts today; the table stays for when one does.)
CREATE TABLE IF NOT EXISTS ai_advisor.call_note_access (
  id             bigserial   PRIMARY KEY,
  call_note_id   bigint      NOT NULL,
  staff_user_id  bigint      NOT NULL,   -- who read it (verified staff token)
  client_uid     bigint      NOT NULL,   -- the token's act claim
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_note_access_at_idx   ON ai_advisor.call_note_access (at DESC);
CREATE INDEX IF NOT EXISTS call_note_access_note_idx ON ai_advisor.call_note_access (call_note_id);
