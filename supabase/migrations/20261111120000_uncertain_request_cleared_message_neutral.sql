-- idempotency-body-check: exempt
-- (a trigger function, not an RPC: it is the idempotency receipt guard itself.)
--
-- KI-27 follow-up (PR #1509 review LOWs). Since 20261110120000 any active staff member,
-- not only an admin, can clear their own stuck request, so the database refusal of a
-- later save of a cleared request no longer says "an admin cleared". The only change to
-- _guard_idempotency_key_insert is that message text; the error code prefix
-- IDEMPOTENCY_REQUEST_RETIRED (what the browser and the smoke chain match on) and the
-- rest of the body are byte-for-byte 20261107150000's. No GRANT or REVOKE: CREATE OR
-- REPLACE keeps the function's existing privileges, and the postflight checks them.
--
-- The postflight also checks that retire_uncertain_request (unchanged here) is still
-- executable by authenticated only: not anon, service_role or metabase_ro (20261110120000
-- checked only anon and authenticated).

DO $preflight$
BEGIN
  IF md5(replace((SELECT prosrc FROM pg_proc
                   WHERE oid = 'public._guard_idempotency_key_insert()'::regprocedure), chr(13), ''))
     <> 'a9e47f3ea8b2b5b76b15ed1d745a8140' THEN
    RAISE EXCEPTION 'PREFLIGHT_GUARD_IDEMPOTENCY_KEY_INSERT_DRIFT: _guard_idempotency_key_insert is not the body of 20261107150000';
  END IF;
  IF md5(replace((SELECT prosrc FROM pg_proc
                   WHERE oid = 'public.retire_uncertain_request(text,text,text)'::regprocedure), chr(13), ''))
     <> 'addf6df43b0e9d23c91e88dba315a1d0' THEN
    RAISE EXCEPTION 'PREFLIGHT_RETIRE_UNCERTAIN_REQUEST_DRIFT: retire_uncertain_request is not the body of 20261110120000';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public._guard_idempotency_key_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing_operation text;
  v_parent text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || NEW.idempotency_key, 0)
  );

  -- KI-27: only an inventory batch sends rows under its own key ("<batch key>:<row>");
  -- any such row takes its batch's lock shared, so it waits for (or blocks)
  -- retire_uncertain_request, which holds that lock exclusively. The retired check
  -- itself runs below, on the only path that saves a new receipt.
  v_parent := substring(NEW.idempotency_key FROM
    '^(adjust_inventory_batch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):.+$');
  IF v_parent IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('crx:idempotency:' || v_parent, 0));
  END IF;

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = NEW.idempotency_key
     AND expires_at < now();

  SELECT operation
    INTO v_existing_operation
    FROM public.idempotency_keys
   WHERE idempotency_key = NEW.idempotency_key;

  IF FOUND THEN
    IF v_existing_operation IS DISTINCT FROM NEW.operation THEN
      RAISE EXCEPTION
        'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
        NEW.idempotency_key, v_existing_operation, NEW.operation;
    END IF;

    IF NEW.operation = 'allocate_payment'
       AND NEW.result->>'_contract' = 'allocate_payment_v1'
       AND NEW.result ? 'request'
       AND NEW.result->'response' = 'null'::jsonb THEN
      RETURN NULL;
    END IF;

    RAISE EXCEPTION
      'IDEMPOTENCY_CONCURRENT_REPLAY_RETRY: operation % with key % completed concurrently; retry to read its saved result',
      NEW.operation, NEW.idempotency_key;
  END IF;

  -- KI-27: no live receipt, so this insert would save new work: a retired request, or
  -- a batch row under one, never does. The exception also undoes the expired-receipt
  -- delete above. A live receipt's replay (above) saves nothing and is left alone.
  IF EXISTS (
    SELECT 1 FROM public.retired_uncertain_requests r
     WHERE r.request_key = NEW.idempotency_key OR r.request_key = v_parent
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_REQUEST_RETIRED: idempotency_key % belongs to a request that was cleared after it got stuck; it cannot be saved',
      NEW.idempotency_key;
  END IF;

  RETURN NEW;
END;
$function$;

DO $postflight$
DECLARE
  v_guard regprocedure := 'public._guard_idempotency_key_insert()'::regprocedure;
  v_retire regprocedure := 'public.retire_uncertain_request(text,text,text)'::regprocedure;
BEGIN
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = v_guard), chr(13), ''))
     <> 'b6d31e7221291e5fb9c40aa146c93ef6' THEN
    RAISE EXCEPTION 'POSTFLIGHT_GUARD_IDEMPOTENCY_KEY_INSERT_BODY: the installed body is not this migration''s';
  END IF;
  IF has_function_privilege('anon', v_guard, 'EXECUTE')
     OR has_function_privilege('authenticated', v_guard, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_GUARD_IDEMPOTENCY_KEY_INSERT_GRANTS: a client role can execute the receipt guard';
  END IF;
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = v_retire), chr(13), ''))
     <> 'addf6df43b0e9d23c91e88dba315a1d0' THEN
    RAISE EXCEPTION 'POSTFLIGHT_RETIRE_UNCERTAIN_REQUEST_BODY: retire_uncertain_request changed';
  END IF;
  IF has_function_privilege('anon', v_retire, 'EXECUTE')
     OR has_function_privilege('service_role', v_retire, 'EXECUTE')
     OR has_function_privilege('metabase_ro', v_retire, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_retire, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_RETIRE_UNCERTAIN_REQUEST_GRANTS: EXECUTE is not authenticated-only';
  END IF;
END
$postflight$;
