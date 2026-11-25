-- ============================================================================
-- 20270304140000_supplier_quote_unit_floor
-- Supplier Pricing follow-up (#2486 Sol round 1 MED). Contract: docs/plans/2026-11-24-supplier-quote-unit-floor-CONTRACT.md
--
-- WHY: the converted cost per inventory unit, round(cost_cents / package_quantity / inventory_units_per_supplier_unit),
--   overflowed bigint when the conversion factor and package quantity were tiny (both columns allow 0.00000001) or the
--   cost was huge, so the review screen showed an absurd cost and the workspace read failed on that row.
-- WHAT: bound each input where it is saved. With factor >= 0.001, package quantity >= 0.001 and cost <= 1e9 cents
--   ($10,000,000 per line) the converted cost is at most 1e15 cents: inside bigint and JavaScript's exact integers.
--   1. stage_supplier_price_import (re-emitted; only these two checks differ from 20260720230000): a package quantity below
--      0.001 is PACKAGE_QUANTITY_INVALID and a cost above $10,000,000 is COST_TOO_LARGE; the row is 'invalid'.
--   2. CHECK product_supplier_links_conversion_floor: factor NULL or >= 0.001 (only upsert_product_supplier_link sets a
--      factor; any UPDATE of a link row is re-checked, so a staging legacy row must be fixed before it can change).
--   3. CHECKs supplier_price_observations_package_quantity_floor (>= 0.001) and supplier_price_observations_cost_ceiling
--      (<= 1e9 cents): backstop for approve and correction (observations are insert-only).
--   4. CHECK supplier_price_import_rows_pending_bounds: a row still awaiting approval (new, changed, cannot_compare) is
--      within the same bounds, so a quote saved by an older call already running during the apply fails instead of
--      leaving a row that looks approvable but cannot be approved.
--   The checks are added validated: the preflight refuses the whole apply (SUPPLIER_QUOTE_UNIT_FLOOR_LEGACY_ROWS, with
--   counts) if any stored link, observation or approvable import row is outside a bound, so no row can slip past them.
--   NaN is refused too: it sorts above every number.
-- LIVE EVIDENCE (read-only, production, 2026-11-24): every factor and package quantity in use is exactly 1 (10 links,
--   20 import rows, 10 observations); 0 below 0.001; largest cost 46,743 cents; stage body md5(prosrc) a927dd96feb00564a3e3e96b012e66e9.
-- NOT CHANGED: grants, policies, idempotency, other functions and their reads.
-- ROLLBACK: a NEW forward migration: drop the four constraints and re-emit stage_supplier_price_import from 20260720230000.
-- ============================================================================

CREATE TEMP TABLE supplier_quote_unit_floor_tx ON COMMIT DROP AS SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_links bigint;
  v_observations bigint;
  v_rows bigint;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.supplier_quote_unit_floor_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.supplier_quote_unit_floor_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p
      WHERE p.oid = 'public.stage_supplier_price_import(uuid, date, text, text, text, text, text, jsonb, uuid, text)'::regprocedure)
     IS DISTINCT FROM 'a927dd96feb00564a3e3e96b012e66e9' THEN
    RAISE EXCEPTION 'SUPPLIER_QUOTE_UNIT_FLOOR_BASELINE_DRIFT: stage_supplier_price_import body changed';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'stage_supplier_price_import') <> 1 THEN
    RAISE EXCEPTION 'SUPPLIER_QUOTE_UNIT_FLOOR_BASELINE_DRIFT: expected one stage_supplier_price_import';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid IN ('public.product_supplier_links'::regclass, 'public.supplier_price_observations'::regclass,
        'public.supplier_price_import_rows'::regclass) AND c.conname IN (
      'product_supplier_links_conversion_floor',
      'supplier_price_observations_package_quantity_floor',
      'supplier_price_observations_cost_ceiling',
      'supplier_price_import_rows_pending_bounds')) THEN
    RAISE EXCEPTION 'SUPPLIER_QUOTE_UNIT_FLOOR_BASELINE_DRIFT: a constraint already exists';
  END IF;
  -- Take every lock the checks below need now, at once and in the app's write order (import rows, then observations),
  -- so the count is exact and no lock is upgraded later. Staff Supplier Pricing calls wait under a second; a wait over 5s
  -- or a deadlock cancels one side with nothing saved (the staff call fails and can be retried, or the apply is re-run).
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE public.supplier_price_import_rows, public.supplier_price_observations, public.product_supplier_links
    IN ACCESS EXCLUSIVE MODE;
  -- Any stored row outside a bound stops the apply: fix or remove it first (production had none on 2026-11-24).
  SELECT count(*) INTO v_links FROM public.product_supplier_links
    WHERE inventory_units_per_supplier_unit < 0.001 OR inventory_units_per_supplier_unit = 'NaN';
  SELECT count(*) INTO v_observations FROM public.supplier_price_observations
    WHERE package_quantity < 0.001 OR package_quantity = 'NaN' OR cost_cents > 1000000000;
  SELECT count(*) INTO v_rows FROM public.supplier_price_import_rows
    WHERE row_status IN ('new', 'changed', 'cannot_compare')
      AND (package_quantity < 0.001 OR package_quantity = 'NaN' OR cost_cents > 1000000000);
  IF v_links + v_observations + v_rows > 0 THEN
    RAISE EXCEPTION 'SUPPLIER_QUOTE_UNIT_FLOOR_LEGACY_ROWS: links=%, observations=%, approvable import rows=%',
      v_links, v_observations, v_rows;
  END IF;
