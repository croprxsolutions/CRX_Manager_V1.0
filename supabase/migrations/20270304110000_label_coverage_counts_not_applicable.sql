-- Label Data Quality: a product ticked "label gives no REI/PHI" counts as covered (issue #2500).
--
-- WHY: Mason decided (2026-11-24, #2500) that a product whose label gives no REI (or no PHI) is covered for that
--   interval, the same as a product with a number. The product page already treats it so (no "Incomplete setup");
--   the coverage report still counted only numbers.
--
-- WHAT: re-issues get_label_coverage_report from 20260629210000 (body verified identical to production 2026-11-24).
--   Only the rei_hours and phi_days counts change: number present OR its not-applicable flag (20270303130000) set.
--   Same name, no arguments, same jsonb keys, same admin check, SECURITY DEFINER and search_path.
--   CREATE OR REPLACE keeps the existing grants (authenticated + service_role; no PUBLIC/anon).
--
-- NON-DESTRUCTIVE: read-only report function; no table, row or grant changes.
-- ROLLBACK: re-issue the 20260629210000 body (drop the two "OR ..._not_applicable" terms).

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.products'::regclass
                  AND attname = 'rei_not_applicable' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.products'::regclass
                     AND attname = 'phi_not_applicable' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PREFLIGHT_INTERVAL_NA_COLUMNS_MISSING: apply 20270303130000 first';
  END IF;
  -- The exact 20260629210000 body (line endings ignored), read on production 2026-11-24.
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = 'public.get_label_coverage_report()'::regprocedure)
     IS DISTINCT FROM '91ea3758541d13f612e7580bd5dd48d7' THEN
    RAISE EXCEPTION 'PREFLIGHT_LABEL_COVERAGE_REPORT_CHANGED: re-read get_label_coverage_report before re-issuing it';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_label_coverage_report()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_total   int;
  v_result  jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: admin role required';
  END IF;

  SELECT count(*) INTO v_total FROM products WHERE is_active = true;

  SELECT jsonb_build_object(
    'total_active_products', v_total,
    'signal_word',       (SELECT count(*) FROM products WHERE is_active = true AND NULLIF(btrim(signal_word), '')      IS NOT NULL),
    -- Covered = a number, or the label gives none (Mason, #2500).
    'rei_hours',         (SELECT count(*) FROM products WHERE is_active = true AND (rei_hours IS NOT NULL OR rei_not_applicable)),
    'phi_days',          (SELECT count(*) FROM products WHERE is_active = true AND (phi_days  IS NOT NULL OR phi_not_applicable)),
    'epa_registration',  (SELECT count(*) FROM products WHERE is_active = true AND NULLIF(btrim(epa_registration), '') IS NOT NULL),
    'max_label_rate',    (SELECT count(*) FROM products WHERE is_active = true AND max_label_rate   IS NOT NULL),
    'pending_drafts',    (SELECT count(*) FROM product_label_drafts WHERE status = 'pending'),
    'accepted_drafts',   (SELECT count(*) FROM product_label_drafts WHERE status IN ('accepted','edited')),
    'rejected_drafts',   (SELECT count(*) FROM product_label_drafts WHERE status = 'rejected'),
    'needs_manual',      (SELECT count(*) FROM product_label_drafts WHERE status = 'needs_manual')
  ) INTO v_result;

  RETURN v_result;
END;
$$;

DO $postflight$
BEGIN
  IF has_function_privilege('anon', 'public.get_label_coverage_report()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_label_coverage_report()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_LABEL_COVERAGE_REPORT_GRANTS_CHANGED';
  END IF;
END;
$postflight$;
