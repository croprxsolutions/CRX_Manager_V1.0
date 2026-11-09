-- idempotency-body-check: exempt
-- (Every mutating RPC here requires p_idempotency_key and checks it before any write with PAR-1's
--  _product_parent_replay(key, scope, fingerprint), which refuses a key reused for another request or
--  another actor, then saves its receipt with save_idempotency. The hook only recognises check_idempotency.)
-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261226100000_epa_registration_tools.md.
-- Re-read the live ledger before applying.
--
-- WHY: REG-1 Step 2 (docs/plans/2026-11-06-product-REG1-BUILD-SHEET.md; cut down 2026-11-09, Mason: "Drop them"
--   (the product-master guards), after "Yes, simplify"). Step 1 (20261210100000, live) added the registration
--   storage and stub tools that refuse EPA_REGISTRATION_NOT_SEEDED. This file adds the private seed-run record,
--   the small shared helpers and a working set_epa_registration: a plain edit of one registration (plus its
--   event). Nothing copies a registration's facts to sizes or brands, and no product edit is refused.
--   Every tool still refuses EPA_REGISTRATION_NOT_SEEDED until Mason runs the one-time seed (20261226120000),
--   so applying this file changes no live behaviour.
--
-- WHAT:
--   - epa_registration_seed_run: private one-row record of the seed (who, when, Q1's RUP default, the
--     preview fingerprint). Its row existing is what "seeded" means (_epa_registrations_seeded()).
--   - Helpers (no grants): the REG-1 lock, facts checker, create, update, event, unrecorded posted lines.
--   - set_epa_registration: working body, same signature and grants as Step 1. p_label_draft_id is kept for
--     that signature and is not used (drafts are not re-based).
--
-- NOT CHANGED: products, brands, invoices, invoice lines, and Step 1's preview_epa_assignment and
--   assign_epa_registration stubs (they keep refusing EPA_REGISTRATION_NOT_SEEDED / not built). No live row
--   is written.
--
-- LOCKS: the REG-1 advisory lock pair (20261210, hashtext('crx_epa_registration')): exclusive for registration
--   writers, shared for posting (which saves what it reads).
--
-- ROLLBACK (its own reviewed migration): re-emit Step 1's set_epa_registration stub (md5 pinned below), drop
--   the helpers and the private table (empty until the seed).
--
-- ORDERING: after 20261210100000_epa_registrations and every older pending migration; before 20261226110000.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE epa_registration_tools_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.epa_registration_tools_tx') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_TOOLS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.epa_registration_tools_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_TOOLS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regclass('public.epa_registrations') IS NULL OR to_regclass('public.label_draft_targets') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_TOOLS_PREFLIGHT: apply 20261210100000_epa_registrations first';
  END IF;
  IF to_regclass('public.epa_registration_seed_run') IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_TOOLS_PREFLIGHT: this file was already applied';
  END IF;
  IF EXISTS (SELECT 1 FROM public.epa_registrations) OR EXISTS (SELECT 1 FROM public.epa_registration_events) THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_TOOLS_PREFLIGHT: a registration exists before the seed';
  END IF;
  -- The replaced body must still be Step 1's stub.
  IF (SELECT count(*) FROM pg_proc p
       WHERE (p.oid, md5(replace(p.prosrc, chr(13), ''))) IN (
         (to_regprocedure('public.set_epa_registration(text,bigint,jsonb,text,uuid,text)'), '8f57c7c93fcd25c893352fda5d34d91a'))
         AND p.proowner = 'postgres'::regrole AND p.prosecdef) <> 1 THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_TOOLS_PREFLIGHT: a replaced function drifted from the body this file was written from';
  END IF;
  IF to_regprocedure('public._product_parent_replay(text,text,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_TOOLS_PREFLIGHT: PAR-1 helpers missing';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Private table
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.epa_registration_seed_run (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  seeded_at timestamptz NOT NULL DEFAULT now(),
  seeded_by uuid NOT NULL,
  rup_default text NOT NULL CHECK (rup_default IN ('unknown', 'no')),
  fingerprint text NOT NULL
);
ALTER TABLE public.epa_registration_seed_run OWNER TO postgres;
COMMENT ON TABLE public.epa_registration_seed_run IS
  'Internal (REG-1): the one-time seed. Its row existing switches the registration tools and posting by registration on; rup_default is Mason''s Q1 answer.';

ALTER TABLE public.epa_registration_seed_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY epa_registration_seed_run_none ON public.epa_registration_seed_run
  FOR ALL TO authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.epa_registration_seed_run
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- ---------------------------------------------------------------------------------------------
-- 2. Helpers (no grants)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public._epa_registrations_seeded() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT EXISTS (SELECT 1 FROM public.epa_registration_seed_run);
$function$;

CREATE FUNCTION public._epa_registration_lock(p_exclusive boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF p_exclusive THEN
    PERFORM pg_advisory_xact_lock(20261210, hashtext('crx_epa_registration'));
  ELSE
    PERFORM pg_advisory_xact_lock_shared(20261210, hashtext('crx_epa_registration'));
  END IF;
END;
$function$;

-- Checks a registration facts object (keys and JSON types; the table CHECKs check the values).
-- p_create: a new registration must state its restricted-use answer.
CREATE FUNCTION public._epa_registration_facts(p jsonb, p_create boolean) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $function$
DECLARE
  v_bad text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_FACTS_INVALID: send the label facts as an object';
  END IF;
  SELECT k INTO v_bad FROM jsonb_object_keys(p) k
   WHERE k NOT IN ('signal_word', 'rup_status', 'rei_hours', 'phi_days', 'max_label_rate', 'max_label_rate_unit',
                   'label_adjuvants', 'registration_status', 'cancelled_on', 'label_url', 'label_accepted_on',
                   'source', 'checked_at')
   ORDER BY k LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_FACTS_INVALID: % is not a registration field', v_bad;
  END IF;
  SELECT e.key INTO v_bad FROM jsonb_each(p) e
   WHERE jsonb_typeof(e.value) <> 'null' AND CASE
     WHEN e.key IN ('rei_hours', 'phi_days') THEN jsonb_typeof(e.value) <> 'number' OR e.value::text !~ '^[0-9]{1,9}$'
     WHEN e.key = 'max_label_rate' THEN NOT (
       -- any non-negative decimal, like the unconstrained products column the seed copies from
       (jsonb_typeof(e.value) = 'number' AND e.value::text ~ '^[0-9]+(\.[0-9]+)?$')
       OR (jsonb_typeof(e.value) = 'string' AND e.value #>> '{}' ~ '^\s*[0-9]+(\.[0-9]+)?\s*$'))
     WHEN e.key = 'label_adjuvants' THEN jsonb_typeof(e.value) <> 'array'
     ELSE jsonb_typeof(e.value) <> 'string'
   END
   ORDER BY e.key LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_FACTS_INVALID: % has the wrong type', v_bad;
  END IF;
  IF p ? 'rup_status' AND COALESCE(p->>'rup_status', '') NOT IN ('yes', 'no', 'unknown') THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_FACTS_INVALID: rup_status is yes, no or unknown';
  END IF;
  IF p_create AND NOT p ? 'rup_status' THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_FACTS_REQUIRED: a new EPA registration needs its restricted-use answer (yes, no or unknown)';
  END IF;
END;
$function$;

-- Creates one registration (the caller holds the exclusive lock and checked the facts). Never overwrites.
CREATE FUNCTION public._epa_registration_insert(p_number text, p_facts jsonb)
RETURNS public.epa_registrations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_row public.epa_registrations;
BEGIN
  INSERT INTO public.epa_registrations (epa_registration, registration_status, cancelled_on, label_url,
    label_accepted_on, source, checked_at, signal_word, rup_status, rei_hours, phi_days, max_label_rate,
    max_label_rate_unit, label_adjuvants, created_by, updated_by)
  VALUES (p_number, COALESCE(p_facts->>'registration_status', 'unknown'), (p_facts->>'cancelled_on')::date,
    NULLIF(btrim(p_facts->>'label_url'), ''), (p_facts->>'label_accepted_on')::date,
    NULLIF(btrim(p_facts->>'source'), ''), (p_facts->>'checked_at')::timestamptz,
    NULLIF(btrim(p_facts->>'signal_word'), ''), COALESCE(p_facts->>'rup_status', 'unknown'),
    (p_facts->>'rei_hours')::integer, (p_facts->>'phi_days')::integer,
    NULLIF(btrim(p_facts->>'max_label_rate'), '')::numeric, NULLIF(btrim(p_facts->>'max_label_rate_unit'), ''),
    CASE WHEN jsonb_typeof(p_facts->'label_adjuvants') = 'array' THEN p_facts->'label_adjuvants' END,
    auth.uid(), auth.uid())
  ON CONFLICT (epa_registration) DO NOTHING
  RETURNING * INTO v_row;
  IF v_row.epa_registration IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_STALE: EPA registration % already exists; reload and try again', p_number;
  END IF;
  RETURN v_row;
END;
$function$;

-- Applies the keys present in p_changes to one registration the caller has locked; bumps its version.
CREATE FUNCTION public._epa_registration_update(p_number text, p_changes jsonb)
RETURNS public.epa_registrations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_row public.epa_registrations;
BEGIN
  UPDATE public.epa_registrations r SET
    registration_status = CASE WHEN p_changes ? 'registration_status' THEN COALESCE(p_changes->>'registration_status', 'unknown') ELSE r.registration_status END,
    cancelled_on = CASE WHEN p_changes ? 'cancelled_on' THEN (p_changes->>'cancelled_on')::date ELSE r.cancelled_on END,
    label_url = CASE WHEN p_changes ? 'label_url' THEN NULLIF(btrim(p_changes->>'label_url'), '') ELSE r.label_url END,
    label_accepted_on = CASE WHEN p_changes ? 'label_accepted_on' THEN (p_changes->>'label_accepted_on')::date ELSE r.label_accepted_on END,
    source = CASE WHEN p_changes ? 'source' THEN NULLIF(btrim(p_changes->>'source'), '') ELSE r.source END,
    checked_at = CASE WHEN p_changes ? 'checked_at' THEN (p_changes->>'checked_at')::timestamptz ELSE r.checked_at END,
    signal_word = CASE WHEN p_changes ? 'signal_word' THEN NULLIF(btrim(p_changes->>'signal_word'), '') ELSE r.signal_word END,
    rup_status = CASE WHEN p_changes ? 'rup_status' THEN p_changes->>'rup_status' ELSE r.rup_status END,
    rei_hours = CASE WHEN p_changes ? 'rei_hours' THEN (p_changes->>'rei_hours')::integer ELSE r.rei_hours END,
    phi_days = CASE WHEN p_changes ? 'phi_days' THEN (p_changes->>'phi_days')::integer ELSE r.phi_days END,
    max_label_rate = CASE WHEN p_changes ? 'max_label_rate' THEN NULLIF(btrim(p_changes->>'max_label_rate'), '')::numeric ELSE r.max_label_rate END,
    max_label_rate_unit = CASE WHEN p_changes ? 'max_label_rate_unit' THEN NULLIF(btrim(p_changes->>'max_label_rate_unit'), '') ELSE r.max_label_rate_unit END,
    label_adjuvants = CASE WHEN p_changes ? 'label_adjuvants'
                           THEN CASE WHEN jsonb_typeof(p_changes->'label_adjuvants') = 'array' THEN p_changes->'label_adjuvants' END
                           ELSE r.label_adjuvants END,
    registration_version = r.registration_version + 1,
    updated_by = auth.uid(),
    updated_at = now()
  WHERE r.epa_registration = p_number
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

CREATE FUNCTION public._epa_registration_event(p_number text, p_type text, p_reason text, p_before jsonb,
  p_after jsonb, p_affected jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO public.epa_registration_events (epa_registration, event_type, reason, before_values, after_values,
    affected, changed_by, changed_by_name)
  VALUES (p_number, p_type, NULLIF(btrim(p_reason), ''), p_before, p_after, COALESCE(p_affected, '[]'::jsonb), auth.uid(),
    (SELECT pr.full_name FROM public.profiles pr WHERE pr.id = auth.uid()))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

-- Posted invoice lines sold under p_number with no active RUP record (shown when a label turns Yes).
-- 20261226110000 re-issues it to match by the product's own number, with the one coverage rule.
CREATE FUNCTION public._epa_registration_unrecorded_posted_lines(p_number text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('invoice_item_id', ii.id, 'invoice_id', ii.invoice_id,
           'invoice_number', i.invoice_number, 'product_id', ii.product_id) ORDER BY ii.id), '[]'::jsonb)
    FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL
     AND public._normalize_epa_registration(ii.epa_registration) = p_number
     AND NOT EXISTS (SELECT 1 FROM public.rup_sales_records rs
                      WHERE rs.invoice_id = ii.invoice_id AND rs.product_id = ii.product_id AND rs.voided_at IS NULL
                        -- posting writes one record per unit and unit price, so a record covers only its own
                        AND rs.unit IS NOT DISTINCT FROM ii.unit_size AND rs.unit_price_cents IS NOT DISTINCT FROM ii.unit_price_cents);
$function$;

DO $owners$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._epa_registrations_seeded()', 'public._epa_registration_lock(boolean)',
    'public._epa_registration_facts(jsonb,boolean)',
    'public._epa_registration_insert(text,jsonb)', 'public._epa_registration_update(text,jsonb)',
    'public._epa_registration_event(text,text,text,jsonb,jsonb,jsonb)',
    'public._epa_registration_unrecorded_posted_lines(text)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END
$owners$;

-- ---------------------------------------------------------------------------------------------
-- 3. Registration edit (same signature and grants as Step 1)
-- ---------------------------------------------------------------------------------------------

-- Edits one registration, or creates it when p_expected_version is NULL and none exists. Admin only.
-- Sizes and brands keep their own facts (no copy); posting reads the registration of the product's number.
CREATE OR REPLACE FUNCTION public.set_epa_registration(p_epa_registration text, p_expected_version bigint, p_changes jsonb,
  p_reason text, p_label_draft_id uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_n text;
  v_fp text;
  v_existing jsonb;
  v_reg public.epa_registrations;
  v_before jsonb;
  v_type text;
  v_was_yes boolean := false;
  v_event bigint;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF NOT public._epa_registrations_seeded() THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NOT_SEEDED: EPA registrations are not set up yet';
  END IF;
  v_n := public._normalize_epa_registration(p_epa_registration);
  IF v_n IS NULL OR v_n !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NUMBER_INVALID: % is not an EPA registration number', COALESCE(p_epa_registration, '(blank)');
  END IF;
  v_fp := md5(jsonb_build_array(v_n, p_expected_version, p_changes, p_reason, p_label_draft_id)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'set_epa_registration', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  PERFORM public._epa_registration_lock(true);
  SELECT * INTO v_reg FROM public.epa_registrations WHERE epa_registration = v_n FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_version IS NOT NULL THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_STALE: EPA registration % does not exist; reload and try again', v_n;
    END IF;
    PERFORM public._epa_registration_facts(p_changes, true);
    v_reg := public._epa_registration_insert(v_n, p_changes);
    v_type := 'created';
  ELSE
    IF p_expected_version IS DISTINCT FROM v_reg.registration_version THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_STALE: EPA registration % changed since you opened it; reload and try again', v_n;
    END IF;
    PERFORM public._epa_registration_facts(p_changes, false);
    IF p_changes = '{}'::jsonb THEN RAISE EXCEPTION 'EPA_REGISTRATION_NO_CHANGES: nothing to change'; END IF;
    v_was_yes := v_reg.rup_status = 'yes';
    v_before := to_jsonb(v_reg);
    v_reg := public._epa_registration_update(v_n, p_changes);
    v_type := 'updated';
  END IF;
  v_event := public._epa_registration_event(v_n, v_type, p_reason, v_before, to_jsonb(v_reg), '[]'::jsonb);

  v_result := jsonb_build_object('epa_registration', v_n, 'registration_version', v_reg.registration_version,
    'event_id', v_event, 'event_type', v_type,
    'posted_sales_to_record', CASE WHEN v_reg.rup_status = 'yes' AND NOT v_was_yes
                                   THEN public._epa_registration_unrecorded_posted_lines(v_n) ELSE '[]'::jsonb END);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_epa_registration',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.set_epa_registration(text, bigint, jsonb, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_epa_registration(text, bigint, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_epa_registration(text, bigint, jsonb, text, uuid, text) TO authenticated;

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  IF has_table_privilege('authenticated', 'public.epa_registration_seed_run', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon', 'public.epa_registration_seed_run', 'SELECT,INSERT,UPDATE,DELETE')
     OR NOT has_function_privilege('authenticated', 'public.set_epa_registration(text,bigint,jsonb,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_epa_registration(text,bigint,jsonb,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_EPA_REGISTRATION_TOOLS_GRANTS_WRONG';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '\_epa\_%'
     AND p.proname <> '_epa_norm'  -- the pure text trimmer is readable by signed-in users on purpose (20261204120000)
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
          OR p.proowner <> 'postgres'::regrole);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_EPA_REGISTRATION_TOOLS_HELPER_GRANTS_WRONG: %', v_bad;
  END IF;
END;
$postflight$;
