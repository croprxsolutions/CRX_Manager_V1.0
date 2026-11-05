-- Smoke chain: check_uncertain_request_clearable (REQUIRES 20261107150000).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK. The function writes nothing; this chain
-- writes nothing either. Proves, as a real signed-in session (role authenticated with a live
-- active profile's claims) and with those claims cleared (signed out):
--   * the installed body is 20261107150000's and only authenticated can execute it;
--   * a key that profile owns and that is recorded in idempotency_keys is safe ('recorded');
--   * an unrecorded key of that profile needs two checks 15+ minutes apart by SERVER time:
--     no first check or a future one -> 'first_check', 5 minutes -> 'waiting', 16 -> safe;
--   * another user's key, a derived row key and a signed-out session are refused.
-- The 'in_progress' answer needs a second session holding the key's lock, so it is proven on the
-- local test database instead (docs/changelog.d/2026-11-05-uncertain-request-clear-check.md).
DO $$
DECLARE
  v_fn regprocedure := 'public.check_uncertain_request_clearable(text,timestamptz)'::regprocedure;
  v_actor uuid;
  v_recorded text;
  v_unrecorded text;
  v_r jsonb;
  v_refused boolean;
BEGIN
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = v_fn), chr(13), '')) <> 'fcd413755176b901d1712930cb737d92' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: check_uncertain_request_clearable is not the body of 20261107150000';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('metabase_ro', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: EXECUTE grants are not authenticated-only';
  END IF;

  SELECT k.idempotency_key, p.id INTO v_recorded, v_actor
    FROM public.idempotency_keys k
    JOIN public.profiles p ON p.is_active
     AND k.idempotency_key ~ ('^[a-z0-9_]+:' || p.id::text || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   ORDER BY k.created_at DESC LIMIT 1;
  IF v_recorded IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need a recorded key of an active profile';
  END IF;
  v_unrecorded := 'receive_po_items:' || v_actor || ':' || gen_random_uuid();

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_r := public.check_uncertain_request_clearable(v_recorded);
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'recorded' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a recorded key was not safe: %', v_r;
  END IF;
  v_r := public.check_uncertain_request_clearable(v_unrecorded);
  IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'first_check' OR (v_r->>'checked_at')::timestamptz <> now() THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a first check did not return server time and refuse: %', v_r;
  END IF;
  v_r := public.check_uncertain_request_clearable(v_unrecorded, now() + interval '1 hour');
  IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'first_check' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a future first check was trusted: %', v_r;
  END IF;
  v_r := public.check_uncertain_request_clearable(v_unrecorded, now() - interval '5 minutes');
  IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'waiting' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a check 5 minutes later was not refused: %', v_r;
  END IF;
  v_r := public.check_uncertain_request_clearable(v_unrecorded, now() - interval '16 minutes');
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'not_recorded_after_wait' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a check 16 minutes later was not safe: %', v_r;
  END IF;

  FOREACH v_unrecorded IN ARRAY ARRAY[
    'receive_po_items:' || gen_random_uuid() || ':' || gen_random_uuid(),
    v_recorded || ':row'
  ] LOOP
    v_refused := false;
    BEGIN
      PERFORM public.check_uncertain_request_clearable(v_unrecorded);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'REQUEST_KEY_NOT_OWNED%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: another user''s key failed oddly: % %', SQLSTATE, SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a key this user does not own was checked'; END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_refused := false;
  BEGIN
    PERFORM public.check_uncertain_request_clearable(v_recorded);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'AUTH_REQUIRED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a signed-out check failed oddly: % %', SQLSTATE, SQLERRM;
    END IF;
    v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a signed-out session was answered'; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: check_uncertain_request_clearable';
END $$;
