-- KI-134: a stock count double-counts anything that moved while the count was open
-- (contract: docs/plans/2026-11-10-ki134-cycle-count-drift-CONTRACT.md).
--
-- WHY: the browser stores each line's expected_qty when the count is CREATED. update_cycle_count_item then sets
--   variance = counted - expected_qty, and Complete adds that variance to TODAY's on-hand. A 10-unit delivery between
--   creating the count and counting the shelf is subtracted twice (stock ends 10 short); a receipt is added twice.
--
-- WHAT: update_cycle_count_item only. When a number is saved, the line's expected_qty becomes the on-hand the app
--   holds at that moment (inventory.quantity_available of the line's inventory row), and variance / variance_pct are
--   computed against it. Complete still adds variance to current on-hand, so movement after the line is counted is
--   kept, and movement before it is no longer counted twice. A line with no inventory row keeps its stored
--   expected_qty (Complete skips such lines). Clearing a count leaves expected_qty alone. The result gains
--   expected_qty. Fingerprint, receipt, guards and grants are unchanged. The inventory row is read FOR SHARE, after
--   the item and parent locks (the order Complete uses), so a receipt or delivery still in flight on that row commits
--   first and is in the baseline instead of being counted on the shelf and added again by Complete.
--
-- LIVE EVIDENCE (read-only, 2026-11-10): md5(replace(prosrc, chr(13), '')) update_cycle_count_item
--   c67e98122a5f1d9dc60c205dac969f3f (20260831212415), _complete_cycle_count_impl 394d15947b9a09eab94f7bea1d90242b,
--   complete_cycle_count ad7249f15027bd75084cb0cfbf8b6bab. 17 cycle counts, all cancelled: no open or completed count.
--
-- idempotency-body-check: exempt -- p_idempotency_key handling is unchanged: required, actor + fingerprint bound
--   through check_idempotency_intent, the stored result is replayed as-is (a retry does not re-read on-hand).
-- caller-analysis: update_cycle_count_item :: grants unchanged (restated: anon/PUBLIC none, authenticated +
--   service_role EXECUTE); src/pages/CycleCounts.tsx calls it with the same arguments; the result is a superset
--   (adds expected_qty), and the screen falls back to counted - variance when expected_qty is absent.
--
-- ROLLBACK (its own reviewed migration): re-create the 20260831212415 body. No data changes; lines saved meanwhile
--   keep the on-hand they recorded.

SET LOCAL lock_timeout = '5s';
-- Holds off count saves until commit, so none can slip in between the preflight and the new body.
LOCK TABLE public.cycle_count_items IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'update_cycle_count_item') <> 1
     OR to_regprocedure('public.update_cycle_count_item(uuid,numeric,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'KI134_PREFLIGHT: expected exactly one update_cycle_count_item(uuid,numeric,text,uuid,text)';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)'::regprocedure)
     IS DISTINCT FROM 'c67e98122a5f1d9dc60c205dac969f3f' THEN
    RAISE EXCEPTION 'KI134_PREFLIGHT: update_cycle_count_item body is not the reviewed live body';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public._complete_cycle_count_impl(uuid,uuid,text)'))
     IS DISTINCT FROM '394d15947b9a09eab94f7bea1d90242b'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public.complete_cycle_count(uuid,uuid,text,bigint)'))
     IS DISTINCT FROM 'ad7249f15027bd75084cb0cfbf8b6bab' THEN
    RAISE EXCEPTION 'KI134_PREFLIGHT: complete_cycle_count / _complete_cycle_count_impl are not the reviewed live bodies (Complete must add variance to current on-hand)';
  END IF;
  -- Clean cutover: no open count may hold a line counted under the old rule (variance against creation-time stock),
  -- or one Complete would mix both rules. Live had none on 2026-11-10; cancel or finish such a count first.
  IF EXISTS (SELECT 1 FROM public.cycle_count_items cci
               JOIN public.cycle_counts cc ON cc.id = cci.cycle_count_id
              WHERE cc.status = 'in_progress' AND cci.is_counted) THEN
    RAISE EXCEPTION 'KI134_PREFLIGHT: an in-progress count has lines counted under the old rule; finish or cancel it before applying';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.update_cycle_count_item(
  p_item_id uuid,
  p_counted_qty numeric DEFAULT NULL::numeric,
  p_notes text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor         uuid := auth.uid();
  v_replay        jsonb;
  v_fingerprint   text;
  v_item          public.cycle_count_items%ROWTYPE;
  v_count         public.cycle_counts%ROWTYPE;
  v_expected      numeric;
  v_on_hand       numeric;
  v_variance      numeric;
  v_variance_pct  numeric;
  v_item_revision bigint;
  v_result        jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: update_cycle_count_item requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'item_id', p_item_id,
    'counted_qty', p_counted_qty,
    'notes', p_notes
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'update_cycle_count_item', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  SELECT * INTO v_item
    FROM public.cycle_count_items
   WHERE id = p_item_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_ITEM_NOT_FOUND'; END IF;

  SELECT * INTO v_count
    FROM public.cycle_counts
   WHERE id = v_item.cycle_count_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND'; END IF;
  IF v_count.status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'CYCLE_COUNT_NOT_IN_PROGRESS';
  END IF;

  v_expected := v_item.expected_qty;
  IF p_counted_qty IS NOT NULL THEN
    -- KI-134: compare the count with what the app holds NOW, not at count creation, so stock that moved in between
    -- is not applied twice when Complete adds the variance to current on-hand.
    IF v_item.inventory_id IS NOT NULL THEN
      SELECT i.quantity_available INTO v_on_hand
        FROM public.inventory i
       WHERE i.id = v_item.inventory_id
         FOR SHARE;
      IF FOUND THEN
        -- Two places, like the stored columns, so the saved row, the result and Complete agree.
        v_expected := round(COALESCE(v_on_hand, 0), 2);
      END IF;
    END IF;
    v_variance := round(p_counted_qty, 2) - v_expected;
    IF v_expected <> 0 THEN
      -- abs(): a negative on hand must not flip the percentage's sign (Taha, PR #1775).
      v_variance_pct := round((v_variance / abs(v_expected)) * 100, 2);
      -- variance_pct is numeric(8,2): a tiny on-hand must not make the count unsavable.
      IF abs(v_variance_pct) >= 1000000 THEN v_variance_pct := NULL; END IF;
    END IF;
  END IF;

  UPDATE public.cycle_count_items
     SET expected_qty = v_expected,
         counted_qty = p_counted_qty,
         variance = v_variance,
         variance_pct = v_variance_pct,
         is_counted = (p_counted_qty IS NOT NULL),
         counted_by = CASE WHEN p_counted_qty IS NOT NULL THEN v_actor ELSE NULL END,
         counted_at = CASE WHEN p_counted_qty IS NOT NULL THEN now() ELSE NULL END,
         notes = COALESCE(p_notes, notes)
   WHERE id = p_item_id;

  SELECT item_revision INTO v_item_revision
    FROM public.cycle_counts
   WHERE id = v_item.cycle_count_id;

  v_result := jsonb_build_object(
    'item_id', p_item_id,
    'counted_qty', round(p_counted_qty, 2),
    'expected_qty', v_expected,
    'variance', v_variance,
    'variance_pct', v_variance_pct,
    'is_counted', (p_counted_qty IS NOT NULL),
    'item_revision', v_item_revision
  );
  PERFORM public.save_idempotency(p_idempotency_key, 'update_cycle_count_item', v_result);
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor,
         request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'update_cycle_count_item';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_cycle_count_item(uuid, numeric, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_cycle_count_item(uuid, numeric, text, uuid, text) TO authenticated, service_role;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'update_cycle_count_item') <> 1
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)'::regprocedure)
     OR has_function_privilege('anon', 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'KI134_POSTFLIGHT: update_cycle_count_item signature, security or grants are not as reviewed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)'::regprocedure
                    AND EXISTS (SELECT 1 FROM unnest(proconfig) c(value)
                                 WHERE replace(c.value, ' ', '') = 'search_path=public,pg_temp')
                    AND prosrc LIKE '%v_expected := round(COALESCE(v_on_hand, 0), 2);%'
                    AND prosrc ~ 'WHERE i\.id = v_item\.inventory_id\s+FOR SHARE;'
                    AND prosrc LIKE '%''expected_qty'', v_expected%') THEN
    RAISE EXCEPTION 'KI134_POSTFLIGHT: update_cycle_count_item search_path or new body did not land';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public._complete_cycle_count_impl(uuid,uuid,text)'))
     IS DISTINCT FROM '394d15947b9a09eab94f7bea1d90242b' THEN
    RAISE EXCEPTION 'KI134_POSTFLIGHT: _complete_cycle_count_impl changed';
  END IF;
END;
$postflight$;
