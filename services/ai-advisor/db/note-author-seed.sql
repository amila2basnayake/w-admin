-- Waterfind AI Advisor — provisioning: the dedicated "AI Advisor" CRM user that authors the
-- Contact Note written back after a brokerage action (order placed / withdrawn) via the
-- ai-broker-exec.jsp seam (see crm-seam/README.md and docs/design/ai-brokerage.md).
--
-- Why a dedicated user: the note's `added_by` must be a real `waterfind_user` — it is rendered as
-- the "User Name" column on the admin client's Contact Notes table. The seam reads THIS user's id
-- from the SERVER-SIDE property `wf.ai.note-author-id` in
-- ${user.home}/.waterfind-ai-advisor.properties — never from the signed request body — so the
-- sidecar (and the model) can never choose who a note is attributed to.
--
-- The user is a WaterfindUser (discriminator subclass 'W', the internal/staff user type). It has
-- no registry account of its own: it only ever appears as the author of AI Advisor notes.
--
-- Run once against the CRM database (public schema):
--   psql -h localhost -U waterfind -d waterfind-db -f db/note-author-seed.sql
-- Then copy the printed id into ${user.home}/.waterfind-ai-advisor.properties:
--   wf.ai.note-author-id=<printed id>
-- and restart is NOT required (the JSP re-reads the properties file lazily on next class load).
--
-- Idempotent: re-running does not create a second user; it just reprints the existing id.
-- `id` is the only NOT NULL column without a DB default; it comes from the shared hibernate_sequence
-- (the same generator Hibernate's `native` id strategy uses for this table). crm_locked / new_market
-- take their false DB defaults.

INSERT INTO public.waterfind_user
        (id, subclass, name, first_name, last_name, username, banned, date_approved, dateplaced)
SELECT nextval('hibernate_sequence'), 'W', 'AI Advisor', 'AI', 'Advisor', 'ai-advisor-system',
       false, now(), now()
WHERE NOT EXISTS (
        SELECT 1 FROM public.waterfind_user WHERE username = 'ai-advisor-system');

-- The id to configure as wf.ai.note-author-id:
SELECT id AS wf_ai_note_author_id, name, username, subclass
  FROM public.waterfind_user
 WHERE username = 'ai-advisor-system';
