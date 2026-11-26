-- Keep browser settings reads on the keys used by each role's workflows.
-- Existing keys and values, admin writes, and trusted server reads are preserved.
SET LOCAL lock_timeout = '5s';

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
