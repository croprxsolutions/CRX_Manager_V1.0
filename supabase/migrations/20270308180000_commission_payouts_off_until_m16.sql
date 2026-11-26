-- 20270308180000_commission_payouts_off_until_m16.sql
-- Record: docs/reference/migrations.d/20270308180000_commission_payouts_off_until_m16.md
--
-- WHY: Mason, Slack 2026-11-25: "Move M16 to January, and please make sure no payout batch can run until it's live."
--   M16 = commission is earned only when the customer's money lands. Until then no commission payout batch may be
--   created or paid.
-- WHAT: one switch, public._commission_payouts_enabled(), returns false. create_commission_payment and
--   post_commission_payment check it after their sign-in, admin, idempotency-key and replay checks (so a request
--   committed before the switch went off still replays its receipt) and refuse with COMMISSION_PAYOUTS_OFF_UNTIL_M16.
--   Nothing else in either body changes. These two wrappers are the only way an API role writes a payout (their
--   _intent_impl_20260809 bodies execute for postgres only; the tables have no write policy).
--   Backstop: a BEFORE INSERT OR UPDATE OF status trigger on commission_payments refuses a new batch row or a move to
--   'posted' while the switch is not true. It also stops a payout call that was already running when this migration
--   committed (its old body has no check, but the trigger fires on its write).
--   void_commission_payment is NOT touched and the trigger allows 'voided': voiding an existing batch stays allowed.
--   M16 turns payouts back on with its own migration that makes the switch return true.
-- SAFETY: preflight refuses unless this runs as one transaction, the switch does not exist yet, and both live
--   bodies are exactly staging's current ones (md5, carriage returns removed). Postflight checks the two new bodies,
--   that owner, grants, security mode, settings, return type, volatility and arguments did not move, and that the
--   switch is owned by postgres, returns false, is SECURITY INVOKER and no API role can execute it.
-- ROLLBACK: scripts/smoke/commission-payouts-off-until-m16-reverse.sql (restores both bodies, drops the trigger and the
--   switch). For this migration only, before M16 changes the switch.
-- PROOF: node scripts/smoke/prove-commission-payouts-off-until-m16-real-schema.mjs

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE payoutguard_m16_attrs ON COMMIT DROP AS
SELECT p.oid AS fn_oid, p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner,
       p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
       pg_get_function_arguments(p.oid) AS args, pg_current_xact_id()::text AS transaction_id
  FROM pg_proc p
 WHERE p.oid IN (to_regprocedure('public.create_commission_payment(uuid[],text,text,date,text,uuid,text)'),
                 to_regprocedure('public.post_commission_payment(uuid,uuid,text)'));

DO $preflight$
DECLARE
  v_expected constant jsonb := jsonb_build_object(
    'create_commission_payment(uuid[],text,text,date,text,uuid,text)', '41ef85f28f8168e2a7330a66828a6b10',
    'post_commission_payment(uuid,uuid,text)', 'bb01e87a4675fc11ba86deb4636e5640');
  v_row record;
