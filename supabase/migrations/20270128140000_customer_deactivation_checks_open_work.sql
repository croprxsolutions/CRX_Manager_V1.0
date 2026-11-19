-- Written 2026-11-18. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270128140000_customer_deactivation_checks_open_work.md.
--
-- WHAT (KI-148; To-Do decision 20 answered 2026-11-18: every role, admins included):
--   A customer cannot be switched from active to inactive while it still has open work:
--   an open order (confirmed or partially fulfilled), an undelivered delivery (scheduled or in
--   progress, of the customer or of one of its orders), an active, unexpired stock hold, an open quote
--   (draft, sent or revised, or accepted with no order yet, as the purchasing plan counts it), or an
--   open invoice (posted or overdue). Deleted rows never count. The refusal names the customer and what is open:
--   CUSTOMER_HAS_OPEN_WORK. It applies to everyone and every path (Customers bulk Deactivate,
--   the edit page through save_customer, a direct API update, server functions).
--
-- HOW: a new BEFORE UPDATE OF is_active trigger on customers. Its function is SECURITY DEFINER
--   (owner postgres) so row-level security cannot hide open work from the caller; it reads only and
--   returns NEW. EXECUTE is revoked from everyone (a trigger function needs no grant to fire). Its
--   name sorts after customers_guard_rep_edit_20261013, so a rep's forbidden edit keeps its own error.
--   Only admins and sales reps may update customers (policy customers_update), and both read every
--   customer's work, so the counts it names reveal nothing new; invoices are named without a count.
--   CONSISTENCY: it first locks the customer row FOR UPDATE, which waits for every transaction still
--   inserting an order, delivery, hold, quote or invoice for it (each insert's foreign key check holds a
--   key-share lock on the row until commit; every delivery path refuses a customer other than its
--   order's) and makes later inserts wait for the deactivation; then one statement counts all five
--   kinds from one snapshot. It refuses outside READ COMMITTED (CUSTOMER_DEACTIVATION_ISOLATION), whose
--   fixed snapshot would not see work committed while it waited; every app path is read committed.
--   LIMIT (accepted, see the KI-148 contract): work that already exists and is reopened by a status
--   change (no new row) in a transaction committing during the check, or later, is not caught; and
--   work added after the deactivation lands on an inactive customer, as on any inactive customer today
--   (whether inactive customers should refuse new work is a separate decision in the contract).
--
-- NOT CHANGED: guard_customer_rep_edit_20261013 and its trigger (its rep-only open-invoice rule
--   stays, now a duplicate), save_customer, every policy and grant. No column or row changes.
--   Customers that are already inactive are not re-checked: editing or reactivating them is
--   unaffected (To-Do decision 23: the inactive customer with 2 confirmed orders stays as it is).
--
-- ROLLBACK (its own reviewed migration):
--   DROP TRIGGER customers_open_work_on_deactivate_20270128 ON public.customers;
--   DROP FUNCTION public.guard_customer_deactivation_open_work_20270128();
--
-- ORDERING: apply after every older pending migration. Not re-runnable (preflight refuses).

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.guard_customer_deactivation_open_work_20270128()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.customers'::regclass
                  AND tgname = 'customers_open_work_on_deactivate_20270128') THEN
    RAISE EXCEPTION 'KI148_PREFLIGHT: the deactivation guard already exists';
  END IF;
  -- Every column the guard reads must exist with the meaning it relies on.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name) IN (
           ('customers','id'), ('customers','is_active'), ('customers','farm_name'),
           ('orders','id'), ('orders','quote_id'), ('orders','customer_id'), ('orders','status'), ('orders','deleted_at'),
           ('deliveries','id'), ('deliveries','customer_id'), ('deliveries','order_id'), ('deliveries','status'), ('deliveries','deleted_at'),
           ('inventory_holds','customer_id'), ('inventory_holds','is_active'), ('inventory_holds','expires_at'),
           ('quotes','id'), ('quotes','customer_id'), ('quotes','status'), ('quotes','deleted_at'),
           ('invoices','customer_id'), ('invoices','status'), ('invoices','deleted_at'))) <> 23 THEN
    RAISE EXCEPTION 'KI148_PREFLIGHT: a column the guard reads is missing';
  END IF;
END
$preflight$;

CREATE FUNCTION public.guard_customer_deactivation_open_work_20270128()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_orders bigint;
  v_deliveries bigint;
  v_holds bigint;
  v_quotes bigint;
  v_invoices bigint;
  v_open text[] := ARRAY[]::text[];
