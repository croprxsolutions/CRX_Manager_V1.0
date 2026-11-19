-- KI-146: farm groups (customers.parent_customer_id) can no longer form a loop, and a farm group lists every
-- customer below its top parent. Contract: docs/plans/2026-11-18-ki146-farm-group-loops-CONTRACT.md.
--
-- * New trigger customers_parent_no_loop_20270127 (BEFORE INSERT OR UPDATE OF parent_customer_id, id) refuses a parent
--   that is the customer itself or any customer below it, on every path (save_customer, the table API, Bulk
--   Customer Import), for every role. It runs only when the parent (or the row's id) actually changes and takes one advisory lock
--   first, so two people re-parenting at once cannot each pass their own check and build a loop together.
-- * get_customer_farm_group: same signature, role check and grants. Its walks recurse on customer ids with UNION,
--   so a loop can never make it run forever (UNION drops repeats; no depth limit cuts a real group short), and the
--   group is the top parent plus ALL its descendants (it used to leave grandchildren out).
-- No data changes. Live 2026-11-18: 154 customers, 19 with a parent, none in a loop, no grandchildren.

CREATE TEMP TABLE ki146_farm_group_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.ki146_farm_group_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.ki146_farm_group_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regprocedure('public.guard_customer_parent_no_loop_20270127()') IS NOT NULL THEN
    RAISE EXCEPTION 'KI146_BASELINE_DRIFT: guard_customer_parent_no_loop_20270127() already exists (already applied?)';
  END IF;
  -- The body this file replaces (20261023090000).
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.get_customer_farm_group(uuid)'))
     IS DISTINCT FROM '6f944c766a46db222e245baeba9a990a' THEN
    RAISE EXCEPTION 'KI146_BASELINE_DRIFT: get_customer_farm_group(uuid) is not the 20261023090000 body';
  END IF;
END;
$preflight$;

SET LOCAL lock_timeout = '10s';

CREATE FUNCTION public.guard_customer_parent_no_loop_20270127()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_loops boolean;
BEGIN
  -- The table API may also rewrite a customer's id, which can re-point existing children; treat that as a change too.
  IF NEW.parent_customer_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.parent_customer_id IS NOT DISTINCT FROM OLD.parent_customer_id AND NEW.id = OLD.id) THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_customer_id = NEW.id THEN
    RAISE EXCEPTION 'Nothing was saved. A customer cannot be its own parent customer.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The walk below must see every parent change committed before the shared lock, which only READ COMMITTED gives
  -- (a REPEATABLE READ or SERIALIZABLE snapshot could predate a concurrent change). Every app path runs READ COMMITTED.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'Nothing was saved. Parent customer changes must run at READ COMMITTED isolation.'
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- Take the foreign-key check's lock on the new parent BEFORE the shared lock. save_customer holds its own row
  -- FOR UPDATE; taking the shared lock first could deadlock with a save that holds this parent and waits for it.
  PERFORM 1 FROM customers WHERE id = NEW.parent_customer_id FOR KEY SHARE;
  -- One parent change at a time; each statement below then sees every earlier committed change (READ COMMITTED).
  PERFORM pg_advisory_xact_lock(hashtextextended('customers.parent_customer_id', 0));

  -- Walk up from the new parent over customer ids; UNION stops on repeats, so even a loop already in the data ends.
  -- A row naming NEW.id as its parent also closes the loop: on INSERT this row is not stored yet (multi-row inserts).
  WITH RECURSIVE up(id, parent_customer_id) AS (
    SELECT c.id, c.parent_customer_id FROM customers c WHERE c.id = NEW.parent_customer_id
    UNION
    SELECT c.id, c.parent_customer_id FROM customers c JOIN up ON c.id = up.parent_customer_id
  )
  SELECT EXISTS (SELECT 1 FROM up WHERE up.id = NEW.id OR up.parent_customer_id = NEW.id) INTO v_loops;

  IF v_loops THEN
    RAISE EXCEPTION 'Nothing was saved. The chosen parent customer is already below this customer in its farm group, so it cannot be its parent. Choose a customer that is not below this one, or clear the parent.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_customer_parent_no_loop_20270127() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_customer_parent_no_loop_20270127() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER customers_parent_no_loop_20270127
  BEFORE INSERT OR UPDATE OF parent_customer_id, id ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_parent_no_loop_20270127();

