-- Written 2026-11-19. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270129170000_customer_deactivation_open_work_followups.md.
--
-- WHAT (issue #2000, follow-ups to KI-148 / 20270128140000; contract
--   docs/plans/2026-11-18-ki148-customer-deactivation-CONTRACT.md, section "Follow-up (issue #2000)"):
--   Polish only; what counts as open work is unchanged except holds:
--   - A hold for zero (or less) no longer blocks; the hold test is `is_active = true`, the form the
--     partial index idx_inventory_holds_customer uses. One Chicago date for the whole check.
--   - Wording: "open or unbilled spray job(s)"; a farm name over 60 characters shows its first 59 and "…".
--   Not here (Taha's billing work until 2026-12-15): split payers of another customer's order (they come
--   from order_shares, order_item_shares and field billing defaults), field-split job owners, blend
--   tickets, when a job counts as billed, quotes, invoices, returns and prepay.
--
-- HOW: CREATE OR REPLACE of guard_customer_deactivation_open_work_20270128() only; same owner,
--   SECURITY DEFINER, search_path, revoked EXECUTE and trigger. Still one statement, one snapshot,
--   no row locks (the point-in-time limit Mason accepted is unchanged).
--
-- ROLLBACK (its own reviewed migration): a CREATE OR REPLACE FUNCTION of the same name and signature
--   whose body (between the $function$ quotes) is copied unchanged from
--   20270128140000_customer_deactivation_checks_open_work.sql (that file says CREATE FUNCTION, so its
--   block cannot be re-run as is), then its REVOKE line. The trigger stays bound to the function.
--
-- ORDERING: needs 20270128140000 applied first and unchanged (the preflight compares the function
--   body's md5 with that file's). Ship both in the same release so no deactivation lands between them.
--   A second apply is refused (preflight).

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.guard_customer_deactivation_open_work_20270128()');
  IF v_src IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.customers'::regclass
                      AND tgname = 'customers_open_work_on_deactivate_20270128') THEN
    RAISE EXCEPTION 'KI148_FOLLOWUP_PREFLIGHT: apply 20270128140000 first (the deactivation guard is missing)';
  END IF;
  IF position('KI148_FOLLOWUP_V1' IN v_src) > 0 THEN
    RAISE EXCEPTION 'KI148_FOLLOWUP_PREFLIGHT: the follow-up guard is already in place';
  END IF;
  -- Replace only the exact body 20270128140000 installed, never a different later version. Carriage
  -- returns are ignored: the repo stores the file with LF, a Windows checkout may run it with CRLF.
  IF md5(replace(v_src, E'\r', '')) <> '357ee3570f4d06cd260dbe061b290ef8' THEN
    RAISE EXCEPTION 'KI148_FOLLOWUP_PREFLIGHT: the deactivation guard is not the 20270128140000 version (md5 %)', md5(replace(v_src, E'\r', ''));
  END IF;
  -- The one column the new check reads must exist.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'inventory_holds' AND column_name = 'quantity') THEN
    RAISE EXCEPTION 'KI148_FOLLOWUP_PREFLIGHT: a column the guard reads is missing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.guard_customer_deactivation_open_work_20270128()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- KI148_FOLLOWUP_V1 (issue #2000).
DECLARE
  v_orders bigint;
  v_deliveries bigint;
  v_holds bigint;
  v_quotes bigint;
  v_invoices bigint;
  v_jobs bigint;
  v_returns bigint;
  v_name text;
  v_today date;
  v_open text[] := ARRAY[]::text[];
