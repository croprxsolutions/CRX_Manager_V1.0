-- idempotency-body-check: exempt
-- (seed_epa_registrations requires p_idempotency_key and checks it before any write with PAR-1's
--  _product_parent_replay(key, scope, fingerprint), which refuses a key reused for another request or
--  another actor, then saves its receipt with save_idempotency. The hook only recognises check_idempotency.
--  The three size wrappers pass the key through to the implementations, which keep their own checks.)
-- Written 2026-11-08. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261218130000_epa_registration_guards.md (REG-1 Step 2, file D of 4).
-- Re-read the live ledger before applying.
--
-- WHY: REG-1 Step 2 part D and the seed (docs/plans/2026-11-06-product-REG1-BUILD-SHEET.md 3.3, 4.D, 5):
--   the guards exist before any registration can, and the one Mason-run seed switches registrations on in a
--   single transaction.
--
-- WHAT:
--   - trigger_zz_guard_product_registration on products and trigger_zz_guard_brand_registration on both
--     brand tables. Inert until the seed. After it: a direct change to a registered size's or brand's label
--     facts is refused (EPA_REGISTRATION_FACT), a number change is refused (EPA_REGISTRATION_ASSIGN) except
--     a PAR-1 copy of the parent's registered number onto a grouped size, and an insert takes its facts from
--     the number's registration (EPA_REGISTRATION_NEW_NUMBER when none, EPA_REGISTRATION_FACT_CONFLICT when a
--     sent fact differs). Writes made by the registration functions carry a pass and are let through.
--   - add_product_size, move_product_size, create_product_with_parent: the live functions are renamed
--     _..._reg1_impl (no grants) and same-signature wrappers take the exclusive REG-1 lock first. New numbers
--     on these paths are registered by the apply_product_setup wrapper (20261218110000), which they insert
--     through; a moved size takes its new parent's registered number through the PAR-1 copy branch above.
--   - preview_epa_registration_seed(p_rup_default) and seed_epa_registrations(p_picks, p_rup_default,
--     p_expected_fingerprint, p_idempotency_key), admin only. The seed creates one registration per EPA number
--     found on sizes, brands, parents, invoice lines and job lines, copies the facts to every size and brand,
--     captures every not-yet-posted invoice line (source prefixed seed-assumed:), and records the seed run
--     last. It refuses a stale preview, a missing or unknown pick, a line it cannot capture, and a second run.
--   - Q7 (products half; Mason approves at apply): INSERT on products revoked from anon and authenticated,
--     table and column level. Products are created only through the admin functions.
--
-- NOT CHANGED: the parent guard, PAR-1 functions other than the three wrapped ones, job lines.
--
-- LOCKS: CREATE TRIGGER takes a brief lock on products and both brand tables (lock_timeout 5s).
--
-- ROLLBACK (its own reviewed migration; only before the seed, or with the seed's rows removed by a reviewed
--   migration): drop the two triggers, the seed functions and the three wrappers, rename the three
--   _reg1_impl functions back with EXECUTE to authenticated, and re-grant the column-level INSERT on products
--   that this file revoked (list in the migrations.d record).
--
-- ORDERING: after 20261218120000_invoice_line_sale_capture.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE epa_registration_guards_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.epa_registration_guards_tx') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_GUARDS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.epa_registration_guards_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_GUARDS_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public._capture_invoice_line_sale()') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_GUARDS_PREFLIGHT: apply 20261218120000_invoice_line_sale_capture first';
  END IF;
  IF to_regprocedure('public.seed_epa_registrations(jsonb,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_GUARDS_PREFLIGHT: this file was already applied';
  END IF;
  IF EXISTS (SELECT 1 FROM public.epa_registrations) OR public._epa_registrations_seeded() THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_GUARDS_PREFLIGHT: registrations exist before their guards';
  END IF;
  IF to_regclass('public.product_parent_copy_passes') IS NULL OR to_regclass('public.product_parent_members') IS NULL
     OR to_regclass('public.split_invoice_provenance') IS NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_GUARDS_PREFLIGHT: PAR-1 or split-billing tables missing';
  END IF;
  IF (SELECT count(*) FROM pg_proc p
       WHERE (p.oid, md5(replace(p.prosrc, chr(13), ''))) IN (
         (to_regprocedure('public.add_product_size(uuid,bigint,jsonb,text)'), '65de10d16adc5ba38925718c4c52d2ef'),
         (to_regprocedure('public.move_product_size(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)'), '1e1ee8a6cddb248f39548f182900b481'),
         (to_regprocedure('public.create_product_with_parent(jsonb,jsonb,text)'), '878a8c3aff8ddddff1299565a12d44c0'))
         AND p.proowner = 'postgres'::regrole AND p.prosecdef) <> 3 THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_GUARDS_PREFLIGHT: a wrapped function drifted from the body this file was written from';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal
              AND tgname IN ('trigger_zz_guard_product_registration', 'trigger_zz_guard_brand_registration')) THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_GUARDS_PREFLIGHT: a guard trigger already exists';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Product guard
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.guard_product_registration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_n text;
  v_old_n text;
  v_reg public.epa_registrations;
  v_col text;
  v_parent_n text;
