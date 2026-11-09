-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261221100000_close_delivery_receipt.md.
-- Re-read the live ledger before applying.
--
-- WHAT (KI-25 follow-up, Sol MED on PRs #1647 and #1649): one new office call, close_delivery_receipt, so the server
--   sender (send-delivery-receipts) never emails a customer receipt the office has dealt with, and never a second copy
--   after the office sends one by hand with Email Confirmation.
--   p_reason 'handled': the receipt is dealt with (from the "Customer receipts to check" list, or by Email Confirmation
--     after its hand send went out). A pending, needs_check or not-in-flight sending row becomes 'cancelled' (claim
--     cleared, so the worker's confirm answers 'stale' and sends nothing) and leaves the office list.
--   p_reason 'manual_send': called by Email Confirmation BEFORE the hand send. The same rows become 'needs_check'
--     (paused: the worker never claims needs_check, and the row is on the office list) rather than cancelled, so a
--     hand send that then fails leaves the receipt on the list instead of lost (Mason, 2026-11-05: a duplicate is
--     preferred to a lost receipt). After the hand send succeeds the screen calls 'handled'.
--   last_error says who did it and why (keeping a needs_check row's earlier message once).
--   A row whose send the worker has confirmed and may be emailing right now (inside its 10-minute lease) is refused
--   with DELIVERY_RECEIPT_SENDING (try again in a minute). A sent row is unchanged and answered 'sent'. No row, or a
--   cancelled one: 'none'. Every answer carries sent_at and send_authorized_at (an email may already have gone out),
--   so the screen can ask before sending another copy; never the address (the screen has it).
--   Who: an active admin or sales rep only. Drivers never see Email Confirmation or the office list, so a driver
--     cannot quietly cancel a receipt the office would never see (Sol HIGH, PR #1678).
--   The worker's three calls, the queue table, its triggers and grants are not changed.
--   A cancelled receipt whose delivery is later completed again, with no send ever authorized, gets a fresh receipt,
--   as _enqueue_delivery_receipt already does for any cancelled row.
--
-- idempotency-body-check: exempt -- close_delivery_receipt requires p_idempotency_key and checks it with
--   check_idempotency_intent (bound to the caller and request: delivery and reason), after authorizing the caller;
--   it saves its first answer with save_idempotency and binds it with _bind_replay_receipt_20261015 in the same
--   transaction. A retry with a used key is refused unless it is the same caller and request, and then re-checks the
--   receipt as it is now instead of returning the saved answer (both transitions are safe to repeat), so a stale
--   answer can never stand for a receipt that changed since (Sol HIGH, PR #1678). A retry acts only on the receipt its
--   key first saw (the answer's queued_at): if the delivery was completed again and its receipt re-queued since, the
--   retry changes nothing and is refused with DELIVERY_RECEIPT_CHANGED (Sol HIGH, round 8). A refused call
--   (DELIVERY_RECEIPT_SENDING) rolls back and saves nothing.
--
-- actor-binding-check: exempt -- the actor is auth.uid() only; there is no p_performed_by parameter.
--
-- NOT CHANGED: delivery_receipt_queue (columns, CHECKs, RLS, grants, triggers), complete_delivery,
--   _enqueue_delivery_receipt, claim_delivery_receipts, confirm_delivery_receipt_send, finish_delivery_receipt,
--   the timer. No existing row changes at apply.
--
-- ROLLBACK (its own reviewed migration): DROP FUNCTION public.close_delivery_receipt(uuid, text, text). Rows it
--   closed stay cancelled and rows it paused stay on the office list (ordinary queue rows).

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.close_delivery_receipt(uuid, text, text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'close_delivery_receipt') THEN
    RAISE EXCEPTION 'PREFLIGHT_CLOSE_DELIVERY_RECEIPT_DRIFT: close_delivery_receipt already exists';
  END IF;
  IF to_regclass('public.delivery_receipt_queue') IS NULL
     OR to_regprocedure('public.confirm_delivery_receipt_send(uuid, uuid, text)') IS NULL
     OR to_regprocedure('public.check_idempotency_intent(text, text, uuid, text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text, text, jsonb)') IS NULL
     OR to_regprocedure('public._bind_replay_receipt_20261015(text, text, text)') IS NULL
     OR to_regprocedure('public._replay_fingerprint_20261015(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_CLOSE_DELIVERY_RECEIPT_DRIFT: the receipt queue (20261113140000) or an idempotency helper is missing';
  END IF;
  -- The statuses this file writes and reads must be the queue's own.
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.delivery_receipt_queue'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) = 'CHECK ((status = ANY (ARRAY[''pending''::text, ''sending''::text, ''sent''::text, ''needs_check''::text, ''cancelled''::text])))') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_CLOSE_DELIVERY_RECEIPT_DRIFT: delivery_receipt_queue status values differ from 20261113140000';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.close_delivery_receipt(
  p_delivery_id uuid,
  p_reason text,
  p_idempotency_key text DEFAULT NULL
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

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'delivery_id', p_delivery_id, 'reason', p_reason));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'close_delivery_receipt', v_actor, v_fingerprint);
  -- A matching retry (v_replay found) is not answered from the saved result: it re-checks the receipt below, so a row
  -- that changed since (closed by someone else, or re-queued by a second completion) gets its current answer. Closing
  -- and pausing are both safe to repeat. 'paused' is a go-ahead, not an exclusive permission: two office users
  -- pressing Email Confirmation at once may both send, a void after the go-ahead does not stop the hand send, and
  -- another office user may mark it handled while a hand send is still going (the sender sees a failure and can press
  -- again). Mason accepted all three on 2026-11-09 (DECISION_LOG.md, "Email Confirmation stays a hand send").

  -- Same lock confirm_delivery_receipt_send takes first, so the two never interleave: whichever commits first wins.
  SELECT * INTO v_row FROM public.delivery_receipt_queue q WHERE q.delivery_id = p_delivery_id FOR UPDATE;
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
ALTER FUNCTION public.close_delivery_receipt(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_delivery_receipt(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_delivery_receipt(uuid, text, text) TO authenticated;
COMMENT ON FUNCTION public.close_delivery_receipt(uuid, text, text) IS
  'KI-25 office call: handled = cancel a queued customer receipt so the server never sends it; manual_send = pause it on the office list (needs_check) before Email Confirmation sends by hand. Outcome closed / paused / sent / none, with sent_at and send_authorized_at; refuses DELIVERY_RECEIPT_SENDING while a confirmed send may be in flight. Active admin or sales rep only. Key required, bound to caller and request.';

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = 'public.close_delivery_receipt(uuid, text, text)'::regprocedure;
  IF NOT p.prosecdef OR p.proowner <> 'postgres'::regrole
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     OR has_function_privilege('anon', p.oid, 'EXECUTE')
     OR has_function_privilege('service_role', p.oid, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) THEN
    RAISE EXCEPTION 'POSTFLIGHT: close_delivery_receipt lost its owner, mode, search_path or grants';
  END IF;
END;
$postflight$;
