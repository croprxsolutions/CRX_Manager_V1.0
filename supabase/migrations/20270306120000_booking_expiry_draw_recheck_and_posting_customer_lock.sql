-- Written 2026-11-25. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270306120000_booking_expiry_draw_recheck_and_posting_customer_lock.md.
--
-- Two release #1990 follow-ups (v0.2.1, Taha's bookings and billing lane):
--
-- 1. #2097 (Sol r60, 20270129160000:1594). The nightly booking expiry (auto_expire_quotes) skips a booking with a
--    partial draw, but it read the draws from the loop's snapshot. A draw committed after that snapshot and before
--    the loop locked the booking row was missed: the booking was expired and its holds released, so stock still
--    reserved for the grower went back on the shelf. The loop already re-checks live spray jobs under the row lock
--    (#1959); it now re-checks draws the same way and leaves such a booking open with its holds. Every path that
--    writes quote_product_draws locks the booking row FOR UPDATE first (draw_down_quote, convert, cancel, void,
--    close remainder, revert; read from pg_proc 2026-11-25), so no draw lands after the re-check. The booking then
--    gets the usual "Booking past its date" alert from the statement after the loop. One CONTINUE WHEN added; every
--    other line is the 20270129160000 body (pinned by md5 below).
--
-- 2. #2089 (Sol r58, 20270128140000:90). Deactivating a customer counts open invoices from one snapshot and takes
--    no locks, so an invoice created and posted in a transaction that had not committed was missed: the customer
--    went inactive with a posted balance, which statements, finance charges and the prepay runs then skip. Now
--    posting takes the same customer row lock the #2000 new-work guard takes (20270201120000): a new AFTER UPDATE OF
--    status trigger on invoices, for the posting step only (draft or unposted to posted, paid or overdue, not
--    deleted; every insert is a draft, trg_invoice_draft_insert), locks the customer FOR SHARE and refuses when the
--    customer is inactive: CUSTOMER_INACTIVE_POSTING. FOR SHARE conflicts with the row lock a deactivation holds,
--    so whichever commits first wins and the other sees it: a posting during a deactivation waits and is refused; a
--    deactivation during a posting waits and KI-148's check then counts the posted invoice and refuses
--    (CUSTOMER_HAS_OPEN_WORK). The same rule refuses posting an inactive customer's old draft; reactivate first.
--    LOCK ORDER: the posting functions (_post_invoice_impl_20260714, _post_deleted_delivery_recovery_invoice_20260719
--    and their wrappers) never lock or update customers after posting (pg_proc 2026-11-25), so FOR SHARE is never
--    upgraded in the same transaction. Two postings for one customer share the lock and never wait on each other.
--    Payment, prepay and returned-check paths lock the customer and then lock only posted invoices, which a posting
--    in flight is not yet, so they never wait on it while it waits on them. Paid back to posted (a returned check or
--    a voided payment) is not a posting and is not checked. Guarantee holds for READ COMMITTED transactions (every
--    app path), as for #2000.
--
-- NOT CHANGED: guard_customer_deactivation_open_work_20270128 (it already counts posted invoices), the #2000 guard,
--   every posting function, policy and grant. No column or row changes.
--
-- ROLLBACK (its own reviewed migration; scripts/smoke/booking-expiry-draw-and-posting-lock-reverse.sql is the
--   tested text): DROP TRIGGER zz_inactive_customer_posting_20270306 ON public.invoices;
--   DROP FUNCTION public.guard_inactive_customer_posting_20270306(); then CREATE OR REPLACE auto_expire_quotes(text)
--   with the 20270129160000 body (owner, SECURITY DEFINER, search_path and grants are kept by CREATE OR REPLACE).
--
-- ORDERING: after 20270129160000, 20270128140000 and 20270201120000. Not re-runnable (preflight refuses).

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'auto_expire_quotes') <> 1 THEN
    RAISE EXCEPTION 'V021_RACES_PREFLIGHT: auto_expire_quotes has more than one signature';
  END IF;
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.auto_expire_quotes(text)');
  -- Replace only the exact 20270129160000 body (carriage returns ignored, as a Windows checkout may add them).
  IF p.oid IS NULL OR md5(replace(p.prosrc, E'\r', '')) <> 'f677101398caef2eb0b195a42af5e38f'
     OR p.proowner <> 'postgres'::regrole OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR p.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']::aclitem[] THEN
    RAISE EXCEPTION 'V021_RACES_PREFLIGHT: auto_expire_quotes(text) is not the 20270129160000 version';
  END IF;
  IF to_regprocedure('public.guard_inactive_customer_posting_20270306()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.invoices'::regclass
                  AND tgname = 'zz_inactive_customer_posting_20270306') THEN
    RAISE EXCEPTION 'V021_RACES_PREFLIGHT: the posting guard already exists';
  END IF;
  -- The deactivation check must still count posted invoices, and every invoice must start as a draft.
  IF position('''posted''' IN COALESCE((SELECT prosrc FROM pg_proc
       WHERE oid = to_regprocedure('public.guard_customer_deactivation_open_work_20270128()')), '')) = 0
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.customers'::regclass
                     AND tgname = 'customers_open_work_on_deactivate_20270128' AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.invoices'::regclass
                     AND tgname = 'trg_invoice_draft_insert' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'V021_RACES_PREFLIGHT: the KI-148 deactivation check or the draft-on-insert rule is missing';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name) IN (('invoices','customer_id'), ('invoices','status'), ('invoices','deleted_at'),
           ('customers','id'), ('customers','is_active'), ('quote_product_draws','quote_id'),
           ('quote_product_draws','quantity_drawn'))) <> 7 THEN
    RAISE EXCEPTION 'V021_RACES_PREFLIGHT: a column this migration reads is missing';
  END IF;
