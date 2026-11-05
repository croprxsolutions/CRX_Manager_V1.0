-- Smoke chain: retire_uncertain_request (REQUIRES 20261107160000).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so the receipts it seeds and the
-- retired-request rows the function writes are all rolled back. It needs one active
-- admin profile: every receipt it reads it seeds itself. Proves, as a real signed-in
-- session (role authenticated with that profile's claims) and with those claims cleared:
--   * the installed bodies (the function and the receipt insert guard) are
--     20261107160000's and 20261107150000's, only authenticated can execute the function, and no client role
--     can reach the signing-key or retired-request tables;
--   * a request key recorded under the operation it names is safe ('recorded'), even
--     when the receipt has expired; a receipt under another operation is not;
--   * an unrecorded key needs two checks 15+ minutes apart by SERVER time, carried in a
--     token the server signed for that exact request: no token, a forged one, another
--     request's token or a future one -> 'first_check'; a genuine token 5 minutes old ->
--     'waiting', 16 minutes -> safe; asking again -> 'retired';
--   * a batch with a row saved under adjust_inventory is 'recorded'; a row receipt under
--     another operation, or one not ending in a UUID, does not count;
--   * after a safe answer the database refuses any later save of the request key, of
--     any row of a batch under it (known or not, any ending), and of an expired one
--     (IDEMPOTENCY_REQUEST_RETIRED); an unrelated key, and a longer key of another
--     operation that starts with a retired key, still save, and a retry of a
--     retired request that still has a live receipt keeps its replay handling
--     (allocate_payment's claim-row replay included);
--   * an active non-admin staff member (when one exists) is answered for their own key
--     and refused another user's key; a service profile (when one exists), another
--     user's key, a row key, a wrong idempotency key and a signed-out session are refused.
-- The 'in_progress' answer and the wait of a row save behind a retire need two sessions,
-- so they are proven on the local test database instead
-- (docs/changelog.d/2026-11-05-uncertain-request-clear-check.md).
DO $$
DECLARE
  v_fn regprocedure := 'public.retire_uncertain_request(text,text,text)'::regprocedure;
  v_actor uuid;
  v_other uuid;
  v_service uuid;
  v_recorded text;
  v_expired text;
  v_foreign text;
  v_unrecorded text;
  v_batch text;
  v_batch_foreign text;
  v_batch_note text;
  v_payment text;
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
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = v_fn), chr(13), '')) <> 'addf6df43b0e9d23c91e88dba315a1d0' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: retire_uncertain_request is not the body of 20261107160000';
  END IF;
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public._guard_idempotency_key_insert()'::regprocedure), chr(13), ''))
     <> 'a9e47f3ea8b2b5b76b15ed1d745a8140' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: _guard_idempotency_key_insert is not the body of 20261107150000';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('metabase_ro', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: EXECUTE grants are not authenticated-only';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro'] LOOP
    IF has_table_privilege(v_role, 'public.uncertain_request_clear_check_key', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege(v_role, 'public.retired_uncertain_requests', 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % can reach a clear-check table', v_role;
    END IF;
  END LOOP;
  SELECT signing_key INTO STRICT v_signing FROM public.uncertain_request_clear_check_key;
  SELECT id INTO v_actor FROM public.profiles WHERE is_active AND role = 'admin' ORDER BY created_at LIMIT 1;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: need one active admin profile'; END IF;
  SELECT id INTO v_other FROM public.profiles WHERE is_active AND role IN ('sales_rep', 'driver', 'applicator') ORDER BY created_at LIMIT 1;
  SELECT id INTO v_service FROM public.profiles WHERE is_active AND role = 'entity_recipient' ORDER BY created_at LIMIT 1;

  -- Seeded receipts (rolled back).
  v_recorded := 'save_vendor:' || v_actor || ':' || gen_random_uuid();
  v_expired := 'save_vendor:' || v_actor || ':' || gen_random_uuid();
  v_foreign := 'save_vendor:' || v_actor || ':' || gen_random_uuid();
  v_unrecorded := 'save_vendor:' || v_actor || ':' || gen_random_uuid();
  v_batch := 'adjust_inventory_batch:' || v_actor || ':' || gen_random_uuid();
  v_batch_foreign := 'adjust_inventory_batch:' || v_actor || ':' || gen_random_uuid();
  v_batch_note := 'adjust_inventory_batch:' || v_actor || ':' || gen_random_uuid();
  v_payment := 'allocate_payment:' || v_actor || ':' || gen_random_uuid();
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id, request_fingerprint)
  VALUES (v_recorded, 'save_vendor', '{"smoke": true}', v_actor, 'smoke'),
         (v_foreign, 'save_customer', '{"smoke": true}', v_actor, 'smoke'),
         (v_batch || ':' || gen_random_uuid(), 'adjust_inventory', '{"smoke": true}', v_actor, 'smoke'),
         (v_batch_foreign || ':' || gen_random_uuid(), 'save_vendor', '{"smoke": true}', v_actor, 'smoke'),
         (v_batch_note || ':note', 'adjust_inventory', '{"smoke": true}', v_actor, 'smoke'),
         (v_payment, 'allocate_payment', '{"smoke": true}', v_actor, 'smoke');
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id, request_fingerprint, created_at, expires_at)
  VALUES (v_expired, 'save_vendor', '{"smoke": true}', v_actor, 'smoke', now() - interval '25 hours', now() - interval '1 hour');

  -- Tokens signed here exactly as the function signs them (postgres can read the key; clients cannot).
  SELECT string_agg(us::text || '.' || encode(extensions.hmac(convert_to(k || '|' || us::text, 'UTF8'), v_signing, 'sha256'), 'hex'), ',' ORDER BY n)
    INTO v_bad
    FROM (VALUES
      (1, v_unrecorded, (extract(epoch FROM now() - interval '5 minutes') * 1000000)::bigint),
      (2, v_unrecorded, (extract(epoch FROM now() - interval '16 minutes') * 1000000)::bigint),
      (3, v_unrecorded, (extract(epoch FROM now() + interval '1 hour') * 1000000)::bigint),
      (4, 'save_vendor:' || v_actor || ':' || gen_random_uuid(), (extract(epoch FROM now() - interval '16 minutes') * 1000000)::bigint)
    ) AS t(n, k, us);
  v_tok_5 := split_part(v_bad, ',', 1);
  v_tok_16 := split_part(v_bad, ',', 2);
  v_tok_future := split_part(v_bad, ',', 3);
  v_tok_other := split_part(v_bad, ',', 4);

  -- A signed-in non-admin staff member is answered for their own key (20261107160000);
  -- an unrecorded key only starts the wait, so nothing is written. Another user's key
  -- is still refused.
  IF v_other IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_r := public.retire_uncertain_request('save_vendor:' || v_other || ':' || gen_random_uuid());
    IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'first_check' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a staff member was not answered for their own key: %', v_r;
    END IF;
    v_refused := false;
    BEGIN
      PERFORM public.retire_uncertain_request('save_vendor:' || v_actor || ':' || gen_random_uuid());
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'REQUEST_KEY_NOT_OWNED%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: a staff member using another key failed oddly: % %', SQLSTATE, SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a staff member was answered for another user''s key'; END IF;
    EXECUTE 'RESET ROLE';
  END IF;

  -- A service profile is refused before anything is read.
  IF v_service IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_service, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_service::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_refused := false;
    BEGIN
      PERFORM public.retire_uncertain_request('save_vendor:' || v_service || ':' || gen_random_uuid());
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'NOT_AUTHORIZED%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: a service profile failed oddly: % %', SQLSTATE, SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a service profile was answered'; END IF;
    EXECUTE 'RESET ROLE';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_r := public.retire_uncertain_request(v_recorded, p_idempotency_key => v_recorded);
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'recorded' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a recorded key was not safe: %', v_r;
  END IF;
  v_r := public.retire_uncertain_request(v_payment);
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'recorded' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a recorded payment was not safe: %', v_r;
  END IF;
  v_r := public.retire_uncertain_request(v_expired);
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'recorded' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an expired receipt was not counted as saved: %', v_r;
  END IF;
  v_r := public.retire_uncertain_request(v_foreign);
  IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'first_check' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a receipt under another operation counted as saved: %', v_r;
  END IF;
  v_r := public.retire_uncertain_request(v_unrecorded);
  IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'first_check'
     OR (v_r->>'checked_at')::timestamptz NOT BETWEEN now() AND clock_timestamp() OR v_r->>'first_check_token' !~ '^[0-9]+\.[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a first check did not return a signed server time and refuse: %', v_r;
  END IF;
  -- Its own fresh token is genuine: asking again at once is 'waiting', not a new first check.
  IF public.retire_uncertain_request(v_unrecorded, v_r->>'first_check_token')->>'reason' <> 'waiting' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a token the server just signed was not accepted';
  END IF;
  FOREACH v_bad IN ARRAY ARRAY[
    'garbage',
    split_part(v_tok_16, '.', 1) || '.' || repeat('0', 64),
    v_tok_other,
    v_tok_future
  ] LOOP
    v_r := public.retire_uncertain_request(v_unrecorded, v_bad);
    IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'first_check' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: an unsigned, borrowed or future token was trusted: %', v_r;
    END IF;
  END LOOP;
  v_r := public.retire_uncertain_request(v_unrecorded, v_tok_5);
  IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'waiting' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a check 5 minutes later was not refused: %', v_r;
  END IF;
  v_r := public.retire_uncertain_request(v_unrecorded, v_tok_16);
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'not_recorded_after_wait' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a check 16 minutes later was not safe: %', v_r;
  END IF;
  v_r := public.retire_uncertain_request(v_unrecorded, p_idempotency_key => v_unrecorded);
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'retired' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: asking again after a retire was not answered retired: %', v_r;
  END IF;

  -- Batches: a row saved under adjust_inventory counts; one under another operation does not.
  v_r := public.retire_uncertain_request(v_batch);
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'recorded' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a batch with a saved row was not recorded: %', v_r;
  END IF;
  v_r := public.retire_uncertain_request(v_batch_foreign);
  IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'first_check' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a batch row under another operation counted as saved: %', v_r;
  END IF;
  v_r := public.retire_uncertain_request(v_batch_note);
  IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'first_check' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a batch row not ending in a UUID counted as saved: %', v_r;
  END IF;

  FOREACH v_bad IN ARRAY ARRAY[
    'save_vendor:' || gen_random_uuid() || ':' || gen_random_uuid(),
    v_recorded || ':row',
    v_batch || ':' || gen_random_uuid()
  ] LOOP
    v_refused := false;
    BEGIN
      PERFORM public.retire_uncertain_request(v_bad);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'REQUEST_KEY_NOT_OWNED%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: a key that is not a request this user owns failed oddly: % %', SQLSTATE, SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a key this user does not own was accepted: %', v_bad; END IF;
  END LOOP;
  v_refused := false;
  BEGIN
    PERFORM public.retire_uncertain_request(v_batch, NULL, v_recorded);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: expected IDEMPOTENCY_KEY_MISMATCH, got % %', SQLSTATE, SQLERRM;
    END IF;
    v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: IDEMPOTENCY_KEY_MISMATCH was not raised'; END IF;

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_refused := false;
  BEGIN
    PERFORM public.retire_uncertain_request(v_recorded);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'AUTH_REQUIRED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a signed-out check failed oddly: % %', SQLSTATE, SQLERRM;
    END IF;
    v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a signed-out session was answered'; END IF;

  -- After the clear, the database refuses a late save of the request, of any row under
  -- it (one the browser never knew about included) and of an expired receipt's key.
  EXECUTE 'RESET ROLE';
  FOREACH v_bad IN ARRAY ARRAY[v_unrecorded, v_expired, v_batch || ':' || gen_random_uuid(), v_batch || ':note'] LOOP
    v_refused := false;
    BEGIN
      INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id, request_fingerprint)
      VALUES (v_bad, CASE WHEN v_bad LIKE 'adjust_inventory_batch:%' THEN 'adjust_inventory' ELSE 'save_vendor' END,
              '{"late": true}', v_actor, 'late');
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'IDEMPOTENCY_REQUEST_RETIRED%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: a late save of a retired request failed oddly: % %', SQLSTATE, SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a retired request was saved later: %', v_bad; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = v_expired AND result = '{"smoke": true}') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused late save removed the expired receipt';
  END IF;
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id, request_fingerprint)
  VALUES ('save_vendor:' || v_actor || ':' || gen_random_uuid(), 'save_vendor', '{"smoke": true}', v_actor, 'smoke'),
         (v_unrecorded || ':' || gen_random_uuid(), 'save_vendor', '{"smoke": true}', v_actor, 'smoke');
  -- A retry of a retired request whose receipt is still live keeps its replay handling:
  -- allocate_payment's claim row is skipped quietly so it can read its saved answer, and
  -- any other operation is told to retry and read it. Neither saves anything.
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id, request_fingerprint)
  VALUES (v_payment, 'allocate_payment', '{"_contract": "allocate_payment_v1", "request": {}, "response": null}', v_actor, 'smoke');
  IF (SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = v_payment AND result = '{"smoke": true}') <> 1
     OR (SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = v_payment) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a payment retry changed the saved payment receipt';
  END IF;
  v_refused := false;
  BEGIN
    INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id, request_fingerprint)
    VALUES (v_recorded, 'save_vendor', '{"late": true}', v_actor, 'late');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_CONCURRENT_REPLAY_RETRY%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a retry of a retired, saved request lost its replay: % %', SQLSTATE, SQLERRM;
    END IF;
    v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a retired, saved request was saved again'; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: retire_uncertain_request';
END $$;
