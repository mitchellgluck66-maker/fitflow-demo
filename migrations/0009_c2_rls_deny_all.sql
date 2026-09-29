-- C2 (2026-09-29 audit): close the database side door.
--
-- Supabase publishes every `public` table through PostgREST, reachable with
-- the project's publishable "anon" key. With RLS disabled, that key could
-- read everything — client PII, payments and the settings table. Enabling
-- ROW LEVEL SECURITY with NO policies denies every row to the anon /
-- authenticated API roles.
--
-- The app is unaffected: it connects as the table OWNER (the `postgres` role
-- that ran these migrations), and owners bypass RLS unless FORCE is set —
-- which it deliberately is not. tests/rls.test.ts proves both halves and
-- fails if any public table is ever created without RLS.
--
-- Every future migration that creates a table must also enable RLS on it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
