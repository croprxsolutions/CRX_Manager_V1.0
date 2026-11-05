-- Smoke chain: check_uncertain_request_clearable (REQUIRES 20261107150000).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK. The function writes nothing; this chain
-- writes nothing either. Proves, as a real signed-in session (role authenticated with a live
-- active profile's claims) and with those claims cleared (signed out):
--   * the installed body is 20261107150000's, only authenticated can execute it, and no
--     client role can reach the signing-key table;
--   * a key that profile owns and that is recorded in idempotency_keys under the operation it
--     names is safe ('recorded'); a receipt under another operation is not;
--   * an unrecorded key needs two checks 15+ minutes apart by SERVER time, carried in a token
--     the server signed for that key: no token, a forged one, another key's token or a future
--     one -> 'first_check'; a genuine token 5 minutes old -> 'waiting', 16 minutes -> safe;
--   * another user's key, a derived row key and a signed-out session are refused.
-- The 'in_progress' answer needs a second session holding the key's lock, so it is proven on the
-- local test database instead (docs/changelog.d/2026-11-05-uncertain-request-clear-check.md).
DO $$
DECLARE
  v_fn regprocedure := 'public.check_uncertain_request_clearable(text,text)'::regprocedure;
  v_actor uuid;
  v_recorded text;
  v_unrecorded text;
  v_signing bytea;
  v_tok_5 text;
  v_tok_16 text;
  v_tok_future text;
  v_tok_other text;
  v_bad text;
  v_r jsonb;
  v_refused boolean;
  v_role text;
BEGIN
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = v_fn), chr(13), '')) <> '0508dea1a928654ab1c07d1788021d10' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: check_uncertain_request_clearable is not the body of 20261107150000';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('metabase_ro', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: EXECUTE grants are not authenticated-only';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro'] LOOP
    IF has_table_privilege(v_role, 'public.uncertain_request_clear_check_key', 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % can reach the signing-key table', v_role;
    END IF;
  END LOOP;
  SELECT signing_key INTO STRICT v_signing FROM public.uncertain_request_clear_check_key;

  SELECT k.idempotency_key, p.id INTO v_recorded, v_actor
    FROM public.idempotency_keys k
    JOIN public.profiles p ON p.is_active
     AND k.idempotency_key ~ ('^[a-z0-9_]+:' || p.id::text || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     AND k.operation = split_part(k.idempotency_key, ':', 1)
     AND (k.request_actor_id IS NULL OR k.request_actor_id = p.id)
   ORDER BY k.created_at DESC LIMIT 1;
  IF v_recorded IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: need a recorded key of an active profile';
  END IF;
  v_unrecorded := 'receive_po_items:' || v_actor || ':' || gen_random_uuid();

  -- Tokens signed here exactly as the function signs them (postgres can read the key; clients cannot).
  SELECT string_agg(us::text || '.' || encode(extensions.hmac(convert_to(k || '|' || us::text, 'UTF8'), v_signing, 'sha256'), 'hex'), ',' ORDER BY n)
    INTO v_bad
    FROM (VALUES
      (1, v_unrecorded, (extract(epoch FROM now() - interval '5 minutes') * 1000000)::bigint),
      (2, v_unrecorded, (extract(epoch FROM now() - interval '16 minutes') * 1000000)::bigint),
      (3, v_unrecorded, (extract(epoch FROM now() + interval '1 hour') * 1000000)::bigint),
      (4, 'receive_po_items:' || v_actor || ':' || gen_random_uuid(), (extract(epoch FROM now() - interval '16 minutes') * 1000000)::bigint)
    ) AS t(n, k, us);
  v_tok_5 := split_part(v_bad, ',', 1);
  v_tok_16 := split_part(v_bad, ',', 2);
  v_tok_future := split_part(v_bad, ',', 3);
  v_tok_other := split_part(v_bad, ',', 4);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_r := public.check_uncertain_request_clearable(v_recorded);
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'recorded' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a recorded key was not safe: %', v_r;
  END IF;
  v_r := public.check_uncertain_request_clearable(v_unrecorded);
  IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'first_check'
     OR (v_r->>'checked_at')::timestamptz NOT BETWEEN now() AND clock_timestamp() OR v_r->>'first_check_token' !~ '^[0-9]+\.[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a first check did not return a signed server time and refuse: %', v_r;
  END IF;
  -- Its own fresh token is genuine: asking again at once is 'waiting', not a new first check.
  IF public.check_uncertain_request_clearable(v_unrecorded, v_r->>'first_check_token')->>'reason' <> 'waiting' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a token the server just signed was not accepted';
  END IF;
  FOREACH v_bad IN ARRAY ARRAY[
    'garbage',
    split_part(v_tok_16, '.', 1) || '.' || repeat('0', 64),
    v_tok_other,
    v_tok_future
  ] LOOP
    v_r := public.check_uncertain_request_clearable(v_unrecorded, v_bad);
    IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'first_check' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: an unsigned, borrowed or future token was trusted: %', v_r;
    END IF;
  END LOOP;
  v_r := public.check_uncertain_request_clearable(v_unrecorded, v_tok_5);
  IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'waiting' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a check 5 minutes later was not refused: %', v_r;
  END IF;
  v_r := public.check_uncertain_request_clearable(v_unrecorded, v_tok_16);
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
