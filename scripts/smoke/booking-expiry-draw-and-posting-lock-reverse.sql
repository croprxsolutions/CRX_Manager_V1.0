-- Rollback text for 20270306120000_booking_expiry_draw_recheck_and_posting_customer_lock.sql (#2097, #2089).
-- Proven by scripts/smoke/prove-2097-2089-real-schema.mjs: after this runs, auto_expire_quotes(text) is the
-- 20270129160000 body again (md5 f677101398caef2eb0b195a42af5e38f) and the posting guard is gone.
-- A live rollback ships as its own reviewed migration with this text.
SET LOCAL lock_timeout = '5s';
DROP TRIGGER zz_inactive_customer_posting_20270306 ON public.invoices;
DROP FUNCTION public.guard_inactive_customer_posting_20270306();
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