END
$preflight$;

-- 1. #2097
CREATE OR REPLACE FUNCTION public.auto_expire_quotes(p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_quote record;
  v_expired_count integer := 0;
  v_holds_released integer := 0;
  v_hold_count integer;
  v_actor uuid;
  v_cached jsonb;
  v_result jsonb;
BEGIN
  -- #1990 apply review: runs take turns (the nightly job and any manual or retried call), so a second run waits, then
  -- sees the first one's expiries and alerts and sends none twice; a repeated key returns the first result.
  -- A waiting REPEATABLE READ or SERIALIZABLE run would keep its first snapshot and miss those alerts (the cron runs
  -- READ COMMITTED).
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'AUTO_EXPIRE_NEEDS_READ_COMMITTED: run the quote expiry sweep in a READ COMMITTED transaction (this one is %).',
      current_setting('transaction_isolation') USING ERRCODE = 'serialization_failure';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('crx:auto_expire_quotes', 0));
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'auto_expire_quotes');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached;
    END IF;
  END IF;
  FOR v_quote IN
    SELECT q.* FROM public.quotes q
    WHERE q.expires_at < CURRENT_DATE
      AND q.status IN ('sent', 'revised')
      AND q.deleted_at IS NULL
      -- A5 (2026-06-10): a quote with partial draw-downs is an open season
      -- booking — being past its quote-expiry date is normal business, not an
      -- expired quote. Never auto-expire it (the undrawn balance would be
      -- destroyed: 'expired' is terminal and releases the booking's holds).
      AND NOT EXISTS (
        SELECT 1 FROM public.quote_product_draws d
        WHERE d.quote_id = q.id AND d.quantity_drawn > 0
      )
      -- #5 (2026-06-13, owner gate G-AE = Option 1): Planned Programs are
      -- deliberate season commitments that reserve inventory on purpose — never
      -- silently auto-expire them (that would release the booking's holds out
      -- from under the forecast). Staff close planned quotes by hand if needed.
      AND q.is_planned = false
      -- #1959 (Mason 2026-11-17): a booking with a live spray job cannot expire; the
      -- booking live-job trigger would refuse it and fail the whole batch.
      AND NOT EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE (j.quote_id = q.id
               OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = q.id))
          AND j.deleted_at IS NULL AND j.status <> 'cancelled'
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    -- #1959: a job committed after the loop's snapshot but before this row was locked is not in the
    -- filter above; re-check under the lock (fresh snapshot) and skip it rather than fail the night.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE (j.quote_id = v_quote.id
             OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = v_quote.id))
        AND j.deleted_at IS NULL AND j.status <> 'cancelled'
    );
    -- #2097: the same for a draw. A draw committed after the loop's snapshot but before this row was locked is not
    -- in the A5 filter above (the lock re-checks only the quote row, not its draws); re-check under the lock and
    -- leave the part-drawn booking open with its holds. A draw locks this quote row first, so none can land now.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.quote_product_draws d
      WHERE d.quote_id = v_quote.id AND d.quantity_drawn > 0
    );
    -- M1 (2026-06-10): release holds BEFORE the status flip so the AFTER
    -- UPDATE trigger finds 0 active holds and its FK-fragile log insert does
    -- not run. End state identical.
    UPDATE public.inventory_holds SET is_active = false, updated_at = now()
      WHERE source_id = v_quote.id AND is_active = true;
    GET DIAGNOSTICS v_hold_count = ROW_COUNT;
    v_holds_released := v_holds_released + v_hold_count;

    UPDATE public.quotes SET status = 'expired', updated_at = now() WHERE id = v_quote.id;
    v_expired_count := v_expired_count + 1;

    INSERT INTO public.notifications (
      user_id, title, message, notification_type, related_entity_type, related_entity_id
    )
    SELECT
      v_quote.created_by,
      'Quote expired',
      'Quote ' || v_quote.quote_number || ' expired',
      'quote_expired',
      'quote',
      v_quote.id
    FROM public.profiles p
    WHERE v_quote.created_by IS NOT NULL
      AND p.id = v_quote.created_by
      AND p.is_active = true;
  END LOOP;

  -- SEASON END (20261029100000, Mason 2026-10-26): a part-drawn booking stays open past its date
  -- (A5 above), so its rep gets one alert per expiry date to re-check it with the grower. A
  -- re-send sets a new date, which can alert again once it passes. #1959: so does a booking kept
  -- open by a live spray job.
  INSERT INTO public.notifications (
    user_id, title, message, notification_type, related_entity_type, related_entity_id
  )
  SELECT
    q.created_by,
    'Booking past its date',
    'Booking ' || q.quote_number || ' passed its expiry date (' || to_char(q.expires_at, 'Mon DD, YYYY')
      || CASE WHEN EXISTS (
                SELECT 1 FROM public.quote_product_draws d
                WHERE d.quote_id = q.id AND d.quantity_drawn > 0)
              THEN ') with product still to draw. Re-check it with the grower.'
              ELSE ') with a spray job made from it, so it stays open. Re-check it with the grower.'
         END,
    'booking_past_expiry',
    'quote',
    q.id
  FROM public.quotes q
  JOIN public.profiles p ON p.id = q.created_by AND p.is_active = true
  WHERE q.expires_at < CURRENT_DATE
    AND q.status IN ('sent', 'revised')
    AND q.deleted_at IS NULL
    AND (
      (q.is_planned = false AND EXISTS (
        SELECT 1 FROM public.quote_product_draws d
        WHERE d.quote_id = q.id AND d.quantity_drawn > 0
      ))
      -- #1959 (Sol HIGH r4): the scheduler only makes jobs from planned bookings, so a job alerts planned or not.
      OR EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE (j.quote_id = q.id
               OR j.quote_section_id IN (SELECT qs.id FROM public.quote_sections qs WHERE qs.quote_id = q.id))
          AND j.deleted_at IS NULL AND j.status <> 'cancelled'
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.related_entity_id = q.id
        AND n.notification_type = 'booking_past_expiry'
        AND n.created_at >= q.expires_at
    );

  IF v_expired_count > 0 THEN
    v_actor := (
      SELECT id
      FROM public.profiles
      WHERE role = 'admin' AND is_active = true
      ORDER BY created_at
      LIMIT 1
    );

    -- Best-effort summary row using a real active admin actor when one exists;
    -- logging must never cancel the expiry work it summarizes.
    IF v_actor IS NOT NULL THEN
      BEGIN
        INSERT INTO public.activity_feed (event_type, description, performed_by)
        VALUES (
          'quotes_auto_expired',
          'Auto-expired ' || v_expired_count || ' quotes, deactivated ' || v_holds_released || ' inventory hold(s)',
          v_actor
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  END IF;

  v_result := jsonb_build_object('expired_count', v_expired_count, 'holds_released', v_holds_released);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'auto_expire_quotes', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

-- 2. #2089
CREATE FUNCTION public.guard_inactive_customer_posting_20270306()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_active boolean;
BEGIN
  -- Fired only for the posting step (the trigger's WHEN clause). FOR SHARE waits for a deactivation in progress,
  -- then reads its committed result; it also makes a deactivation wait for this posting, so KI-148's count sees it.
  -- A customer this transaction cannot find is refused, never assumed active.
  SELECT c.is_active INTO v_active FROM public.customers c WHERE c.id = NEW.customer_id FOR SHARE;
  IF v_active IS NOT TRUE THEN
    RAISE EXCEPTION 'CUSTOMER_INACTIVE_POSTING: nothing was posted. This customer is inactive. An admin or sales rep must reactivate the customer before an invoice is posted for them';
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_inactive_customer_posting_20270306() FROM PUBLIC, anon, authenticated, service_role;

-- AFTER, so every BEFORE posting check (and row-level security) runs first and keeps its own error.
CREATE TRIGGER zz_inactive_customer_posting_20270306
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW
  WHEN (OLD.status IN ('draft', 'unposted') AND NEW.status IN ('posted', 'paid', 'overdue') AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION public.guard_inactive_customer_posting_20270306();

DO $postflight$
DECLARE
  a pg_proc%ROWTYPE;
  g pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO a FROM pg_proc WHERE oid = to_regprocedure('public.auto_expire_quotes(text)');
  SELECT * INTO g FROM pg_proc WHERE oid = to_regprocedure('public.guard_inactive_customer_posting_20270306()');
  -- tgtype 17 = ROW | UPDATE (AFTER); tgattr = status only.
  IF a.oid IS NULL OR position('#2097' IN a.prosrc) = 0
     OR a.proowner <> 'postgres'::regrole OR NOT a.prosecdef
     OR a.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR a.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres', 'service_role=X/postgres']::aclitem[]
     OR g.oid IS NULL OR position('CUSTOMER_INACTIVE_POSTING' IN g.prosrc) = 0
     OR g.proowner <> 'postgres'::regrole OR NOT g.prosecdef
     OR g.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR g.proacl IS DISTINCT FROM ARRAY['postgres=X/postgres']::aclitem[]
     OR NOT EXISTS (
          SELECT 1 FROM pg_trigger t
           WHERE t.tgrelid = 'public.invoices'::regclass AND t.tgname = 'zz_inactive_customer_posting_20270306'
             AND t.tgfoid = g.oid AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgqual IS NOT NULL
             AND t.tgtype = 17 AND t.tgnargs = 0
             AND t.tgattr::text = (SELECT a2.attnum::text FROM pg_attribute a2
                                    WHERE a2.attrelid = 'public.invoices'::regclass AND a2.attname = 'status')) THEN
    RAISE EXCEPTION 'V021_RACES_POSTFLIGHT: auto_expire_quotes or the posting guard lost its body, owner, mode, search_path, grants or trigger';
  END IF;
END
$postflight$;
