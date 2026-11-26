-- Watchdog flags and dismissals must be written by the existing office RPCs.
-- Keep all existing rows, read policies, and system-role grants.
BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER
  ON TABLE public.watchdog_flags, public.watchdog_flag_dismissals
  FROM PUBLIC, anon, authenticated;

DO $postflight$
DECLARE
  api_role name;
  relation regclass;
BEGIN
  FOR api_role IN SELECT unnest(ARRAY['anon', 'authenticated']::name[]) LOOP
    FOR relation IN SELECT unnest(ARRAY['public.watchdog_flags', 'public.watchdog_flag_dismissals']::regclass[]) LOOP
      IF has_table_privilege(api_role, relation, 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER')
        OR has_any_column_privilege(api_role, relation, 'INSERT, UPDATE') THEN
        RAISE EXCEPTION 'WATCHDOG_DIRECT_WRITE_GRANT: % on %', api_role, relation;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT has_function_privilege('authenticated', 'public.get_watchdog_flags(uuid,uuid,text,boolean)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.refresh_watchdog_flags(uuid,numeric,numeric)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.dismiss_watchdog_flag(uuid,text,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'WATCHDOG_RPC_GRANT_MISSING';
  END IF;
END
$postflight$;

COMMIT;
