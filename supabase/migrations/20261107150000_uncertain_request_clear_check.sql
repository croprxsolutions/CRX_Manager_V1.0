-- idempotency-body-check: exempt
-- (retire_uncertain_request's receipt is its retired_uncertain_requests row, keyed by
-- the request key it is given as its idempotency key; a repeat finds it and answers
-- 'retired' without writing. It cannot use idempotency_keys: the request key may
-- already hold the request's own receipt there.)
--
-- KI-27: server-side check, and retire, before an admin clears a stuck "uncertain"
-- request from their own browser (PR #1485's "I checked the records - clear this").
-- Admins only, for their own keys only, matching the admin-only button.
--
-- Why: the browser judged that a stuck request had expired with the device's own
-- clock. A clock that jumped forward could let a request that is still being saved
-- be cleared, and the form could then send the same change again as a duplicate
-- payment or stock change. This function lets the SERVER decide, so the device clock
-- is never trusted:
--   * in_progress  - a transaction holding this request's idempotency lock is running
--                    right now (check_idempotency_intent and the receipt insert guard
--                    take it; a batch row's receipt insert takes it shared): refuse.
--   * recorded     - the request key is recorded under the operation it names, or a
--                    row of the batch it names is recorded under the operation its
--                    rows are sent to (this actor, when the receipt records one):
--                    something saved, clear is safe.
--   * first_check  - nothing recorded, nothing running: returns first_check_token, the
--                    server's time signed for this request; ask again 15+ minutes later.
--   * waiting      - asked again too soon (by the signed server time): refuse.
--   * not_recorded_after_wait - nothing recorded on two checks 15+ minutes apart by
--                    server time. authenticated statements stop after 8 seconds (live
--                    pg_roles: authenticated statement_timeout=8s, checked 2026-11-05)
--                    and the API gateway gives up long before 15 minutes: clear is safe.
--   * retired      - an earlier safe answer already retired this request.
--
-- Every safe answer RETIRES the request: it records the key in
-- retired_uncertain_requests under the request's lock. The receipt insert guard
-- (re-issued below) then refuses any later save of that key, or of any row of an
-- inventory batch under it ("<adjust_inventory_batch key>:<anything>"), with IDEMPOTENCY_REQUEST_RETIRED - from any
-- tab, whatever rows the browser knows about, expired receipts included - on the one
-- path that saves a new receipt (no live receipt of the key). Every saving RPC writes its receipt in the same transaction as its work,
-- so a refused receipt rolls the work back. Replays of a saved receipt are untouched.
--
-- The first check's time travels in the browser as a token signed with a random key
-- that never leaves the database (uncertain_request_clear_check_key), bound to the
-- request key, so a caller cannot invent an earlier first check or reuse one from
-- another request. A missing, damaged or future token starts a new wait.
--
-- "Not recorded" does not mean "never saved" (receipts expire after 24 hours), so the
-- screen must still say "check the records" before it clears.
--
-- Times come from clock_timestamp(), so a long-open transaction cannot shorten the wait.
--
-- SECURITY DEFINER is required because idempotency_keys and both new tables have RLS
-- with deny-all policies. It never reveals or retires another user's request: the key
-- must be one this caller minted, "<operation>:<auth.uid()>:<uuid>"
-- (generateIdempotencyKey's format). request_actor_id cannot be used instead because
-- older receipts leave it NULL.

CREATE TABLE public.uncertain_request_clear_check_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  signing_key bytea NOT NULL CHECK (octet_length(signing_key) = 32)
);
ALTER TABLE public.uncertain_request_clear_check_key ENABLE ROW LEVEL SECURITY;
CREATE POLICY "No direct client access to the clear-check key"
  ON public.uncertain_request_clear_check_key FOR ALL USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.uncertain_request_clear_check_key
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
INSERT INTO public.uncertain_request_clear_check_key (signing_key)
  VALUES (extensions.gen_random_bytes(32));

CREATE TABLE public.retired_uncertain_requests (
  request_key text PRIMARY KEY CHECK (request_key ~
    '^[a-z0-9_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  retired_by uuid NOT NULL REFERENCES public.profiles(id),
  retired_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (reason IN ('recorded', 'not_recorded_after_wait'))
);
ALTER TABLE public.retired_uncertain_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "No direct client access to retired requests"
  ON public.retired_uncertain_requests FOR ALL USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.retired_uncertain_requests
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Re-issued from 20260716160000 with one addition: the retired-request check.
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
      'IDEMPOTENCY_REQUEST_RETIRED: idempotency_key % belongs to a request an admin cleared; it cannot be saved',
      NEW.idempotency_key;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_idempotency_key_insert()
  FROM PUBLIC, anon, authenticated;

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
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND role = 'admin' AND is_active = true) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only an admin can clear a stuck request' USING ERRCODE = '42501';
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
