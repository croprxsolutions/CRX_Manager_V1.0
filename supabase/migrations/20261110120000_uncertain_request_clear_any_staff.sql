-- idempotency-body-check: exempt
-- (unchanged from 20261107150000: retire_uncertain_request's receipt is its
-- retired_uncertain_requests row, keyed by the request key it is given as its
-- idempotency key; a repeat finds it and answers 'retired' without writing.)
--
-- KI-27 follow-up (Mason's decision, 2026-11-05): any active staff member may clear
-- their OWN stuck request, not only admins. A stuck request lives in the browser of the
-- person who sent it, under their own login, so an admin can never clear anyone else's:
-- before this, a sales rep, driver or applicator whose request got stuck had no way out
-- inside the app.
--
-- The only change to retire_uncertain_request is the role check: an active profile
-- with a staff role (admin, sales_rep, driver, applicator) instead of an active admin.
-- entity_recipient service profiles stay refused. Everything else is byte-for-byte
-- 20261107150000's: own keys only ("<operation>:<auth.uid()>:<uuid>"), the in_progress
-- lock check, the signed 15-minute server-time wait, the retire row, grants
-- (EXECUTE for authenticated only) and SECURITY DEFINER with search_path = public, pg_temp.
-- No table, policy or other function changes.
--
-- Why calling it directly (without the screen's activity note) is not a bypass: the
-- server's own audit record of every clear is the retired_uncertain_requests row
-- (retired_by = auth.uid(), retired_at, reason), written in the same transaction and
-- unreadable and unwritable by clients. The screen's activity_log note was never a gate
-- (clients can write activity_log, and admins could already call this RPC directly). A
-- caller can only retire a key carrying their own user id, and retiring it only refuses
-- that same caller's later save of that same request, which is what the button does.
--
-- The same PR shows the clear button to every signed-in staff member (it already calls
-- this RPC, so no new function name is added); this is applied live before that merges.

DO $preflight$
BEGIN
  IF md5(replace((SELECT prosrc FROM pg_proc
                   WHERE oid = 'public.retire_uncertain_request(text,text,text)'::regprocedure), chr(13), ''))
     <> '482ac2199575547aac2899e6621d9168' THEN
    RAISE EXCEPTION 'PREFLIGHT_RETIRE_UNCERTAIN_REQUEST_DRIFT: retire_uncertain_request is not the body of 20261107150000';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.retire_uncertain_request(
  p_request_key text,
  p_first_check_token text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_now timestamptz;
  v_now_us bigint;
  v_wait_us bigint := 15 * 60 * 1000000;
  -- The operation a batch sends its rows to; a row receipt counts only under it.
  v_row_operation text := CASE split_part(p_request_key, ':', 1)
    WHEN 'adjust_inventory_batch' THEN 'adjust_inventory' END;
  v_reason text;
  v_signing bytea;
  v_first_us bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  -- Any active staff account (not a service profile), for its own requests only (below).
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true
                   AND role IN ('admin', 'sales_rep', 'driver', 'applicator')) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only an active staff account can clear a stuck request' USING ERRCODE = '42501';
  END IF;
  IF p_request_key IS NULL OR p_request_key !~ ('^[a-z0-9_]+:' || v_actor::text
    || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'REQUEST_KEY_NOT_OWNED: only your own request can be retired' USING ERRCODE = '22023';
  END IF;
  -- The request key is this call's idempotency key.
  IF p_idempotency_key IS NOT NULL AND p_idempotency_key IS DISTINCT FROM p_request_key THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_MISMATCH: the idempotency key must be the request key' USING ERRCODE = '22023';
  END IF;

  -- The request's lock: held by a save of this key, and shared by a batch row's
  -- receipt insert. Held here until this transaction ends, so no receipt of this
  -- request or its rows can be added meanwhile.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('crx:idempotency:' || p_request_key, 0)) THEN
    RETURN jsonb_build_object('safe', false, 'reason', 'in_progress', 'checked_at', clock_timestamp());
  END IF;
  -- Wall-clock time, not now(): now() is frozen at the start of the transaction.
  v_now := clock_timestamp();
  v_now_us := (extract(epoch FROM v_now) * 1000000)::bigint;

  IF EXISTS (SELECT 1 FROM public.retired_uncertain_requests WHERE request_key = p_request_key) THEN
    RETURN jsonb_build_object('safe', true, 'reason', 'retired', 'checked_at', v_now);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.idempotency_keys i
     WHERE (i.request_actor_id IS NULL OR i.request_actor_id = v_actor)
       AND ((i.idempotency_key = p_request_key AND i.operation = split_part(p_request_key, ':', 1))
         OR (v_row_operation IS NOT NULL AND i.operation = v_row_operation
             AND i.idempotency_key ~ ('^' || p_request_key || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
  ) THEN
    v_reason := 'recorded';
  ELSE
    SELECT signing_key INTO v_signing FROM public.uncertain_request_clear_check_key WHERE singleton;
    IF v_signing IS NULL THEN RAISE EXCEPTION 'CLEAR_CHECK_KEY_MISSING'; END IF;
    -- Token: "<server microseconds>.<hmac of request key and time>"; only a token
    -- this function signed for this request counts.
    IF p_first_check_token ~ '^[0-9]{1,18}\.[0-9a-f]{64}$'
       AND split_part(p_first_check_token, '.', 2) = encode(extensions.hmac(convert_to(
         p_request_key || '|' || split_part(p_first_check_token, '.', 1), 'UTF8'), v_signing, 'sha256'), 'hex')
    THEN
      v_first_us := split_part(p_first_check_token, '.', 1)::bigint;
    END IF;
    IF v_first_us IS NULL OR v_first_us > v_now_us THEN
      RETURN jsonb_build_object('safe', false, 'reason', 'first_check', 'checked_at', v_now,
        'wait_until', v_now + interval '15 minutes',
        'first_check_token', v_now_us::text || '.' || encode(extensions.hmac(convert_to(
          p_request_key || '|' || v_now_us::text, 'UTF8'), v_signing, 'sha256'), 'hex'));
    END IF;
    IF v_now_us < v_first_us + v_wait_us THEN
      RETURN jsonb_build_object('safe', false, 'reason', 'waiting', 'checked_at', v_now,
        'wait_until', to_timestamp((v_first_us + v_wait_us) / 1000000.0));
    END IF;
    v_reason := 'not_recorded_after_wait';
  END IF;

  -- Safe: retire the request, so the receipt guard refuses any later save of it or
  -- of any row under it. This row is also this call's idempotency receipt.
  INSERT INTO public.retired_uncertain_requests (request_key, retired_by, retired_at, reason)
  VALUES (p_request_key, v_actor, v_now, v_reason);
  RETURN jsonb_build_object('safe', true, 'reason', v_reason, 'checked_at', v_now);
END;
$function$;

ALTER FUNCTION public.retire_uncertain_request(text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.retire_uncertain_request(text, text, text)
  FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.retire_uncertain_request(text, text, text) TO authenticated;

DO $postflight$
BEGIN
  IF md5(replace((SELECT prosrc FROM pg_proc
                   WHERE oid = 'public.retire_uncertain_request(text,text,text)'::regprocedure), chr(13), ''))
     <> 'addf6df43b0e9d23c91e88dba315a1d0' THEN
    RAISE EXCEPTION 'POSTFLIGHT_RETIRE_UNCERTAIN_REQUEST_BODY: the installed body is not this migration''s';
  END IF;
  IF has_function_privilege('anon', 'public.retire_uncertain_request(text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.retire_uncertain_request(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_RETIRE_UNCERTAIN_REQUEST_GRANTS: EXECUTE is not authenticated-only';
  END IF;
END
$postflight$;