BEGIN
  -- Only the active -> inactive change is checked; already-inactive customers stay editable.
  IF NOT (OLD.is_active IS TRUE AND NEW.is_active IS NOT TRUE) THEN
    RETURN NEW;
  END IF;
  -- Wait for any transaction still creating work for this customer: every insert into the five tables
  -- holds a key-share lock on this row (its foreign key check) until it commits, and FOR UPDATE waits
  -- for it. Work inserted after this point waits for the deactivation instead.
  -- (No order-row lock: every delivery path refuses a customer that differs from its order's, so a
  -- delivery insert locks this row too; locking orders here could deadlock with billing, Sol r2.)
  -- The count below needs a fresh snapshot after the lock, which only READ COMMITTED (every app path) gives.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CUSTOMER_DEACTIVATION_ISOLATION: a customer can only be deactivated in a read-committed transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM public.customers c WHERE c.id = OLD.id FOR UPDATE;
  -- One statement, so all five counts read the same committed state.
  SELECT
    (SELECT count(*) FROM public.orders o
      WHERE o.customer_id = OLD.id AND o.deleted_at IS NULL
        AND o.status IN ('confirmed', 'partially_fulfilled')),
    (SELECT count(*) FROM (
       SELECT d.id FROM public.deliveries d
        WHERE d.customer_id = OLD.id AND d.deleted_at IS NULL AND d.status IN ('scheduled', 'in_progress')
       UNION
       SELECT d.id FROM public.orders o JOIN public.deliveries d ON d.order_id = o.id
        WHERE o.customer_id = OLD.id AND d.deleted_at IS NULL AND d.status IN ('scheduled', 'in_progress')) dd),
    -- An expired hold no longer reserves stock (the purchasing plan never counts one either).
    (SELECT count(*) FROM public.inventory_holds h
      WHERE h.customer_id = OLD.id AND h.is_active IS TRUE
        AND (h.expires_at IS NULL OR h.expires_at >= (now() AT TIME ZONE 'America/Chicago')::date)),
    (SELECT count(*) FROM public.quotes q
      WHERE q.customer_id = OLD.id AND q.deleted_at IS NULL
        -- An accepted quote with no order still promises product (the purchasing plan's rule).
        AND (q.status IN ('draft', 'sent', 'revised')
             OR (q.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.quote_id = q.id)))),
    (SELECT count(*) FROM public.invoices i
      WHERE i.customer_id = OLD.id AND i.deleted_at IS NULL
        AND i.status IN ('posted', 'overdue'))
  INTO v_orders, v_deliveries, v_holds, v_quotes, v_invoices;
  IF v_orders > 0 THEN v_open := v_open || format('%s open order(s)', v_orders); END IF;
  IF v_deliveries > 0 THEN v_open := v_open || format('%s undelivered delivery(ies)', v_deliveries); END IF;
  IF v_holds > 0 THEN v_open := v_open || format('%s active stock hold(s)', v_holds); END IF;
  IF v_quotes > 0 THEN v_open := v_open || format('%s open quote(s)', v_quotes); END IF;
  -- No invoice count: the rep guard keeps invoice detail to itself for reps.
  IF v_invoices > 0 THEN v_open := v_open || 'open invoices'::text; END IF;
  IF cardinality(v_open) > 0 THEN
    RAISE EXCEPTION 'CUSTOMER_HAS_OPEN_WORK: nothing was deactivated. % still has %. Finish or cancel its orders, deliveries and quotes, release its holds and settle or void its invoices first',
      COALESCE(NULLIF(btrim(OLD.farm_name), ''), 'this customer'), array_to_string(v_open, ', ');
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_customer_deactivation_open_work_20270128() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER customers_open_work_on_deactivate_20270128
  BEFORE UPDATE OF is_active ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_deactivation_open_work_20270128();

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.guard_customer_deactivation_open_work_20270128()');
  -- tgtype 19 = ROW | BEFORE | UPDATE; tgattr = is_active only. Structural, so search_path cannot change it.
  IF p.oid IS NULL
     OR position('CUSTOMER_HAS_OPEN_WORK' IN p.prosrc) = 0
     OR position('FOR UPDATE' IN p.prosrc) = 0
     OR p.proowner <> 'postgres'::regrole OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR p.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR NOT EXISTS (
          SELECT 1 FROM pg_trigger t
           WHERE t.tgrelid = 'public.customers'::regclass AND t.tgname = 'customers_open_work_on_deactivate_20270128'
             AND t.tgfoid = p.oid AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgqual IS NULL
             AND t.tgtype = 19 AND t.tgnargs = 0
             AND t.tgattr::text = (SELECT a.attnum::text FROM pg_attribute a
                                    WHERE a.attrelid = 'public.customers'::regclass AND a.attname = 'is_active')) THEN
    RAISE EXCEPTION 'KI148_POSTFLIGHT: the deactivation guard lost its owner, mode, search_path, grants or trigger';
  END IF;
END
$postflight$;
