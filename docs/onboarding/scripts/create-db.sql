-- Waterfind AUS CRM — create the application DB role + (empty) database.
-- Run as the postgres superuser, e.g. (PowerShell/cmd, with PGPASSWORD from .env):
--    & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -f create-db.sql
--
-- The docs use role "waterfind" as the DB owner and a date-stamped DB name
-- (e.g. waterfind-20171116). Adjust the CREATE DATABASE name to match the
-- wf1win dump you receive, then restore with:
--    pg_restore -U postgres -d "waterfind-<date>" -v wf1win
-- (restoring as the postgres superuser is safest for an old 8.2-era dump).

-- 1) Application owner role. Password here is a LOCAL DEV value (see .env WF_DB_PASSWORD).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waterfind') THEN
    CREATE ROLE waterfind WITH LOGIN PASSWORD 'waterfind' CREATEDB;
  END IF;
END
$$;

-- 2) Empty database owned by waterfind. Rename to the dump's date stamp before restoring.
--    (CREATE DATABASE cannot run inside the DO block above.)
-- Example:
--    CREATE DATABASE "waterfind-YYYYMMDD" WITH OWNER = waterfind ENCODING = 'UTF8';
