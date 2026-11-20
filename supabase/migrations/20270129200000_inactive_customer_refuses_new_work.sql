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
--   inactive customer's existing work can still be finished down or cleaned up. Holds: every hold,
--   whatever its type or source (Mason, 2026-11-19: no exceptions). So starting an inactive
--   customer's old spray job that reserves stock, or a quote or booking reservation, needs the
--   customer reactivated first (live 2026-11-19: no inactive customer has a spray job, quote or
--   hold; named for Taha in the PR). An active hold built from a job or quote (source_id set) must name its
--   customer (CHECK inventory_holds_source_needs_customer; live 2026-11-19: 0 such rows, and jobs
--   and quotes require a customer); a manual hold with no source and no customer belongs to no
--   customer. Refusal:
--   CUSTOMER_INACTIVE_NEW_WORK, a fixed sentence that names no customer (the caller may not be allowed
--   to read the order's customer). Every role and path (RPCs, direct writes, server roles).
--   Moving any of these rows to another customer or order is for admins and sales reps only: anyone
--   else signed in gets WORK_CUSTOMER_MOVE_NOT_ALLOWED before a customer is read (no status leak;
--   no screen lets a non-admin move work); the same applies to reopening a delivery, whose order's
--   customer the caller may not see (restore_cancelled_delivery is admin-only maintenance, so only the
--   inactive-customer check applies to it). Pushing a hold's dated expiry later or
--   raising its quantity or switching its product is checked as opening it.
--   Correcting closed history that reopens a row (for example voiding a completed delivery, which
--   reopens its order) needs the customer reactivated first.
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
--   ALTER TABLE public.inventory_holds DROP CONSTRAINT inventory_holds_source_needs_customer;
--
-- ORDERING: after 20270128140000 (KI-148). Not re-runnable (preflight refuses). Triggers are added
--   orders, deliveries, jobs, then inventory_holds: a job cancel writes jobs before holds, so taking
--   the holds table lock last cannot deadlock with it. Live paths write orders and deliveries in both
--   orders (quick delivery: order first; completion: delivery first), so no trigger order avoids every
--   install-time deadlock: apply at a quiet time; lock_timeout 5s bounds the wait, and a deadlock
--   aborts one transaction whole (retry it).

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  -- The other half of the rule (KI-148's deactivation check) must already be installed.
  IF to_regprocedure('public.is_admin()') IS NULL OR to_regprocedure('public.is_sales_rep()') IS NULL THEN
    RAISE EXCEPTION 'INACTIVE_NEW_WORK_PREFLIGHT: the role helpers is_admin() and is_sales_rep() are missing';
  END IF;
  IF to_regprocedure('public.guard_customer_deactivation_open_work_20270128()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgrelid = 'public.customers'::regclass
                       AND t.tgname = 'customers_open_work_on_deactivate_20270128'
                       AND t.tgfoid = to_regprocedure('public.guard_customer_deactivation_open_work_20270128()')
                       AND t.tgenabled = 'O' AND t.tgqual IS NULL
                       AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF is_active ON public.customers FOR EACH ROW%') THEN
    RAISE EXCEPTION 'INACTIVE_NEW_WORK_PREFLIGHT: KI-148 (20270128140000) must be applied first';
  END IF;
  IF to_regprocedure('public.guard_inactive_customer_new_work_20270129()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_inactive_customer_new_work_20270129'
                  AND tgrelid IN ('public.orders'::regclass, 'public.deliveries'::regclass,
                                  'public.jobs'::regclass, 'public.inventory_holds'::regclass))
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.inventory_holds'::regclass
                  AND conname = 'inventory_holds_source_needs_customer') THEN
    RAISE EXCEPTION 'INACTIVE_NEW_WORK_PREFLIGHT: the guard already exists';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name) IN (
           ('customers','id'), ('customers','is_active'),
           ('orders','id'), ('orders','customer_id'), ('orders','status'), ('orders','deleted_at'),
           ('deliveries','customer_id'), ('deliveries','order_id'), ('deliveries','status'), ('deliveries','deleted_at'),
           ('inventory_holds','customer_id'), ('inventory_holds','is_active'), ('inventory_holds','expires_at'),
           ('inventory_holds','source_id'), ('inventory_holds','quantity'), ('inventory_holds','product_id'),
           ('jobs','customer_id'), ('jobs','status'), ('jobs','deleted_at'), ('jobs','invoice_id'))) <> 20 THEN
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
  v_active integer;
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
    -- Every hold, whatever its type or source (Mason, 2026-11-19: no exceptions).
    v_new_open := NEW.is_active IS TRUE AND (NEW.expires_at IS NULL OR NEW.expires_at >= v_today);
    IF TG_OP = 'UPDATE' THEN
      -- Pushing a dated expiry later counts as opening, so an extension saved across Chicago midnight
      -- (old row open at the trigger, expired by the time a deactivation counts) is still checked.
      -- Raising the quantity or switching the product reserves new stock, so it counts as opening too.
      v_old_open := OLD.is_active IS TRUE AND (OLD.expires_at IS NULL OR OLD.expires_at >= v_today)
        AND NOT (OLD.expires_at IS NOT NULL AND (NEW.expires_at IS NULL OR NEW.expires_at > OLD.expires_at))
        AND NOT (NEW.quantity > OLD.quantity) AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id;
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

  -- Only an admin or sales rep may move work to another customer or order, or reopen a delivery (its
  -- order's customer may be one the caller cannot see). Anyone else signed in (a driver on an assigned
  -- delivery) gets this fixed refusal before any customer is read, so it can never reveal whether such
  -- a customer is active. Server roles have no signed-in user.
  IF (v_moved OR (TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'deliveries'))
     AND auth.uid() IS NOT NULL AND NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'WORK_CUSTOMER_MOVE_NOT_ALLOWED: nothing was saved. Only an admin or sales rep can move an order, delivery, stock hold or spray job to another customer or order, or reopen a delivery';
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
  -- Every named customer must be found, locked and active: one this transaction cannot see yet is
  -- refused, never assumed active.
  SELECT count(*) INTO v_active
    FROM (SELECT c.is_active FROM public.customers c WHERE c.id = ANY (v_ids) ORDER BY c.id FOR SHARE) locked
   WHERE locked.is_active IS TRUE;
  IF v_active < (SELECT count(DISTINCT x) FROM unnest(v_ids) x WHERE x IS NOT NULL) THEN
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

-- An active hold built from a job or quote names its customer, so the guard above always has one to
-- check. A plain constraint, so it holds on every write path. A released hold may lose its customer
-- (the customer foreign key sets it to NULL on delete). Live 2026-11-19: 0 violating rows.
ALTER TABLE public.inventory_holds
  ADD CONSTRAINT inventory_holds_source_needs_customer
  CHECK (source_id IS NULL OR customer_id IS NOT NULL OR is_active IS NOT TRUE) NOT VALID;
ALTER TABLE public.inventory_holds VALIDATE CONSTRAINT inventory_holds_source_needs_customer;

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
            AND t.tgtype = 21 AND t.tgnargs = 0 AND t.tgattr::text = '') <> 4
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid = 'public.inventory_holds'::regclass
                       AND conname = 'inventory_holds_source_needs_customer' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION 'INACTIVE_NEW_WORK_POSTFLIGHT: the guard lost its owner, mode, search_path, grants, triggers or hold constraint';
  END IF;
END
$postflight$;