BEGIN
  IF NOT public._epa_registrations_seeded() THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    v_n := public._normalize_epa_registration(NEW.epa_registration);
    IF v_n IS NULL THEN RETURN NEW; END IF;
    PERFORM public._epa_registration_lock(false);
    SELECT * INTO v_reg FROM public.epa_registrations WHERE epa_registration = v_n FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_NEW_NUMBER: add EPA number %''s registration first', v_n;
    END IF;
    v_col := CASE
      WHEN NEW.signal_word IS NOT NULL AND NEW.signal_word IS DISTINCT FROM v_reg.signal_word THEN 'signal_word'
      WHEN NEW.rei_hours IS NOT NULL AND NEW.rei_hours IS DISTINCT FROM v_reg.rei_hours THEN 'rei_hours'
      WHEN NEW.phi_days IS NOT NULL AND NEW.phi_days IS DISTINCT FROM v_reg.phi_days THEN 'phi_days'
      WHEN NEW.max_label_rate IS NOT NULL AND NEW.max_label_rate IS DISTINCT FROM v_reg.max_label_rate THEN 'max_label_rate'
      WHEN NEW.max_label_rate_unit IS NOT NULL AND NEW.max_label_rate_unit IS DISTINCT FROM v_reg.max_label_rate_unit THEN 'max_label_rate_unit'
      WHEN NEW.is_rup AND v_reg.rup_status <> 'yes' THEN 'is_rup'
    END;
    IF v_col IS NOT NULL THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_FACT_CONFLICT: % on EPA registration % is %', v_col, v_n,
        COALESCE(CASE v_col WHEN 'signal_word' THEN v_reg.signal_word WHEN 'rei_hours' THEN v_reg.rei_hours::text
          WHEN 'phi_days' THEN v_reg.phi_days::text WHEN 'max_label_rate' THEN v_reg.max_label_rate::text
          WHEN 'max_label_rate_unit' THEN v_reg.max_label_rate_unit ELSE v_reg.rup_status END, 'blank')
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.epa_registration := v_n;
    NEW.signal_word := v_reg.signal_word; NEW.is_rup := v_reg.rup_status = 'yes';
    NEW.rei_hours := v_reg.rei_hours; NEW.phi_days := v_reg.phi_days;
    NEW.max_label_rate := v_reg.max_label_rate; NEW.max_label_rate_unit := v_reg.max_label_rate_unit;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF public._epa_registration_has_pass('products', NEW.id) THEN RETURN NEW; END IF;
  v_n := public._normalize_epa_registration(NEW.epa_registration);
  v_old_n := public._normalize_epa_registration(OLD.epa_registration);
  IF v_n IS DISTINCT FROM v_old_n THEN
    -- The one number change allowed outside the registration tools: PAR-1 copying a grouped size's
    -- parent number onto it (move_product_size), when that number is registered.
    SELECT public._normalize_epa_registration(pp.generic_epa_registration) INTO v_parent_n
      FROM public.product_parent_members m JOIN public.product_parents pp ON pp.id = m.parent_id
     WHERE m.product_id = NEW.id;
    IF v_n IS NULL OR v_n IS DISTINCT FROM v_parent_n
       OR NOT EXISTS (SELECT 1 FROM public.product_parent_copy_passes WHERE txid = txid_current() AND product_id = NEW.id) THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_ASSIGN: use Change EPA number to change a size''s EPA number'
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM public._epa_registration_lock(false);
    SELECT * INTO v_reg FROM public.epa_registrations WHERE epa_registration = v_n FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_NEW_NUMBER: add EPA number %''s registration first', v_n;
    END IF;
    NEW.epa_registration := v_n;
    NEW.signal_word := v_reg.signal_word; NEW.is_rup := v_reg.rup_status = 'yes';
    NEW.rei_hours := v_reg.rei_hours; NEW.phi_days := v_reg.phi_days;
    NEW.max_label_rate := v_reg.max_label_rate; NEW.max_label_rate_unit := v_reg.max_label_rate_unit;
    PERFORM public._epa_registration_event(v_n, 'assigned', 'size moved to a product group',
      jsonb_build_object('epa_registration', v_old_n), jsonb_build_object('epa_registration', v_n),
      jsonb_build_array(jsonb_build_object('table', 'products', 'id', NEW.id)));
    IF v_old_n IS NOT NULL THEN
      PERFORM public._epa_registration_event(v_old_n, 'assigned', 'size moved to a product group',
        jsonb_build_object('epa_registration', v_old_n), jsonb_build_object('epa_registration', v_n),
        jsonb_build_array(jsonb_build_object('table', 'products', 'id', NEW.id)));
    END IF;
    RETURN NEW;
  END IF;
  IF v_n IS NULL THEN RETURN NEW; END IF;  -- a numberless size edits its own facts
  v_col := CASE
    WHEN NEW.signal_word IS DISTINCT FROM OLD.signal_word THEN 'signal_word'
    WHEN NEW.is_rup IS DISTINCT FROM OLD.is_rup THEN 'is_rup'
    WHEN NEW.rei_hours IS DISTINCT FROM OLD.rei_hours THEN 'rei_hours'
    WHEN NEW.phi_days IS DISTINCT FROM OLD.phi_days THEN 'phi_days'
    WHEN NEW.max_label_rate IS DISTINCT FROM OLD.max_label_rate THEN 'max_label_rate'
    WHEN NEW.max_label_rate_unit IS DISTINCT FROM OLD.max_label_rate_unit THEN 'max_label_rate_unit'
  END;
  IF v_col IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_FACT: % belongs to EPA registration %; edit it on the registration (reload the app if you do not see a Registration panel)', v_col, v_n
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_product_registration() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_product_registration() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trigger_zz_guard_product_registration BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.guard_product_registration();

