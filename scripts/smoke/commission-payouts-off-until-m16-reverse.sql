-- Reverse of 20270308180000_commission_payouts_off_until_m16.sql (run as one transaction: psql -1).
-- Turns commission payouts back on exactly as staging had them: removes the switch check from
-- create_commission_payment and post_commission_payment (each body back to its pinned staging md5) and drops
-- the commission_payments trigger, its function and public._commission_payouts_enabled(). CREATE OR REPLACE keeps owner,
-- grants, SECURITY DEFINER and settings. For this migration only: run it before M16 changes the switch.
-- Refuses unless both live bodies are exactly the guarded ones. void_commission_payment is not touched.
SET LOCAL lock_timeout = '5s';

DO $reverse$
DECLARE
  v_guard constant text := $guard$  -- Mason, 2026-11-25: no commission payout batch is created or paid until commission-on-payment (M16) is live.
  -- After the replay check, so a request committed before the switch went off still gets its receipt back.
  IF public._commission_payouts_enabled() IS NOT TRUE THEN
    RAISE EXCEPTION 'COMMISSION_PAYOUTS_OFF_UNTIL_M16: Commission payouts are switched off until commission-on-payment (M16) is live.';
  END IF;

$guard$;
  v_fn record;
  v_def text;
BEGIN
  -- Only this migration's own state: once M16 has changed the switch, this rollback must not run.
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public._commission_payouts_enabled()')) IS DISTINCT FROM ' SELECT false ' THEN
    RAISE EXCEPTION 'PAYOUT_GUARD_M16_REVERSE_DRIFT: the payout switch is missing or no longer the one this migration created';
  END IF;
  FOR v_fn IN
    SELECT * FROM (VALUES
      ('public.create_commission_payment(uuid[],text,text,date,text,uuid,text)'::regprocedure,
       '6e68288bef20e511cee5ebf2cccf05bf', '41ef85f28f8168e2a7330a66828a6b10'),
      ('public.post_commission_payment(uuid,uuid,text)'::regprocedure,
       'acaaa4020a8ecbbd439b38cd79dba9df', 'bb01e87a4675fc11ba86deb4636e5640')) t(oid, guarded_md5, staging_md5)
  LOOP
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_fn.oid) IS DISTINCT FROM v_fn.guarded_md5 THEN
      RAISE EXCEPTION 'PAYOUT_GUARD_M16_REVERSE_DRIFT: % is not the guarded body', v_fn.oid;
    END IF;
    v_def := pg_get_functiondef(v_fn.oid);
    IF array_length(string_to_array(v_def, v_guard), 1) <> 2 THEN
      RAISE EXCEPTION 'PAYOUT_GUARD_M16_REVERSE_DRIFT: % does not hold the guard exactly once', v_fn.oid;
    END IF;
    EXECUTE replace(v_def, v_guard, '');
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_fn.oid) IS DISTINCT FROM v_fn.staging_md5 THEN
      RAISE EXCEPTION 'PAYOUT_GUARD_M16_REVERSE_FAIL: % did not return to the staging body', v_fn.oid;
    END IF;
  END LOOP;
  DROP TRIGGER trg_commission_payouts_off_until_m16 ON public.commission_payments;
  DROP FUNCTION public._commission_payouts_off_guard();
  DROP FUNCTION public._commission_payouts_enabled();
  RAISE NOTICE 'REVERSE_OK: commission payouts are back on (staging bodies restored, trigger and switch dropped)';
END;
$reverse$;