BEGIN
  IF (SELECT count(*) FROM pg_temp.payoutguard_m16_attrs) <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: expected 2 functions, found %', (SELECT count(*) FROM pg_temp.payoutguard_m16_attrs);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_temp.payoutguard_m16_attrs WHERE transaction_id IS DISTINCT FROM pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regprocedure('public._commission_payouts_enabled()') IS NOT NULL
     OR to_regprocedure('public._commission_payouts_off_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'PAYOUT_GUARD_M16_BASELINE_DRIFT: the payout switch or its trigger function already exists';
  END IF;
  FOR v_row IN
    SELECT a.sig, md5(replace(p.prosrc, chr(13), '')) AS body_md5
      FROM pg_temp.payoutguard_m16_attrs a JOIN pg_proc p ON p.oid = a.fn_oid
  LOOP
    IF v_row.body_md5 IS DISTINCT FROM v_expected ->> v_row.sig THEN
      RAISE EXCEPTION 'PAYOUT_GUARD_M16_BASELINE_DRIFT: % body md5 %', v_row.sig, v_row.body_md5;
    END IF;
  END LOOP;
END;
$preflight$;

-- The switch. False until M16 is live. SECURITY INVOKER and reads nothing; only the two SECURITY DEFINER wrappers
-- (owned by postgres) call it, so no API role is granted EXECUTE.
CREATE FUNCTION public._commission_payouts_enabled()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $switch$ SELECT false $switch$;
ALTER FUNCTION public._commission_payouts_enabled() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._commission_payouts_enabled() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
COMMENT ON FUNCTION public._commission_payouts_enabled() IS
  'False until commission-on-payment (M16) is live (Mason, 2026-11-25). create_commission_payment and post_commission_payment refuse with COMMISSION_PAYOUTS_OFF_UNTIL_M16 while it is false.';

-- Backstop on the table itself (see WHY/WHAT). SECURITY DEFINER so it can read the switch whoever writes.
CREATE FUNCTION public._commission_payouts_off_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $guard$
BEGIN
  IF public._commission_payouts_enabled() IS NOT TRUE
     AND (TG_OP = 'INSERT' OR (NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted')) THEN
    RAISE EXCEPTION 'COMMISSION_PAYOUTS_OFF_UNTIL_M16: Commission payouts are switched off until commission-on-payment (M16) is live.';
  END IF;
  RETURN NEW;
END;
$guard$;
ALTER FUNCTION public._commission_payouts_off_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._commission_payouts_off_guard() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER trg_commission_payouts_off_until_m16
  BEFORE INSERT OR UPDATE OF status ON public.commission_payments
  FOR EACH ROW EXECUTE FUNCTION public._commission_payouts_off_guard();

CREATE OR REPLACE FUNCTION public.create_commission_payment(p_commission_ids uuid[], p_payment_method text, p_reference text, p_payment_date date, p_notes text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_payment_id uuid;
  -- Normalize ONCE, then use these same values for both the fingerprint and the
  -- implementation call. Fingerprinting a trimmed value while storing the raw
  -- one would let ' REF-1 ' replay REF-1's receipt while claiming to persist
  -- different metadata, so the two must never diverge.
  v_payment_method text := NULLIF(btrim(COALESCE(p_payment_method, '')), '');
  v_reference      text := NULLIF(btrim(COALESCE(p_reference, '')), '');
  v_notes          text := NULLIF(btrim(COALESCE(p_notes, '')), '');
BEGIN
  -- Same guards, same messages, same order as the implementation, so no
  -- legitimate caller sees a behaviour change.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to create a commission payment';
  END IF;

  -- A key is REQUIRED. It used to be optional, and omitting it ran the payout
  -- with no receipt and therefore no intent binding at all — an authenticated
  -- admin calling the RPC directly (PostgREST lets a defaulted argument be
  -- omitted) reached the money path unbound, which is the exact hole this
  -- migration exists to close. Every application caller already sends one, and
  -- the one checked-in smoke script that passed NULL
  -- (scripts/smoke/smoke-commission_payment_for_update_fix.sql) was fixed in the
  -- same change, so refusing here leaves no unbound door.
  -- Two predicates, deliberately. The first is the house rule already live in
  -- 20260721145936 across every money/lifecycle RPC, kept so this path does not
  -- drift from the rest. The second demands one printable ASCII character:
  -- [[:space:]] follows the database collation, so whether NBSP or an em-space
  -- counts as blank is not the same answer on every cluster, and a key made
  -- only of those would be accepted somewhere. Every key this application
  -- generates is ASCII, so this costs no real caller anything.
  --
  -- COLLATE "C" is what makes the second predicate locale-independent, and it
  -- is not decoration: Postgres resolves a bracket RANGE like [!-~] through the
  -- active collating sequence, so under a non-C collation a non-ASCII character
  -- can sort inside the range and satisfy it. Both predicates would then be
  -- locale-dependent and a key with no printable ASCII could be accepted after
  -- all. "C" is built in and always present, so pinning it here has no
  -- deployment cost.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_commission_payment requires p_idempotency_key';
  END IF;

  -- Intent = the actor plus the sorted, de-duplicated commission selection and
  -- every payment field the admin can edit. p_payment_date is fingerprinted
  -- raw: substituting CURRENT_DATE here would make an otherwise identical
  -- retry across midnight look like a changed intent.
  --
  -- p_performed_by is deliberately NOT fingerprinted, and that omission depends
  -- on the guard above constraining it to {NULL, v_actor} — it therefore carries
  -- no information beyond actor_id. If that guard is ever relaxed, p_performed_by
  -- MUST be added here.
  --
  -- The DISTINCT below matches the implementation, which also de-duplicates the
  -- selection (SELECT DISTINCT id FROM unnest(p_commission_ids)) before locking
  -- and paying, so [A, A] and [A] are the same request in both layers.
  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'commission_ids', (
          SELECT COALESCE(jsonb_agg(to_jsonb(cid) ORDER BY cid), '[]'::jsonb)
            FROM (
              SELECT DISTINCT unnest(COALESCE(p_commission_ids, ARRAY[]::uuid[])) AS cid
            ) s
        ),
        'payment_method', v_payment_method,
        'reference', v_reference,
        'payment_date', p_payment_date,
        'notes', v_notes
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'create_commission_payment', v_actor, v_fingerprint
  );

  IF v_replay IS NOT NULL THEN
    -- Return the committed receipt here rather than delegating: the
    -- implementation's own check_idempotency reads a NULL stored result as
    -- "no receipt" and would re-execute the payout. idempotency_keys.result
    -- is nullable, so fail closed instead.
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN ((v_replay -> 'result') #>> '{}')::uuid;
  END IF;

  -- Mason, 2026-11-25: no commission payout batch is created or paid until commission-on-payment (M16) is live.
  -- After the replay check, so a request committed before the switch went off still gets its receipt back.
  IF public._commission_payouts_enabled() IS NOT TRUE THEN
    RAISE EXCEPTION 'COMMISSION_PAYOUTS_OFF_UNTIL_M16: Commission payouts are switched off until commission-on-payment (M16) is live.';
  END IF;

  v_payment_id := public._create_commission_payment_intent_impl_20260809(
    p_commission_ids, v_payment_method, v_reference,
    p_payment_date, v_notes, p_performed_by, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'create_commission_payment';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_payment_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_commission_payment(p_payment_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to post a commission payment';
  END IF;

  -- See create: a key is REQUIRED, so no caller reaches the money path unbound.
  -- Two predicates, deliberately. The first is the house rule already live in
  -- 20260721145936 across every money/lifecycle RPC, kept so this path does not
  -- drift from the rest. The second demands one printable ASCII character:
  -- [[:space:]] follows the database collation, so whether NBSP or an em-space
  -- counts as blank is not the same answer on every cluster, and a key made
  -- only of those would be accepted somewhere. Every key this application
  -- generates is ASCII, so this costs no real caller anything.
  --
  -- COLLATE "C" is what makes the second predicate locale-independent, and it
  -- is not decoration: Postgres resolves a bracket RANGE like [!-~] through the
  -- active collating sequence, so under a non-C collation a non-ASCII character
  -- can sort inside the range and satisfy it. Both predicates would then be
  -- locale-dependent and a key with no printable ASCII could be accepted after
  -- all. "C" is built in and always present, so pinning it here has no
  -- deployment cost.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: post_commission_payment requires p_idempotency_key';
  END IF;

  -- Intent = the actor plus which payment is being posted.
  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'payment_id', p_payment_id
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'post_commission_payment', v_actor, v_fingerprint
  );

  IF v_replay IS NOT NULL THEN
    -- See create_commission_payment: return the committed receipt directly so a
    -- NULL stored result can never be mistaken for "not yet performed".
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- Mason, 2026-11-25: no commission payout batch is created or paid until commission-on-payment (M16) is live.
  -- After the replay check, so a request committed before the switch went off still gets its receipt back.
  IF public._commission_payouts_enabled() IS NOT TRUE THEN
    RAISE EXCEPTION 'COMMISSION_PAYOUTS_OFF_UNTIL_M16: Commission payouts are switched off until commission-on-payment (M16) is live.';
  END IF;

  v_result := public._post_commission_payment_intent_impl_20260809(
    p_payment_id, p_performed_by, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'post_commission_payment';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_result;
END;
$function$;

DO $postflight$
DECLARE
  v_expected constant jsonb := jsonb_build_object(
    'create_commission_payment(uuid[],text,text,date,text,uuid,text)', '6e68288bef20e511cee5ebf2cccf05bf',
    'post_commission_payment(uuid,uuid,text)', 'acaaa4020a8ecbbd439b38cd79dba9df');
  v_fn record;
  v_seen integer := 0;
  v_switch constant regprocedure := to_regprocedure('public._commission_payouts_enabled()');
  v_role text;
BEGIN
  FOR v_fn IN
    SELECT a.sig, md5(replace(p.prosrc, chr(13), '')) AS body_md5, pg_get_userbyid(p.proowner) AS owner,
           p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
           pg_get_function_arguments(p.oid) AS args, a.args AS was_args,
           a.owner AS was_owner, a.acl AS was_acl, a.proconfig AS was_config, a.prorettype AS was_rettype,
           a.provolatile AS was_volatile, a.prosecdef AS was_secdef, a.transaction_id
      FROM pg_temp.payoutguard_m16_attrs a JOIN pg_proc p ON p.oid = a.fn_oid
  LOOP
    v_seen := v_seen + 1;
    IF v_fn.transaction_id IS DISTINCT FROM pg_current_xact_id()::text THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
    END IF;
    IF v_fn.body_md5 IS DISTINCT FROM v_expected ->> v_fn.sig
       OR v_fn.owner IS DISTINCT FROM v_fn.was_owner
       OR v_fn.acl IS DISTINCT FROM v_fn.was_acl
       OR v_fn.proconfig IS DISTINCT FROM v_fn.was_config
       OR v_fn.prorettype IS DISTINCT FROM v_fn.was_rettype
       OR v_fn.provolatile IS DISTINCT FROM v_fn.was_volatile
       OR v_fn.prosecdef IS DISTINCT FROM v_fn.was_secdef
       OR v_fn.args IS DISTINCT FROM v_fn.was_args
       OR NOT has_function_privilege(v_fn.owner, v_switch, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % is not the expected body/attributes (md5 %)', v_fn.sig, v_fn.body_md5;
    END IF;
  END LOOP;
  IF v_seen <> 2 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected 2 functions, saw %', v_seen;
  END IF;
  IF v_switch IS NULL
     OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_switch) IS DISTINCT FROM 'postgres'
     OR (SELECT prosecdef FROM pg_proc WHERE oid = v_switch)
     OR public._commission_payouts_enabled() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: the payout switch is missing, not owned by postgres, SECURITY DEFINER, or not false';
  END IF;
  -- A PUBLIC grant would show up here too: every one of these roles inherits it.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro'] LOOP
    IF has_function_privilege(v_role, v_switch, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % can execute the payout switch', v_role;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.commission_payments'::regclass AND t.tgname = 'trg_commission_payouts_off_until_m16'
       AND t.tgenabled = 'O' AND NOT t.tgisinternal AND p.oid = to_regprocedure('public._commission_payouts_off_guard()')
       AND pg_get_userbyid(p.proowner) = 'postgres' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: the commission_payments payout trigger is missing, disabled or not owned by postgres';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro'] LOOP
    IF has_function_privilege(v_role, 'public._commission_payouts_off_guard()', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % can execute the payout trigger function', v_role;
    END IF;
  END LOOP;
  RAISE NOTICE 'POSTFLIGHT_OK: commission payouts are off until M16 (create and post refuse; void unchanged)';
END;
$postflight$;
