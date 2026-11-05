-- KI-27: server-side check before an admin clears a stuck "uncertain" request
-- from their own browser (PR #1485's "I checked the records - clear this").
--
-- Why: the browser judged that a stuck request had expired with the device's own
-- clock. A clock that jumped forward could let a request that is still being
-- saved be cleared, and the form could then send the same change again as a
-- duplicate payment or stock change. This function lets the SERVER decide, so
-- the device clock is never trusted:
--   * recorded     - the key is in idempotency_keys: the request saved, clear is safe.
--   * in_progress  - a transaction holding this key's idempotency lock is running
--                    right now (check_idempotency_intent takes the same lock): refuse.
--   * first_check  - not recorded, not running: the server returns its own time as
--                    checked_at; the caller must ask again at least 15 minutes later.
--   * waiting      - asked again too soon (by server time): refuse.
--   * not_recorded_after_wait - not recorded on two checks 15+ minutes apart by
--                    server time. authenticated statements stop after 8 seconds
--                    (live pg_roles: authenticated statement_timeout=8s, checked
--                    2026-11-05) and the API gateway gives up long before 15 minutes,
--                    so the request can no longer commit: clear is safe.
--
-- Caller contract: stop every retry of the key before the first check and never
-- send it again after a clear; and "not recorded" does not mean "never saved"
-- (receipts expire after 24 hours), so the screen must still say "check the records".
--
-- p_first_checked_at must be a checked_at value this function returned earlier.
-- Carrying it in the browser is not a hole: the clear only removes saved data
-- from that same admin's browser storage, which they can already do by hand;
-- this check protects against a wrong clock, not against the admin.
--
-- Read-only: no table writes, so no p_idempotency_key parameter is needed (the
-- AGENTS.md idempotency rule covers mutating RPCs). The only side effect is a
-- try-lock that is released when the call's transaction ends.
--
-- SECURITY DEFINER is required because idempotency_keys has RLS with a deny-all
-- policy. It never reveals another user's keys: the key must be one this caller
-- minted, "<operation>:<auth.uid()>:<uuid>" (generateIdempotencyKey's format).
-- request_actor_id cannot be used instead because older receipts leave it NULL.

CREATE OR REPLACE FUNCTION public.check_uncertain_request_clearable(
  p_request_key text,
  p_first_checked_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_wait interval := interval '15 minutes';
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

  IF p_first_checked_at IS NULL OR p_first_checked_at > now() THEN
    RETURN jsonb_build_object('safe', false, 'reason', 'first_check', 'checked_at', now(),
      'wait_until', now() + v_wait);
  END IF;
  IF now() < p_first_checked_at + v_wait THEN
    RETURN jsonb_build_object('safe', false, 'reason', 'waiting', 'checked_at', now(),
      'wait_until', p_first_checked_at + v_wait);
  END IF;
  RETURN jsonb_build_object('safe', true, 'reason', 'not_recorded_after_wait', 'checked_at', now());
END;
$function$;

ALTER FUNCTION public.check_uncertain_request_clearable(text, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_uncertain_request_clearable(text, timestamptz)
  FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.check_uncertain_request_clearable(text, timestamptz) TO authenticated;
