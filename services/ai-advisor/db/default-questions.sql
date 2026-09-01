-- Default questions offered on an EMPTY new chat, edited in the AI Trainer's "Questions" tab.
-- Two audiences: 'broker' (the Client Rail on the CRM client page) and 'client' (the client's own
-- AI Advisor tab). One row per audience; NO ROW = the built-in lists in src/default-questions.ts,
-- so shipping new built-ins keeps working until an admin saves a list for that audience.
CREATE TABLE IF NOT EXISTS ai_advisor.default_questions (
  audience    text        PRIMARY KEY CHECK (audience IN ('broker', 'client')),
  questions   jsonb       NOT NULL,               -- JSON array of strings, in display order
  version     int         NOT NULL DEFAULT 1,     -- bumped on every save; stale-edit guard (409)
  updated_by  bigint      NOT NULL,               -- CRM waterfind_user.id of the admin who saved
  updated_at  timestamptz NOT NULL DEFAULT now()
);
