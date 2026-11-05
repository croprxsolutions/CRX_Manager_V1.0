-- KI-27: server-side check, and retire, before an admin clears a stuck "uncertain"
-- request from their own browser (PR #1485's "I checked the records - clear this").
-- Any active profile may call it, for its own keys only: the answer reveals nothing
-- new, and the only write retires keys that never saved, so the admin-only limit
-- stays in the screen.
--
-- Why: the browser judged that a stuck request had expired with the device's own
-- clock. A clock that jumped forward could let a request that is still being saved
-- be cleared, and the form could then send the same change again as a duplicate
-- payment or stock change. This function lets the SERVER decide, so the device clock
-- is never trusted. It looks at the request key and, for a batch, every row key the
-- batch sent (a batch saves each row under "<request key>:<row uuid>"):
--   * in_progress  - a transaction holding the idempotency lock of one of the keys
--                    is running right now (check_idempotency_intent and the receipt
--                    insert guard take the same lock): refuse; ask again shortly.
--   * recorded     - the request key is recorded under the operation it names, or a
--                    row key is recorded (this actor, when the receipt records one):
--                    something saved, clear is safe.
--   * first_check  - nothing recorded, nothing running: returns first_check_token, the
--                    server's time signed for this request; ask again 15+ minutes later.
--   * waiting      - asked again too soon (by the signed server time): refuse.
--   * not_recorded_after_wait - nothing recorded on two checks 15+ minutes apart by
--                    server time. authenticated statements stop after 8 seconds (live
--                    pg_roles: authenticated statement_timeout=8s, checked 2026-11-05)
--                    and the API gateway gives up long before 15 minutes: clear is safe.
--   * retired      - this request was already retired by an earlier safe answer.
--
-- Every safe answer RETIRES each key that still has no receipt: it writes a
-- 'retire_uncertain_request' receipt under that key's lock, so any later send of the
-- key, from any tab, is refused by the database (IDEMPOTENCY_CROSS_OP_KEY_REUSE) and
-- cannot save after the clear. A key that already has a receipt never saves again
-- while that receipt lasts (a resend replays it or is refused), but the next send
-- deletes an expired receipt, so each of the request's receipts is kept for 30 days
-- from the safe answer. Retire receipts also last 30 days, far beyond any retry.
--
-- The first check's time travels in the browser as a token signed with a random key
-- that never leaves the database (uncertain_request_clear_check_key), bound to the
-- request key and its row keys, so a caller cannot invent an earlier first check or
-- reuse one from another request. A missing, damaged or future token starts a new wait.
--
-- "Not recorded" does not mean "never saved" (receipts expire after 24 hours), so the
-- screen must still say "check the records" before it clears.
--
-- Idempotency: the request key is this call's idempotency key. p_idempotency_key, if
-- sent, must equal it; a repeat after a safe answer finds its own retire receipt and
-- answers 'retired' (it only renews the 30-day barrier). Times come from clock_timestamp(), so a
-- long-open transaction cannot shorten the wait.
--
-- SECURITY DEFINER is required because idempotency_keys and the signing-key table have
-- RLS with deny-all policies. It never reveals or retires another user's keys: the key
-- must be one this caller minted, "<operation>:<auth.uid()>:<uuid>"
-- (generateIdempotencyKey's format), and every row key must extend it.
-- request_actor_id cannot be used instead because older receipts leave it NULL.

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

CREATE OR REPLACE FUNCTION public.retire_uncertain_request(
  p_request_key text,
  p_row_keys text[] DEFAULT NULL,
  p_first_check_token text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  -- Wall-clock time, not now(): now() is frozen at the start of the transaction.
  v_now timestamptz := clock_timestamp();
  v_now_us bigint := (extract(epoch FROM v_now) * 1000000)::bigint;
  v_wait_us bigint := 15 * 60 * 1000000;
  v_uuid constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  v_keys text[];
  v_rows text;
  v_open text[];
  v_k text;
  v_reason text;
  v_signing bytea;
  v_first_us bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (SELECT public.is_active_profile()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF p_request_key IS NULL OR p_request_key !~ ('^[a-z0-9_]+:' || v_actor::text || ':' || v_uuid || '$') THEN
    RAISE EXCEPTION 'REQUEST_KEY_NOT_OWNED: only your own request can be retired' USING ERRCODE = '22023';
  END IF;
  -- The request key is this call's idempotency key: a repeat finds its own retire receipt.
  IF p_idempotency_key IS NOT NULL AND p_idempotency_key IS DISTINCT FROM p_request_key THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_MISMATCH: the idempotency key must be the request key' USING ERRCODE = '22023';
  END IF;
  IF cardinality(p_row_keys) > 500 THEN
    RAISE EXCEPTION 'TOO_MANY_ROW_KEYS: at most 500 row keys' USING ERRCODE = '22023';
  END IF;
  -- Row keys are "<request key>:<uuid>" (a batch sends each row under one); p_request_key
  -- was checked above, so it holds no regex metacharacters.
  IF EXISTS (SELECT 1 FROM unnest(p_row_keys) r WHERE r IS NULL OR r !~ ('^' || p_request_key || ':' || v_uuid || '$')) THEN
    RAISE EXCEPTION 'REQUEST_KEY_NOT_OWNED: a row key is not part of this request' USING ERRCODE = '22023';
  END IF;
  v_keys := ARRAY[p_request_key] || ARRAY(SELECT DISTINCT r FROM unnest(p_row_keys) r ORDER BY r);
  v_rows := array_to_string(v_keys[2:], ',');

  -- Lock every key: the same lock check_idempotency_intent and the receipt insert
  -- guard take, held until a saving transaction ends. Busy means a save (or a
  -- resend removing an expired receipt) is running right now; ask again shortly.
  FOREACH v_k IN ARRAY v_keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('crx:idempotency:' || v_k, 0)) THEN
      RETURN jsonb_build_object('safe', false, 'reason', 'in_progress', 'checked_at', v_now);
    END IF;
  END LOOP;
  -- Under the locks no receipt of these keys can be added or removed until this
  -- transaction ends. Keys with no receipt could still be saved by a request that
  -- has not arrived yet.
  SELECT array_agg(k ORDER BY k) INTO v_open FROM unnest(v_keys) k
   WHERE NOT EXISTS (SELECT 1 FROM public.idempotency_keys i WHERE i.idempotency_key = k);

  IF EXISTS (
    SELECT 1 FROM public.idempotency_keys i
     WHERE i.idempotency_key = ANY (v_keys)
       AND (i.request_actor_id IS NULL OR i.request_actor_id = v_actor)
       AND i.operation <> 'retire_uncertain_request'
       -- The request key counts only under the operation it names; a row key under any.
       AND (i.idempotency_key <> p_request_key OR i.operation = split_part(p_request_key, ':', 1))
  ) THEN
    v_reason := 'recorded';
  ELSIF EXISTS (
    SELECT 1 FROM public.idempotency_keys i
     WHERE i.idempotency_key = p_request_key AND i.operation = 'retire_uncertain_request'
       AND i.request_actor_id = v_actor
  ) THEN
    v_reason := 'retired';
  ELSE
    SELECT signing_key INTO v_signing FROM public.uncertain_request_clear_check_key WHERE singleton;
    IF v_signing IS NULL THEN RAISE EXCEPTION 'CLEAR_CHECK_KEY_MISSING'; END IF;
    -- Token: "<server microseconds>.<hmac of request key, time, row keys>"; only a
    -- token this function signed for this exact request counts.
    IF p_first_check_token ~ '^[0-9]{1,18}\.[0-9a-f]{64}$'
       AND split_part(p_first_check_token, '.', 2) = encode(extensions.hmac(convert_to(
         p_request_key || '|' || split_part(p_first_check_token, '.', 1) || '|' || v_rows, 'UTF8'), v_signing, 'sha256'), 'hex')
    THEN
      v_first_us := split_part(p_first_check_token, '.', 1)::bigint;
    END IF;
    IF v_first_us IS NULL OR v_first_us > v_now_us THEN
      RETURN jsonb_build_object('safe', false, 'reason', 'first_check', 'checked_at', v_now,
        'wait_until', v_now + interval '15 minutes',
        'first_check_token', v_now_us::text || '.' || encode(extensions.hmac(convert_to(
          p_request_key || '|' || v_now_us::text || '|' || v_rows, 'UTF8'), v_signing, 'sha256'), 'hex'));
    END IF;
    IF v_now_us < v_first_us + v_wait_us THEN
      RETURN jsonb_build_object('safe', false, 'reason', 'waiting', 'checked_at', v_now,
        'wait_until', to_timestamp((v_first_us + v_wait_us) / 1000000.0));
    END IF;
    v_reason := 'not_recorded_after_wait';
  END IF;

  -- Safe: retire every key that still has no receipt, under its lock, so a late
  -- resend from any tab is refused by the database (IDEMPOTENCY_CROSS_OP_KEY_REUSE).
  INSERT INTO public.idempotency_keys
    (idempotency_key, operation, result, request_actor_id, request_fingerprint, expires_at)
  SELECT k, 'retire_uncertain_request',
         jsonb_build_object('retired_at', v_now, 'request_key', p_request_key),
         v_actor, 'retired', v_now + interval '30 days'
    FROM unnest(coalesce(v_open, '{}')) k;
  -- A key that has a receipt never saves again while the receipt lasts (a resend
  -- replays it or is refused), but the next send deletes an expired one; keep every
  -- receipt of this request for 30 days from now.
  UPDATE public.idempotency_keys SET expires_at = v_now + interval '30 days'
   WHERE idempotency_key = ANY (v_keys) AND expires_at < v_now + interval '30 days';
  RETURN jsonb_build_object('safe', true, 'reason', v_reason, 'checked_at', v_now,
    'retired_keys', cardinality(coalesce(v_open, '{}')));
END;
$function$;

ALTER FUNCTION public.retire_uncertain_request(text, text[], text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.retire_uncertain_request(text, text[], text, text)
  FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.retire_uncertain_request(text, text[], text, text) TO authenticated;
