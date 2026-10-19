-- Written 2026-10-19. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: one server call that starts AND completes a delivery in a single transaction, for the
--   Deliveries list's Mark Delivered (KNOWN_ISSUES.md, "the Deliveries list can leave a scheduled
--   delivery In Progress if signal drops between its two steps"). Today the list calls
--   confirm_delivery (scheduled -> in_progress) and then complete_delivery as two requests; signal
--   lost in the instant after the first answers leaves the delivery In Progress. Here both steps
--   run in one transaction: either the delivery ends completed or nothing changed.
--
--   start_and_complete_delivery(p_delivery_id, p_signed_by, p_delivered_on, p_performed_by,
--                               p_quantities, p_issue_type, p_issue_notes, p_idempotency_key)
--     1. requires a key (IDEMPOTENCY_KEY_REQUIRED, 22023), auth.uid() (AUTH_REQUIRED) and refuses a
--        p_performed_by naming someone else (ACTOR_MISMATCH) -- complete_delivery's tests and
--        messages;
--     2. requires p_delivered_on, the business date the person chose (America/Chicago), and refuses
--        one after today's Chicago date (DELIVERED_ON_IN_FUTURE);
--     3. fingerprints the actor and every argument (SHA-256, _replay_fingerprint_20261015) and calls
--        check_idempotency_intent under the per-key advisory lock. An exact retry by the same person
--        returns the saved result; a different person or request is refused
--        (IDEMPOTENCY_ACTOR_MISMATCH / IDEMPOTENCY_INTENT_MISMATCH). The fingerprint carries the
--        chosen DATE, not a derived timestamp, so an exact retry across Chicago midnight replays;
--     4. locks the delivery row; if it is scheduled, starts it by calling confirm_delivery keyless
--        (unchanged: same status change, activity row, driver notification and authorization);
--     5. completes it by calling complete_delivery under a derived key (<key>:complete), which
--        binds its own receipt as before. completed_at: NULL (the server's now()) when the chosen
--        date is today in Chicago; otherwise midday of the chosen date, 17:00 UTC -- the exact
--        value the app already sends for a past date (src/lib/paperTicket.ts
--        completedAtForDeliveredOn). So a "today" completion that reaches the server just after
--        Chicago midnight keeps the chosen day instead of moving to the next;
--     6. saves its own receipt (save_idempotency) and binds it to the caller and fingerprint
--        (_bind_replay_receipt_20261015) before returning complete_delivery's result plus
--        "started" (true when step 4 ran).
--   Any refusal in step 4 or 5 (authorization, status, closed period, stock) raises and rolls the
--   whole call back, including the start.
--
-- WHAT DOES NOT CHANGE: confirm_delivery and complete_delivery and the private chain under it are
--   not edited; no stock, invoice or period logic is retyped; no table, row, policy, trigger or
--   existing grant changes. The other screens (DeliveryDetail, FieldStop, FieldView) keep their
--   own calls.
--
-- COMMIT-TIME GUARD: the deferred trigger require_bound_replay_receipt_20261015 is not extended to
--   this operation. Only this function writes a 'start_and_complete_delivery' receipt, and it binds
--   it in the same call (_bind_replay_receipt_20261015 raises IDEMPOTENCY_RECEIPT_MISSING if none
--   was written). save_idempotency is not executable by authenticated, and an unbound receipt
--   could only ever be refused by check_idempotency_intent (it fails closed). The inner
--   complete_delivery receipt is covered by that trigger already. Recreating the trigger here
--   would race the other replay-binding batches that recreate it.
--
-- GRANTS: EXECUTE for authenticated only (no anon, no PUBLIC); SECURITY DEFINER with
--   search_path = public, pg_temp. The function runs as its owner so it can call the
--   postgres-only helpers; every caller check above uses auth.uid(), and confirm_delivery and
--   complete_delivery re-check authorization on the caller.
--
-- ROLLBACK: DROP FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text,
--   text, text); the app would then need its previous two-call version.

CREATE OR REPLACE FUNCTION public.start_and_complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_delivered_on date,
  p_performed_by uuid DEFAULT NULL,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_completed_at timestamptz;
  v_fingerprint text;
  v_replay jsonb;
  v_status text;
  v_started boolean := false;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: start_and_complete_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF p_delivered_on IS NULL THEN
    RAISE EXCEPTION 'DELIVERED_ON_REQUIRED: choose the delivery date' USING ERRCODE = '22023';
  END IF;
  IF p_delivered_on > v_today THEN
    RAISE EXCEPTION 'DELIVERED_ON_IN_FUTURE: the delivery date % is after today (%)', p_delivered_on, v_today
      USING ERRCODE = '22023';
  END IF;

  -- p_quantities is fingerprinted as sent (jsonb normalizes key order); the chosen date, not a
  -- derived instant, so an exact retry keeps its fingerprint across Chicago midnight.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'delivery_id', p_delivery_id,
    'signed_by', p_signed_by,
    'delivered_on', p_delivered_on,
    'quantities', p_quantities,
    'issue_type', p_issue_type,
    'issue_notes', p_issue_notes
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'start_and_complete_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  SELECT status INTO v_status FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  IF v_status = 'scheduled' THEN
    PERFORM public.confirm_delivery(p_delivery_id, v_actor, NULL);
    v_started := true;
  END IF;

  IF p_delivered_on < v_today THEN
    -- Midday in Chicago of the chosen date: same instant as completedAtForDeliveredOn.
    v_completed_at := (p_delivered_on + time '17:00') AT TIME ZONE 'UTC';
  END IF;

  v_result := public.complete_delivery(
    p_delivery_id,
    p_signed_by,
    v_actor,
    p_quantities,
    p_issue_type,
    p_issue_notes,
    p_idempotency_key || ':complete',
    v_completed_at
  );
  IF v_result IS NULL OR jsonb_typeof(v_result) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'COMPLETE_DELIVERY_RESULT_INVALID';
  END IF;
  v_result := v_result || jsonb_build_object('started', v_started);

  PERFORM public.save_idempotency(p_idempotency_key, 'start_and_complete_delivery', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'start_and_complete_delivery', v_fingerprint);
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text) IS
  'Deliveries list Mark Delivered: starts a scheduled delivery (confirm_delivery) and completes it (complete_delivery) in one transaction, on the chosen America/Chicago business date. Key required and bound to caller + request.';
