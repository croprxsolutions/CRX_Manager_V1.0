-- Rehearsal for the forward-compatible rollback. Run in an explicit local transaction.
-- Keep both completion signatures, existing receipts and the sender's API grants.
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF current_setting('lock_timeout') <> '5s'
     OR to_regprocedure('public.notify_saved_delivery_completion(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_NOTICE_ROLLBACK_REQUIRES_INSTALLED_TRANSACTION';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.notify_saved_delivery_completion(
  p_delivery_id uuid,
  p_completion_key text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $disabled$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NULLIF(btrim(p_idempotency_key), '') IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  RAISE EXCEPTION 'DELIVERY_COMPLETION_NOTICE_DISABLED: Delivery alerts are temporarily disabled';
END;
$disabled$;
