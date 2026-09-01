-- "AI Trainer" CRM role — the grant behind the AI Trainer Home screen and the Knowledge Curator.
--
-- Run ONCE against the CRM database (public schema), as the CRM's own DB owner:
--   psql -h localhost -U waterfind -d waterfind-db -f services/ai-advisor/db/ai-trainer-role.sql
--
-- This is a row in the CRM's own role catalogue (public.user_role), exactly like SALES_MANAGER or
-- MARKETING_TEAM — nothing sidecar-specific. It follows the CRM migration idiom
-- (sql/schema/REV44-HOTFIX18/SchemaUpdate.sql: MAX(id)+1, created by the Administrator account 10),
-- and it is idempotent: re-running it changes nothing.
--
-- The role can equally be created from the CRM UI by a superuser: Admin Home -> Waterfind Admin ->
-- Manage User Roles -> add, Name "AI Trainer" (the Role ID auto-derives to AI_TRAINER). Either way,
-- WHO holds it is then administered in the CRM: the "Roles" button on a staff user's record
-- (/admin-view-registry-user-details.html), superuser / ASSIGN_ROLES only.
--
-- Where it is read:
--   CRM   manager-homepage-links.jsp / ai-trainer-home.jsp -> WaterfindDelegate.hasAccess("AI_TRAINER", uid)
--   sidecar  services/ai-advisor/src/curator/auth.ts       -> user_role_map JOIN user_role, fresh per request

INSERT INTO user_role (id, waterfind_user, role_id, role_name, visible)
SELECT (SELECT MAX(id) + 1 FROM user_role), 10, 'AI_TRAINER', 'AI Trainer', true
 WHERE NOT EXISTS (SELECT 1 FROM user_role WHERE role_id = 'AI_TRAINER');

-- Optional: grant it to one account straight away (uncomment and set the user id). Assignments
-- are otherwise made in the CRM UI. Idempotent.
-- INSERT INTO user_role_map (id, waterfind_user, user_role)
-- SELECT nextval('hibernate_sequence'), <waterfind_user.id>, r.id
--   FROM user_role r
--  WHERE r.role_id = 'AI_TRAINER'
--    AND NOT EXISTS (SELECT 1 FROM user_role_map m WHERE m.waterfind_user = <waterfind_user.id> AND m.user_role = r.id);

SELECT id, role_id, role_name, visible FROM user_role WHERE role_id = 'AI_TRAINER';
