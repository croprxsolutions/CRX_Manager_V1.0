-- idempotency-body-check: exempt
-- (set_registration_adjuvants requires p_idempotency_key and checks it before any write with PAR-1's
--  _product_parent_replay(key, scope, fingerprint), which calls check_idempotency, then saves its receipt with
--  save_idempotency last, in the same transaction. The hook only recognises check_idempotency.)
-- Written 2026-11-15. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270114130000_registration_adjuvants.md.
-- Re-read the live ledger before applying.
--
-- WHY: Product Master USE-2, part 1 (database). docs/plans/2026-11-15-product-USE2-BUILD-SHEET.md sections 3.0
--   and 4.0. Each EPA registration carries the label's adjuvant statements: Required, Recommended or Do not use,
--   an optional condition ("when tank mixed with atrazine"), one or more types ("any one of" / "none of"), an
--   optional preferred type and a note. Admins and sales reps record them (Mason, 2026-11-15).
--
-- WHAT:
--   - _epa_label_adjuvants_valid: re-issued to accept the new entry shape AND REG-1's one-type entry, exactly as
--     REG-1 checked it (every list valid before stays valid). The epa_registrations CHECK already calls it, so
--     set_epa_registration (admin) and the new save share one rule. NULL = not reviewed, [] = none on the label.
--   - set_registration_adjuvants: active admins and sales reps. Changes ONLY label_adjuvants of one
--     registration (or creates the registration, RUP 'unknown', when none exists and p_expected_version is
--     NULL), refuses a stale version, logs one epa_registration_events row, returns a small receipt.
--
-- NOT CHANGED: every table, column, row, grant and policy; set_epa_registration and every other REG-1 and DM-4
--   function (the postflight proves them unchanged by md5). No live row is written.
--
-- LOCKS: the same order as set_epa_registration: the retry-key lock (_product_parent_replay; identical requests
--   sent at once wait there and the second returns the first one's receipt), then the REG-1 exclusive lock
--   (20261210, hashtext('crx_epa_registration')), then the registration row FOR UPDATE.
--
-- ROLLBACK (its own reviewed migration; SQL in the migrations.d record): drop set_registration_adjuvants (never
--   CASCADE) and KEEP the new validator, so every list already entered stays valid and readable. Nothing deleted.
--
-- ORDERING: after 20270108100000_ingredient_modes_of_action and every older migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE registration_adjuvants_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       (SELECT count(*) FROM public.epa_registrations) AS registrations,
       (SELECT count(*) FROM public.epa_registration_events) AS events;

-- Functions this file must not change (live md5s of prosrc without carriage returns, read 2026-11-15).
CREATE TEMP TABLE registration_adjuvants_pins ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('_epa_registration_event', '2993d332865925e3d8b997555c254fdb'),
  ('_epa_registration_facts', '8619b99732acdf893a8dd7f119cef6c4'),
  ('_epa_registration_insert', 'e840a2c29b4ec8dbdc27b767b6f2169f'),
  ('_epa_registration_lock', '0470f94473b8d22cc7ac19f5e880ca70'),
  ('_epa_registration_seed_plan', 'f09d8ed84ce88796865911c0021183ab'),
  ('_epa_registration_target_table', 'c011c66947c64571f75cc0444246dd51'),
  ('_epa_registration_unrecorded_posted_lines', 'a15ee1aabac50d9f4e854d87c3720cf8'),
  ('_epa_registration_update', '49bd5402160b0cb9c4073894f83fca8a'),
  ('_epa_registrations_seeded', 'bfda524a07d41a733f891541f5c3c68f'),
  ('_product_parent_replay', '62880d61a470c2eeca02de7bc11c76be'),
  ('commit_epa_proposal', '8e58775eae0d0a42b9ef08aea716fe75'),
  ('get_epa_registrations', '83e1ca0eacddf079ae16d79dfe5b83cf'),
  ('save_idempotency', 'f600171c426e48c995f204c4dac3ff8b'),
  ('set_epa_registration', '35ec6669fe23608f0b4e55224bfca0cf')
) AS v(proname, body_md5);

