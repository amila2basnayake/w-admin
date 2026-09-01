-- AI Trainer — staff maintenance of the AI Water Advisor's knowledge base.
--
-- Isolation posture matches schema.sql: keyed by CRM waterfind_user.id, never references public.*.
--
-- Access: a WATERFIND STAFF ACCOUNT (waterfind_user_type.type_number in (1,2,3)) THAT HOLDS THE
-- "AI TRAINER" CRM ROLE (public.user_role.role_id = 'AI_TRAINER' via user_role_map — see
-- ai-trainer-role.sql), both read fresh from the database per request, fail-closed
-- (trainer/auth.ts). The CRM's own role administration is the roster.
--
-- Model: the trainer (a person, or the trainer AI acting for that person) changes the knowledge
-- base DIRECTLY. Safety comes from the ledger below, not from a review queue: every change records
-- the complete before and after text of the file it touched, so any single change can be undone
-- and the whole knowledge base can be put back to how it was at any earlier moment.

-- One row per file change. before_content/after_content are COMPLETE file bodies (NULL = the file
-- did not exist / no longer exists). Restore-to-a-point is derived from these rows alone: for every
-- path touched after point P, the earliest event after P holds the content as it was at P.
CREATE TABLE IF NOT EXISTS ai_advisor.kb_event (
  id                bigserial   PRIMARY KEY,
  at                timestamptz NOT NULL DEFAULT now(),
  actor_user_id     bigint      NOT NULL,
  -- how the change was made: 'chat' (the trainer AI on the person's instruction), 'manual' (a form
  -- in the Trainer page), 'ingest' (an upload turned into a document), 'undo', 'restore',
  -- 'external' (found on disk at startup: a deploy / git pull / edit outside the Trainer — recorded
  -- by the startup reconcile with actor_user_id 0 so restore-to-point sees it), 'refresh' (the
  -- scheduled best-by auto-refresh re-verified or updated the item — actor_user_id 0, undoable
  -- like any other change)
  via               text        NOT NULL CHECK (via IN ('chat', 'manual', 'ingest', 'undo', 'restore', 'external', 'refresh')),
  -- groups the file writes of one restore (or any multi-file operation) so they read and undo as one
  batch_id          bigint,
  kind              text        NOT NULL CHECK (kind IN ('doc', 'note')),
  path              text        NOT NULL,          -- service-relative, e.g. knowledge/regulatory/nsw/x.md
  doc_id            text        NOT NULL,          -- the frontmatter id at the time (stable label for the UI)
  -- 'snapshot' = a baseline row written by the first reconcile for a file that predates the ledger:
  -- before_content = after_content, so undo and restore-to-point treat it as "nothing to change"
  op                text        NOT NULL CHECK (op IN ('create', 'update', 'delete', 'snapshot')),
  before_content    text,
  after_content     text,
  summary           text        NOT NULL,          -- one human sentence: what changed and why
  undoes_event_id   bigint      REFERENCES ai_advisor.kb_event(id) ON DELETE SET NULL,
  restore_target    text,                          -- for via='restore': "checkpoint 'x'" / "event #N" / an ISO time
  source_upload_id  bigint,                        -- when the content came from an upload
  git_commit        text                           -- short sha when the publish was also committed
);
CREATE INDEX IF NOT EXISTS kb_event_path_idx  ON ai_advisor.kb_event (path, id DESC);
CREATE INDEX IF NOT EXISTS kb_event_batch_idx ON ai_advisor.kb_event (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS kb_event_at_idx    ON ai_advisor.kb_event (at DESC);

-- Widen the CHECKs on a table created before 'external' / 'snapshot' existed. Drop-then-add is the
-- idempotent form (ADD CONSTRAINT has no IF NOT EXISTS); the names are Postgres's defaults for the
-- inline column checks above.
ALTER TABLE ai_advisor.kb_event DROP CONSTRAINT IF EXISTS kb_event_via_check;
ALTER TABLE ai_advisor.kb_event ADD CONSTRAINT kb_event_via_check
  CHECK (via IN ('chat', 'manual', 'ingest', 'undo', 'restore', 'external', 'refresh'));
ALTER TABLE ai_advisor.kb_event DROP CONSTRAINT IF EXISTS kb_event_op_check;
ALTER TABLE ai_advisor.kb_event ADD CONSTRAINT kb_event_op_check
  CHECK (op IN ('create', 'update', 'delete', 'snapshot'));

CREATE SEQUENCE IF NOT EXISTS ai_advisor.kb_batch_seq;

-- One row per startup reconcile (store.ts reconcileExternal): the ledger is compared with the files
-- on disk and any drift is written to kb_event as via='external'. The first run ever (no rows here)
-- writes 'snapshot' baselines for files that predate the ledger; later runs treat an unledgered
-- file as an external create.
CREATE TABLE IF NOT EXISTS ai_advisor.kb_reconcile (
  id          bigserial   PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  files       int         NOT NULL,               -- files on disk under the managed collections
  events      int         NOT NULL,               -- kb_event rows this run wrote
  batch_id    bigint                              -- the batch those rows share (NULL when none)
);

-- A named point in the ledger. "Restore to checkpoint" = restore to the state after last_event_id.
CREATE TABLE IF NOT EXISTS ai_advisor.kb_checkpoint (
  id             bigserial   PRIMARY KEY,
  label          text        NOT NULL,
  last_event_id  bigint      NOT NULL DEFAULT 0,   -- 0 = before any recorded change
  created_by     bigint      NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Source files supplied by Waterfind, archived verbatim (never edited) as the provenance for the
-- knowledge written from them. `text` is the extracted plain text (PDF/DOCX/text); NULL when the
-- file yielded none (a scanned PDF, an image), in which case ingestion shows the model the file.
CREATE TABLE IF NOT EXISTS ai_advisor.kb_upload (
  id           bigserial   PRIMARY KEY,
  sha256       text        NOT NULL UNIQUE,
  filename     text        NOT NULL,
  mime         text,
  bytes        bigint      NOT NULL,
  path         text        NOT NULL,               -- knowledge/uploads/<sha>/<filename>
  text         text,
  text_status  text        NOT NULL DEFAULT 'pending'
                 CHECK (text_status IN ('pending', 'ok', 'empty', 'failed', 'unsupported')),
  text_note    text,                               -- extractor detail (page count, error)
  doc_id       text,                               -- the library document written from it, once ingested
  dismissed    boolean     NOT NULL DEFAULT false, -- hidden from the list without losing provenance
  uploaded_by  bigint      NOT NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

-- Resolution state for advisor users' inaccuracy reports (feedback.kind = 'inaccuracy'). One row
-- per report, upserted; the report itself is never edited.
CREATE TABLE IF NOT EXISTS ai_advisor.kb_report_status (
  feedback_id    bigint      PRIMARY KEY,
  status         text        NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
  note           text,
  actor_user_id  bigint      NOT NULL,
  by_agent       boolean     NOT NULL DEFAULT false,
  at             timestamptz NOT NULL DEFAULT now()
);

-- Every read of a client conversation from the Trainer surface (the trainer AI's conversation
-- lookup, and the Reports view). Client chats carry holdings, prices and personal circumstances;
-- this is a regulated, independently audited broker, so staff access is logged rather than assumed.
CREATE TABLE IF NOT EXISTS ai_advisor.kb_access_log (
  id               bigserial   PRIMARY KEY,
  reader_user_id   bigint      NOT NULL,
  conversation_id  bigint      NOT NULL,
  message_id       bigint,
  purpose          text,                           -- 'chat-tool' | 'report-view' | free text
  by_agent         boolean     NOT NULL DEFAULT false,
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_access_log_at_idx ON ai_advisor.kb_access_log (at DESC);

-- The pre-redesign curator tables (curator_change, curator_upload, curator_triage,
-- curator_access_log) are no longer read or written. They are left in place so a local database
-- keeps its history; drop them by hand when that history is no longer wanted.
