-- Knowledge auto-refresh — the scheduled worker that re-verifies documents and notes whose
-- best_by date has passed (src/trainer/refresh/). The FILES are the schedule: dueness is computed
-- from each item's best_by (or as_at + TTL) frontmatter, so a sidecar that was down for a month
-- refreshes everything due the moment it is back — these tables only record what happened and
-- throttle retries, they never drive when something fires.

-- One row per sweep that actually processed at least one item (a tick with nothing due writes
-- nothing). email_* records the digest sent to AI Trainer role holders — or what WOULD have been
-- sent when no SMTP is configured (email_status 'console').
CREATE TABLE IF NOT EXISTS ai_advisor.kb_refresh_run (
  id            bigserial   PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  due           int         NOT NULL DEFAULT 0,   -- items due when the sweep started
  processed     int         NOT NULL DEFAULT 0,   -- items the sweep ran the agent on
  confirmed     int         NOT NULL DEFAULT 0,
  updated       int         NOT NULL DEFAULT 0,
  flagged       int         NOT NULL DEFAULT 0,
  errors        int         NOT NULL DEFAULT 0,
  cost_usd      numeric(10,4),
  email_status  text        NOT NULL DEFAULT 'none'
                  CHECK (email_status IN ('none', 'sent', 'console', 'failed')),
  email_to      text,                             -- comma-separated recipients (or the override)
  email_subject text,
  email_body    text,
  detail        text                              -- e.g. why the email failed
);

-- One row per item ATTEMPT (not per item): the latest row per path is what retry backoff reads —
-- an 'error' item is not retried for a few hours, a 'flagged' one for a few days, so a permanently
-- broken source cannot re-run the agent at full rate forever (the same lesson as the external-data
-- refresher: throttle on attempts, never on the data's own dates).
CREATE TABLE IF NOT EXISTS ai_advisor.kb_refresh_item (
  id            bigserial   PRIMARY KEY,
  run_id        bigint      NOT NULL REFERENCES ai_advisor.kb_refresh_run(id) ON DELETE CASCADE,
  at            timestamptz NOT NULL DEFAULT now(),
  path          text        NOT NULL,             -- service-relative, same form as kb_event.path
  doc_id        text        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('doc', 'note')),
  outcome       text        NOT NULL CHECK (outcome IN ('confirmed', 'updated', 'flagged', 'error')),
  detail        text,                             -- the agent's one-sentence explanation / the error
  sources       text,                             -- comma-separated URLs the agent checked
  event_id      bigint,                           -- the kb_event written (confirmed/updated only)
  next_best_by  text,                             -- the best_by stamped on the file (YYYY-MM-DD)
  cost_usd      numeric(10,4)
);
CREATE INDEX IF NOT EXISTS kb_refresh_item_path_idx ON ai_advisor.kb_refresh_item (path, at DESC);
CREATE INDEX IF NOT EXISTS kb_refresh_item_run_idx  ON ai_advisor.kb_refresh_item (run_id);

-- The refresh agent may also remove a due item whose whole subject is repealed/withdrawn, and add
-- new documents that arise from a re-verification (a superseding instrument). Both are ledgered
-- via='refresh' and undoable like any refresh change. Widen the item CHECK and add run counters.
ALTER TABLE ai_advisor.kb_refresh_item DROP CONSTRAINT IF EXISTS kb_refresh_item_outcome_check;
ALTER TABLE ai_advisor.kb_refresh_item ADD CONSTRAINT kb_refresh_item_outcome_check
  CHECK (outcome IN ('confirmed', 'updated', 'flagged', 'error', 'deleted', 'created'));
ALTER TABLE ai_advisor.kb_refresh_run ADD COLUMN IF NOT EXISTS deleted int NOT NULL DEFAULT 0;
ALTER TABLE ai_advisor.kb_refresh_run ADD COLUMN IF NOT EXISTS created int NOT NULL DEFAULT 0;
