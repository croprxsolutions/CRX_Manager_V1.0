-- Keep browser settings reads on the keys used by each role's workflows.
-- Existing keys and values, admin writes, and trusted server reads are preserved.
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE settings_read_policy_tx ON COMMIT DROP AS
  SELECT pg_current_xact_id() AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.settings_read_policy_tx') IS NULL THEN
    RAISE EXCEPTION 'SETTINGS_READ_POLICY_NEEDS_TRANSACTION';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'app_settings' AND policyname = 'settings_select'
      AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND roles = ARRAY['authenticated']::name[]
      AND regexp_replace(replace(qual, 'public.', ''), '\s+', '', 'g') = '(SELECTis_active_profile()ASis_active_profile)'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'app_settings' AND policyname <> 'settings_select'
      AND cmd IN ('SELECT', 'ALL')
  ) THEN RAISE EXCEPTION 'SETTINGS_READ_POLICY_PRECHECK_FAIL'; END IF;
END
$preflight$;

ALTER POLICY settings_select ON public.app_settings
  USING (
    (SELECT public.is_active_profile())
    AND (
      (SELECT public.is_admin())
      OR (
        ((SELECT public.is_sales_rep()) OR (SELECT public.is_driver()) OR (SELECT public.is_applicator()))
        AND setting_key IN ('company_name', 'company_phone', 'company_email', 'company_address')
      )
      OR (
        ((SELECT public.is_sales_rep()) OR (SELECT public.is_applicator()))
        AND setting_key IN ('label_rate_guardrail_mode', 'applicator_print_options', 'applicator_sheet_custom')
      )
      OR (
        (SELECT public.is_sales_rep())
        AND setting_key IN (
          'default_tier', 'default_quote_valid_days', 'booking_timing_windows',
          'sales_tax_rate', 'prepay_bucket_labels', 'per_line_split_billing_enabled',
          'fuel_surcharge', 'crop_programs', 'pre_application_notice_template',
          'post_application_notice_template'
        )
      )
    )
  );

DO $postflight$
BEGIN
  IF to_regclass('pg_temp.settings_read_policy_tx') IS NULL
    OR (SELECT transaction_id FROM pg_temp.settings_read_policy_tx) IS DISTINCT FROM pg_current_xact_id()
  THEN RAISE EXCEPTION 'SETTINGS_READ_POLICY_NEEDS_TRANSACTION'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'app_settings' AND policyname = 'settings_select'
      AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[]
      AND qual LIKE ALL (ARRAY['%is_admin()%', '%is_active_profile()%', '%is_sales_rep()%', '%is_driver()%',
        '%is_applicator()%', '%company_name%', '%label_rate_guardrail_mode%', '%default_tier%'])
  ) THEN RAISE EXCEPTION 'SETTINGS_READ_POLICY_POSTCHECK_FAIL'; END IF;
END
$postflight$;