-- ---------------------------------------------------------------------------------------------
-- 2. Brand guard (both brand tables); brand is_rup mirrors rup_status as true / false / null
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.guard_brand_registration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_n text;
  v_reg public.epa_registrations;
BEGIN
  IF NOT public._epa_registrations_seeded() THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND public._epa_registration_has_pass(TG_TABLE_NAME, NEW.id) THEN RETURN NEW; END IF;
  v_n := public._normalize_epa_registration(NEW.epa_registration);
  IF TG_OP = 'UPDATE' AND v_n IS DISTINCT FROM public._normalize_epa_registration(OLD.epa_registration) THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_ASSIGN: use Change EPA number to change a brand''s EPA number'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_n IS NULL THEN RETURN NEW; END IF;  -- a numberless brand keeps its own facts
  PERFORM public._epa_registration_lock(false);
  SELECT * INTO v_reg FROM public.epa_registrations WHERE epa_registration = v_n FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_NEW_NUMBER: add EPA number %''s registration first', v_n;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.signal_word IS NOT NULL AND NEW.signal_word IS DISTINCT FROM v_reg.signal_word)
     OR (TG_OP = 'UPDATE' AND NEW.signal_word IS DISTINCT FROM OLD.signal_word) THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_FACT_CONFLICT: signal_word on EPA registration % is %', v_n, COALESCE(v_reg.signal_word, 'blank')
      USING ERRCODE = 'check_violation';
  END IF;
  -- Sent true needs Yes; sent false conflicts only with Yes (a boolean cannot say Not reviewed).
  IF (NEW.is_rup AND v_reg.rup_status <> 'yes') OR (NEW.is_rup = false AND v_reg.rup_status = 'yes') THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_FACT_CONFLICT: restricted use on EPA registration % is %', v_n, v_reg.rup_status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.epa_registration := v_n;
  NEW.signal_word := v_reg.signal_word;
  NEW.is_rup := CASE v_reg.rup_status WHEN 'yes' THEN true WHEN 'no' THEN false END;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.guard_brand_registration() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_brand_registration() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trigger_zz_guard_brand_registration BEFORE INSERT OR UPDATE ON public.product_brands
  FOR EACH ROW EXECUTE FUNCTION public.guard_brand_registration();
