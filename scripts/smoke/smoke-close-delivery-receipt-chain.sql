-- ============================================================================
-- SMOKE CHAIN: close_delivery_receipt (migration 20261221100000, KI-25 follow-up)
-- ----------------------------------------------------------------------------
-- Live-safe, rolled back by design. Plants no rows: it calls the RPC as a real active admin on a delivery id that
-- does not exist, and (when one exists) on a real receipt the server already sent, then rolls everything back.
--   1. no signed-in user -> AUTH_REQUIRED; no key -> IDEMPOTENCY_KEY_REQUIRED; bad reason -> RECEIPT_CLOSE_INVALID
--   2. admin, unknown delivery, 'handled' -> outcome none; a retry with the same key gives the same (current) answer; 'manual_send' on a
--      delivery that is not completed -> DELIVERY_NOT_COMPLETED (checked before any replay)
--   3. an active driver -> INSUFFICIENT_ROLE (office only)
--   4. admin, a real sent receipt of a completed delivery, 'manual_send' -> outcome sent with sent_at, row unchanged,
--      no address returned; the same key with 'handled' -> IDEMPOTENCY_INTENT_MISMATCH
--   5. grants: authenticated EXECUTE; anon and service_role none
-- The full behaviour (pause, close, in-flight refusal, races with the worker) needs seeded deliveries and is proved
-- in scripts/smoke/prove-close-delivery-receipt-real-schema.mjs.
--
-- HOW TO RUN: as ONE statement inside a transaction that rolls back. It ALWAYS ends with RAISE EXCEPTION
-- 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin   uuid;
  v_driver  uuid;
  v_nowhere uuid := gen_random_uuid();
  v_suffix  text := substr(md5(random()::text), 1, 8);
  v_res     jsonb;
  v_res2    jsonb;
  v_msg     text;
  v_sent    public.delivery_receipt_queue%ROWTYPE;
  v_after   public.delivery_receipt_queue%ROWTYPE;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found'; END IF;

  -- 1. Refusals before any work.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.close_delivery_receipt(v_nowhere, 'handled', 'smk-cdr-' || v_suffix || '-0');
    RAISE EXCEPTION 'SMOKE_FAIL: no signed-in user was not refused';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: no user: %', v_msg; END IF;
  END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.close_delivery_receipt(v_nowhere, 'handled', NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: a missing key was not refused';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: no key: %', v_msg; END IF;
  END;
  BEGIN
    PERFORM public.close_delivery_receipt(v_nowhere, 'resend', 'smk-cdr-' || v_suffix || '-bad');
    RAISE EXCEPTION 'SMOKE_FAIL: a bad reason was not refused';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'RECEIPT_CLOSE_INVALID%' THEN RAISE EXCEPTION 'SMOKE_FAIL: bad reason: %', v_msg; END IF;
  END;

  -- 2. Unknown delivery: nothing to close; the key replays and is bound to its request.
  v_res := public.close_delivery_receipt(v_nowhere, 'handled', 'smk-cdr-' || v_suffix || '-1');
  IF v_res ->> 'outcome' IS DISTINCT FROM 'none' OR v_res ->> 'delivery_id' IS DISTINCT FROM v_nowhere::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unknown delivery answered %', v_res;
  END IF;
  v_res2 := public.close_delivery_receipt(v_nowhere, 'handled', 'smk-cdr-' || v_suffix || '-1');
  IF v_res2 IS DISTINCT FROM v_res THEN RAISE EXCEPTION 'SMOKE_FAIL: replay answered % not %', v_res2, v_res; END IF;
  BEGIN
    PERFORM public.close_delivery_receipt(v_nowhere, 'manual_send', 'smk-cdr-' || v_suffix || '-1');
    RAISE EXCEPTION 'SMOKE_FAIL: manual_send on a delivery that is not completed was not refused';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'DELIVERY_NOT_COMPLETED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: not completed: %', v_msg; END IF;
  END;

  -- 3. A driver is refused: the call is office only.
  SELECT id INTO v_driver FROM public.profiles WHERE role = 'driver' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_driver IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    BEGIN
      PERFORM public.close_delivery_receipt(v_nowhere, 'manual_send', 'smk-cdr-' || v_suffix || '-drv');
      RAISE EXCEPTION 'SMOKE_FAIL: a driver was not refused';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'INSUFFICIENT_ROLE%' THEN RAISE EXCEPTION 'SMOKE_FAIL: driver: %', v_msg; END IF;
    END;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  END IF;

  -- 4. A real receipt the server already sent: answered 'sent', unchanged, no address in the answer.
  SELECT q.* INTO v_sent FROM public.delivery_receipt_queue q JOIN public.deliveries d ON d.id = q.delivery_id
   WHERE q.status = 'sent' AND d.status = 'completed' AND d.deleted_at IS NULL ORDER BY q.sent_at DESC LIMIT 1;
  IF v_sent.id IS NOT NULL THEN
    v_res := public.close_delivery_receipt(v_sent.delivery_id, 'manual_send', 'smk-cdr-' || v_suffix || '-sent');
    IF v_res ->> 'outcome' IS DISTINCT FROM 'sent' OR v_res ->> 'sent_at' IS NULL OR v_res ? 'sent_to' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a sent receipt answered %', v_res;
    END IF;
    SELECT * INTO v_after FROM public.delivery_receipt_queue WHERE id = v_sent.id;
    IF v_after.status IS DISTINCT FROM 'sent' OR v_after.updated_at IS DISTINCT FROM v_sent.updated_at THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a sent receipt was changed';
    END IF;
    BEGIN
      PERFORM public.close_delivery_receipt(v_sent.delivery_id, 'handled', 'smk-cdr-' || v_suffix || '-sent');
      RAISE EXCEPTION 'SMOKE_FAIL: a reused key with another reason was not refused';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: reused key: %', v_msg; END IF;
    END;
  END IF;

  -- 5. Grants.
  IF NOT has_function_privilege('authenticated', 'public.close_delivery_receipt(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.close_delivery_receipt(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.close_delivery_receipt(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: close_delivery_receipt grants are not authenticated-only';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
