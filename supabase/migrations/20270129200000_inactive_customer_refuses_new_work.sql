-- Written 2026-11-19. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270129200000_inactive_customer_refuses_new_work.md.
--
-- WHAT (#2000; Mason, 2026-11-19: an inactive customer must be made active again before any new
--   work is done for them): a row of orders, deliveries, inventory_holds or jobs may not become open
--   work for an inactive customer. Refused: any INSERT for an inactive customer, and any UPDATE that
--   leaves the row open when it was not open before (reopen, undelete, hold switched back on or its
--   expiry pushed out), or that moves any row (open or closed) onto an inactive customer. "Open" is KI-148's meaning
--   (20270128140000). A delivery is checked against its own customer and its order's customer.
--   Closing, cancelling, deleting, releasing and editing an already-open row stay allowed, so an
--   inactive customer's existing work can still be finished down or cleaned up. Holds: a job hold
--   whose job belongs to the same customer follows that job (so starting an existing job can still
--   rebuild its holds); every other hold is checked, whatever its type or source. A quote or booking
--   hold for an inactive customer is therefore refused (live 2026-11-19: no inactive customer has a
--   quote or a hold; named for Taha in the PR). Refusal:
--   CUSTOMER_INACTIVE_NEW_WORK, a fixed sentence that names no customer (the caller may not be allowed
--   to read the order's customer). Every role and path (RPCs, direct writes, server roles).
--   Guarantee holds for READ COMMITTED transactions (every app path); a REPEATABLE READ deactivation
--   would count from its own older snapshot.
--   NOT HERE (Taha's quote, invoice and booking work, until 2026-12-15): quotes, invoices, bookings.
--
-- HOW: one trigger function, SECURITY DEFINER (owner postgres) so row-level security cannot hide the
--   customer's flag, EXECUTE revoked from everyone, and four AFTER INSERT OR UPDATE row triggers.
--   AFTER, so every BEFORE trigger and the row-level security check run first: a caller who may not
--   write the row gets the normal permission error and learns nothing about the customer's status.
--   LOCKING (closes KI-148's accepted gap): the guard locks the customer row FOR SHARE before reading
--   is_active. That conflicts with the row lock a deactivation holds, so whichever commits first wins
--   and the other sees it: work saved during a deactivation waits and is refused; a deactivation
--   during a work save waits and KI-148 then counts that work. A delivery also locks its order FOR
--   SHARE first, so the order cannot move to another customer under it. FOR SHARE locks never conflict with
--   each other, and no function that creates this work also updates customers (live pg_proc,
--   2026-11-19), so two saves for one customer cannot deadlock on it.
--
-- EXISTING ROWS: none changed. Live 2026-11-19: one inactive customer has 2 confirmed orders (To-Do
--   decision 23); they stay editable and cancellable; delivering them needs reactivation first.
--
-- ROLLBACK (its own reviewed migration):
--   DROP TRIGGER zz_inactive_customer_new_work_20270129 ON public.orders;
--   DROP TRIGGER zz_inactive_customer_new_work_20270129 ON public.deliveries;
--   DROP TRIGGER zz_inactive_customer_new_work_20270129 ON public.inventory_holds;
--   DROP TRIGGER zz_inactive_customer_new_work_20270129 ON public.jobs;
--   DROP FUNCTION public.guard_inactive_customer_new_work_20270129();
--
-- ORDERING: after 20270128140000 (KI-148). Not re-runnable (preflight refuses). Triggers are added
--   orders, deliveries, jobs, then inventory_holds: a job cancel writes jobs before holds, so taking
--   the holds table lock last cannot deadlock with it.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  -- The other half of the rule (KI-148's deactivation check) must already be installed.
  IF to_regprocedure('public.guard_customer_deactivation_open_work_20270128()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgrelid = 'public.customers'::regclass
                       AND t.tgname = 'customers_open_work_on_deactivate_20270128'
                       AND t.tgfoid = to_regprocedure('public.guard_customer_deactivation_open_work_20270128()')
                       AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'INACTIVE_NEW_WORK_PREFLIGHT: KI-148 (20270128140000) must be applied first';
  END IF;
  IF to_regprocedure('public.guard_inactive_customer_new_work_20270129()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_inactive_customer_new_work_20270129') THEN
    RAISE EXCEPTION 'INACTIVE_NEW_WORK_PREFLIGHT: the guard already exists';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name) IN (
           ('customers','id'), ('customers','is_active'),
           ('orders','id'), ('orders','customer_id'), ('orders','status'), ('orders','deleted_at'),
           ('deliveries','customer_id'), ('deliveries','order_id'), ('deliveries','status'), ('deliveries','deleted_at'),
           ('inventory_holds','customer_id'), ('inventory_holds','is_active'), ('inventory_holds','expires_at'),
           ('inventory_holds','hold_type'), ('inventory_holds','source_id'),
           ('jobs','customer_id'), ('jobs','status'), ('jobs','deleted_at'), ('jobs','invoice_id'))) <> 19 THEN
    RAISE EXCEPTION 'INACTIVE_NEW_WORK_PREFLIGHT: a column the guard reads is missing';
  END IF;
END
$preflight$;

CREATE FUNCTION public.guard_inactive_customer_new_work_20270129()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today date := (clock_timestamp() AT TIME ZONE 'America/Chicago')::date;
  v_new_open boolean;
  v_old_open boolean := false;
  v_moved boolean := false;
  v_ids uuid[];
  v_order_customer uuid;
  v_found integer;
BEGIN
  -- "Open" matches KI-148's deactivation check (20270128140000).
  IF TG_TABLE_NAME = 'orders' THEN
    v_new_open := NEW.deleted_at IS NULL AND NEW.status IN ('confirmed', 'partially_fulfilled');
    IF TG_OP = 'UPDATE' THEN
      v_old_open := OLD.deleted_at IS NULL AND OLD.status IN ('confirmed', 'partially_fulfilled');
      v_moved := NEW.customer_id IS DISTINCT FROM OLD.customer_id;
    END IF;
    v_ids := ARRAY[NEW.customer_id];
  ELSIF TG_TABLE_NAME = 'deliveries' THEN
    v_new_open := NEW.deleted_at IS NULL AND NEW.status IN ('scheduled', 'in_progress');
    IF TG_OP = 'UPDATE' THEN
      v_old_open := OLD.deleted_at IS NULL AND OLD.status IN ('scheduled', 'in_progress');
      v_moved := NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.order_id IS DISTINCT FROM OLD.order_id;
    END IF;
    v_ids := ARRAY[NEW.customer_id];  -- plus the order's customer, read under a lock below
  ELSIF TG_TABLE_NAME = 'inventory_holds' THEN
    -- A job hold whose job belongs to this same customer follows that job (starting an existing job
    -- rebuilds its holds; a new job or a job moved onto an inactive customer is refused above).
    -- Every other hold is checked, whatever its type or source.
    IF NEW.hold_type = 'job' AND NEW.source_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = NEW.source_id AND j.customer_id = NEW.customer_id) THEN
      RETURN NULL;
    END IF;
    v_new_open := NEW.is_active IS TRUE AND (NEW.expires_at IS NULL OR NEW.expires_at >= v_today);
    IF TG_OP = 'UPDATE' THEN
      v_old_open := OLD.is_active IS TRUE AND (OLD.expires_at IS NULL OR OLD.expires_at >= v_today);
      v_moved := NEW.customer_id IS DISTINCT FROM OLD.customer_id;
    END IF;
    v_ids := ARRAY[NEW.customer_id];
  ELSIF TG_TABLE_NAME = 'jobs' THEN
    v_new_open := NEW.deleted_at IS NULL
      AND (NEW.status IN ('scheduled', 'in_progress') OR (NEW.status = 'completed' AND NEW.invoice_id IS NULL));
    IF TG_OP = 'UPDATE' THEN
      v_old_open := OLD.deleted_at IS NULL
        AND (OLD.status IN ('scheduled', 'in_progress') OR (OLD.status = 'completed' AND OLD.invoice_id IS NULL));
      v_moved := NEW.customer_id IS DISTINCT FROM OLD.customer_id;
    END IF;
    v_ids := ARRAY[NEW.customer_id];
  ELSE
    RAISE EXCEPTION 'INACTIVE_NEW_WORK_GUARD: unexpected table %', TG_TABLE_NAME;
  END IF;

  -- Every new row is new work; an update only when it opens the row or moves any row to a customer.
  -- (Moving a closed order counts too: else a delivery could be added to it while it moves.)
  IF TG_OP = 'UPDATE' AND NOT ((v_new_open AND NOT v_old_open) OR v_moved) THEN
    RETURN NULL;
  END IF;

  -- The delivery's order is locked first, so it cannot move to another customer before this commits.
  -- (Nested IF: PL/pgSQL would read NEW.order_id on every table in a single AND.)
  IF TG_TABLE_NAME = 'deliveries' THEN
    IF NEW.order_id IS NOT NULL THEN
      SELECT o.customer_id INTO v_order_customer FROM public.orders o WHERE o.id = NEW.order_id FOR SHARE;
      v_ids := v_ids || v_order_customer;
    END IF;
  END IF;

  -- FOR SHARE waits for a deactivation in progress, then reads its committed result; it also makes a
  -- deactivation wait for this save, so KI-148's count sees it. Id order: no lock-order deadlock.
  SELECT count(*) INTO v_found
    FROM (SELECT 1 FROM public.customers c WHERE c.id = ANY (v_ids) ORDER BY c.id FOR SHARE) locked;
  -- A customer this transaction cannot see yet is refused, never assumed active.
  IF v_found < (SELECT count(DISTINCT x) FROM unnest(v_ids) x WHERE x IS NOT NULL) THEN
    RAISE EXCEPTION 'CUSTOMER_INACTIVE_NEW_WORK: nothing was saved. This customer is inactive. An admin or sales rep must reactivate the customer before new orders, deliveries, stock holds or spray jobs are added';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers c WHERE c.id = ANY (v_ids) AND c.is_active IS NOT TRUE) THEN
    RAISE EXCEPTION 'CUSTOMER_INACTIVE_NEW_WORK: nothing was saved. This customer is inactive. An admin or sales rep must reactivate the customer before new orders, deliveries, stock holds or spray jobs are added';
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_inactive_customer_new_work_20270129() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER zz_inactive_customer_new_work_20270129
  AFTER INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_inactive_customer_new_work_20270129();
CREATE TRIGGER zz_inactive_customer_new_work_20270129
  AFTER INSERT OR UPDATE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.guard_inactive_customer_new_work_20270129();
CREATE TRIGGER zz_inactive_customer_new_work_20270129
  AFTER INSERT OR UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.guard_inactive_customer_new_work_20270129();
CREATE TRIGGER zz_inactive_customer_new_work_20270129
  AFTER INSERT OR UPDATE ON public.inventory_holds
  FOR EACH ROW EXECUTE FUNCTION public.guard_inactive_customer_new_work_20270129();

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.guard_inactive_customer_new_work_20270129()');
  -- tgtype 21 = ROW | INSERT | UPDATE (AFTER); no column list, no WHEN clause.
  IF p.oid IS NULL
     OR position('CUSTOMER_INACTIVE_NEW_WORK' IN p.prosrc) = 0
     OR p.proowner <> 'postgres'::regrole OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR p.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR (SELECT count(*) FROM pg_trigger t
          WHERE t.tgname = 'zz_inactive_customer_new_work_20270129' AND t.tgfoid = p.oid
            AND t.tgrelid IN ('public.orders'::regclass, 'public.deliveries'::regclass,
                              'public.inventory_holds'::regclass, 'public.jobs'::regclass)
            AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgqual IS NULL
            AND t.tgtype = 21 AND t.tgnargs = 0 AND t.tgattr::text = '') <> 4 THEN
    RAISE EXCEPTION 'INACTIVE_NEW_WORK_POSTFLIGHT: the guard lost its owner, mode, search_path, grants or triggers';
  END IF;
END
$postflight$;