END;
$preflight$;

-- The preflight already holds the exclusive locks these need.
ALTER TABLE public.product_supplier_links
  ADD CONSTRAINT product_supplier_links_conversion_floor
  CHECK (inventory_units_per_supplier_unit IS NULL
         OR (inventory_units_per_supplier_unit >= 0.001 AND inventory_units_per_supplier_unit <> 'NaN'));

ALTER TABLE public.supplier_price_observations
  ADD CONSTRAINT supplier_price_observations_package_quantity_floor
  CHECK (package_quantity >= 0.001 AND package_quantity <> 'NaN');

ALTER TABLE public.supplier_price_observations
  ADD CONSTRAINT supplier_price_observations_cost_ceiling
  CHECK (cost_cents <= 1000000000);

ALTER TABLE public.supplier_price_import_rows
  ADD CONSTRAINT supplier_price_import_rows_pending_bounds
  CHECK (row_status NOT IN ('new', 'changed', 'cannot_compare')
         OR ((package_quantity IS NULL OR (package_quantity >= 0.001 AND package_quantity <> 'NaN'))
             AND (cost_cents IS NULL OR cost_cents <= 1000000000)));

-- Unchanged from 20260720230000 except the COST_TOO_LARGE branch and the 0.001 package-quantity floor.
CREATE OR REPLACE FUNCTION public.stage_supplier_price_import(
  p_vendor_id uuid,
  p_document_date date,
  p_ingestion_method text,
  p_format_version text,
  p_source_document_path text,
  p_source_document_name text,
  p_source_document_mime text,
  p_rows jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request_fp text;
  v_durable public.supplier_price_imports%ROWTYPE;
  v_import_id uuid;
  v_row jsonb;
  v_sequence integer;
  v_link public.product_supplier_links%ROWTYPE;
  v_cost_cents bigint;
  v_effective_from date;
  v_effective_to date;
  v_package_quantity numeric(20,8);
  v_price_kind text;
  v_price_unit text;
  v_status text;
  v_errors text[];
  v_link_id uuid;
  v_result jsonb;
  v_row_count integer;
  v_eligible_count integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_document_date IS NULL THEN RAISE EXCEPTION 'DOCUMENT_DATE_REQUIRED'; END IF;
  IF p_ingestion_method NOT IN ('quote_sheet', 'quick_quote') THEN
    RAISE EXCEPTION 'SUPPLIER_INGESTION_METHOD_INVALID';
  END IF;
  IF NULLIF(btrim(p_format_version), '') IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_FORMAT_VERSION_REQUIRED';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'SUPPLIER_IMPORT_ROWS_REQUIRED';
  END IF;
  v_row_count := jsonb_array_length(p_rows);
  IF v_row_count < 1 OR v_row_count > 5000 THEN
    RAISE EXCEPTION 'SUPPLIER_IMPORT_ROW_COUNT_INVALID';
  END IF;
  IF p_source_document_path IS NOT NULL AND (
    NULLIF(btrim(COALESCE(p_source_document_name, '')), '') IS NULL
    OR p_source_document_mime IS DISTINCT FROM 'application/pdf'
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_SOURCE_DOCUMENT_INVALID';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'vendor_id', p_vendor_id,
    'document_date', p_document_date,
    'ingestion_method', p_ingestion_method,
    'format_version', p_format_version,
    'source_document_path', p_source_document_path,
    'rows', p_rows
  )::text);
  v_existing := public.check_idempotency(p_idempotency_key, 'stage_supplier_price_import');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- The shared cache expires after 24 hours. The import row is the durable
  -- receipt, so only the exact original actor, payload fingerprint, and
  -- idempotency key may replay it. Runs before the ownership/existence checks
  -- so a replay does not re-litigate transient state (e.g. an already-consumed
  -- source PDF); the fingerprint pins the replay to the identical payload.
  SELECT * INTO v_durable
  FROM public.supplier_price_imports i
  WHERE i.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_durable.created_by IS DISTINCT FROM v_actor
       OR v_durable.request_fingerprint IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN public.get_supplier_price_import(v_durable.id);
  END IF;

  IF p_source_document_path IS NOT NULL AND (
    split_part(p_source_document_path, '/', 1) IS DISTINCT FROM v_actor::text
    OR NOT EXISTS (
      SELECT 1
      FROM storage.objects object
      WHERE object.bucket_id = 'supplier-price-evidence'
        AND object.name = p_source_document_path
    )
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_SOURCE_DOCUMENT_NOT_OWNED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.vendors WHERE id = p_vendor_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND';
  END IF;

  INSERT INTO public.supplier_price_imports(
    vendor_id, document_date, ingestion_method, format_version, status,
    source_document_path, source_document_name, source_document_mime,
    request_fingerprint, idempotency_key, row_count, created_by
  ) VALUES (
    p_vendor_id, p_document_date, p_ingestion_method, p_format_version, 'draft',
    NULLIF(btrim(COALESCE(p_source_document_path, '')), ''),
    NULLIF(btrim(COALESCE(p_source_document_name, '')), ''),
    NULLIF(btrim(COALESCE(p_source_document_mime, '')), ''),
    v_request_fp, p_idempotency_key, v_row_count, v_actor
  ) RETURNING id INTO v_import_id;

  FOR v_row, v_sequence IN
    SELECT value, ordinality::integer
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY
  LOOP
    v_errors := ARRAY[]::text[];
    v_status := 'new';
    v_cost_cents := NULL;
    v_effective_from := NULL;
    v_effective_to := NULL;
    v_package_quantity := NULL;
    v_link_id := NULL;
    v_link := NULL;
    v_price_kind := lower(COALESCE(NULLIF(btrim(v_row->>'price_kind'), ''), 'quote'));
    v_price_unit := NULLIF(btrim(COALESCE(v_row->>'price_unit', '')), '');

    IF lower(COALESCE(v_row->>'has_formula', 'false')) = 'true' THEN
      v_errors := array_append(v_errors, 'FORMULA_NOT_ALLOWED');
    END IF;

    BEGIN
      v_link_id := NULLIF(btrim(COALESCE(v_row->>'product_supplier_link_id', '')), '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_errors := array_append(v_errors, 'LINK_ID_INVALID');
    END;

    IF v_link_id IS NOT NULL THEN
      SELECT * INTO v_link
      FROM public.product_supplier_links
      WHERE id = v_link_id AND is_active;
      IF NOT FOUND OR v_link.vendor_id IS DISTINCT FROM p_vendor_id THEN
        v_errors := array_append(v_errors, 'LINK_VENDOR_MISMATCH');
        v_link_id := NULL;
        v_link := NULL;
      ELSIF NOT v_link.is_reusable THEN
        v_errors := array_append(v_errors, 'LINK_NOT_CONFIRMED_FOR_REUSE');
      ELSE
        IF v_price_unit IS NULL THEN
          v_price_unit := v_link.supplier_uom;
        ELSIF v_price_unit IS DISTINCT FROM v_link.supplier_uom THEN
          -- Normalized ranking divides the package cost by the link's
          -- inventory_units_per_supplier_unit, which is defined for the link's
          -- supplier_uom. A quote in any other unit cannot be ranked honestly.
          v_errors := array_append(v_errors, 'PRICE_UNIT_MISMATCH');
        END IF;
      END IF;
    ELSE
      v_errors := array_append(v_errors, 'LINK_REQUIRED');
    END IF;

    BEGIN
      v_cost_cents := public._parse_pricing_dollars(btrim(COALESCE(v_row->>'new_cost', '')));
      IF v_cost_cents <= 0 THEN
        v_errors := array_append(v_errors, 'COST_MUST_BE_POSITIVE');
      ELSIF v_cost_cents > 1000000000 THEN
        -- $10,000,000 per line: with the 0.001 floors the converted cost stays below 1e15 cents.
        v_errors := array_append(v_errors, 'COST_TOO_LARGE');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := array_append(v_errors, 'COST_INVALID');
      v_cost_cents := NULL;
    END;

    IF v_price_kind NOT IN ('list', 'quote', 'contract', 'promo', 'manual') THEN
      v_errors := array_append(v_errors, 'PRICE_KIND_INVALID');
      v_price_kind := NULL;
    END IF;
    IF v_price_unit IS NULL THEN
      v_errors := array_append(v_errors, 'PRICE_UNIT_REQUIRED');
    END IF;

    BEGIN
      v_package_quantity := COALESCE(NULLIF(btrim(v_row->>'package_quantity'), '')::numeric, 1);
      -- NaN sorts above every number, so it is named explicitly.
      IF v_package_quantity < 0.001 OR v_package_quantity = 'NaN' THEN
        v_errors := array_append(v_errors, 'PACKAGE_QUANTITY_INVALID');
      END IF;
    EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
      v_errors := array_append(v_errors, 'PACKAGE_QUANTITY_INVALID');
      v_package_quantity := NULL;
    END;

    BEGIN
      v_effective_from := COALESCE(NULLIF(btrim(v_row->>'effective_date'), '')::date, p_document_date);
      v_effective_to := NULLIF(btrim(COALESCE(v_row->>'effective_to', '')), '')::date;
      IF v_effective_to IS NOT NULL AND v_effective_to < v_effective_from THEN
        v_errors := array_append(v_errors, 'EFFECTIVE_RANGE_INVALID');
      END IF;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      v_errors := array_append(v_errors, 'EFFECTIVE_DATE_INVALID');
      v_effective_from := NULL;
      v_effective_to := NULL;
    END;

    IF cardinality(v_errors) > 0 THEN
      v_status := 'invalid';
    ELSIF EXISTS (
      SELECT 1 FROM public.supplier_price_import_rows prior
      WHERE prior.import_id = v_import_id
        AND prior.product_supplier_link_id = v_link_id
        AND prior.cost_cents = v_cost_cents
        AND prior.effective_from = v_effective_from
        AND prior.price_kind = v_price_kind
    ) THEN
      v_status := 'duplicate';
    ELSIF EXISTS (
      SELECT 1 FROM public.supplier_price_observations o
      WHERE o.product_supplier_link_id = v_link_id
        AND o.cost_cents = v_cost_cents
        AND o.effective_from = v_effective_from
        AND o.price_kind = v_price_kind
        AND o.price_unit = v_price_unit
        AND o.package_quantity = v_package_quantity
    ) THEN
      v_status := 'unchanged';
    ELSIF v_link.comparison_status <> 'comparable' THEN
      v_status := 'cannot_compare';
    ELSIF EXISTS (
      SELECT 1
      FROM public.supplier_price_observations o
      WHERE o.product_supplier_link_id = v_link_id
    ) THEN
      v_status := 'changed';
    END IF;

    INSERT INTO public.supplier_price_import_rows(
      import_id, row_number, submitted_row,
      product_id, vendor_id, product_supplier_link_id,
      supplier_sku, supplier_product_name,
      cost_cents, price_unit, package_quantity,
      effective_from, effective_to, price_kind,
      row_status, validation_errors
    ) VALUES (
      v_import_id, v_sequence, v_row,
      CASE WHEN v_link_id IS NULL THEN NULL ELSE v_link.product_id END,
      CASE WHEN v_link_id IS NULL THEN NULL ELSE p_vendor_id END,
      v_link_id,
      CASE WHEN v_link_id IS NULL THEN NULL ELSE v_link.supplier_sku END,
      CASE WHEN v_link_id IS NULL THEN NULL ELSE v_link.supplier_product_name END,
      v_cost_cents, v_price_unit, v_package_quantity,
      v_effective_from, v_effective_to, v_price_kind,
      v_status, v_errors
    );
  END LOOP;

  SELECT count(*)::integer INTO v_eligible_count
  FROM public.supplier_price_import_rows
  WHERE import_id = v_import_id
    AND row_status IN ('new', 'changed', 'cannot_compare');

  UPDATE public.supplier_price_imports
  SET status = 'needs_review',
      eligible_row_count = v_eligible_count
  WHERE id = v_import_id;

  v_result := public.get_supplier_price_import(v_import_id);
  PERFORM public.save_idempotency(
    p_idempotency_key,
    'stage_supplier_price_import',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_result
    )
  );
  RETURN v_result;
END;
$function$;

DO $postflight$
DECLARE
  v_sig regprocedure := 'public.stage_supplier_price_import(uuid, date, text, text, text, text, text, jsonb, uuid, text)'::regprocedure;
BEGIN
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'stage_supplier_price_import') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_OVERLOAD: expected exactly one stage_supplier_price_import';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_sig AND p.prosecdef
                   AND p.proconfig = ARRAY['search_path=public, pg_temp']
                   AND p.prosrc LIKE '%v_package_quantity < 0.001 OR v_package_quantity = ''NaN''%' AND p.prosrc LIKE '%COST_TOO_LARGE%') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FUNCTION: stage_supplier_price_import body, security or search_path wrong';
  END IF;
  IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANTS: execute must stay authenticated only';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c WHERE c.conrelid IN ('public.product_supplier_links'::regclass, 'public.supplier_price_observations'::regclass,
        'public.supplier_price_import_rows'::regclass) AND c.contype = 'c' AND c.conname IN (
        'product_supplier_links_conversion_floor',
        'supplier_price_observations_package_quantity_floor',
        'supplier_price_observations_cost_ceiling',
        'supplier_price_import_rows_pending_bounds')) <> 4 THEN
    RAISE EXCEPTION 'POSTFLIGHT_CONSTRAINTS: expected the four checks';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid IN ('public.product_supplier_links'::regclass, 'public.supplier_price_observations'::regclass,
        'public.supplier_price_import_rows'::regclass) AND NOT c.convalidated AND c.conname IN (
        'product_supplier_links_conversion_floor',
        'supplier_price_observations_package_quantity_floor',
        'supplier_price_observations_cost_ceiling',
        'supplier_price_import_rows_pending_bounds')) THEN
    RAISE EXCEPTION 'POSTFLIGHT_CONSTRAINTS: every check must be validated';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