BEGIN
  -- Only the active -> inactive change is checked; already-inactive customers stay editable.
  IF NOT (OLD.is_active IS TRUE AND NEW.is_active IS NOT TRUE) THEN
    RETURN NEW;
  END IF;
  v_today := (clock_timestamp() AT TIME ZONE 'America/Chicago')::date;
  -- One statement, so all counts read the same committed state. No row locks (Mason, 2026-11-19:
  -- locking drew deadlocks with payments and billing; the split-second gap is accepted instead).
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
    -- An expired or empty hold no longer reserves stock (the purchasing plan never counts one either).
    -- `is_active = true` matches the partial index idx_inventory_holds_customer.
    (SELECT count(*) FROM public.inventory_holds h
      WHERE h.customer_id = OLD.id AND h.is_active = true AND h.quantity > 0
        AND (h.expires_at IS NULL OR h.expires_at >= v_today)),
    (SELECT count(*) FROM public.quotes q
      WHERE q.customer_id = OLD.id AND q.deleted_at IS NULL
        -- An accepted quote with no order still promises product (the purchasing plan's rule).
        AND (q.status IN ('draft', 'sent', 'revised')
             OR (q.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.quote_id = q.id AND o.deleted_at IS NULL)))),
    (SELECT count(*) FROM public.invoices i
      WHERE i.customer_id = OLD.id AND i.deleted_at IS NULL
        -- Draft and unposted invoices still bill (Mason, 2026-11-19).
        AND i.status IN ('draft', 'unposted', 'posted', 'overdue')),
    -- Unchanged from 20270128140000: a completed job with no invoice has not been billed yet.
    (SELECT count(*) FROM public.jobs j
      WHERE j.customer_id = OLD.id AND j.deleted_at IS NULL
        AND (j.status IN ('scheduled', 'in_progress') OR (j.status = 'completed' AND j.invoice_id IS NULL))),
    (SELECT count(*) FROM public.returns r
      WHERE r.customer_id = OLD.id AND r.deleted_at IS NULL AND r.status IN ('approved', 'received'))
  INTO v_orders, v_deliveries, v_holds, v_quotes, v_invoices, v_jobs, v_returns;
  IF v_orders > 0 THEN v_open := v_open || format('%s open order(s)', v_orders); END IF;
  IF v_deliveries > 0 THEN v_open := v_open || format('%s undelivered delivery(ies)', v_deliveries); END IF;
  IF v_holds > 0 THEN v_open := v_open || format('%s active stock hold(s)', v_holds); END IF;
  IF v_quotes > 0 THEN v_open := v_open || format('%s open quote(s)', v_quotes); END IF;
  -- No invoice count: the rep guard keeps invoice detail to itself for reps.
  IF v_invoices > 0 THEN v_open := v_open || 'open invoices'::text; END IF;
  IF v_jobs > 0 THEN v_open := v_open || format('%s open or unbilled spray job(s)', v_jobs); END IF;
  IF v_returns > 0 THEN v_open := v_open || format('%s return(s) awaiting credit', v_returns); END IF;
  -- No amount: the balance is the customer's money, not something this message needs to show.
  IF COALESCE(OLD.prepay_balance_cents, 0) <> 0 THEN v_open := v_open || 'prepay money on account'::text; END IF;
  IF cardinality(v_open) > 0 THEN
    -- The farm name is typed by users and sits inside the sentence: at most 60 characters (issue #2000).
    v_name := COALESCE(NULLIF(btrim(OLD.farm_name), ''), 'this customer');
    IF char_length(v_name) > 60 THEN v_name := left(v_name, 59) || '…'; END IF;
    RAISE EXCEPTION 'CUSTOMER_HAS_OPEN_WORK: nothing was deactivated. % still has %. Finish or cancel that work, bill it, credit its returns and use up or refund its prepay first',
      v_name, array_to_string(v_open, ', ');
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_customer_deactivation_open_work_20270128() FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.guard_customer_deactivation_open_work_20270128()');
  -- tgtype 19 = ROW | BEFORE | UPDATE; tgattr = is_active only. Structural, so search_path cannot change it.
  IF p.oid IS NULL
     OR position('KI148_FOLLOWUP_V1' IN p.prosrc) = 0
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
    RAISE EXCEPTION 'KI148_FOLLOWUP_POSTFLIGHT: the deactivation guard lost its owner, mode, search_path, grants or trigger';
  END IF;
END
$postflight$;
