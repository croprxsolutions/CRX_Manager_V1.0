-- KI-27: server-side check before an admin clears a stuck "uncertain" request
-- from their own browser (PR #1485's "I checked the records - clear this").
-- Any active profile may call it, for its own keys only: the answer reveals
-- nothing new and authorizes nothing, so the admin-only limit stays in the screen.
--
-- Why: the browser judged that a stuck request had expired with the device's own
-- clock. A clock that jumped forward could let a request that is still being
-- saved be cleared, and the form could then send the same change again as a
-- duplicate payment or stock change. This function lets the SERVER decide, so
-- the device clock is never trusted:
--   * recorded     - the key is in idempotency_keys: the request saved, clear is safe.
--   * in_progress  - a transaction holding this key's idempotency lock is running
--                    right now (check_idempotency_intent takes the same lock): refuse.
--   * first_check  - not recorded, not running: returns first_check_token, the
--                    server's time signed for this key; ask again 15+ minutes later.
--   * waiting      - asked again too soon (by the signed server time): refuse.
--   * not_recorded_after_wait - not recorded on two checks 15+ minutes apart by
--                    server time. authenticated statements stop after 8 seconds
--                    (live pg_roles: authenticated statement_timeout=8s, checked
--                    2026-11-05) and the API gateway gives up long before 15 minutes,
--                    so the request can no longer commit: clear is safe.
--
-- The first check's time travels in the browser as a token signed with a random
-- key that never leaves the database (uncertain_request_clear_check_key), bound
-- to the request key, so a caller cannot invent an earlier first check or reuse
-- one from another request. A missing, damaged or future token starts a new wait.
--
-- Caller contract: stop every retry of the key before the first check and never
-- send it again after a clear; and "not recorded" does not mean "never saved"
-- (receipts expire after 24 hours), so the screen must still say "check the records".
--
-- Read-only: no table writes, so no p_idempotency_key parameter is needed (the
-- AGENTS.md idempotency rule covers mutating RPCs). The only side effect is a
-- try-lock that is released when the call's transaction ends.
--
-- SECURITY DEFINER is required because idempotency_keys and the signing-key table
-- have RLS with deny-all policies. It never reveals another user's keys: the key
-- must be one this caller minted, "<operation>:<auth.uid()>:<uuid>"
-- (generateIdempotencyKey's format). request_actor_id cannot be used instead
-- because older receipts leave it NULL.

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

CREATE OR REPLACE FUNCTION public.check_uncertain_request_clearable(
  p_request_key text,
  p_first_check_token text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_wait_us bigint := 15 * 60 * 1000000;
  v_now_us bigint := (extract(epoch FROM now()) * 1000000)::bigint;
  v_key bytea;
  v_first_us bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (SELECT public.is_active_profile()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  IF p_request_key IS NULL OR p_request_key !~ (
    '^[a-z0-9_]+:' || v_actor::text
    || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'REQUEST_KEY_NOT_OWNED: only your own request can be checked' USING ERRCODE = '22023';
  END IF;

  -- Same lock key as check_idempotency_intent; held until a saving transaction ends.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('crx:idempotency:' || p_request_key, 0)) THEN
    RETURN jsonb_build_object('safe', false, 'reason', 'in_progress', 'checked_at', now());
  END IF;

  IF EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = p_request_key) THEN
    RETURN jsonb_build_object('safe', true, 'reason', 'recorded', 'checked_at', now());
  END IF;

  SELECT signing_key INTO v_key FROM public.uncertain_request_clear_check_key WHERE singleton;
  IF v_key IS NULL THEN RAISE EXCEPTION 'CLEAR_CHECK_KEY_MISSING'; END IF;

  -- Token: "<server microseconds>.<hmac of key and time>"; only a token this function signed counts.
  IF p_first_check_token ~ '^[0-9]{1,18}\.[0-9a-f]{64}$'
     AND split_part(p_first_check_token, '.', 2) = encode(extensions.hmac(
       convert_to(p_request_key || '|' || split_part(p_first_check_token, '.', 1), 'UTF8'), v_key, 'sha256'), 'hex')
  THEN
    v_first_us := split_part(p_first_check_token, '.', 1)::bigint;
  END IF;

  IF v_first_us IS NULL OR v_first_us > v_now_us THEN
    RETURN jsonb_build_object('safe', false, 'reason', 'first_check', 'checked_at', now(),
      'wait_until', now() + interval '15 minutes',
      'first_check_token', v_now_us::text || '.' || encode(extensions.hmac(
        convert_to(p_request_key || '|' || v_now_us::text, 'UTF8'), v_key, 'sha256'), 'hex'));
  END IF;
  IF v_now_us < v_first_us + v_wait_us THEN
    RETURN jsonb_build_object('safe', false, 'reason', 'waiting', 'checked_at', now(),
      'wait_until', to_timestamp((v_first_us + v_wait_us) / 1000000.0));
  END IF;
  RETURN jsonb_build_object('safe', true, 'reason', 'not_recorded_after_wait', 'checked_at', now());
END;
$function$;

ALTER FUNCTION public.check_uncertain_request_clearable(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_uncertain_request_clearable(text, text)
  FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.check_uncertain_request_clearable(text, text) TO authenticated;
