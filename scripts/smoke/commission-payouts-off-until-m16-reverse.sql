-- Reverse of 20270308180000_commission_payouts_off_until_m16.sql (run as one transaction: psql -1).
-- Turns commission payouts back on exactly as staging had them: removes the switch check from
-- create_commission_payment and post_commission_payment (each body back to its pinned staging md5) and drops
-- public._commission_payouts_enabled(). CREATE OR REPLACE keeps owner, grants, SECURITY DEFINER and settings.
-- Refuses unless both live bodies are exactly the guarded ones. void_commission_payment is not touched.
SET LOCAL lock_timeout = '5s';

DO $reverse$
DECLARE
  v_guard constant text := $guard$
  -- Mason, 2026-11-25: no commission payout batch is created or paid until commission-on-payment (M16) is live.
  IF NOT public._commission_payouts_enabled() THEN
    RAISE EXCEPTION 'COMMISSION_PAYOUTS_OFF_UNTIL_M16: Commission payouts are switched off until commission-on-payment (M16) is live.';
  END IF;
$guard$;
  v_fn record;
  v_def text;
BEGIN
  FOR v_fn IN
    SELECT * FROM (VALUES
      ('public.create_commission_payment(uuid[],text,text,date,text,uuid,text)'::regprocedure,
       '58349c6b07b88b798cdb548237559a3e', '41ef85f28f8168e2a7330a66828a6b10'),
      ('public.post_commission_payment(uuid,uuid,text)'::regprocedure,
       '4fa82d42276d7d9411c50ba2b8622afb', 'bb01e87a4675fc11ba86deb4636e5640')) t(oid, guarded_md5, staging_md5)
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
  DROP FUNCTION public._commission_payouts_enabled();
  RAISE NOTICE 'REVERSE_OK: commission payouts are back on (staging bodies restored, switch dropped)';
END;
$reverse$;