DO $preflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.registration_adjuvants_tx') IS NULL THEN
    RAISE EXCEPTION 'REGISTRATION_ADJUVANTS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.registration_adjuvants_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'REGISTRATION_ADJUVANTS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public.set_registration_adjuvants(text,bigint,jsonb,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'REGISTRATION_ADJUVANTS_PREFLIGHT: this file was already applied';
  END IF;
  IF to_regclass('public.epa_registration_seed_run') IS NULL THEN
    RAISE EXCEPTION 'REGISTRATION_ADJUVANTS_PREFLIGHT: apply 20261231200000_epa_registration_tools first';
  END IF;
  -- The replaced validator must still be REG-1's.
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._epa_label_adjuvants_valid(jsonb)')
         AND md5(replace(p.prosrc, chr(13), '')) = '3502e7f31b7f90124a5fcedf79a99aaa'
         AND p.proowner = 'postgres'::regrole) <> 1 THEN
    RAISE EXCEPTION 'REGISTRATION_ADJUVANTS_PREFLIGHT: _epa_label_adjuvants_valid drifted from the body this file was written from';
  END IF;
  SELECT string_agg(v.proname, ', ') INTO v_bad
    FROM pg_temp.registration_adjuvants_pins v
   WHERE (SELECT count(*) FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v.proname
             AND md5(replace(p.prosrc, chr(13), '')) = v.body_md5) <> 1
      OR (SELECT count(*) FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v.proname) <> 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'REGISTRATION_ADJUVANTS_PREFLIGHT: these functions drifted from the bodies this file was written from: %', v_bad;
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL OR to_regprocedure('public.is_sales_rep()') IS NULL
     OR to_regprocedure('public._normalize_epa_registration(text)') IS NULL THEN
    RAISE EXCEPTION 'REGISTRATION_ADJUVANTS_PREFLIGHT: role or EPA number helpers missing';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Entry shape (sheet 3.0). The epa_registrations CHECK calls this function.
-- ---------------------------------------------------------------------------------------------

-- NULL = not reviewed; [] = reviewed, none on the label. Each entry is one statement on the label:
-- {kind: required|recommended|do_not_use, adjuvant_types: 1-8 distinct trimmed strings (any one of / none of),
--  preferred?: one of adjuvant_types (not on do_not_use), when?: condition <= 200, note?: <= 500}.
-- plpgsql so each check runs only after the type checks before it (a SQL OR chain has no order guarantee).
CREATE OR REPLACE FUNCTION public._epa_label_adjuvants_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  e jsonb;
  t jsonb;
  v_types text[];
