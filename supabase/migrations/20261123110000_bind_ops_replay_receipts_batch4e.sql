-- Written 2026-11-05. STATUS: NOT APPLIED. KI-10 replay-binding batch 4e: 15 operations.
-- idempotency-body-check: exempt -- wrappers call the pinned body, check_idempotency_intent,
-- and _bind_replay_receipt_20261015; the hook does not parse this delegated pattern.
-- APPLY ORDER: after 20261114200000_bind_records_replay_receipts_batch4d (applied live).
-- APPLY ORDER: only after the app PR adding keys to confirm_job_notification_sent,
-- log_failed_notification, and update_field_app_applied_info is deployed to production.
-- ROLLBACK: a new reviewed migration restores the prior trigger list, drops the public
-- wrappers, renames each pinned _<name>_replay_impl_20261015 back, and restores grants.
-- ORDERING: live high-water 20261120100000_field_invoice_due_date_follows_owner_terms (ledger
-- 20261106145427; it replaces only invoice due-date and field-billing functions, none pinned here).
-- Re-checked 2026-11-06 after it: every pin below matches live, each of the 15 names has exactly
-- one live overload (the keyed signature), and no unexpired receipt exists for these operations.
-- Restamped from 20261111210000 (below applied batch 4d), then from 20261117110000 (below open
-- PR #1524, 20261117140000), then from 20261117150000 (below applied sale_line_vendor), then from
-- 20261118120000 (below applied 20261120100000; highest local stamp 20261123100000).
-- This file requires the exact 78-operation post-4d guard (53 through 4c, then the 25 batch 4d
-- operations, in that order) and appends its own 15; every other guard state is refused.
-- KNOWN LIMITS: dynamic SQL callers cannot be found by catalog text scan; a keyless call
-- still fails closed, except the three calls PR #1518 began keying: confirm_job_notification_sent,
-- log_failed_notification and update_field_app_applied_info keep their pre-4e keyless path
-- (unchanged body, no receipt), so a tab older than PR #1518 can still confirm an email it sent,
-- log a failure, and save applied info after its invoice. Every other old-bundle call already sent a key.
-- EXCLUDED: the twelve 4c functions; generate_rup_sales_records (parked rewrite);
-- service-role-only commit_blend_ticket_ocr_result, increment_customer_prepay,
-- load_recipe_into_job, restore_cancelled_delivery; save_job_applied_record (own request hash);
-- receipt-free create_order_from_blend_ticket, link_blend_ticket_to_order,
-- unlink_blend_ticket_from_order, generate_batch_statements, get_ap_dashboard_summary,
-- get_expiring_planned_holds.
-- Internal batch_apply_all_prepayments -> apply_remaining_prepayments passes NULL, but its
-- pinned PREPAY_BULK_APPLY_DISABLED raise makes the call unreachable. Re-enabling that body
-- without a key makes the inner call fail closed. _complete_job_replay_impl_20261015 only
-- mentions start_job in an error string; it is not a live internal call.
-- caller-analysis: confirm_job_notification_sent :: src/pages/JobDetail.tsx, src/pages/FieldApplicationInvoice.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: confirm_job_notification_sent: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: confirm_job_notification_sent: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true; IF v_role IS.
-- receipt-less-return: confirm_job_notification_sent has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: record_job_pre_notifications :: src/pages/JobDetail.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: record_job_pre_notifications: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: record_job_pre_notifications: -- actor / strict-actor / role gate (admin or sales_rep send notifications). v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; SELECT role IN.
-- receipt-less-return: record_job_pre_notifications has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: record_job_post_notifications :: src/pages/JobDetail.tsx, src/pages/FieldApplicationInvoice.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: record_job_post_notifications: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: record_job_post_notifications: -- actor / strict-actor / role gate (admin or sales_rep send notifications). v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; SELECT role IN.
-- receipt-less-return: record_job_post_notifications has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: log_failed_notification :: src/lib/notificationTriggers.ts (fresh key per call; shared by about 14 screens, including Field Stop used by drivers and applicators) and src/pages/Dashboard.tsx (key added by the app PR that must deploy first); wrapper retains authenticated/service_role EXECUTE. Deliberately NO role check: the pinned body has none, it only appends a row to the failed_notifications log (no money, stock or customer record), and a staff-only check would silently drop failure logs from field screens.
-- fingerprint-exclusions: log_failed_notification: p_idempotency_key only.
-- pre-lookup-checks: log_failed_notification: .
-- receipt-less-return: log_failed_notification has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: apply_remaining_prepayments :: src/components/prepay/PrepaymentManagerPanel.tsx; batch_apply_all_prepayments passes NULL inner key; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: apply_remaining_prepayments: p_idempotency_key only.
-- pre-lookup-checks: apply_remaining_prepayments: -- OVERNIGHT BUG HUNT GUARD (HIGH: prepay double-spend, no-ledger). -- Hard-block bulk prepay apply until the reserved-pool redesign lands. -- Remove this RAISE block to restore the (still-defective) behavior. RAISE EXCEPTION 'PREPAY_BULK_APPLY_DISABLED' USING DETAIL = 'Bulk prepay application is te.
-- receipt-less-return: apply_remaining_prepayments has no reachable success: PREPAY_BULK_APPLY_DISABLED raises first and writes no receipt.
-- caller-analysis: batch_apply_all_prepayments :: src/components/prepay/PrepaymentManagerPanel.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: batch_apply_all_prepayments: p_idempotency_key only; p_performed_by check unreachable after hard block.
-- pre-lookup-checks: batch_apply_all_prepayments: -- OVERNIGHT BUG HUNT GUARD (HIGH: prepay double-spend, no-ledger). -- Hard-block bulk prepay apply until the reserved-pool redesign lands. -- Remove this RAISE block to restore the (still-defective) behavior. RAISE EXCEPTION 'PREPAY_BULK_APPLY_DISABLED' USING DETAIL = 'Bulk prepay application is te.
-- receipt-less-return: batch_apply_all_prepayments has no reachable success: PREPAY_BULK_APPLY_DISABLED raises first and writes no receipt.
-- caller-analysis: assign_job_applicator :: src/pages/JobDetail.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: assign_job_applicator: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: assign_job_applicator: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true; IF v_role IS.
-- receipt-less-return: assign_job_applicator has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: dispatch_job_locations :: src/components/dispatch/DispatchWizard.tsx, src/pages/DispatchBoard.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: dispatch_job_locations: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: dispatch_job_locations: -- actor / strict-actor / role gate (mirrors jobs_update RLS) v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; SELECT role INTO v_role FROM .
-- receipt-less-return: dispatch_job_locations has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: undispatch_job_locations :: src/pages/DispatchBoard.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: undispatch_job_locations: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: undispatch_job_locations: -- actor / strict-actor / role gate (mirrors dispatch_job_locations). v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; SELECT role INTO v_ro.
-- receipt-less-return: undispatch_job_locations has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: start_job :: src/pages/JobDetail.tsx, src/pages/FieldView.tsx; _complete_job_replay_impl_20261015 mentions the name in an error only; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: start_job: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: start_job: IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF; IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'p_performed_by does not match authenticated user'; END IF;.
-- receipt-less-return: start_job has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: create_job_from_quote_section :: src/pages/QuoteBuilder.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: create_job_from_quote_section: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: create_job_from_quote_section: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN (.
-- receipt-less-return: create_job_from_quote_section has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: update_field_app_applied_info :: src/pages/FieldApplicationInvoice.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: update_field_app_applied_info: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: update_field_app_applied_info: IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF; IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'p_performed_by does not match the authenticated user'; END IF; IF NOT (is_admin() OR is_sales_rep()) THEN RAISE EXCEPTION 'Not authorized: admin or sales role require.
-- receipt-less-return: update_field_app_applied_info has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: create_quote_from_template :: src/pages/QuoteBuilder.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: create_quote_from_template: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: create_quote_from_template: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN (.
-- receipt-less-return: create_quote_from_template has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: rollover_quote_to_season :: src/pages/QuoteBuilder.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: rollover_quote_to_season: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: rollover_quote_to_season: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN (.
-- receipt-less-return: rollover_quote_to_season has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: save_quote_template :: src/pages/QuoteBuilder.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: save_quote_template: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: save_quote_template: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN (.
-- receipt-less-return: save_quote_template has no reachable keyed success without a receipt in its pinned body.

SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE ops_replay_binding_batch4e_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;
CREATE TEMP TABLE ops_replay_binding_batch4e_guard_ops (ord integer PRIMARY KEY, operation text NOT NULL UNIQUE) ON COMMIT DROP;
CREATE TEMP TABLE ops_replay_binding_batch4e_pins ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('confirm_job_notification_sent', 'p_notification_id uuid, p_subject text DEFAULT NULL::text, p_message text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_notification_id uuid, p_subject text, p_message text, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', '04e62e96e776ad0b28eb383d2692d051'),
  ('record_job_pre_notifications', 'p_job_id uuid, p_subject text, p_message text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_job_id uuid, p_subject text, p_message text, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'c1170f13c2eb180f6c9725ad1582e854'),
  ('record_job_post_notifications', 'p_job_id uuid, p_subject text, p_message text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_job_id uuid, p_subject text, p_message text, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', '7249113fd8b48cab67f5c42a4e0486dd'),
  ('log_failed_notification', 'p_notification_type text, p_entity_type text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid, p_error_message text DEFAULT NULL::text, p_payload jsonb DEFAULT NULL::jsonb, p_idempotency_key text DEFAULT NULL::text', 'p_notification_type text, p_entity_type text, p_entity_id uuid, p_error_message text, p_payload jsonb, p_idempotency_key text', 'uuid', 'public, pg_temp', '81f925ec94ec92c4e85f74c209162fcd'),
  ('apply_remaining_prepayments', 'p_customer_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_customer_id uuid, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'c0d7a2aef843ace0f557af2d096b090e'),
  ('batch_apply_all_prepayments', 'p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', '1d76228210c474da37c9a3cd91b97b7d'),
  ('assign_job_applicator', 'p_job_id uuid, p_applicator_id uuid DEFAULT NULL::uuid, p_license_override boolean DEFAULT false, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_job_id uuid, p_applicator_id uuid, p_license_override boolean, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'f96453095206b981ce1d553d72941fad'),
  ('dispatch_job_locations', 'p_assignments jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_license_override boolean DEFAULT false', 'p_assignments jsonb, p_performed_by uuid, p_idempotency_key text, p_license_override boolean', 'jsonb', 'public, pg_temp', 'b6cafd947beaf19678d491e1832f1908'),
  ('undispatch_job_locations', 'p_job_field_ids uuid[], p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_job_field_ids uuid[], p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'e16d9f0119e83b33b2550de73c48b094'),
  ('start_job', 'p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_job_id uuid, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', '8e9b5356c6019cee2f82f37a30d018e1'),
  ('create_job_from_quote_section', 'p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'e1e701e0a096c0d022b5ac370aa4bb60'),
  ('update_field_app_applied_info', 'p_invoice_ids uuid[], p_wind_direction text DEFAULT NULL::text, p_temperature_text text DEFAULT NULL::text, p_applicator_name text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_start_temp_f numeric DEFAULT NULL::numeric, p_start_wind_mph numeric DEFAULT NULL::numeric, p_start_wind_direction text DEFAULT NULL::text, p_start_humidity_pct numeric DEFAULT NULL::numeric, p_start_weather_time time without time zone DEFAULT NULL::time without time zone, p_start_weather_source text DEFAULT NULL::text, p_end_temp_f numeric DEFAULT NULL::numeric, p_end_wind_mph numeric DEFAULT NULL::numeric, p_end_wind_direction text DEFAULT NULL::text, p_end_humidity_pct numeric DEFAULT NULL::numeric, p_end_weather_time time without time zone DEFAULT NULL::time without time zone, p_end_weather_source text DEFAULT NULL::text, p_weather_manual_override boolean DEFAULT NULL::boolean, p_update_weather boolean DEFAULT false, p_diluent_rate_gpa numeric DEFAULT NULL::numeric, p_update_diluent boolean DEFAULT false', 'p_invoice_ids uuid[], p_wind_direction text, p_temperature_text text, p_applicator_name text, p_performed_by uuid, p_idempotency_key text, p_start_temp_f numeric, p_start_wind_mph numeric, p_start_wind_direction text, p_start_humidity_pct numeric, p_start_weather_time time without time zone, p_start_weather_source text, p_end_temp_f numeric, p_end_wind_mph numeric, p_end_wind_direction text, p_end_humidity_pct numeric, p_end_weather_time time without time zone, p_end_weather_source text, p_weather_manual_override boolean, p_update_weather boolean, p_diluent_rate_gpa numeric, p_update_diluent boolean', 'jsonb', 'public, pg_temp', 'e6d5f41411e96cd4453d2209c846645d'),
  ('create_quote_from_template', 'p_template_id uuid, p_customer_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_template_id uuid, p_customer_id uuid, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'b2265a519558bcff8e5d276999b3c31e'),
  ('rollover_quote_to_season', 'p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'eb9b65e556f3054d0751f3a7c08dce3f'),
  ('save_quote_template', 'p_quote_id uuid, p_template_name text, p_description text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_quote_id uuid, p_template_name text, p_description text, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'ed2a36c82a5397174ee492946b1160e6')
) AS pin(name,args,identity_args,ret,search_path,body_md5);
CREATE TEMP TABLE ops_replay_binding_batch4e_helper_pins ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('public.check_idempotency_intent(text,text,uuid,text)', 'edc73be809069669e8441eba7acf443d', true, 'postgres'),
  ('public._replay_fingerprint_20261015(jsonb)', '68d5c0c62579349ced47c89e6b65ccaf', false, 'postgres'),
  ('public._bind_replay_receipt_20261015(text,text,text)', '722ddd3b5d9174c598735cb321088f73', false, 'postgres'),
  ('public._require_bound_replay_receipt_20261015()', '5c0478525131ddbeb7b96ef1535ff91e', true, 'postgres'),
  ('public._section9_cancel_purchase_order_serialized(uuid,text,uuid,text)', '57bd6a9408c65daf6d82bbf3750554f9', true, 'postgres,service_role'),
  ('public._section9_delete_purchase_order_serialized(uuid,uuid,text)', '3c91b72ae3c97bb473e83abc89a38f00', true, 'postgres,service_role'),
  ('public._section9_submit_purchase_order_serialized(uuid,uuid,text)', 'dd639711fdceb089f4eb9c466ab23bae', true, 'postgres,service_role'),
  ('public._duplicate_quote_below_cost_impl_20260810(uuid,uuid,text)', 'b15cd71cbbee64c327a8ebe7b1509299', true, 'postgres')
) AS h(sig,body_md5,secdef,acl);

DO $preflight$
DECLARE v_drift text;
BEGIN
  IF to_regclass('pg_temp.ops_replay_binding_batch4e_tx') IS NULL THEN
    RAISE EXCEPTION 'OPS_REPLAY_BINDING_BATCH4E_NOT_IN_TRANSACTION';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.ops_replay_binding_batch4e_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'OPS_REPLAY_BINDING_BATCH4E_NOT_IN_TRANSACTION';
  END IF;
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_drift
  FROM pg_temp.ops_replay_binding_batch4e_pins pin
  WHERE (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=pin.name) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=pin.name
       AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v'
       AND NOT p.proisstrict AND NOT p.proretset AND p.prokind='f'
       AND p.prorettype=pin.ret::regtype
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=' || pin.search_path]::text[]
       AND pg_get_function_arguments(p.oid)=pin.args
       AND pg_get_function_identity_arguments(p.oid)=pin.identity_args
       AND md5(replace(p.prosrc, chr(13), ''))=pin.body_md5
       AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                 FROM aclexplode(p.proacl) a WHERE a.privilege_type='EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated','postgres','service_role']::text[])
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
                AND p.proname='_' || pin.name || '_replay_impl_20261015');
  IF v_drift IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT_4E_BODY_DRIFT: %', v_drift; END IF;

  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname,p.proname) INTO v_drift
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema')
    AND NOT (n.nspname='public' AND p.proname IN (SELECT pin.name FROM pg_temp.ops_replay_binding_batch4e_pins pin))
    AND NOT (n.nspname='public' AND p.proname IN
      ('_complete_job_replay_impl_20261015'))
    AND regexp_replace(regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g'), '''[^'']*''', '', 'g')
        ~* '(^|[^_a-z0-9])(confirm_job_notification_sent|record_job_pre_notifications|record_job_post_notifications|log_failed_notification|apply_remaining_prepayments|batch_apply_all_prepayments|assign_job_applicator|dispatch_job_locations|undispatch_job_locations|start_job|create_job_from_quote_section|update_field_app_applied_info|create_quote_from_template|rollover_quote_to_season|save_quote_template)"?\s*\(';
  IF v_drift IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: %', v_drift; END IF;
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $cron$SELECT string_agg(jobname, ', ' ORDER BY jobname) FROM cron.job
      WHERE command ~* '(confirm_job_notification_sent|record_job_pre_notifications|record_job_post_notifications|log_failed_notification|apply_remaining_prepayments|batch_apply_all_prepayments|assign_job_applicator|dispatch_job_locations|undispatch_job_locations|start_job|create_job_from_quote_section|update_field_app_applied_info|create_quote_from_template|rollover_quote_to_season|save_quote_template)'$cron$ INTO v_drift;
    IF v_drift IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: pg_cron %', v_drift; END IF;
  END IF;

  IF (SELECT count(*) FROM pg_attribute a WHERE a.attrelid='public.idempotency_keys'::regclass
      AND NOT a.attisdropped AND ((a.attname='request_actor_id' AND a.atttypid='uuid'::regtype)
       OR (a.attname='request_fingerprint' AND a.atttypid='text'::regtype))) <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_COLUMNS_DRIFT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('auth.uid()')
      AND NOT p.prosecdef AND md5(replace(p.prosrc,chr(13),''))='cdef18c69c4f4cbbced2eaf81e628b49') THEN
    RAISE EXCEPTION 'PREFLIGHT_AUTH_UID_DRIFT';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_temp.ops_replay_binding_batch4e_helper_pins h WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(h.sig)
        AND p.proowner='postgres'::regrole AND p.prosecdef=h.secdef
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND md5(replace(p.prosrc,chr(13),''))=h.body_md5
        AND array_to_string(ARRAY(SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC'
          ELSE a.grantee::regrole::text END FROM aclexplode(p.proacl) a
          WHERE a.privilege_type='EXECUTE' ORDER BY 1), ',')=h.acl)
  ) THEN RAISE EXCEPTION 'PREFLIGHT_4E_HELPER_DRIFT'; END IF;

  LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys k
             WHERE k.operation IN (SELECT pin.name FROM pg_temp.ops_replay_binding_batch4e_pins pin)
             AND (k.expires_at IS NULL OR k.expires_at >= now())) THEN
    RAISE EXCEPTION 'PREFLIGHT_UNEXPIRED_RECEIPTS';
  END IF;
END
$preflight$;

DO $guard$
DECLARE
  v_prior constant text[] := ARRAY[
    'void_payment', 'delete_prepay_credit', 'edit_prepay_credit', 'apply_write_off',
    'reverse_write_off', 'apply_prepay_to_invoice', 'create_prepay_check_splits',
    'batch_apply_prepayments', 'batch_void_invoices',
    'release_inventory_hold', 'retire_inventory_item', 'reconcile_negative_inventory',
    'manual_inventory_add', 'create_order_from_blend_ticket', 'create_direct_order',
    'create_rush_order', 'close_quote_as_applied', 'close_quote_as_short',
    'create_app_record_from_bt', 'batch_cancel_deliveries', 'reverse_completed_cycle_count',
    'create_planned_holds',
    'complete_delivery', 'complete_job',
    'cancel_delivery', 'void_delivery', 'void_order',
    'unpost_invoice', 'unpost_invoice_group', 'close_accounting_period', 'reopen_accounting_period',
    'transfer_invoice_to_job', 'save_field_app_invoice', 'update_field_app_invoice_billing',
    'consolidate_draft_invoices', 'update_blend_ticket_billing_status', 'create_rebate_claim',
    'transition_rebate_claim',
    'price_order', 'update_order_items', 'mark_inventory_row_verified', 
    'submit_purchase_order', 'cancel_purchase_order', 'delete_purchase_order', 'duplicate_quote',
    'edit_delivery', 'reassign_delivery', 'batch_reschedule_deliveries', 'confirm_delivery',
    'create_delivery_with_items', 'create_followup_delivery', 'cancel_cycle_count',
    'reverse_blend_ticket_approval'];
  v_other constant text[] := ARRAY['admin_update_profile', 'batch_approve_blend_tickets', 'batch_reject_blend_tickets', 'bulk_create_label_drafts', 'commit_label_draft', 'create_label_draft', 'create_blend_ticket', 'save_blend_ticket', 'save_blend_ticket_fields', 'dismiss_watchdog_flag', 'delete_vendor', 'reactivate_vendor', 'save_vendor', 'link_fields_to_parent', 'unlink_field_from_parent', 'review_customer_fact', 'supersede_customer_fact', 'save_blend_recipe', 'save_field', 'save_field_crop_history', 'save_field_geometry', 'save_field_polygons', 'set_application_record_lots', 'set_field_boundary', 'set_field_override_acres'];
  v_this constant text[] := ARRAY['confirm_job_notification_sent', 'record_job_pre_notifications', 'record_job_post_notifications', 'log_failed_notification', 'apply_remaining_prepayments', 'batch_apply_all_prepayments', 'assign_job_applicator', 'dispatch_job_locations', 'undispatch_job_locations', 'start_job', 'create_job_from_quote_section', 'update_field_app_applied_info', 'create_quote_from_template', 'rollover_quote_to_season', 'save_quote_template'];
  v_def text;
  v_expected text;
  v_ops text[];
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO v_def FROM pg_trigger t
  WHERE t.tgrelid='public.idempotency_keys'::regclass
    AND t.tgname='require_bound_replay_receipt_20261015'
    AND t.tgfoid=to_regprocedure('public._require_bound_replay_receipt_20261015()')
    AND t.tgenabled='O' AND t.tgconstraint<>0 AND t.tgdeferrable AND t.tginitdeferred;
  IF v_def IS NULL OR (SELECT count(*) FROM pg_trigger t
    WHERE t.tgfoid=to_regprocedure('public._require_bound_replay_receipt_20261015()'))<>1 THEN
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_GUARD_DRIFT';
  END IF;
  v_expected := 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
    || (SELECT string_agg(quote_literal(o) || '::text', ', ' ORDER BY ord)
        FROM unnest(v_prior || v_other) WITH ORDINALITY AS u(o,ord))
    || ']))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()';
  IF v_def IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'PREFLIGHT_RECEIPT_GUARD_DRIFT'; END IF;
  v_ops := v_prior || v_other || v_this;
  INSERT INTO pg_temp.ops_replay_binding_batch4e_guard_ops(ord,operation)
  SELECT ord,o FROM unnest(v_ops) WITH ORDINALITY AS u(o,ord);
  DROP TRIGGER require_bound_replay_receipt_20261015 ON public.idempotency_keys;
  EXECUTE format('CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 '
    || 'AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED '
    || 'FOR EACH ROW WHEN (NEW.operation IN (%s)) '
    || 'EXECUTE FUNCTION public._require_bound_replay_receipt_20261015()',
    (SELECT string_agg(quote_literal(o), ', ' ORDER BY ord)
     FROM unnest(v_ops) WITH ORDINALITY AS u(o,ord)));
END
$guard$;

-- 1. confirm_job_notification_sent
ALTER FUNCTION public.confirm_job_notification_sent(uuid, text, text, uuid, text) RENAME TO _confirm_job_notification_sent_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._confirm_job_notification_sent_replay_impl_20261015(uuid, text, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.confirm_job_notification_sent(p_notification_id uuid, p_subject text DEFAULT NULL::text, p_message text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  -- Transition: a tab opened before the key-sending app update (PR #1518) confirms an email it
  -- already sent without a key. Refusing it would leave the notice unconfirmed and invite a resend,
  -- so a keyless call runs the unchanged body exactly as before 4e; it writes no receipt to bind.
  IF p_idempotency_key IS NULL THEN
    RETURN public._confirm_job_notification_sent_replay_impl_20261015(p_notification_id, p_subject, p_message, p_performed_by, NULL);
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor    uuid;
    v_role     text;
    v_existing jsonb;
    v_status   text;
    v_result   jsonb;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_notification_id', p_notification_id, 'p_subject', p_subject, 'p_message', p_message));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'confirm_job_notification_sent', v_actor, v_fingerprint);
  v_result := public._confirm_job_notification_sent_replay_impl_20261015(p_notification_id, p_subject, p_message, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='confirm_job_notification_sent'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'confirm_job_notification_sent', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.confirm_job_notification_sent(uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_job_notification_sent(uuid, text, text, uuid, text) TO authenticated, service_role;

-- 2. record_job_pre_notifications
ALTER FUNCTION public.record_job_pre_notifications(uuid, text, text, uuid, text) RENAME TO _record_job_pre_notifications_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._record_job_pre_notifications_replay_impl_20261015(uuid, text, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.record_job_pre_notifications(p_job_id uuid, p_subject text, p_message text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: record_job_pre_notifications requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor               uuid;
    v_role                text;
    v_existing            jsonb;
    v_primary_customer_id uuid;
    v_job_status          text;
    v_recipient           record;
    v_email               text;
    v_per_email_key       text;
    v_row_id              uuid;
    v_recipients          jsonb := '[]'::jsonb;
    v_sent_count          int := 0;   -- recipients WITH an email (a send will be attempted)
    v_failed_count        int := 0;   -- recipients with NO email on file
    v_result              jsonb;
  BEGIN
  -- actor / strict-actor / role gate (admin or sales_rep send notifications).
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;

  IF p_subject IS NULL OR btrim(p_subject) = '' THEN
    RAISE EXCEPTION 'INVALID_SUBJECT: a non-empty subject is required';
  END IF;
  IF p_message IS NULL OR btrim(p_message) = '' THEN
    RAISE EXCEPTION 'INVALID_MESSAGE: a non-empty message is required';
  END IF;

  -- Load the job's primary customer + status (also validates the job exists).
  SELECT j.customer_id, j.status INTO v_primary_customer_id, v_job_status
  FROM jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOB_NOT_FOUND: job % does not exist', p_job_id;
  END IF;

  -- LIFECYCLE GATE (Codex #40 P2 + bug-hunt B1): a PRE-application notice only makes
  -- sense for a job that has NOT happened yet — scheduled or in_progress. This gate
  -- now runs BEFORE the idempotency replay (B1), so a retry after the job's status
  -- changed cannot re-drive a stale "upcoming application" notice.
  IF v_job_status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'JOB_NOT_PRE_NOTIFIABLE: job % is % (pre-notice requires scheduled or in_progress)', p_job_id, v_job_status;
  END IF;

  -- idempotency: return the cached result if this key already ran for THIS op —
  -- ONLY reached once the lifecycle gate above has (re-)passed for the CURRENT status.
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_job_id', p_job_id, 'p_subject', p_subject, 'p_message', p_message));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'record_job_pre_notifications', v_actor, v_fingerprint);
  v_result := public._record_job_pre_notifications_replay_impl_20261015(p_job_id, p_subject, p_message, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='record_job_pre_notifications'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'record_job_pre_notifications', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_job_pre_notifications(uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_job_pre_notifications(uuid, text, text, uuid, text) TO authenticated, service_role;

-- 3. record_job_post_notifications
ALTER FUNCTION public.record_job_post_notifications(uuid, text, text, uuid, text) RENAME TO _record_job_post_notifications_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._record_job_post_notifications_replay_impl_20261015(uuid, text, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.record_job_post_notifications(p_job_id uuid, p_subject text, p_message text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: record_job_post_notifications requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor               uuid;
    v_role                text;
    v_existing            jsonb;
    v_primary_customer_id uuid;
    v_job_status          text;
    v_recipient           record;
    v_email               text;
    v_per_email_key       text;
    v_row_id              uuid;
    v_recipients          jsonb := '[]'::jsonb;
    v_sent_count          int := 0;
    v_failed_count        int := 0;
    v_result              jsonb;
  BEGIN
  -- actor / strict-actor / role gate (admin or sales_rep send notifications).
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;

  IF p_subject IS NULL OR btrim(p_subject) = '' THEN
    RAISE EXCEPTION 'INVALID_SUBJECT: a non-empty subject is required';
  END IF;
  IF p_message IS NULL OR btrim(p_message) = '' THEN
    RAISE EXCEPTION 'INVALID_MESSAGE: a non-empty message is required';
  END IF;

  -- Load the job's primary customer + status (also validates the job exists).
  SELECT j.customer_id, j.status INTO v_primary_customer_id, v_job_status
  FROM jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOB_NOT_FOUND: job % does not exist', p_job_id;
  END IF;

  -- LIFECYCLE GATE (bug-hunt B1): a POST-application notice only makes sense for a
  -- job whose work HAS happened — completed or invoiced. This gate now runs BEFORE the
  -- idempotency replay, so a retry after the job's status changed cannot re-drive a
  -- stale "application complete" notice on a job that is no longer completed/invoiced.
  IF v_job_status NOT IN ('completed', 'invoiced') THEN
    RAISE EXCEPTION 'JOB_NOT_POST_NOTIFIABLE: job % is % (post-notice requires completed or invoiced)', p_job_id, v_job_status;
  END IF;

  -- idempotency: return the cached result if this key already ran for THIS op —
  -- ONLY reached once the lifecycle gate above has (re-)passed for the CURRENT status.
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_job_id', p_job_id, 'p_subject', p_subject, 'p_message', p_message));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'record_job_post_notifications', v_actor, v_fingerprint);
  v_result := public._record_job_post_notifications_replay_impl_20261015(p_job_id, p_subject, p_message, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='record_job_post_notifications'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'record_job_post_notifications', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_job_post_notifications(uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_job_post_notifications(uuid, text, text, uuid, text) TO authenticated, service_role;

-- 4. log_failed_notification
ALTER FUNCTION public.log_failed_notification(text, text, uuid, text, jsonb, text) RENAME TO _log_failed_notification_replay_impl_20261015;
-- Only signed-in browser screens call this (Dashboard, notificationTriggers); no Edge Function, cron job or
-- database function does (checked live 2026-11-06). A keyless call (an old tab, or a service-role caller)
-- runs the unchanged body as before 4e; a keyed call needs a signed-in caller, like every bound function.
REVOKE ALL ON FUNCTION public._log_failed_notification_replay_impl_20261015(text, text, uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.log_failed_notification(p_notification_type text, p_entity_type text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid, p_error_message text DEFAULT NULL::text, p_payload jsonb DEFAULT NULL::jsonb, p_idempotency_key text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result uuid;
BEGIN
  -- Transition: a tab opened before PR #1518 logs a failure without a key. Refusing it would lose the
  -- failure record, so a keyless call runs the unchanged body exactly as before 4e; no receipt to bind.
  IF p_idempotency_key IS NULL THEN
    RETURN public._log_failed_notification_replay_impl_20261015(p_notification_type, p_entity_type, p_entity_id, p_error_message, p_payload, NULL);
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_existing jsonb;
    v_id       uuid;
  BEGIN
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_notification_type', p_notification_type, 'p_entity_type', p_entity_type, 'p_entity_id', p_entity_id, 'p_error_message', p_error_message, 'p_payload', p_payload));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'log_failed_notification', v_actor, v_fingerprint);
  v_result := public._log_failed_notification_replay_impl_20261015(p_notification_type, p_entity_type, p_entity_id, p_error_message, p_payload, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='log_failed_notification'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'log_failed_notification', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.log_failed_notification(text, text, uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_failed_notification(text, text, uuid, text, jsonb, text) TO authenticated, service_role;

-- 5. apply_remaining_prepayments
ALTER FUNCTION public.apply_remaining_prepayments(uuid, uuid, text) RENAME TO _apply_remaining_prepayments_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._apply_remaining_prepayments_replay_impl_20261015(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.apply_remaining_prepayments(p_customer_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: apply_remaining_prepayments requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor         uuid;
    v_available     bigint;
    v_invoice       record;
    v_apply         bigint;
    v_applied_total bigint := 0;
    v_count         integer := 0;
    v_cached        jsonb;
    v_result        jsonb;
  BEGIN
  -- OVERNIGHT BUG HUNT GUARD (HIGH: prepay double-spend, no-ledger).
  -- Hard-block bulk prepay apply until the reserved-pool redesign lands.
  -- Remove this RAISE block to restore the (still-defective) behavior.
  RAISE EXCEPTION 'PREPAY_BULK_APPLY_DISABLED'
    USING DETAIL = 'Bulk prepay application is temporarily disabled pending the prepay reserved-pool redesign. Apply prepayments one invoice at a time (apply_prepay_to_invoice).',
          ERRCODE = 'P0001';
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_customer_id', p_customer_id, 'p_performed_by', p_performed_by));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'apply_remaining_prepayments', v_actor, v_fingerprint);
  v_result := public._apply_remaining_prepayments_replay_impl_20261015(p_customer_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='apply_remaining_prepayments'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'apply_remaining_prepayments', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.apply_remaining_prepayments(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_remaining_prepayments(uuid, uuid, text) TO authenticated, service_role;

-- 6. batch_apply_all_prepayments
ALTER FUNCTION public.batch_apply_all_prepayments(uuid, text) RENAME TO _batch_apply_all_prepayments_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._batch_apply_all_prepayments_replay_impl_20261015(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.batch_apply_all_prepayments(p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: batch_apply_all_prepayments requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_cust       record;
    v_result     jsonb;
    v_details    jsonb := '[]'::jsonb;
    v_total_customers integer := 0;
    v_total_applied   bigint  := 0;
    v_actor      uuid;
    v_existing   jsonb;
    v_final      jsonb;
  BEGIN
  -- OVERNIGHT BUG HUNT GUARD (HIGH: prepay double-spend, no-ledger).
  -- Hard-block bulk prepay apply until the reserved-pool redesign lands.
  -- Remove this RAISE block to restore the (still-defective) behavior.
  RAISE EXCEPTION 'PREPAY_BULK_APPLY_DISABLED'
    USING DETAIL = 'Bulk prepay application is temporarily disabled pending the prepay reserved-pool redesign. Apply prepayments one invoice at a time (apply_prepay_to_invoice).',
          ERRCODE = 'P0001';
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_performed_by', p_performed_by));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'batch_apply_all_prepayments', v_actor, v_fingerprint);
  v_result := public._batch_apply_all_prepayments_replay_impl_20261015(p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='batch_apply_all_prepayments'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'batch_apply_all_prepayments', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.batch_apply_all_prepayments(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_apply_all_prepayments(uuid, text) TO authenticated, service_role;

-- 7. assign_job_applicator
ALTER FUNCTION public.assign_job_applicator(uuid, uuid, boolean, uuid, text) RENAME TO _assign_job_applicator_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._assign_job_applicator_replay_impl_20261015(uuid, uuid, boolean, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.assign_job_applicator(p_job_id uuid, p_applicator_id uuid DEFAULT NULL::uuid, p_license_override boolean DEFAULT false, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: assign_job_applicator requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid;
    v_role text;
    v_existing jsonb;
    v_job jobs%ROWTYPE;
    v_applicator_name text;
    v_result jsonb;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;
  IF p_license_override AND v_role <> 'admin' THEN
    RAISE EXCEPTION 'OVERRIDE_REQUIRES_ADMIN';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_job_id', p_job_id, 'p_applicator_id', p_applicator_id, 'p_license_override', p_license_override));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'assign_job_applicator', v_actor, v_fingerprint);
  v_result := public._assign_job_applicator_replay_impl_20261015(p_job_id, p_applicator_id, p_license_override, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='assign_job_applicator'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'assign_job_applicator', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.assign_job_applicator(uuid, uuid, boolean, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_job_applicator(uuid, uuid, boolean, uuid, text) TO authenticated, service_role;

-- 8. dispatch_job_locations
ALTER FUNCTION public.dispatch_job_locations(jsonb, uuid, text, boolean) RENAME TO _dispatch_job_locations_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._dispatch_job_locations_replay_impl_20261015(jsonb, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.dispatch_job_locations(p_assignments jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_license_override boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: dispatch_job_locations requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor        uuid;
    v_role         text;
    v_existing     jsonb;
    v_assignment   jsonb;
    v_job_field    uuid;
    v_applicator   uuid;
    v_crew         uuid;
    v_job_id       uuid;
    v_job_status   text;
    v_has_licenses boolean;
    v_latest_expiry date;
    v_count        int := 0;
    v_override_used int := 0;   -- # of expired-license applicators dispatched via override
    v_this_override boolean := false;  -- did THIS location use the license override?
    v_job_cust     uuid;
    v_assignee_label text;
    v_field_label  text;
    v_result       jsonb;
  BEGIN
  -- actor / strict-actor / role gate (mirrors jobs_update RLS)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;
  -- The license-override hatch is admin-only (mirrors assign_job_applicator).
  IF p_license_override AND v_role <> 'admin' THEN
    RAISE EXCEPTION 'OVERRIDE_REQUIRES_ADMIN';
  END IF;

  -- idempotency: return the cached result if this key already ran for THIS op.
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_assignments', p_assignments, 'p_license_override', p_license_override));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'dispatch_job_locations', v_actor, v_fingerprint);
  v_result := public._dispatch_job_locations_replay_impl_20261015(p_assignments, p_performed_by, p_idempotency_key, p_license_override);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='dispatch_job_locations'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'dispatch_job_locations', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.dispatch_job_locations(jsonb, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_job_locations(jsonb, uuid, text, boolean) TO authenticated, service_role;

-- 9. undispatch_job_locations
ALTER FUNCTION public.undispatch_job_locations(uuid[], uuid, text) RENAME TO _undispatch_job_locations_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._undispatch_job_locations_replay_impl_20261015(uuid[], uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.undispatch_job_locations(p_job_field_ids uuid[], p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: undispatch_job_locations requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor      uuid;
    v_role       text;
    v_existing   jsonb;
    v_count      int := 0;
    v_row        record;
    v_assignee   text;
    v_field      text;
    v_result     jsonb;
    v_dispatchable_jobs uuid[];  -- the locked, dispatchable parent jobs (TOCTOU guard)
  BEGIN
  -- actor / strict-actor / role gate (mirrors dispatch_job_locations).
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;

  -- idempotency: return the cached result if this key already ran for THIS op.
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_job_field_ids', p_job_field_ids));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'undispatch_job_locations', v_actor, v_fingerprint);
  v_result := public._undispatch_job_locations_replay_impl_20261015(p_job_field_ids, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='undispatch_job_locations'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'undispatch_job_locations', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.undispatch_job_locations(uuid[], uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undispatch_job_locations(uuid[], uuid, text) TO authenticated, service_role;

-- 10. start_job
ALTER FUNCTION public.start_job(uuid, uuid, text) RENAME TO _start_job_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._start_job_replay_impl_20261015(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.start_job(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: start_job requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor     uuid := auth.uid();
    v_existing  jsonb;
    v_job       record;
    v_now       timestamptz := now();
    v_result    jsonb;
  BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_job_id', p_job_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'start_job', v_actor, v_fingerprint);
  v_result := public._start_job_replay_impl_20261015(p_job_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='start_job'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'start_job', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.start_job(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_job(uuid, uuid, text) TO authenticated, service_role;

-- 11. create_job_from_quote_section
ALTER FUNCTION public.create_job_from_quote_section(uuid, uuid, uuid, text) RENAME TO _create_job_from_quote_section_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_job_from_quote_section_replay_impl_20261015(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.create_job_from_quote_section(p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_job_from_quote_section requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid;
    v_existing jsonb; v_quote RECORD; v_section RECORD; v_item RECORD;
    v_job_id uuid; v_job_number text; v_job_date date; v_season integer;
    v_total_acres numeric := 0; v_total_cost_cents bigint := 0;
    v_total_price_cents bigint := 0; v_sort integer := 0;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_quote_id', p_quote_id, 'p_section_id', p_section_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_job_from_quote_section', v_actor, v_fingerprint);
  v_result := public._create_job_from_quote_section_replay_impl_20261015(p_quote_id, p_section_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='create_job_from_quote_section'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_job_from_quote_section', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_job_from_quote_section(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_job_from_quote_section(uuid, uuid, uuid, text) TO authenticated, service_role;

-- 12. update_field_app_applied_info
ALTER FUNCTION public.update_field_app_applied_info(uuid[], text, text, text, uuid, text, numeric, numeric, text, numeric, time without time zone, text, numeric, numeric, text, numeric, time without time zone, text, boolean, boolean, numeric, boolean) RENAME TO _update_field_app_applied_info_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._update_field_app_applied_info_replay_impl_20261015(uuid[], text, text, text, uuid, text, numeric, numeric, text, numeric, time without time zone, text, numeric, numeric, text, numeric, time without time zone, text, boolean, boolean, numeric, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.update_field_app_applied_info(p_invoice_ids uuid[], p_wind_direction text DEFAULT NULL::text, p_temperature_text text DEFAULT NULL::text, p_applicator_name text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_start_temp_f numeric DEFAULT NULL::numeric, p_start_wind_mph numeric DEFAULT NULL::numeric, p_start_wind_direction text DEFAULT NULL::text, p_start_humidity_pct numeric DEFAULT NULL::numeric, p_start_weather_time time without time zone DEFAULT NULL::time without time zone, p_start_weather_source text DEFAULT NULL::text, p_end_temp_f numeric DEFAULT NULL::numeric, p_end_wind_mph numeric DEFAULT NULL::numeric, p_end_wind_direction text DEFAULT NULL::text, p_end_humidity_pct numeric DEFAULT NULL::numeric, p_end_weather_time time without time zone DEFAULT NULL::time without time zone, p_end_weather_source text DEFAULT NULL::text, p_weather_manual_override boolean DEFAULT NULL::boolean, p_update_weather boolean DEFAULT false, p_diluent_rate_gpa numeric DEFAULT NULL::numeric, p_update_diluent boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  -- Transition: a tab opened before PR #1518 saves applied info without a key, after its invoice
  -- already committed. Refusing it would leave the invoice without its applied info, so a keyless
  -- call runs the unchanged body exactly as before 4e; it writes no receipt to bind.
  IF p_idempotency_key IS NULL THEN
    RETURN public._update_field_app_applied_info_replay_impl_20261015(p_invoice_ids, p_wind_direction, p_temperature_text, p_applicator_name, p_performed_by, NULL, p_start_temp_f, p_start_wind_mph, p_start_wind_direction, p_start_humidity_pct, p_start_weather_time, p_start_weather_source, p_end_temp_f, p_end_wind_mph, p_end_wind_direction, p_end_humidity_pct, p_end_weather_time, p_end_weather_source, p_weather_manual_override, p_update_weather, p_diluent_rate_gpa, p_update_diluent);
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor    uuid := auth.uid();
    v_expected int;
    v_updated  int;
    v_existing jsonb;
    v_result   jsonb;
  BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match the authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save applied info';
  END IF;

  v_expected := COALESCE(array_length(p_invoice_ids, 1), 0);
  IF v_expected = 0 THEN
    RAISE EXCEPTION 'At least one invoice id is required';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_invoice_ids', p_invoice_ids, 'p_wind_direction', p_wind_direction, 'p_temperature_text', p_temperature_text, 'p_applicator_name', p_applicator_name, 'p_start_temp_f', p_start_temp_f, 'p_start_wind_mph', p_start_wind_mph, 'p_start_wind_direction', p_start_wind_direction, 'p_start_humidity_pct', p_start_humidity_pct, 'p_start_weather_time', p_start_weather_time, 'p_start_weather_source', p_start_weather_source, 'p_end_temp_f', p_end_temp_f, 'p_end_wind_mph', p_end_wind_mph, 'p_end_wind_direction', p_end_wind_direction, 'p_end_humidity_pct', p_end_humidity_pct, 'p_end_weather_time', p_end_weather_time, 'p_end_weather_source', p_end_weather_source, 'p_weather_manual_override', p_weather_manual_override, 'p_update_weather', p_update_weather, 'p_diluent_rate_gpa', p_diluent_rate_gpa, 'p_update_diluent', p_update_diluent));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'update_field_app_applied_info', v_actor, v_fingerprint);
  v_result := public._update_field_app_applied_info_replay_impl_20261015(p_invoice_ids, p_wind_direction, p_temperature_text, p_applicator_name, p_performed_by, p_idempotency_key, p_start_temp_f, p_start_wind_mph, p_start_wind_direction, p_start_humidity_pct, p_start_weather_time, p_start_weather_source, p_end_temp_f, p_end_wind_mph, p_end_wind_direction, p_end_humidity_pct, p_end_weather_time, p_end_weather_source, p_weather_manual_override, p_update_weather, p_diluent_rate_gpa, p_update_diluent);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='update_field_app_applied_info'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'update_field_app_applied_info', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.update_field_app_applied_info(uuid[], text, text, text, uuid, text, numeric, numeric, text, numeric, time without time zone, text, numeric, numeric, text, numeric, time without time zone, text, boolean, boolean, numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_field_app_applied_info(uuid[], text, text, text, uuid, text, numeric, numeric, text, numeric, time without time zone, text, numeric, numeric, text, numeric, time without time zone, text, boolean, boolean, numeric, boolean) TO authenticated, service_role;

-- 13. create_quote_from_template
ALTER FUNCTION public.create_quote_from_template(uuid, uuid, uuid, text) RENAME TO _create_quote_from_template_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_quote_from_template_replay_impl_20261015(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.create_quote_from_template(p_template_id uuid, p_customer_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_quote_from_template requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid;
    v_template quote_templates%ROWTYPE;
    v_customer customers%ROWTYPE;
    v_quote_id uuid;
    v_quote_number text;
    v_section jsonb;
    v_item jsonb;
    v_section_id uuid;
    v_tier_price numeric;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_template_id', p_template_id, 'p_customer_id', p_customer_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_quote_from_template', v_actor, v_fingerprint);
  v_result := public._create_quote_from_template_replay_impl_20261015(p_template_id, p_customer_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='create_quote_from_template'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    -- The pinned body saved a marker before work and reports duplicate on retry.
    -- Store the actual first answer so exact retries answer identically.
    UPDATE public.idempotency_keys SET result = v_result
    WHERE idempotency_key = p_idempotency_key AND operation = 'create_quote_from_template'
      AND request_actor_id IS NULL AND request_fingerprint IS NULL;
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_quote_from_template', v_fingerprint);
  END IF;
  RETURN COALESCE(v_replay->'result', v_result);
END;
$function$;
REVOKE ALL ON FUNCTION public.create_quote_from_template(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_quote_from_template(uuid, uuid, uuid, text) TO authenticated, service_role;

-- 14. rollover_quote_to_season
ALTER FUNCTION public.rollover_quote_to_season(uuid, integer, uuid, text) RENAME TO _rollover_quote_to_season_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._rollover_quote_to_season_replay_impl_20261015(uuid, integer, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.rollover_quote_to_season(p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: rollover_quote_to_season requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid;
    v_old_quote quotes%ROWTYPE;
    v_new_quote_id uuid;
    v_new_quote_number text;
    v_section RECORD;
    v_new_section_id uuid;
    v_item RECORD;
    v_tier_price numeric;
    v_current_cost numeric;
    v_has_draws boolean := false;
    v_total_remainder numeric;
    v_drawn numeric;
    v_cum_before numeric;
    v_item_tun numeric;
    v_new_tun numeric;
    v_new_acres numeric;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_quote_id', p_quote_id, 'p_new_season', p_new_season));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'rollover_quote_to_season', v_actor, v_fingerprint);
  v_result := public._rollover_quote_to_season_replay_impl_20261015(p_quote_id, p_new_season, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='rollover_quote_to_season'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    -- The pinned body saved a marker before work and reports duplicate on retry.
    -- Store the actual first answer so exact retries answer identically.
    UPDATE public.idempotency_keys SET result = v_result
    WHERE idempotency_key = p_idempotency_key AND operation = 'rollover_quote_to_season'
      AND request_actor_id IS NULL AND request_fingerprint IS NULL;
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'rollover_quote_to_season', v_fingerprint);
  END IF;
  RETURN COALESCE(v_replay->'result', v_result);
END;
$function$;
REVOKE ALL ON FUNCTION public.rollover_quote_to_season(uuid, integer, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rollover_quote_to_season(uuid, integer, uuid, text) TO authenticated, service_role;

-- 15. save_quote_template
ALTER FUNCTION public.save_quote_template(uuid, text, text, uuid, text) RENAME TO _save_quote_template_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._save_quote_template_replay_impl_20261015(uuid, text, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_quote_template(p_quote_id uuid, p_template_name text, p_description text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: save_quote_template requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid;
    v_sections jsonb;
    v_template_id uuid;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_quote_id', p_quote_id, 'p_template_name', p_template_name, 'p_description', p_description));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'save_quote_template', v_actor, v_fingerprint);
  v_result := public._save_quote_template_replay_impl_20261015(p_quote_id, p_template_name, p_description, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='save_quote_template'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    -- The pinned body saved a marker before work and reports duplicate on retry.
    -- Store the actual first answer so exact retries answer identically.
    UPDATE public.idempotency_keys SET result = v_result
    WHERE idempotency_key = p_idempotency_key AND operation = 'save_quote_template'
      AND request_actor_id IS NULL AND request_fingerprint IS NULL;
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'save_quote_template', v_fingerprint);
  END IF;
  RETURN COALESCE(v_replay->'result', v_result);
END;
$function$;
REVOKE ALL ON FUNCTION public.save_quote_template(uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_quote_template(uuid, text, text, uuid, text) TO authenticated, service_role;

DO $postflight$
DECLARE v_bad text; v_expected_def text;
BEGIN
  IF to_regclass('pg_temp.ops_replay_binding_batch4e_tx') IS NULL THEN RAISE EXCEPTION 'OPS_REPLAY_BINDING_BATCH4E_NOT_IN_TRANSACTION'; END IF;
  IF (SELECT transaction_id FROM pg_temp.ops_replay_binding_batch4e_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'OPS_REPLAY_BINDING_BATCH4E_NOT_IN_TRANSACTION';
  END IF;
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_bad
  FROM pg_temp.ops_replay_binding_batch4e_pins pin
  WHERE (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=pin.name)<>1
    OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND p.proname=pin.name AND pg_get_function_arguments(p.oid)=pin.args
      AND pg_get_function_identity_arguments(p.oid)=pin.identity_args
      AND p.prorettype=pin.ret::regtype AND NOT p.proretset AND p.provolatile='v'
      AND NOT p.proisstrict AND p.prokind='f' AND p.proowner='postgres'::regrole
      AND p.prosecdef AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=' || pin.search_path]::text[]
      AND strpos(p.prosrc, 'check_idempotency_intent(p_idempotency_key, ''' || pin.name || ''',')>0
      AND strpos(p.prosrc, '_bind_replay_receipt_20261015(p_idempotency_key, ''' || pin.name || ''',')>0
      AND strpos(p.prosrc, '_' || pin.name || '_replay_impl_20261015(')>0
      AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
        FROM aclexplode(p.proacl) a WHERE a.privilege_type='EXECUTE' ORDER BY 1)
        IS NOT DISTINCT FROM ARRAY['authenticated','postgres','service_role']::text[])
    OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
        AND p.proname='_' || pin.name || '_replay_impl_20261015')<>1
    OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND p.proname='_' || pin.name || '_replay_impl_20261015'
      AND pg_get_function_arguments(p.oid)=pin.args
      AND p.prorettype=pin.ret::regtype AND p.proowner='postgres'::regrole
      AND p.prosecdef AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=' || pin.search_path]::text[]
      AND md5(replace(p.prosrc,chr(13),''))=pin.body_md5
      AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
        FROM aclexplode(p.proacl) a WHERE a.privilege_type='EXECUTE' ORDER BY 1)
        IS NOT DISTINCT FROM ARRAY['postgres']::text[]);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_4E_CONTRACT: %',v_bad; END IF;
  IF (SELECT count(*) FROM pg_temp.ops_replay_binding_batch4e_guard_ops) <> 93
    OR (SELECT count(*) FROM pg_temp.ops_replay_binding_batch4e_guard_ops g
        JOIN pg_temp.ops_replay_binding_batch4e_pins pin ON pin.name=g.operation)<>15 THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECEIPT_GUARD_CONTRACT';
  END IF;
  v_expected_def := 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
    || (SELECT string_agg(quote_literal(operation) || '::text', ', ' ORDER BY ord)
        FROM pg_temp.ops_replay_binding_batch4e_guard_ops)
    || ']))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()';
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='public.idempotency_keys'::regclass
    AND t.tgname='require_bound_replay_receipt_20261015'
    AND t.tgfoid=to_regprocedure('public._require_bound_replay_receipt_20261015()')
    AND t.tgenabled='O' AND t.tgconstraint<>0 AND t.tgdeferrable AND t.tginitdeferred
    AND (t.tgtype::int & 1)=1 AND (t.tgtype::int & 2)=0
    AND (t.tgtype::int & 4)<>0 AND (t.tgtype::int & 16)<>0
    AND pg_get_triggerdef(t.oid)=v_expected_def)<>1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECEIPT_GUARD_CONTRACT';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[
      'public._replay_fingerprint_20261015(jsonb)',
      'public._bind_replay_receipt_20261015(text,text,text)',
      'public._require_bound_replay_receipt_20261015()']) AS h(sig)
      CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) AS api_role
      WHERE has_function_privilege(api_role, to_regprocedure(h.sig), 'EXECUTE')) THEN
    RAISE EXCEPTION 'POSTFLIGHT_HELPER_CONTRACT';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: batch 4e bound 15 replay operations';
END
$postflight$;