CREATE OR REPLACE FUNCTION public.get_customer_farm_group(p_customer_id uuid)
 RETURNS TABLE(id uuid, farm_name text, is_parent boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();

  RETURN QUERY
    -- Walk up to the top parent. Both walks recurse on customer ids alone, so UNION drops every repeat: the walk
    -- always ends (even if a loop got in), never lists a customer twice, and no depth limit can cut a group short.
    WITH RECURSIVE up(id, parent_customer_id) AS (
      SELECT c.id, c.parent_customer_id
        FROM customers c WHERE c.id = p_customer_id
      UNION
      SELECT p.id, p.parent_customer_id
        FROM customers p JOIN up u ON p.id = u.parent_customer_id
    )
    -- No top (only possible with a loop, which the guard now refuses): the requested customer stands in as the top.
    , top_parent AS (
      SELECT COALESCE((SELECT up.id FROM up WHERE up.parent_customer_id IS NULL LIMIT 1), p_customer_id) AS id
    )
    -- The top parent and everyone below it: children, grandchildren and further.
    , down(id) AS (
      SELECT tp.id FROM top_parent tp
      UNION
      SELECT c.id
        FROM customers c JOIN down d ON c.parent_customer_id = d.id
    )
    SELECT c.id, c.farm_name,
           (c.id = tp.id) AS is_parent
    FROM customers c
    CROSS JOIN top_parent tp
    WHERE c.id IN (SELECT down.id FROM down)
    ORDER BY (c.id = tp.id) DESC, c.farm_name;
END;
$function$;

DO $postflight$
BEGIN
  IF (SELECT transaction_id FROM pg_temp.ki146_farm_group_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;

  -- The guard: definer, fixed search_path, owned by postgres, callable by no API role, wired as an enabled row trigger.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.guard_customer_parent_no_loop_20270127()')
       AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig = ARRAY['search_path=public, pg_temp'])
     OR has_function_privilege('anon', 'public.guard_customer_parent_no_loop_20270127()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_customer_parent_no_loop_20270127()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.guard_customer_parent_no_loop_20270127()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: guard_customer_parent_no_loop_20270127() shape or grants wrong';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.customers'::regclass AND t.tgname = 'customers_parent_no_loop_20270127'
       AND t.tgenabled = 'O' AND NOT t.tgisinternal
       AND t.tgfoid = to_regprocedure('public.guard_customer_parent_no_loop_20270127()')
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER customers_parent_no_loop_20270127 BEFORE INSERT OR UPDATE OF parent_customer_id, id ON public.customers FOR EACH ROW EXECUTE FUNCTION guard_customer_parent_no_loop_20270127()') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: trigger customers_parent_no_loop_20270127 missing or wrong';
  END IF;

  -- The farm-group read keeps its shape and grants: definer, stable, office staff only via authenticated.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.get_customer_farm_group(uuid)')
       AND p.prosecdef AND p.provolatile = 's' AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig = ARRAY['search_path=public, pg_temp'])
     OR has_function_privilege('anon', 'public.get_customer_farm_group(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_customer_farm_group(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: get_customer_farm_group(uuid) shape or grants wrong';
  END IF;

  -- The guard's and the reader's walks must see every customer: their owner (postgres) bypasses row security on customers.
  IF NOT (SELECT r.rolbypassrls OR (c.relowner = r.oid AND NOT c.relforcerowsecurity)
            FROM pg_class c, pg_roles r WHERE c.oid = 'public.customers'::regclass AND r.rolname = 'postgres') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: the guard owner could miss customers hidden by row security';
  END IF;

  -- No customer already sits above itself (nothing the new guard would have refused is left in the data).
  IF EXISTS (
    -- Every ancestor of every customer; UNION drops repeats, so this ends on any data, with no depth limit.
    WITH RECURSIVE up(start_id, id) AS (
      SELECT c.id, c.parent_customer_id FROM customers c WHERE c.parent_customer_id IS NOT NULL
      UNION
      SELECT up.start_id, c.parent_customer_id
        FROM up JOIN customers c ON c.id = up.id
       WHERE c.parent_customer_id IS NOT NULL
    )
    SELECT 1 FROM up WHERE up.id = up.start_id) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a customer is already its own ancestor; fix the data first';
  END IF;

  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
