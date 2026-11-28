-- Written 2026-11-24. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270301220000_mark_handled_admin_only.md.
--
-- WHAT (Mason, Slack 2026-11-23, Taha's review item 6): "Mark handled" on a customer receipt is admin-only.
--   close_delivery_receipt(..., 'handled') from anyone but an admin is refused with RECEIPT_HANDLED_ADMIN_ONLY (42501)
--   when it would close a receipt. No exception for a rep's own hand send (Mason, 2026-11-24, after Sol r2: an email
--   log cannot prove what a rep's email said or where it really went): the rep's Email Confirmation still pauses the
--   receipt and sends the email, and the receipt stays on "Customer receipts to check" until an admin marks it handled.
--   A non-admin's 'handled' that would change nothing (none / sent) or hits the in-flight refusal answers as before.
--   Admins, 'manual_send', the expected-receipt check and every other line of 20270223120000's body: unchanged.
--
-- idempotency-body-check: exempt -- as 20270223120000: p_idempotency_key is required and checked with
--   check_idempotency_intent, bound to caller and request; saved with save_idempotency and bound with
--   _bind_replay_receipt_20261015 in the same transaction. The new refusal rolls back and saves nothing.
--
-- actor-binding-check: exempt -- the actor is auth.uid() only; there is no p_performed_by parameter.
--
-- NOT CHANGED: tables, rows, triggers, RLS, grants, the worker's calls, _enqueue_delivery_receipt.
--
-- ROLLOUT: CREATE OR REPLACE, same signature, so PostgREST and the deployed app's calls are unchanged. The deployed
--   app's rep screens get the refusal as a "Nothing was changed" message until the app update ships.
--
-- ROLLBACK (its own reviewed migration): CREATE OR REPLACE 20270223120000's body.-- ROLLBACK (its own reviewed migration): CREATE OR REPLACE 20270223120000's body; the columns can stay (unused).

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.close_delivery_receipt(uuid, text, text, timestamptz)') IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'close_delivery_receipt') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_CLOSE_DELIVERY_RECEIPT_DRIFT: expected exactly the four-argument close_delivery_receipt (20270223120000)';
  END IF;
  -- The body below is 20270223120000's plus the admin-only rule: refuse if the installed body is any other.
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.close_delivery_receipt(uuid, text, text, timestamptz)'::regprocedure) <> '8ca6b2b787e780cbd4dc4daeb8f00388' THEN
    RAISE EXCEPTION 'PREFLIGHT_CLOSE_DELIVERY_RECEIPT_DRIFT: close_delivery_receipt body differs from 20270223120000';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.close_delivery_receipt(
  p_delivery_id uuid,
  p_reason text,
  p_idempotency_key text DEFAULT NULL,
  p_expected_queued_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_name text;
  v_fingerprint text;
  v_replay jsonb;
  v_row public.delivery_receipt_queue%ROWTYPE;
  v_result jsonb;
  v_outcome text;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: close_delivery_receipt requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_delivery_id IS NULL OR p_reason IS NULL OR p_reason NOT IN ('handled', 'manual_send') THEN
    RAISE EXCEPTION 'RECEIPT_CLOSE_INVALID: p_delivery_id and p_reason (handled or manual_send) are required' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  -- FOR SHARE: a concurrent demotion or deactivation waits until this call ends.
  SELECT p.role, p.full_name INTO v_role, v_name FROM public.profiles p WHERE p.id = v_actor AND p.is_active = true FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only the office (admin or sales rep) can close a delivery receipt'
      USING ERRCODE = '42501';
  END IF;
  -- A hand send is only for a completed, not deleted delivery (the server sender's own rule). Checked before a replay,
  -- so a retry after a void cannot reuse an earlier go-ahead; FOR SHARE holds off a void until this call ends (Sol HIGH, #1678).
  IF p_reason = 'manual_send' THEN
    PERFORM 1 FROM public.deliveries d
     WHERE d.id = p_delivery_id AND d.status = 'completed' AND d.deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'DELIVERY_NOT_COMPLETED: this delivery is not completed any more; do not send its receipt'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  -- The expected receipt is part of the request only when given, so a NULL call fingerprints as 20261221100000 did.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'delivery_id', p_delivery_id, 'reason', p_reason)
    || CASE WHEN p_expected_queued_at IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('expected_queued_at', extract(epoch FROM p_expected_queued_at)::text) END);
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'close_delivery_receipt', v_actor, v_fingerprint);
  -- A matching retry (v_replay found) is not answered from the saved result: it re-checks the receipt below, so a row
  -- that changed since (closed by someone else, or re-queued by a second completion) gets its current answer. Closing
  -- and pausing are both safe to repeat. 'paused' is a go-ahead, not an exclusive permission: two office users
  -- pressing Email Confirmation at once may both send, a void after the go-ahead does not stop the hand send, and
  -- another office user may mark it handled while a hand send is still going (the sender sees a failure and can press
  -- again). Mason accepted all three on 2026-11-09 (DECISION_LOG.md, "Email Confirmation stays a hand send").

  -- Same lock confirm_delivery_receipt_send takes first, so the two never interleave: whichever commits first wins.
  SELECT * INTO v_row FROM public.delivery_receipt_queue q WHERE q.delivery_id = p_delivery_id FOR UPDATE;
  -- The screen said which receipt it means: act on no other (#2251). No row counts as a different receipt.
  IF p_expected_queued_at IS NOT NULL AND v_row.created_at IS DISTINCT FROM p_expected_queued_at THEN
    RAISE EXCEPTION 'DELIVERY_RECEIPT_CHANGED: this delivery''s receipt was queued again since; reload the page'
      USING ERRCODE = '55000';
  END IF;
  -- A retry acts only on the receipt its key first saw: a second completion re-queues the receipt with a new created_at,
  -- and an old retry must neither cancel that new receipt nor give a go-ahead to send it.
  IF v_replay IS NOT NULL
     AND v_row.created_at IS DISTINCT FROM (v_replay -> 'result' ->> 'queued_at')::timestamptz THEN
    RAISE EXCEPTION 'DELIVERY_RECEIPT_CHANGED: this delivery''s receipt was queued again since; reload the page'
      USING ERRCODE = '55000';
  END IF;
  IF v_row.id IS NULL OR v_row.status = 'cancelled' THEN
    v_outcome := 'none';
  ELSIF v_row.status = 'sent' THEN
    v_outcome := 'sent';
  ELSIF v_row.status = 'sending' AND v_row.send_confirmed_token = v_row.claim_token
        AND v_row.claimed_at > clock_timestamp() - interval '10 minutes' THEN
    -- The worker was told to send and may be emailing it now (the same window _delivery_receipt_hold_while_sending holds).
    RAISE EXCEPTION 'DELIVERY_RECEIPT_SENDING: this delivery''s receipt is being emailed right now; try again in a minute'
      USING ERRCODE = '55006';
  ELSIF p_reason = 'handled' AND v_role <> 'admin' THEN
    -- Mason, 2026-11-23/24: only an admin marks a receipt handled, a rep's own hand send included.
    RAISE EXCEPTION 'RECEIPT_HANDLED_ADMIN_ONLY: only an admin can mark a customer receipt handled'
      USING ERRCODE = '42501';
  ELSE
    v_outcome := CASE WHEN p_reason = 'handled' THEN 'closed' ELSE 'paused' END;
    UPDATE public.delivery_receipt_queue
       SET status = CASE WHEN p_reason = 'handled' THEN 'cancelled' ELSE 'needs_check' END,
           claim_token = NULL, claimed_at = NULL,
           last_error = left(CASE WHEN p_reason = 'handled'
                                  THEN 'Marked handled by ' || left(COALESCE(v_name, 'staff'), 60) || '; the server will not send it.'
                                  ELSE 'Email Confirmation started by ' || left(COALESCE(v_name, 'staff'), 60)
                                       || '; the server will not send it. If the customer did not get it, send it again.' END
                             -- Keep why it was listed: an earlier Email Confirmation note passes on its own "Was:" part (Taha, LOW).
                             || CASE WHEN v_row.status <> 'needs_check' OR v_row.last_error IS NULL THEN ''
                                     WHEN v_row.last_error NOT LIKE 'Email Confirmation started by %' THEN ' Was: ' || v_row.last_error
                                     WHEN strpos(v_row.last_error, ' Was: ') > 0
                                     THEN substr(v_row.last_error, strpos(v_row.last_error, ' Was: '))
                                     ELSE '' END, 800)  -- room for the note plus a whole 500-character earlier message (Sol LOW)
     WHERE id = v_row.id;
  END IF;
  v_result := jsonb_build_object('delivery_id', p_delivery_id, 'outcome', v_outcome, 'previous_status', v_row.status,
                                 'sent_at', v_row.sent_at, 'send_authorized_at', v_row.send_authorized_at,
                                 'queued_at', v_row.created_at);  -- which receipt this answer is about (NULL: none)

  IF v_replay IS NULL THEN  -- first use of the key: save and bind its answer (a retry's key is already bound)
    PERFORM public.save_idempotency(p_idempotency_key, 'close_delivery_receipt', v_result);
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'close_delivery_receipt', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.close_delivery_receipt(uuid, text, text, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_delivery_receipt(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_delivery_receipt(uuid, text, text, timestamptz) TO authenticated;
COMMENT ON FUNCTION public.close_delivery_receipt(uuid, text, text, timestamptz) IS
  'KI-25 office call: handled = cancel a queued customer receipt so the server never sends it; manual_send = pause it on the office list (needs_check) before Email Confirmation sends by hand. Outcome closed / paused / sent / none, with sent_at, send_authorized_at and queued_at; refuses DELIVERY_RECEIPT_SENDING while a confirmed send may be in flight, and DELIVERY_RECEIPT_CHANGED when p_expected_queued_at is given and is not the queued receipt. Active admin or sales rep; handled is admin-only, a sales rep''s own hand send included (RECEIPT_HANDLED_ADMIN_ONLY). Key required, bound to caller and request.';

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'close_delivery_receipt') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT: close_delivery_receipt must have exactly one overload';
  END IF;
  SELECT * INTO p FROM pg_proc WHERE oid = 'public.close_delivery_receipt(uuid, text, text, timestamptz)'::regprocedure;
  IF NOT p.prosecdef OR p.proowner <> 'postgres'::regrole
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     OR has_function_privilege('anon', p.oid, 'EXECUTE')
     OR has_function_privilege('service_role', p.oid, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) THEN
    RAISE EXCEPTION 'POSTFLIGHT: close_delivery_receipt lost its owner, mode, search_path or grants';
  END IF;
  IF md5(replace(p.prosrc, chr(13), '')) <> 'ffacdf10bd86256e16534545bccc5708' THEN
    RAISE EXCEPTION 'POSTFLIGHT: close_delivery_receipt is not this migration''s body (admin-only rule)';
  END IF;
END;
$postflight$;