BEGIN
  IF p IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(p) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p) > 50 THEN RETURN false; END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p) x LOOP
    IF jsonb_typeof(e) <> 'object' THEN RETURN false; END IF;
    -- REG-1's one-type entry {kind: required|recommended, adjuvant_type, note?} stays valid, exactly as REG-1
    -- checked it, so set_epa_registration keeps its write contract. The screens read it as a one-type statement.
    IF e ? 'adjuvant_type' THEN
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('kind', 'adjuvant_type', 'note')) THEN
        RETURN false;
      END IF;
      IF jsonb_typeof(e->'kind') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      IF e->>'kind' NOT IN ('required', 'recommended') THEN RETURN false; END IF;
      IF jsonb_typeof(e->'adjuvant_type') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      IF btrim(e->>'adjuvant_type') = '' OR length(e->>'adjuvant_type') > 100 THEN RETURN false; END IF;
      IF e ? 'note' AND jsonb_typeof(e->'note') NOT IN ('string', 'null') THEN RETURN false; END IF;
      IF length(COALESCE(e->>'note', '')) > 500 THEN RETURN false; END IF;
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(e) k
                WHERE k NOT IN ('kind', 'adjuvant_types', 'preferred', 'when', 'note')) THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(e->'kind') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    IF e->>'kind' NOT IN ('required', 'recommended', 'do_not_use') THEN RETURN false; END IF;
    IF jsonb_typeof(e->'adjuvant_types') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(e->'adjuvant_types') NOT BETWEEN 1 AND 8 THEN RETURN false; END IF;
    v_types := ARRAY[]::text[];
    FOR t IN SELECT x FROM jsonb_array_elements(e->'adjuvant_types') x LOOP
      IF jsonb_typeof(t) <> 'string' THEN RETURN false; END IF;
      -- non-blank, no space, tab or line break at either end (the editor trims)
      IF t #>> '{}' !~ '^[^[:space:]](.*[^[:space:]])?$' OR length(t #>> '{}') > 100
         OR lower(t #>> '{}') = ANY (v_types) THEN
        RETURN false;
      END IF;
      v_types := v_types || lower(t #>> '{}');
    END LOOP;
    IF e ? 'preferred' AND jsonb_typeof(e->'preferred') <> 'null' THEN
      IF e->>'kind' = 'do_not_use' OR jsonb_typeof(e->'preferred') <> 'string' THEN RETURN false; END IF;
      IF NOT (e->'adjuvant_types' @> jsonb_build_array(e->'preferred')) THEN RETURN false; END IF;
    END IF;
    IF e ? 'when' AND jsonb_typeof(e->'when') <> 'null' THEN
      IF jsonb_typeof(e->'when') <> 'string' THEN RETURN false; END IF;
      IF e->>'when' !~ '^[^[:space:]](.*[^[:space:]])?$' OR length(e->>'when') > 200 THEN RETURN false; END IF;
    END IF;
    IF e ? 'note' AND jsonb_typeof(e->'note') NOT IN ('string', 'null') THEN RETURN false; END IF;
    IF length(COALESCE(e->>'note', '')) > 500 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$function$;
ALTER FUNCTION public._epa_label_adjuvants_valid(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._epa_label_adjuvants_valid(jsonb) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- ---------------------------------------------------------------------------------------------
-- 2. The adjuvant save (admins and sales reps)
-- ---------------------------------------------------------------------------------------------

-- Replaces one registration's adjuvant list and nothing else. With p_expected_version NULL and no registration
-- for the number, creates one holding only the list (every other fact at its default; RUP 'unknown').
CREATE FUNCTION public.set_registration_adjuvants(p_epa_registration text, p_expected_version bigint,
  p_adjuvants jsonb, p_reason text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_n text;
  v_fp text;
  v_existing jsonb;
  v_reg public.epa_registrations;
  v_before jsonb;
  v_type text;
  v_event bigint;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'ADMIN_OR_SALES_REP_REQUIRED: only admins and sales reps record label adjuvants';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF NOT public._epa_registrations_seeded() THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NOT_SEEDED: EPA registrations are not set up yet';
  END IF;
  IF p_reason IS NULL OR p_reason !~ '[^[:space:]]' THEN  -- tabs and line breaks are blank too
    RAISE EXCEPTION 'EPA_REGISTRATION_REASON_REQUIRED: say why this registration is changing';
  END IF;
  IF length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_REASON_TOO_LONG: keep the reason to 1,000 characters';
  END IF;
  v_n := public._normalize_epa_registration(p_epa_registration);
  IF v_n IS NULL OR v_n !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NUMBER_INVALID: % is not an EPA registration number', COALESCE(p_epa_registration, '(blank)');
  END IF;
  IF p_adjuvants IS NULL OR jsonb_typeof(p_adjuvants) <> 'array' OR NOT public._epa_label_adjuvants_valid(p_adjuvants) THEN
    RAISE EXCEPTION 'EPA_LABEL_ADJUVANTS_INVALID: the adjuvant list is not in the expected shape';
  END IF;
  v_fp := md5(jsonb_build_array(v_n, p_expected_version, p_adjuvants, p_reason)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'set_registration_adjuvants', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  PERFORM public._epa_registration_lock(true);
  SELECT * INTO v_reg FROM public.epa_registrations WHERE epa_registration = v_n FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_version IS NOT NULL THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_STALE: EPA registration % does not exist; reload and try again', v_n;
    END IF;
    v_reg := public._epa_registration_insert(v_n,
      jsonb_build_object('rup_status', 'unknown', 'label_adjuvants', p_adjuvants));
    v_type := 'created';
  ELSE
    IF p_expected_version IS NULL THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_STALE: EPA registration % already exists; reload and try again', v_n;
    END IF;
    IF p_expected_version IS DISTINCT FROM v_reg.registration_version THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_STALE: EPA registration % changed since you opened it; reload and try again', v_n;
    END IF;
    IF v_reg.label_adjuvants IS NOT DISTINCT FROM p_adjuvants THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_NO_CHANGES: nothing to change';
    END IF;
    v_before := to_jsonb(v_reg);
    v_reg := public._epa_registration_update(v_n, jsonb_build_object('label_adjuvants', p_adjuvants));
    v_type := 'updated';
  END IF;
  v_event := public._epa_registration_event(v_n, v_type, p_reason, v_before, to_jsonb(v_reg), '[]'::jsonb);

  v_result := jsonb_build_object('epa_registration', v_n, 'registration_version', v_reg.registration_version,
    'event_id', v_event, 'event_type', v_type);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_registration_adjuvants',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.set_registration_adjuvants(text, bigint, jsonb, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_registration_adjuvants(text, bigint, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.set_registration_adjuvants(text, bigint, jsonb, text, text) TO authenticated;

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.set_registration_adjuvants(text,bigint,jsonb,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_registration_adjuvants(text,bigint,jsonb,text,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.set_registration_adjuvants(text,bigint,jsonb,text,text)', 'EXECUTE')
     OR has_function_privilege('metabase_ro', 'public.set_registration_adjuvants(text,bigint,jsonb,text,text)', 'EXECUTE')
     OR has_function_privilege('metabase_ro', 'public._epa_label_adjuvants_valid(jsonb)', 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = 'public.set_registration_adjuvants(text,bigint,jsonb,text,text)'::regprocedure
                       AND p.prosecdef AND p.proowner = 'postgres'::regrole
                       AND p.proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'POSTFLIGHT_REGISTRATION_ADJUVANTS_GRANTS_WRONG';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '\_epa\_%'
     AND p.proname <> '_epa_norm'  -- the pure text trimmer is readable by signed-in users on purpose (20261204120000)
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
          OR p.proowner <> 'postgres'::regrole);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_REGISTRATION_ADJUVANTS_HELPER_GRANTS_WRONG: %', v_bad;
  END IF;
  SELECT string_agg(v.proname, ', ') INTO v_bad
    FROM pg_temp.registration_adjuvants_pins v
   WHERE (SELECT count(*) FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v.proname
             AND md5(replace(p.prosrc, chr(13), '')) = v.body_md5) <> 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_REGISTRATION_ADJUVANTS_FUNCTION_CHANGED: %', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM public.epa_registrations WHERE NOT public._epa_label_adjuvants_valid(label_adjuvants)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_REGISTRATION_ADJUVANTS_ROW_INVALID';
  END IF;
  IF (SELECT count(*) FROM public.epa_registrations) <> (SELECT registrations FROM pg_temp.registration_adjuvants_tx)
     OR (SELECT count(*) FROM public.epa_registration_events) <> (SELECT events FROM pg_temp.registration_adjuvants_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_REGISTRATION_ADJUVANTS_ROWS_CHANGED';
  END IF;
END;
$postflight$;