CREATE TRIGGER trigger_zz_guard_brand_registration BEFORE INSERT OR UPDATE ON public.product_parent_brands
  FOR EACH ROW EXECUTE FUNCTION public.guard_brand_registration();

-- ---------------------------------------------------------------------------------------------
-- 3. Size and group writers: exclusive REG-1 lock first (sheet 3.2)
-- ---------------------------------------------------------------------------------------------

ALTER FUNCTION public.add_product_size(uuid, bigint, jsonb, text) RENAME TO _add_product_size_reg1_impl;
REVOKE ALL ON FUNCTION public._add_product_size_reg1_impl(uuid, bigint, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.add_product_size(p_parent_id uuid, p_expected_parent_version bigint, p_size jsonb,
  p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM public._product_parent_require_admin();  -- before the company-wide lock (the impl's own check)
  PERFORM public._epa_registration_lock(true);
  RETURN public._add_product_size_reg1_impl(p_parent_id, p_expected_parent_version, p_size, p_idempotency_key);
END;
$function$;

ALTER FUNCTION public.move_product_size(uuid, uuid, bigint, bigint, text, text, text, jsonb, text) RENAME TO _move_product_size_reg1_impl;
REVOKE ALL ON FUNCTION public._move_product_size_reg1_impl(uuid, uuid, bigint, bigint, text, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.move_product_size(p_product_id uuid, p_to_parent_id uuid, p_expected_from_version bigint,
  p_expected_to_version bigint, p_expected_size_fingerprint text, p_reason text, p_evidence text,
  p_expected_prices jsonb, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM public._product_parent_require_admin();  -- before the company-wide lock (the impl's own check)
  PERFORM public._epa_registration_lock(true);
  RETURN public._move_product_size_reg1_impl(p_product_id, p_to_parent_id, p_expected_from_version,
    p_expected_to_version, p_expected_size_fingerprint, p_reason, p_evidence, p_expected_prices, p_idempotency_key);
END;
$function$;

ALTER FUNCTION public.create_product_with_parent(jsonb, jsonb, text) RENAME TO _create_product_with_parent_reg1_impl;
REVOKE ALL ON FUNCTION public._create_product_with_parent_reg1_impl(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.create_product_with_parent(p_parent jsonb, p_size jsonb, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  PERFORM public._product_parent_require_admin();  -- before the company-wide lock (the impl's own check)
  PERFORM public._epa_registration_lock(true);
  RETURN public._create_product_with_parent_reg1_impl(p_parent, p_size, p_idempotency_key);
END;
$function$;

ALTER FUNCTION public.add_product_size(uuid, bigint, jsonb, text) OWNER TO postgres;
ALTER FUNCTION public.move_product_size(uuid, uuid, bigint, bigint, text, text, text, jsonb, text) OWNER TO postgres;
ALTER FUNCTION public.create_product_with_parent(jsonb, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_product_size(uuid, bigint, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.move_product_size(uuid, uuid, bigint, bigint, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_product_with_parent(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_product_size(uuid, bigint, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.move_product_size(uuid, uuid, bigint, bigint, text, text, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_product_with_parent(jsonb, jsonb, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Seed preview and seed (sheet 5)
-- ---------------------------------------------------------------------------------------------

-- The seed plan: one entry per EPA number, the facts every carrier agrees on, each disagreement with its
-- candidates, the not-yet-posted lines it will capture, and the rows it read (so a change between preview
-- and seed changes the fingerprint).
CREATE FUNCTION public._epa_registration_seed_plan(p_rup_default text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_regs jsonb;
  v_lines jsonb;
  v_rows text;
BEGIN
  WITH carriers AS (
    SELECT public._normalize_epa_registration(p.epa_registration) AS n, 'products' AS t, p.id,
           p.signal_word AS sw, p.is_rup AS rup, p.rei_hours AS rei, p.phi_days AS phi,
           CASE WHEN p.max_label_rate IS NOT NULL OR p.max_label_rate_unit IS NOT NULL
                THEN jsonb_build_object('max_label_rate', p.max_label_rate, 'max_label_rate_unit', p.max_label_rate_unit) END AS mlr
      FROM public.products p
    UNION ALL
    SELECT public._normalize_epa_registration(b.epa_registration), 'product_brands', b.id, b.signal_word, b.is_rup, NULL, NULL, NULL
      FROM public.product_brands b
    UNION ALL
    SELECT public._normalize_epa_registration(b.epa_registration), 'product_parent_brands', b.id, b.signal_word, b.is_rup, NULL, NULL, NULL
      FROM public.product_parent_brands b
  ), numbers AS (
    SELECT n FROM carriers WHERE n IS NOT NULL
    UNION SELECT public._normalize_epa_registration(generic_epa_registration) FROM public.product_parents
    UNION SELECT public._normalize_epa_registration(epa_registration) FROM public.invoice_items
    UNION SELECT public._normalize_epa_registration(epa_registration) FROM public.job_product_epa
  ), per AS (
    SELECT nb.n,
           count(c.id) > 0 AS carried,
           COALESCE(bool_or(c.rup), false) AS any_rup,
           COALESCE(jsonb_agg(DISTINCT to_jsonb(c.sw)) FILTER (WHERE c.sw IS NOT NULL), '[]') AS sw,
           COALESCE(jsonb_agg(DISTINCT to_jsonb(c.rei)) FILTER (WHERE c.rei IS NOT NULL), '[]') AS rei,
           COALESCE(jsonb_agg(DISTINCT to_jsonb(c.phi)) FILTER (WHERE c.phi IS NOT NULL), '[]') AS phi,
           COALESCE(jsonb_agg(DISTINCT c.mlr) FILTER (WHERE c.mlr IS NOT NULL), '[]') AS mlr
      FROM numbers nb LEFT JOIN carriers c ON c.n = nb.n
     WHERE nb.n IS NOT NULL
     GROUP BY nb.n
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'epa_registration', n,
           'number_valid', n ~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$',
           'carried', carried,
           'facts', jsonb_strip_nulls(jsonb_build_object(
             'rup_status', CASE WHEN any_rup THEN 'yes' WHEN carried THEN p_rup_default ELSE 'unknown' END,
             'signal_word', CASE WHEN jsonb_array_length(sw) = 1 THEN sw->0 END,
             'rei_hours', CASE WHEN jsonb_array_length(rei) = 1 THEN rei->0 END,
             'phi_days', CASE WHEN jsonb_array_length(phi) = 1 THEN phi->0 END))
             || CASE WHEN jsonb_array_length(mlr) = 1 THEN jsonb_strip_nulls(mlr->0) ELSE '{}'::jsonb END,
           'disagreements', jsonb_strip_nulls(jsonb_build_object(
             'signal_word', CASE WHEN jsonb_array_length(sw) > 1 THEN sw END,
             'rei_hours', CASE WHEN jsonb_array_length(rei) > 1 THEN rei END,
             'phi_days', CASE WHEN jsonb_array_length(phi) > 1 THEN phi END,
             'max_label_rate', CASE WHEN jsonb_array_length(mlr) > 1 THEN mlr END)))
           ORDER BY n), '[]'::jsonb)
    INTO v_regs FROM per;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'invoice_item_id', ii.id, 'invoice_id', ii.invoice_id, 'invoice_number', i.invoice_number,
           'product_id', ii.product_id, 'product_name', p.product_name, 'quantity', ii.quantity,
           'stored_epa_registration', ii.epa_registration,
           'epa_registration', COALESCE(public._normalize_epa_registration(ii.epa_registration), public._normalize_epa_registration(p.epa_registration)),
           'product_is_rup', p.is_rup,
           'blocked', CASE
             WHEN EXISTS (SELECT 1 FROM public.split_invoice_provenance s WHERE s.invoice_id = i.id) THEN 'split_invoice'
             WHEN o.id IS NOT NULL AND (o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL) THEN 'terminal_order'
             WHEN ii.billing_line_id IS NOT NULL THEN 'split_billing_line' END)
           ORDER BY ii.id), '[]'::jsonb)
    INTO v_lines
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
    JOIN public.products p ON p.id = ii.product_id
    LEFT JOIN public.orders o ON o.id = i.order_id
   WHERE i.status IN ('draft', 'unposted') AND i.deleted_at IS NULL;

  -- Every row the seed reads or writes, so any edit between preview and seed is caught.
  SELECT md5(string_agg(x, E'\n' ORDER BY x)) INTO v_rows FROM (
    SELECT 'p' || jsonb_build_array(p.id, p.epa_registration, p.signal_word, p.is_rup, p.rei_hours, p.phi_days,
             p.max_label_rate, p.max_label_rate_unit)::text AS x FROM public.products p
    UNION ALL SELECT 'b' || jsonb_build_array(b.id, b.epa_registration, b.signal_word, b.is_rup, b.row_version)::text FROM public.product_brands b
    UNION ALL SELECT 'pb' || jsonb_build_array(b.id, b.epa_registration, b.signal_word, b.is_rup, b.row_version)::text FROM public.product_parent_brands b
    UNION ALL SELECT 'pp' || jsonb_build_array(pp.id, pp.generic_epa_registration)::text FROM public.product_parents pp
    UNION ALL SELECT 'm' || jsonb_build_array(m.product_id, m.parent_id)::text FROM public.product_parent_members m
    UNION ALL SELECT 'j' || jsonb_build_array(j.job_id, j.product_id, j.epa_registration)::text FROM public.job_product_epa j
    UNION ALL SELECT 'i' || jsonb_build_array(ii.id, ii.product_id, ii.epa_registration, ii.quantity, i.status)::text
      FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
  ) rows_read;

  RETURN jsonb_build_object('rup_default', p_rup_default, 'registrations', v_regs, 'open_lines', v_lines,
    'rows_md5', COALESCE(v_rows, ''));
END;
$function$;
ALTER FUNCTION public._epa_registration_seed_plan(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._epa_registration_seed_plan(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.preview_epa_registration_seed(p_rup_default text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_plan jsonb;
BEGIN
  IF p_rup_default IS NULL OR p_rup_default NOT IN ('unknown', 'no') THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_DEFAULT: the restricted-use default is unknown or no';
  END IF;
  IF public._epa_registrations_seeded() OR EXISTS (SELECT 1 FROM public.epa_registrations) THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_DONE: EPA registrations are already set up';
  END IF;
  v_plan := public._epa_registration_seed_plan(p_rup_default);
  RETURN v_plan || jsonb_build_object(
    'fingerprint', md5(v_plan::text),
    'registration_count', jsonb_array_length(v_plan->'registrations'),
    'disagreement_count', (SELECT count(*) FROM jsonb_array_elements(v_plan->'registrations') r
                            WHERE r->'disagreements' <> '{}'::jsonb),
    'invalid_numbers', (SELECT COALESCE(jsonb_agg(r->'epa_registration'), '[]') FROM jsonb_array_elements(v_plan->'registrations') r
                         WHERE NOT (r->>'number_valid')::boolean),
    'blocked_lines', (SELECT COALESCE(jsonb_agg(l), '[]') FROM jsonb_array_elements(v_plan->'open_lines') l
                       WHERE l->>'blocked' IS NOT NULL));
END;
$function$;
ALTER FUNCTION public.preview_epa_registration_seed(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_epa_registration_seed(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_epa_registration_seed(text) TO authenticated;

-- p_picks: {"<number>": {"signal_word": <one candidate>, "rei_hours": ..., "phi_days": ...,
--   "max_label_rate": {"max_label_rate": ..., "max_label_rate_unit": ...}}}, one entry per disagreement only.
CREATE FUNCTION public.seed_epa_registrations(p_picks jsonb, p_rup_default text, p_expected_fingerprint text,
  p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE
  v_actor uuid := public._product_parent_require_admin();
  v_fp text;
  v_existing jsonb;
  v_plan jsonb;
  v_r jsonb;
  v_n text;
  v_facts jsonb;
  v_col text;
  v_cands jsonb;
  v_pick jsonb;
  v_reg public.epa_registrations;
  v_aff jsonb;
  v_reg_count integer := 0;
  v_aff_count integer := 0;
  v_line record;
  v_line_count integer := 0;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  v_fp := md5(jsonb_build_array(p_picks, p_rup_default, p_expected_fingerprint)::text);
  v_existing := public._product_parent_replay(p_idempotency_key, 'seed_epa_registrations', v_fp);
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  IF p_rup_default IS NULL OR p_rup_default NOT IN ('unknown', 'no') THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_DEFAULT: the restricted-use default is unknown or no';
  END IF;
  IF p_picks IS NULL OR jsonb_typeof(p_picks) <> 'object' THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_PICKS: send the picks as an object ({} when there are none)';
  END IF;

  -- Nothing that reads or writes a number, a label fact or an invoice line runs beside the seed.
  PERFORM public._epa_registration_lock(true);
  LOCK TABLE public.products, public.product_brands, public.product_parent_brands, public.product_parents,
    public.product_parent_members, public.invoices, public.invoice_items, public.job_product_epa,
    public.orders, public.split_invoice_provenance
    IN SHARE ROW EXCLUSIVE MODE;
  IF public._epa_registrations_seeded() OR EXISTS (SELECT 1 FROM public.epa_registrations) THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_DONE: EPA registrations are already set up';
  END IF;

  v_plan := public._epa_registration_seed_plan(p_rup_default);
  IF md5(v_plan::text) IS DISTINCT FROM p_expected_fingerprint THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_STALE: products, brands or invoices changed since the preview; preview again';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'registrations') r WHERE NOT (r->>'number_valid')::boolean) THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_INVALID_NUMBER: fix the EPA numbers the preview lists as invalid first';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'open_lines') l WHERE l->>'blocked' IS NOT NULL) THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_BLOCKED_LINE: an unposted invoice line the seed cannot capture is open (see the preview''s blocked lines)';
  END IF;
  -- Every pick must answer a listed disagreement with one of its candidates, and every disagreement needs one.
  SELECT k INTO v_n FROM jsonb_object_keys(p_picks) k
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan->'registrations') r
                      WHERE r->>'epa_registration' = k AND r->'disagreements' <> '{}'::jsonb)
   LIMIT 1;
  IF v_n IS NOT NULL THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_SEED_PICK_UNEXPECTED: EPA number % has no disagreement to pick', v_n;
  END IF;

  FOR v_r IN SELECT r FROM jsonb_array_elements(v_plan->'registrations') r ORDER BY r->>'epa_registration' LOOP
    v_n := v_r->>'epa_registration';
    v_facts := v_r->'facts';
    FOR v_col, v_cands IN SELECT key, value FROM jsonb_each(v_r->'disagreements') LOOP
      v_pick := p_picks->v_n->v_col;
      IF v_pick IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_cands) c WHERE c = v_pick) THEN
        RAISE EXCEPTION 'EPA_REGISTRATION_SEED_PICK_REQUIRED: pick % for EPA number % from %', v_col, v_n, v_cands;
      END IF;
      v_facts := v_facts || CASE WHEN v_col = 'max_label_rate' THEN jsonb_strip_nulls(v_pick) ELSE jsonb_build_object(v_col, v_pick) END;
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(p_picks->v_n, '{}')) k WHERE NOT (v_r->'disagreements') ? k) THEN
      RAISE EXCEPTION 'EPA_REGISTRATION_SEED_PICK_UNEXPECTED: EPA number % has a pick for a column with no disagreement', v_n;
    END IF;
    PERFORM public._epa_registration_facts(v_facts, true);
    v_reg := public._epa_registration_insert(v_n, v_facts);
    v_aff := public._epa_registration_copy_to_targets(v_n);
    PERFORM public._epa_registration_event(v_n, 'seeded', 'seed (restricted-use default ' || p_rup_default || ')',
      NULL, to_jsonb(v_reg), v_aff);
    v_reg_count := v_reg_count + 1;
    v_aff_count := v_aff_count + jsonb_array_length(v_aff);
  END LOOP;

  -- Capture every not-yet-posted line from its own number, else its product's, else its product
  -- (numberless). The seed_run row does not exist yet, so the capture trigger keeps these values.
  FOR v_line IN
    SELECT ii.id, ii.invoice_id, l->>'epa_registration' AS n, p.id AS product_id, p.is_rup, p.signal_word
      FROM jsonb_array_elements(v_plan->'open_lines') l
      JOIN public.invoice_items ii ON ii.id = (l->>'invoice_item_id')::uuid
      JOIN public.products p ON p.id = ii.product_id
     ORDER BY ii.invoice_id, ii.id
  LOOP
    PERFORM public._epa_registration_pass('invoices', v_line.invoice_id);
    IF v_line.n IS NOT NULL THEN
      SELECT * INTO STRICT v_reg FROM public.epa_registrations WHERE epa_registration = v_line.n;
      UPDATE public.invoice_items SET epa_registration = v_line.n, sale_rup_status = v_reg.rup_status,
             sale_signal_word = v_reg.signal_word, sale_facts_captured_at = now(),
             sale_facts_source = 'seed-assumed:registration:' || v_line.n || '@' || v_reg.registration_version
       WHERE id = v_line.id;
    ELSE
      UPDATE public.invoice_items SET sale_rup_status = CASE WHEN v_line.is_rup THEN 'yes' ELSE p_rup_default END,
             sale_signal_word = v_line.signal_word, sale_facts_captured_at = now(),
             sale_facts_source = 'seed-assumed:product:' || v_line.product_id::text
       WHERE id = v_line.id;
    END IF;
    v_line_count := v_line_count + 1;
  END LOOP;
  DELETE FROM public.epa_registration_copy_passes WHERE txid = txid_current() AND target_table = 'invoices';

  -- Last: from here on every guard, capture and registration tool is live.
  INSERT INTO public.epa_registration_seed_run (seeded_by, rup_default, fingerprint)
  VALUES (v_actor, p_rup_default, p_expected_fingerprint);

  v_result := jsonb_build_object('registrations', v_reg_count, 'sizes_and_brands_updated', v_aff_count,
    'lines_captured', v_line_count, 'rup_default', p_rup_default, 'fingerprint', p_expected_fingerprint);
  PERFORM public.save_idempotency(p_idempotency_key, 'seed_epa_registrations',
    jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result));
  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.seed_epa_registrations(jsonb, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.seed_epa_registrations(jsonb, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.seed_epa_registrations(jsonb, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Q7 (products half): no direct product inserts from the app roles (Mason approves at apply)
-- ---------------------------------------------------------------------------------------------

REVOKE INSERT ON TABLE public.products FROM anon, authenticated;
-- The 28 column-level INSERT grants live holds (2026-11-08), named so the removal is explicit.
REVOKE INSERT (category, container_size, container_type, container_unit, epa_registration, internal_notes, inventory_unit, is_active, is_rup, manufacturer, max_label_rate, max_label_rate_unit, notes, phi_days, product_form, product_name, quoting_notes, rate_per_acre, rate_unit, rei_hours, signal_word, sku, suggested_rate, unit_size, updated_at, use_timing, use_timings, vendor)
  ON public.products FROM anon, authenticated;

DO $postflight$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, 'public.products', 'INSERT')
       OR has_any_column_privilege(v_role, 'public.products', 'INSERT') THEN
      RAISE EXCEPTION 'POSTFLIGHT_EPA_REGISTRATION_GUARDS: % can insert products', v_role;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._add_product_size_reg1_impl(uuid,bigint,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._move_product_size_reg1_impl(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._create_product_with_parent_reg1_impl(jsonb,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._epa_registration_seed_plan(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_product_registration()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_brand_registration()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.add_product_size(uuid,bigint,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.move_product_size(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.create_product_with_parent(jsonb,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.seed_epa_registrations(jsonb,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.preview_epa_registration_seed(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.seed_epa_registrations(jsonb,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preview_epa_registration_seed(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.add_product_size(uuid,bigint,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.move_product_size(uuid,uuid,bigint,bigint,text,text,text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.create_product_with_parent(jsonb,jsonb,text)', 'EXECUTE')
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
          AND tgname IN ('trigger_zz_guard_product_registration', 'trigger_zz_guard_brand_registration')) <> 3
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                 AND proname IN ('add_product_size', 'move_product_size', 'create_product_with_parent')
               GROUP BY proname HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                 AND (p.proname LIKE '\_epa\_registration%' OR p.proname LIKE '%\_reg1\_impl')
                 AND (p.proowner <> 'postgres'::regrole
                      OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                      OR has_function_privilege('anon', p.oid, 'EXECUTE')))
     OR EXISTS (SELECT 1 FROM public.epa_registrations) THEN
    RAISE EXCEPTION 'POSTFLIGHT_EPA_REGISTRATION_GUARDS_WRONG';
  END IF;
END;
$postflight$;
