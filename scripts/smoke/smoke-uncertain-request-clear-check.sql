-- Smoke chain: retire_uncertain_request (REQUIRES 20261107150000).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so the receipts it seeds and the
-- retire receipts the function writes are all rolled back. It needs only one active
-- profile: every receipt it reads it seeds itself. Proves, as a real signed-in session
-- (role authenticated with that profile's claims) and with those claims cleared:
--   * the installed body is 20261107150000's, only authenticated can execute it, and no
--     client role can reach the signing-key table;
--   * a request key recorded under the operation it names is safe ('recorded'); a
--     receipt under another operation is not;
--   * an unrecorded key needs two checks 15+ minutes apart by SERVER time, carried in a
--     token the server signed for that exact request (key and row keys): no token, a
--     forged one, another request's token or a future one -> 'first_check'; a genuine
--     token 5 minutes old -> 'waiting', 16 minutes -> safe;
--   * a safe answer retires every key that had no receipt: a later send of that key is
--     refused (IDEMPOTENCY_CROSS_OP_KEY_REUSE), and asking again answers 'retired';
--   * a batch whose row key is recorded is 'recorded', and its unrecorded rows retire;
--   * another user's key, a row key outside the request, a wrong idempotency key and a
--     signed-out session are refused.
-- The 'in_progress' answer needs a second session holding a key's lock, so it is proven
-- on the local test database instead (docs/changelog.d/2026-11-05-uncertain-request-clear-check.md).
DO $$
DECLARE
  v_fn regprocedure := 'public.retire_uncertain_request(text,text[],text,text)'::regprocedure;
  v_actor uuid;
  v_recorded text;
  v_foreign text;
  v_unrecorded text;
  v_batch text;
  v_row_saved text;
  v_row_open text;
  v_signing bytea;
  v_tok_5 text;
  v_tok_16 text;
  v_tok_future text;
  v_tok_other text;
  v_tok_batch text;
  v_bad text;
  v_r jsonb;
  v_refused boolean;
  v_role text;
BEGIN
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = v_fn), chr(13), '')) <> '2bd1d44924b096acef97cbf7a039fb68' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: retire_uncertain_request is not the body of 20261107150000';
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
  SELECT id INTO v_actor FROM public.profiles WHERE is_active ORDER BY created_at LIMIT 1;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: need one active profile'; END IF;

  -- Seeded receipts (rolled back): a saved request, a request key used by another
  -- operation, and a batch with one saved row and one unsent row.
  v_recorded := 'save_vendor:' || v_actor || ':' || gen_random_uuid();
  v_foreign := 'save_vendor:' || v_actor || ':' || gen_random_uuid();
  v_unrecorded := 'save_vendor:' || v_actor || ':' || gen_random_uuid();
  v_batch := 'adjust_inventory_batch:' || v_actor || ':' || gen_random_uuid();
  v_row_saved := v_batch || ':' || gen_random_uuid();
  v_row_open := v_batch || ':' || gen_random_uuid();
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id, request_fingerprint)
  VALUES (v_recorded, 'save_vendor', '{"smoke": true}', v_actor, 'smoke'),
         (v_foreign, 'save_customer', '{"smoke": true}', v_actor, 'smoke'),
         (v_row_saved, 'adjust_inventory', '{"smoke": true}', v_actor, 'smoke');

  -- Tokens signed here exactly as the function signs them (postgres can read the key; clients cannot).
  SELECT string_agg(us::text || '.' || encode(extensions.hmac(convert_to(k || '|' || us::text || '|' || rows, 'UTF8'), v_signing, 'sha256'), 'hex'), ',' ORDER BY n)
    INTO v_bad
    FROM (VALUES
      (1, v_unrecorded, (extract(epoch FROM now() - interval '5 minutes') * 1000000)::bigint, ''),
      (2, v_unrecorded, (extract(epoch FROM now() - interval '16 minutes') * 1000000)::bigint, ''),
      (3, v_unrecorded, (extract(epoch FROM now() + interval '1 hour') * 1000000)::bigint, ''),
      (4, 'save_vendor:' || v_actor || ':' || gen_random_uuid(), (extract(epoch FROM now() - interval '16 minutes') * 1000000)::bigint, ''),
      (5, v_unrecorded, (extract(epoch FROM now() - interval '16 minutes') * 1000000)::bigint, v_row_open)
    ) AS t(n, k, us, rows);
  v_tok_5 := split_part(v_bad, ',', 1);
  v_tok_16 := split_part(v_bad, ',', 2);
  v_tok_future := split_part(v_bad, ',', 3);
  v_tok_other := split_part(v_bad, ',', 4);
  v_tok_batch := split_part(v_bad, ',', 5);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_r := public.retire_uncertain_request(v_recorded, p_idempotency_key => v_recorded);
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'recorded' OR (v_r->>'retired_keys')::int <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a recorded key was not safe: %', v_r;
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
  IF public.retire_uncertain_request(v_unrecorded, NULL, v_r->>'first_check_token')->>'reason' <> 'waiting' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a token the server just signed was not accepted';
  END IF;
  FOREACH v_bad IN ARRAY ARRAY[
    'garbage',
    split_part(v_tok_16, '.', 1) || '.' || repeat('0', 64),
    v_tok_other,
    v_tok_future
  ] LOOP
    v_r := public.retire_uncertain_request(v_unrecorded, NULL, v_bad);
    IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'first_check' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: an unsigned, borrowed or future token was trusted: %', v_r;
    END IF;
  END LOOP;
  -- A token signed for other row keys does not count for this request.
  IF public.retire_uncertain_request(v_unrecorded, NULL, v_tok_batch)->>'reason' <> 'first_check' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a token signed for different row keys was trusted';
  END IF;
  v_r := public.retire_uncertain_request(v_unrecorded, NULL, v_tok_5);
  IF (v_r->>'safe')::boolean IS NOT FALSE OR v_r->>'reason' <> 'waiting' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a check 5 minutes later was not refused: %', v_r;
  END IF;
  v_r := public.retire_uncertain_request(v_unrecorded, NULL, v_tok_16);
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'not_recorded_after_wait' OR (v_r->>'retired_keys')::int <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a check 16 minutes later was not safe and retired: %', v_r;
  END IF;
  v_r := public.retire_uncertain_request(v_unrecorded);
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'retired' OR (v_r->>'retired_keys')::int <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: asking again after a retire was not answered retired: %', v_r;
  END IF;

  -- A batch: one row saved, one never saved. Recorded at once; the base key and the
  -- unsaved row retire.
  v_r := public.retire_uncertain_request(v_batch, ARRAY[v_row_saved, v_row_open, v_row_open]);
  IF (v_r->>'safe')::boolean IS NOT TRUE OR v_r->>'reason' <> 'recorded' OR (v_r->>'retired_keys')::int <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a batch with a saved row was not recorded with its open keys retired: %', v_r;
  END IF;

  FOREACH v_bad IN ARRAY ARRAY[
    'save_vendor:' || gen_random_uuid() || ':' || gen_random_uuid(),
    v_recorded || ':row',
    v_recorded || ':' || gen_random_uuid()
  ] LOOP
    v_refused := false;
    BEGIN
      PERFORM public.retire_uncertain_request(v_bad);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'REQUEST_KEY_NOT_OWNED%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: another user''s key failed oddly: % %', SQLSTATE, SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a key this user does not own was accepted: %', v_bad; END IF;
  END LOOP;
  FOREACH v_bad IN ARRAY ARRAY['REQUEST_KEY_NOT_OWNED', 'IDEMPOTENCY_KEY_MISMATCH'] LOOP
    v_refused := false;
    BEGIN
      IF v_bad = 'REQUEST_KEY_NOT_OWNED' THEN
        PERFORM public.retire_uncertain_request(v_batch, ARRAY[v_recorded || ':' || gen_random_uuid()]);
      ELSE
        PERFORM public.retire_uncertain_request(v_batch, NULL, NULL, v_recorded);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE v_bad || '%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: expected %, got % %', v_bad, SQLSTATE, SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: % was not raised', v_bad; END IF;
  END LOOP;

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

  -- A late send of a retired key, by any path, is refused by the database.
  EXECUTE 'RESET ROLE';
  FOREACH v_bad IN ARRAY ARRAY[v_unrecorded, v_row_open] LOOP
    v_refused := false;
    BEGIN
      INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id, request_fingerprint)
      VALUES (v_bad, CASE WHEN v_bad = v_row_open THEN 'adjust_inventory' ELSE 'save_vendor' END, '{"late": true}', v_actor, 'late');
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'IDEMPOTENCY_CROSS_OP_KEY_REUSE%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: a late send of a retired key failed oddly: % %', SQLSTATE, SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'SMOKE_FAIL: a retired key was saved later: %', v_bad; END IF;
  END LOOP;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: retire_uncertain_request';
END $$;
