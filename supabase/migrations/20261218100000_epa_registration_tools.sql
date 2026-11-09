-- idempotency-body-check: exempt
-- (Every mutating RPC here requires p_idempotency_key and checks it before any write with PAR-1's
--  _product_parent_replay(key, scope, fingerprint), which refuses a key reused for another request or
--  another actor, then saves its receipt with save_idempotency. The hook only recognises check_idempotency.)
-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261218100000_epa_registration_tools.md.
-- Re-read the live ledger before applying.
--
-- WHY: REG-1 Step 2 (docs/plans/2026-11-06-product-REG1-BUILD-SHEET.md, sections 3, 4.A and 5; Mason's answers
--   in 11.1). Step 1 (20261210100000, live) added the registration storage and stub tools that refuse
--   EPA_REGISTRATION_NOT_SEEDED. This file is part A of Step 2: the private seed-run and pass tables, the shared
--   helpers, and the working bodies of set_epa_registration, preview_epa_assignment and assign_epa_registration.
--   Every tool still refuses EPA_REGISTRATION_NOT_SEEDED until Mason runs the one-time seed (part D,
--   20261218130000), so applying this file changes no live behaviour.
--
-- WHAT:
--   - epa_registration_seed_run: private one-row record of the seed (who, when, Q1's RUP default, the
--     preview fingerprint). Its row existing is what "seeded" means (_epa_registrations_seeded()).
--   - epa_registration_copy_passes: private one-row permission slips (transaction ID plus target), the same
--     mechanism as PAR-1's product_parent_copy_passes. Targets: products, product_brands,
--     product_parent_brands, and invoices (part C's sale capture carry).
--   - Helpers (no grants): the lock, passes, facts checker, create/update/event/copy, assignment, draft re-base.
--   - set_epa_registration, preview_epa_assignment, assign_epa_registration: working bodies, same signatures
--     and grants as Step 1.
--
-- NOT CHANGED: products, brands, invoices, invoice lines (parts B to D do those). No live row is written.
--
-- LOCKS: the REG-1 advisory lock pair (20261210, hashtext('crx_epa_registration')), exclusive for writers of
--   numbers or label facts, shared for readers that save what they read (sheet 3.2). Row order after it:
--   registrations (number order) -> products (ID) -> legacy brands (ID) -> parent brands (ID).
--
-- ROLLBACK (its own reviewed migration): re-emit Step 1's three stub bodies (md5 pinned below), drop the
--   helpers and the two private tables (both empty until the seed).
--
-- ORDERING: after 20261210100000_epa_registrations and every older pending migration; before 20261218110000.

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
  -- The three replaced bodies must still be Step 1's stubs.
  IF (SELECT count(*) FROM pg_proc p
       WHERE (p.oid, md5(replace(p.prosrc, chr(13), ''))) IN (
         (to_regprocedure('public.set_epa_registration(text,bigint,jsonb,text,uuid,text)'), '8f57c7c93fcd25c893352fda5d34d91a'),
         (to_regprocedure('public.preview_epa_assignment(text,uuid,text)'), '7a79f8eb54954b4805dd48d06116d21c'),
         (to_regprocedure('public.assign_epa_registration(text,uuid,text,jsonb,text,bigint,text,uuid,text)'), '1dcb2c11bb997d99e66c2c8df0a8a887'))
         AND p.proowner = 'postgres'::regrole AND p.prosecdef) <> 3 THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_TOOLS_PREFLIGHT: a replaced function drifted from the body this file was written from';
  END IF;
  IF to_regprocedure('public._product_parent_replay(text,text,text)') IS NULL
     OR to_regprocedure('public.save_idempotency(text,text,jsonb)') IS NULL
     OR to_regclass('public.product_parent_members') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_TOOLS_PREFLIGHT: PAR-1 helpers missing';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Private tables
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
  'Internal (REG-1): the one-time seed. Its row existing switches the registration guards on; rup_default is Mason''s Q1 answer.';

CREATE TABLE public.epa_registration_copy_passes (
  txid bigint NOT NULL,
  target_table text NOT NULL CHECK (target_table IN ('products', 'product_brands', 'product_parent_brands', 'invoices')),
  target_id uuid NOT NULL,
  PRIMARY KEY (txid, target_table, target_id)
);
ALTER TABLE public.epa_registration_copy_passes OWNER TO postgres;
COMMENT ON TABLE public.epa_registration_copy_passes IS
  'Internal (REG-1): a registration write in progress, one row for the life of one write. Only REG-1 functions write it.';

ALTER TABLE public.epa_registration_seed_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.epa_registration_copy_passes ENABLE ROW LEVEL SECURITY;
CREATE POLICY epa_registration_seed_run_none ON public.epa_registration_seed_run
  FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY epa_registration_copy_passes_none ON public.epa_registration_copy_passes
  FOR ALL TO authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.epa_registration_seed_run, public.epa_registration_copy_passes
  FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- ---------------------------------------------------------------------------------------------
-- 2. Helpers (no grants)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public._epa_registrations_seeded() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT EXISTS (SELECT 1 FROM public.epa_registration_seed_run);
$function$;

-- Q1's answer, stored by the seed; NULL before it.
CREATE FUNCTION public._epa_rup_default() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT rup_default FROM public.epa_registration_seed_run;
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

CREATE FUNCTION public._epa_registration_pass(p_table text, p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  INSERT INTO public.epa_registration_copy_passes (txid, target_table, target_id)
  VALUES (txid_current(), p_table, p_id) ON CONFLICT DO NOTHING;
$function$;

CREATE FUNCTION public._epa_registration_pass_clear(p_table text, p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  DELETE FROM public.epa_registration_copy_passes
   WHERE txid = txid_current() AND target_table = p_table AND target_id = p_id;
$function$;

CREATE FUNCTION public._epa_registration_has_pass(p_table text, p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT EXISTS (SELECT 1 FROM public.epa_registration_copy_passes
                  WHERE txid = txid_current() AND target_table = p_table AND target_id = p_id);
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
       (jsonb_typeof(e.value) = 'number' AND e.value::text ~ '^[0-9]{1,12}(\.[0-9]{1,6})?$')
       OR (jsonb_typeof(e.value) = 'string' AND e.value #>> '{}' ~ '^\s*[0-9]{1,12}(\.[0-9]{1,6})?\s*$'))
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

-- Makes every size and brand carrying p_number match its registration, under passes, in sheet 3.2 row
-- order. Writes only rows that differ. Returns what it wrote. Sizes carry the RUP answer as a mirror
-- (true only for yes); brands as true / false / null.
CREATE FUNCTION public._epa_registration_copy_to_targets(p_number text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  r public.epa_registrations;
  v_row record;
  v_aff jsonb := '[]'::jsonb;
  v_brand_rup boolean;
BEGIN
  SELECT * INTO STRICT r FROM public.epa_registrations WHERE epa_registration = p_number;
  v_brand_rup := CASE r.rup_status WHEN 'yes' THEN true WHEN 'no' THEN false END;
  FOR v_row IN
    SELECT p.id, p.signal_word, p.is_rup, p.rei_hours, p.phi_days, p.max_label_rate, p.max_label_rate_unit
      FROM public.products p
     WHERE public._normalize_epa_registration(p.epa_registration) = p_number
     ORDER BY p.id FOR UPDATE
  LOOP
    IF (v_row.signal_word, v_row.is_rup, v_row.rei_hours, v_row.phi_days, v_row.max_label_rate, v_row.max_label_rate_unit)
       IS DISTINCT FROM (r.signal_word, r.rup_status = 'yes', r.rei_hours, r.phi_days, r.max_label_rate, r.max_label_rate_unit) THEN
      PERFORM public._epa_registration_pass('products', v_row.id);
      UPDATE public.products SET signal_word = r.signal_word, is_rup = (r.rup_status = 'yes'), rei_hours = r.rei_hours,
             phi_days = r.phi_days, max_label_rate = r.max_label_rate, max_label_rate_unit = r.max_label_rate_unit,
             updated_at = now()
       WHERE id = v_row.id;
      PERFORM public._epa_registration_pass_clear('products', v_row.id);
      v_aff := v_aff || jsonb_build_object('table', 'products', 'id', v_row.id,
        'before', jsonb_build_object('signal_word', v_row.signal_word, 'is_rup', v_row.is_rup, 'rei_hours', v_row.rei_hours,
          'phi_days', v_row.phi_days, 'max_label_rate', v_row.max_label_rate, 'max_label_rate_unit', v_row.max_label_rate_unit),
        'after', jsonb_build_object('signal_word', r.signal_word, 'is_rup', r.rup_status = 'yes', 'rei_hours', r.rei_hours,
          'phi_days', r.phi_days, 'max_label_rate', r.max_label_rate, 'max_label_rate_unit', r.max_label_rate_unit));
    END IF;
  END LOOP;
  FOR v_row IN
    SELECT b.id, b.signal_word, b.is_rup FROM public.product_brands b
     WHERE public._normalize_epa_registration(b.epa_registration) = p_number ORDER BY b.id FOR UPDATE
  LOOP
    IF (v_row.signal_word, v_row.is_rup) IS DISTINCT FROM (r.signal_word, v_brand_rup) THEN
      PERFORM public._epa_registration_pass('product_brands', v_row.id);
      UPDATE public.product_brands SET signal_word = r.signal_word, is_rup = v_brand_rup,
             row_version = row_version + 1, updated_by = auth.uid(), updated_at = now()
       WHERE id = v_row.id;
      PERFORM public._epa_registration_pass_clear('product_brands', v_row.id);
      v_aff := v_aff || jsonb_build_object('table', 'product_brands', 'id', v_row.id,
        'before', jsonb_build_object('signal_word', v_row.signal_word, 'is_rup', v_row.is_rup),
        'after', jsonb_build_object('signal_word', r.signal_word, 'is_rup', v_brand_rup));
    END IF;
  END LOOP;
  FOR v_row IN
    SELECT b.id, b.signal_word, b.is_rup FROM public.product_parent_brands b
     WHERE public._normalize_epa_registration(b.epa_registration) = p_number ORDER BY b.id FOR UPDATE
  LOOP
    IF (v_row.signal_word, v_row.is_rup) IS DISTINCT FROM (r.signal_word, v_brand_rup) THEN
      PERFORM public._epa_registration_pass('product_parent_brands', v_row.id);
      UPDATE public.product_parent_brands SET signal_word = r.signal_word, is_rup = v_brand_rup,
             row_version = row_version + 1, updated_by = auth.uid(), updated_at = now()
       WHERE id = v_row.id;
      PERFORM public._epa_registration_pass_clear('product_parent_brands', v_row.id);
      v_aff := v_aff || jsonb_build_object('table', 'product_parent_brands', 'id', v_row.id,
        'before', jsonb_build_object('signal_word', v_row.signal_word, 'is_rup', v_row.is_rup),
        'after', jsonb_build_object('signal_word', r.signal_word, 'is_rup', v_brand_rup));
    END IF;
  END LOOP;
  RETURN v_aff;
END;
$function$;

-- What Change EPA number checks between its preview and its save.
CREATE FUNCTION public._epa_registration_target_fingerprint(p_table text, p_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF p_table = 'products' THEN
    RETURN public._product_label_fingerprint(p_id);
  ELSIF p_table = 'product_brands' THEN
    RETURN (SELECT md5(jsonb_build_object('epa_registration', public._normalize_epa_registration(b.epa_registration),
              'signal_word', b.signal_word, 'is_rup', b.is_rup, 'row_version', b.row_version)::text)
              FROM public.product_brands b WHERE b.id = p_id);
  ELSIF p_table = 'product_parent_brands' THEN
    RETURN (SELECT md5(jsonb_build_object('epa_registration', public._normalize_epa_registration(b.epa_registration),
              'signal_word', b.signal_word, 'is_rup', b.is_rup, 'row_version', b.row_version)::text)
              FROM public.product_parent_brands b WHERE b.id = p_id);
  END IF;
  RETURN NULL;
END;
$function$;

-- Posted invoice lines sold under p_number with no active RUP record (shown when a label turns Yes).
CREATE FUNCTION public._epa_registration_unrecorded_posted_lines(p_number text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('invoice_item_id', ii.id, 'invoice_id', ii.invoice_id,
           'invoice_number', i.invoice_number, 'product_id', ii.product_id) ORDER BY ii.id), '[]'::jsonb)
    FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE i.status IN ('posted', 'paid', 'overdue') AND i.deleted_at IS NULL
     AND public._normalize_epa_registration(ii.epa_registration) = p_number
     AND NOT EXISTS (SELECT 1 FROM public.rup_sales_records rs
                      WHERE rs.invoice_id = ii.invoice_id AND rs.product_id = ii.product_id AND rs.voided_at IS NULL);
$function$;

-- Moves one size or brand to p_new (whose registration exists and is locked by the caller, who also holds
-- the exclusive lock and the target's row lock). Writes the number and the registration's facts under a
-- pass and one 'assigned' event on each of the old and new registrations. No grouped-size check: callers
-- that are not parent functions check that first.
CREATE FUNCTION public._epa_registration_assign_internal(p_table text, p_id uuid, p_new text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  r public.epa_registrations;
  v_old text;
  v_before jsonb;
  v_after jsonb;
  v_aff jsonb;
  v_brand_rup boolean;
BEGIN
  SELECT * INTO STRICT r FROM public.epa_registrations WHERE epa_registration = p_new;
  v_brand_rup := CASE r.rup_status WHEN 'yes' THEN true WHEN 'no' THEN false END;
  PERFORM public._epa_registration_pass(p_table, p_id);
  IF p_table = 'products' THEN
    SELECT public._normalize_epa_registration(p.epa_registration),
           jsonb_build_object('epa_registration', p.epa_registration, 'signal_word', p.signal_word, 'is_rup', p.is_rup,
             'rei_hours', p.rei_hours, 'phi_days', p.phi_days, 'max_label_rate', p.max_label_rate,
             'max_label_rate_unit', p.max_label_rate_unit)
      INTO STRICT v_old, v_before FROM public.products p WHERE p.id = p_id;
    UPDATE public.products SET epa_registration = p_new, signal_word = r.signal_word, is_rup = (r.rup_status = 'yes'),
           rei_hours = r.rei_hours, phi_days = r.phi_days, max_label_rate = r.max_label_rate,
           max_label_rate_unit = r.max_label_rate_unit, updated_at = now()
     WHERE id = p_id;
    v_after := jsonb_build_object('epa_registration', p_new, 'signal_word', r.signal_word, 'is_rup', r.rup_status = 'yes',
      'rei_hours', r.rei_hours, 'phi_days', r.phi_days, 'max_label_rate', r.max_label_rate,
      'max_label_rate_unit', r.max_label_rate_unit);
  ELSIF p_table = 'product_brands' THEN
    SELECT public._normalize_epa_registration(b.epa_registration),
           jsonb_build_object('epa_registration', b.epa_registration, 'signal_word', b.signal_word, 'is_rup', b.is_rup)
      INTO STRICT v_old, v_before FROM public.product_brands b WHERE b.id = p_id;
    UPDATE public.product_brands SET epa_registration = p_new, signal_word = r.signal_word, is_rup = v_brand_rup,
           row_version = row_version + 1, updated_by = auth.uid(), updated_at = now()
     WHERE id = p_id;
    v_after := jsonb_build_object('epa_registration', p_new, 'signal_word', r.signal_word, 'is_rup', v_brand_rup);
  ELSIF p_table = 'product_parent_brands' THEN
    SELECT public._normalize_epa_registration(b.epa_registration),
           jsonb_build_object('epa_registration', b.epa_registration, 'signal_word', b.signal_word, 'is_rup', b.is_rup)
      INTO STRICT v_old, v_before FROM public.product_parent_brands b WHERE b.id = p_id;
    UPDATE public.product_parent_brands SET epa_registration = p_new, signal_word = r.signal_word, is_rup = v_brand_rup,
           row_version = row_version + 1, updated_by = auth.uid(), updated_at = now()
     WHERE id = p_id;
    v_after := jsonb_build_object('epa_registration', p_new, 'signal_word', r.signal_word, 'is_rup', v_brand_rup);
  ELSE
    RAISE EXCEPTION 'EPA_REGISTRATION_TARGET_TABLE: target must be products, product_brands or product_parent_brands';
  END IF;
  PERFORM public._epa_registration_pass_clear(p_table, p_id);
  v_aff := jsonb_build_array(jsonb_build_object('table', p_table, 'id', p_id, 'before', v_before, 'after', v_after));
  IF v_old IS NOT NULL THEN
    PERFORM public._epa_registration_event(v_old, 'assigned', p_reason, jsonb_build_object('epa_registration', v_old),
      jsonb_build_object('epa_registration', p_new), v_aff);
  END IF;
  PERFORM public._epa_registration_event(p_new, 'assigned', p_reason, jsonb_build_object('epa_registration', v_old),
    jsonb_build_object('epa_registration', p_new), v_aff);
  RETURN v_aff;
END;
$function$;

-- Refreshes a pending draft's private target to the state just written (sheet 4.B "recovery re-bases").
-- Only a draft whose size now carries the number just written: an unrelated draft keeps its staleness check.
CREATE FUNCTION public._epa_registration_rebase_draft(p_draft_id uuid, p_number text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  UPDATE public.label_draft_targets t
     SET product_epa_registration = public._normalize_epa_registration(p.epa_registration),
         product_label_fingerprint = public._product_label_fingerprint(t.product_id),
         registration_version = (SELECT r.registration_version FROM public.epa_registrations r
                                  WHERE r.epa_registration = public._normalize_epa_registration(p.epa_registration)),
         updated_at = now()
    FROM public.product_label_drafts d, public.products p
   WHERE t.draft_id = p_draft_id AND d.id = t.draft_id AND p.id = t.product_id
     AND d.status NOT IN ('accepted', 'edited', 'rejected')
     AND public._normalize_epa_registration(p.epa_registration) = p_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LABEL_DRAFT_NOT_PENDING: label draft % is not an open draft for EPA number %', p_draft_id, p_number;
  END IF;
END;
$function$;

DO $owners$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._epa_registrations_seeded()', 'public._epa_rup_default()', 'public._epa_registration_lock(boolean)',
    'public._epa_registration_pass(text,uuid)', 'public._epa_registration_pass_clear(text,uuid)',
    'public._epa_registration_has_pass(text,uuid)', 'public._epa_registration_facts(jsonb,boolean)',
    'public._epa_registration_insert(text,jsonb)', 'public._epa_registration_update(text,jsonb)',
    'public._epa_registration_event(text,text,text,jsonb,jsonb,jsonb)',
    'public._epa_registration_copy_to_targets(text)', 'public._epa_registration_target_fingerprint(text,uuid)',
    'public._epa_registration_unrecorded_posted_lines(text)',
    'public._epa_registration_assign_internal(text,uuid,text,text)', 'public._epa_registration_rebase_draft(uuid,text)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END
$owners$;

-- ---------------------------------------------------------------------------------------------
-- 3. Registration tools (same signatures and grants as Step 1)
-- ---------------------------------------------------------------------------------------------

-- Edits one registration, or creates it when p_expected_version is NULL and none exists, then copies its
-- facts to every size and brand carrying the number. Admin only.
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
  v_aff jsonb;
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
  v_aff := public._epa_registration_copy_to_targets(v_n);
  v_event := public._epa_registration_event(v_n, v_type, p_reason, v_before, to_jsonb(v_reg), v_aff);
  IF p_label_draft_id IS NOT NULL THEN PERFORM public._epa_registration_rebase_draft(p_label_draft_id, v_n); END IF;

  v_result := jsonb_build_object('epa_registration', v_n, 'registration_version', v_reg.registration_version,
    'event_id', v_event, 'event_type', v_type, 'affected_count', jsonb_array_length(v_aff),
    'posted_sales_to_record', CASE WHEN v_reg.rup_status = 'yes' AND NOT v_was_yes
                                   THEN public._epa_registration_unrecorded_posted_lines(v_n) ELSE '[]'::jsonb END);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_epa_registration',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

-- What Change EPA number would do to one ungrouped size or one brand. Admin only; writes nothing.
CREATE OR REPLACE FUNCTION public.preview_epa_assignment(p_target_table text, p_target_id uuid, p_new_number text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_n text;
  v_old text;
  v_parent text;
BEGIN
  PERFORM public._epa_registration_target_table(p_target_table);
  IF NOT public._epa_registrations_seeded() THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NOT_SEEDED: EPA registrations are not set up yet';
  END IF;
  v_n := public._normalize_epa_registration(p_new_number);
  IF v_n IS NULL OR v_n !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NUMBER_INVALID: % is not an EPA registration number', COALESCE(p_new_number, '(blank)');
  END IF;
  IF p_target_table = 'products' THEN
    SELECT public._normalize_epa_registration(p.epa_registration), pp.name INTO v_old, v_parent
      FROM public.products p
      LEFT JOIN public.product_parent_members m ON m.product_id = p.id
      LEFT JOIN public.product_parents pp ON pp.id = m.parent_id
     WHERE p.id = p_target_id;
  ELSIF p_target_table = 'product_brands' THEN
    SELECT public._normalize_epa_registration(b.epa_registration) INTO v_old FROM public.product_brands b WHERE b.id = p_target_id;
  ELSE
    SELECT public._normalize_epa_registration(b.epa_registration) INTO v_old FROM public.product_parent_brands b WHERE b.id = p_target_id;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'EPA_REGISTRATION_TARGET_NOT_FOUND: that size or brand no longer exists'; END IF;
  RETURN jsonb_build_object(
    'target_table', p_target_table, 'target_id', p_target_id,
    'current_number', v_old, 'new_number', v_n, 'same_number', v_old IS NOT DISTINCT FROM v_n,
    'grouped_parent', v_parent,
    'target_fingerprint', public._epa_registration_target_fingerprint(p_target_table, p_target_id),
    'current_registration', (SELECT to_jsonb(r) FROM public.epa_registrations r WHERE r.epa_registration = v_old),
    'new_registration', (SELECT to_jsonb(r) FROM public.epa_registrations r WHERE r.epa_registration = v_n),
    'new_version', (SELECT r.registration_version FROM public.epa_registrations r WHERE r.epa_registration = v_n));
END;
$function$;

-- Change EPA number on one ungrouped size or one brand. A new number with no registration needs
-- p_new_registration (from the new label; the old facts are never copied). Admin only.
CREATE OR REPLACE FUNCTION public.assign_epa_registration(p_target_table text, p_target_id uuid, p_new_number text,
  p_new_registration jsonb, p_expected_target_fingerprint text, p_expected_new_version bigint, p_reason text,
  p_label_draft_id uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_n text;
  v_old text;
  v_fp text;
  v_existing jsonb;
  v_new_version bigint;
  v_reg public.epa_registrations;
  v_aff jsonb;
  v_result jsonb;
BEGIN
  PERFORM public._epa_registration_target_table(p_target_table);
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF NOT public._epa_registrations_seeded() THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NOT_SEEDED: EPA registrations are not set up yet';
  END IF;
  v_n := public._normalize_epa_registration(p_new_number);
  IF v_n IS NULL OR v_n !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NUMBER_INVALID: % is not an EPA registration number', COALESCE(p_new_number, '(blank)');
  END IF;
  v_fp := md5(jsonb_build_array(p_target_table, p_target_id, v_n, p_new_registration, p_expected_target_fingerprint,
    p_expected_new_version, p_reason, p_label_draft_id)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'assign_epa_registration', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  PERFORM public._epa_registration_lock(true);
  -- Nothing changes a number without the exclusive lock, so this read holds until the row locks below.
  IF p_target_table = 'products' THEN
    SELECT public._normalize_epa_registration(epa_registration) INTO v_old FROM public.products WHERE id = p_target_id;
  ELSIF p_target_table = 'product_brands' THEN
    SELECT public._normalize_epa_registration(epa_registration) INTO v_old FROM public.product_brands WHERE id = p_target_id;
  ELSE
    SELECT public._normalize_epa_registration(epa_registration) INTO v_old FROM public.product_parent_brands WHERE id = p_target_id;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'EPA_REGISTRATION_TARGET_NOT_FOUND: that size or brand no longer exists'; END IF;
  PERFORM 1 FROM public.epa_registrations WHERE epa_registration IN (v_old, v_n) ORDER BY epa_registration FOR UPDATE;
  IF p_target_table = 'products' THEN
    PERFORM 1 FROM public.products WHERE id = p_target_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.product_parent_members WHERE product_id = p_target_id) THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_GROUPED_USE_PARENT: this size belongs to a parent; correct the number on the parent';
    END IF;
  ELSIF p_target_table = 'product_brands' THEN
    PERFORM 1 FROM public.product_brands WHERE id = p_target_id FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.product_parent_brands WHERE id = p_target_id FOR UPDATE;
  END IF;
  IF public._epa_registration_target_fingerprint(p_target_table, p_target_id) IS DISTINCT FROM p_expected_target_fingerprint THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_STALE: this size or brand changed since the preview; reload and try again';
  END IF;
  IF v_old IS NOT DISTINCT FROM v_n THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SAME_NUMBER: it already carries EPA number %', v_n;
  END IF;
  SELECT registration_version INTO v_new_version FROM public.epa_registrations WHERE epa_registration = v_n;
  IF v_new_version IS DISTINCT FROM p_expected_new_version THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_STALE: EPA registration % changed since the preview; reload and try again', v_n;
  END IF;
  IF v_new_version IS NULL THEN
    IF p_new_registration IS NULL THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_FACTS_REQUIRED: EPA number % has no registration yet; enter its label facts', v_n;
    END IF;
    PERFORM public._epa_registration_facts(p_new_registration, true);
    v_reg := public._epa_registration_insert(v_n, p_new_registration);
    PERFORM public._epa_registration_event(v_n, 'created', p_reason, NULL, to_jsonb(v_reg), '[]'::jsonb);
  END IF;
  v_aff := public._epa_registration_assign_internal(p_target_table, p_target_id, v_n, p_reason);
  IF p_label_draft_id IS NOT NULL THEN PERFORM public._epa_registration_rebase_draft(p_label_draft_id, v_n); END IF;

  v_result := jsonb_build_object('target_table', p_target_table, 'target_id', p_target_id, 'old_number', v_old,
    'new_number', v_n, 'registration_version', (SELECT registration_version FROM public.epa_registrations WHERE epa_registration = v_n),
    'affected', v_aff);
  PERFORM public.save_idempotency(p_idempotency_key, 'assign_epa_registration',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.set_epa_registration(text, bigint, jsonb, text, uuid, text) OWNER TO postgres;
ALTER FUNCTION public.preview_epa_assignment(text, uuid, text) OWNER TO postgres;
ALTER FUNCTION public.assign_epa_registration(text, uuid, text, jsonb, text, bigint, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_epa_registration(text, bigint, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.preview_epa_assignment(text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.assign_epa_registration(text, uuid, text, jsonb, text, bigint, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_epa_registration(text, bigint, jsonb, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_epa_assignment(text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_epa_registration(text, uuid, text, jsonb, text, bigint, text, uuid, text) TO authenticated;

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  IF has_table_privilege('authenticated', 'public.epa_registration_seed_run', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.epa_registration_copy_passes', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon', 'public.epa_registration_copy_passes', 'SELECT,INSERT,UPDATE,DELETE')
     OR NOT has_function_privilege('authenticated', 'public.set_epa_registration(text,bigint,jsonb,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.preview_epa_assignment(text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.assign_epa_registration(text,uuid,text,jsonb,text,bigint,text,uuid,text)', 'EXECUTE')
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
