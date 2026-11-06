-- Written 2026-11-05. STATUS: NOT APPLIED. KI-10 replay-binding batch 4d: 25 operations.
-- idempotency-body-check: exempt -- wrappers call the pinned body, check_idempotency_intent,
-- and _bind_replay_receipt_20261015; the hook does not parse this delegated pattern.
-- APPLY ORDER: after 20261110160000_bind_money_inventory_replay_receipts_batch4c.
-- ROLLBACK: a new reviewed migration restores the prior trigger list, drops the public
-- wrappers, renames each pinned _<name>_replay_impl_20261015 back, and restores grants.
-- ORDERING: live high-water 20261110140000_rup_records_require_posted_invoice (generate_rup_sales_records
-- only); main also carries 20261108160000, 20261109120000, 20261110110000, 20261110120000; pending
-- 20261110130000 and 20261110150000 touch none of these functions.
-- This file requires the 53-operation post-4c guard and accepts it alone or with the other
-- batch's operations appended. Both orders are pinned; all other states are refused.
-- KNOWN LIMITS: dynamic SQL callers cannot be found by catalog text scan; a keyless call
-- still fails closed. An old browser bundle needs the key-adding app PR before batch 4e.
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
-- caller-analysis: admin_update_profile :: src/pages/SettingsPage.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: admin_update_profile: p_idempotency_key only.
-- pre-lookup-checks: admin_update_profile: PERFORM require_admin();.
-- receipt-less-return: admin_update_profile returns an error object for inactive admin, invalid role, or missing user; no receipt is written.
-- caller-analysis: batch_approve_blend_tickets :: src/pages/BlendTickets.tsx, src/pages/BlendTicketDetail.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: batch_approve_blend_tickets: p_idempotency_key only.
-- pre-lookup-checks: batch_approve_blend_tickets: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_approved_by IS NOT NULL AND p_approved_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('a.
-- receipt-less-return: batch_approve_blend_tickets has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: batch_reject_blend_tickets :: src/pages/BlendTickets.tsx, src/pages/BlendTicketDetail.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: batch_reject_blend_tickets: p_idempotency_key only.
-- pre-lookup-checks: batch_reject_blend_tickets: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_rejected_by IS NOT NULL AND p_rejected_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('a.
-- receipt-less-return: batch_reject_blend_tickets has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: bulk_create_label_drafts :: no direct src/ or Edge Function RPC call found; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: bulk_create_label_drafts: p_idempotency_key only.
-- pre-lookup-checks: bulk_create_label_drafts: IF NOT EXISTS ( SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true ) THEN RAISE EXCEPTION 'PERMISSION_DENIED: admin role required'; END IF;.
-- receipt-less-return: bulk_create_label_drafts has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: commit_label_draft :: src/pages/LabelReview.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: commit_label_draft: p_idempotency_key only.
-- pre-lookup-checks: commit_label_draft: -- Auth gate IF NOT EXISTS ( SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true ) THEN RAISE EXCEPTION 'PERMISSION_DENIED: admin role required'; END IF; -- Validate decision IF p_decision NOT IN ('accepted', 'edited', 'rejected') THEN RAISE EXCEPTION 'INVALID_DECISIO.
-- receipt-less-return: commit_label_draft has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: create_label_draft :: src/pages/ProductDetail.tsx, src/pages/LabelReview.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: create_label_draft: p_idempotency_key only.
-- pre-lookup-checks: create_label_draft: -- Auth gate: admin only IF NOT EXISTS ( SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true ) THEN RAISE EXCEPTION 'PERMISSION_DENIED: admin role required'; END IF; -- A new draft is never created already-decided: clamp to a reviewable status so a row can't -- enter .
-- receipt-less-return: create_label_draft has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: create_blend_ticket :: src/components/blendtickets/ManualTicketCreate.tsx, src/components/blendtickets/BulkTicketUpload.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: create_blend_ticket: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: create_blend_ticket: IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; IF NOT (public.is_admin() OR public.is_sales_rep()) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE: active admin or sales.
-- receipt-less-return: create_blend_ticket has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: save_blend_ticket :: src/pages/BlendTicketDetail.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: save_blend_ticket: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: save_blend_ticket: IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; IF NOT EXISTS ( SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales.
-- receipt-less-return: save_blend_ticket has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: save_blend_ticket_fields :: src/pages/BlendTicketDetail.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: save_blend_ticket_fields: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: save_blend_ticket_fields: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN (.
-- receipt-less-return: save_blend_ticket_fields has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: dismiss_watchdog_flag :: src/components/watchdog/WatchdogFlagBanner.tsx, src/pages/WatchdogExceptions.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: dismiss_watchdog_flag: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: dismiss_watchdog_flag: -- Resolve actor (canonical pattern: bind auth.uid first, then validate) v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED: must be authenticated to dismiss watchdog flags'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEP.
-- receipt-less-return: dismiss_watchdog_flag has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: delete_vendor :: src/pages/Vendors.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: delete_vendor: p_idempotency_key only.
-- pre-lookup-checks: delete_vendor: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true; IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can delete vendors'; END I.
-- receipt-less-return: delete_vendor has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: reactivate_vendor :: src/pages/Vendors.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: reactivate_vendor: p_idempotency_key only.
-- pre-lookup-checks: reactivate_vendor: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true; IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can reactivate vendors'; E.
-- receipt-less-return: reactivate_vendor has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: save_vendor :: src/pages/Vendors.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: save_vendor: p_idempotency_key only.
-- pre-lookup-checks: save_vendor: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true; IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can manage vendors'; END I.
-- receipt-less-return: save_vendor has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: link_fields_to_parent :: src/pages/Fields.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: link_fields_to_parent: p_idempotency_key only.
-- pre-lookup-checks: link_fields_to_parent: PERFORM require_admin_or_sales_rep();.
-- receipt-less-return: link_fields_to_parent has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: unlink_field_from_parent :: no direct src/ or Edge Function RPC call found; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: unlink_field_from_parent: p_idempotency_key only.
-- pre-lookup-checks: unlink_field_from_parent: PERFORM require_admin_or_sales_rep();.
-- receipt-less-return: unlink_field_from_parent has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: review_customer_fact :: src/components/customers/CustomerFacts.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: review_customer_fact: p_idempotency_key only.
-- pre-lookup-checks: review_customer_fact: IF p_verdict NOT IN ('verified', 'rejected') THEN RAISE EXCEPTION 'FACT_VERDICT_INVALID'; END IF; SELECT * INTO v_fact FROM public.customer_facts WHERE id = p_fact_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'FACT_NOT_FOUND'; END IF; IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = a.
-- receipt-less-return: review_customer_fact has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: supersede_customer_fact :: src/components/customers/CustomerFacts.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: supersede_customer_fact: p_idempotency_key only.
-- pre-lookup-checks: supersede_customer_fact: IF (p_value_text IS NULL) = (p_value_json IS NULL) OR (p_value_text IS NOT NULL AND btrim(p_value_text) = '') OR (p_value_json IS NOT NULL AND jsonb_typeof(p_value_json) NOT IN ('object', 'array')) OR (p_confidence IS NOT NULL AND p_confidence NOT BETWEEN 0 AND 1) THEN RAISE EXCEPTION 'FACT_VALUE_IN.
-- receipt-less-return: supersede_customer_fact has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: save_blend_recipe :: src/pages/BlendRecipes.tsx and src/pages/JobDetail.tsx, both reachable only by admin and sales_rep; wrapper retains authenticated/service_role EXECUTE and adds an active admin/sales_rep check the pinned body lacked (an applicator could create a priced recipe directly).
-- fingerprint-exclusions: save_blend_recipe: p_idempotency_key only.
-- pre-lookup-checks: save_blend_recipe: IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_name IS NULL OR p_name = '' THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF; IF p_recipe_type NOT IN ('generic', 'crop_specific') THEN RAISE EXCEPTION 'RECIPE_TYPE_INVALID'; END IF; IF p_items IS NULL OR jsonb_typeof(p_items) <> 'arr.
-- receipt-less-return: save_blend_recipe has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: save_field :: src/components/fields/BulkFieldImport.tsx, src/pages/FieldSetup.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: save_field: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: save_field: v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; PERFORM require_admin_or_sales_rep();.
-- receipt-less-return: save_field has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: save_field_crop_history :: src/pages/FieldDashboard.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: save_field_crop_history: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: save_field_crop_history: -- strict-actor (canonical) -------------------------------------------------- v_actor := auth.uid(); IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; IF NOT EXIST.
-- receipt-less-return: save_field_crop_history has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: save_field_geometry :: no direct src/ or Edge Function RPC call found; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: save_field_geometry: p_idempotency_key only.
-- pre-lookup-checks: save_field_geometry: PERFORM require_admin_or_sales_rep();.
-- receipt-less-return: save_field_geometry has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: save_field_polygons :: no direct src/ or Edge Function RPC call found; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: save_field_polygons: p_idempotency_key only.
-- pre-lookup-checks: save_field_polygons: PERFORM require_admin_or_sales_rep();.
-- receipt-less-return: save_field_polygons has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: set_application_record_lots :: src/lib/lotRpc.ts; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: set_application_record_lots: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: set_application_record_lots: -- strict-actor (bind auth.uid(); reject a spoofed p_performed_by) IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; -- in-body role gate (the real gate — the EXECU.
-- receipt-less-return: set_application_record_lots has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: set_field_boundary :: src/components/fields/BulkFieldImport.tsx, src/pages/FieldSetup.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: set_field_boundary: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: set_field_boundary: -- 1) strict-actor + role gate (source-verifiable inline binding + the project role helper) IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; PERFORM require_admin_.
-- receipt-less-return: set_field_boundary has no reachable keyed success without a receipt in its pinned body.
-- caller-analysis: set_field_override_acres :: src/components/fields/BulkFieldImport.tsx, src/pages/FieldSetup.tsx; wrapper retains authenticated/service_role EXECUTE.
-- fingerprint-exclusions: set_field_override_acres: p_idempotency_key; p_performed_by proven equal to actor or NULL before lookup.
-- pre-lookup-checks: set_field_override_acres: IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF; IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF; PERFORM require_admin_or_sales_rep(); -- validate at STORED precision (numeric(10,2)): NULL clears; otherwise must.
-- receipt-less-return: set_field_override_acres has no reachable keyed success without a receipt in its pinned body.

SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE records_replay_binding_batch4d_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;
CREATE TEMP TABLE records_replay_binding_batch4d_guard_ops (ord integer PRIMARY KEY, operation text NOT NULL UNIQUE) ON COMMIT DROP;
CREATE TEMP TABLE records_replay_binding_batch4d_pins ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('admin_update_profile', 'target_user_id uuid, new_role text DEFAULT NULL::text, new_full_name text DEFAULT NULL::text, new_phone text DEFAULT NULL::text, new_is_active boolean DEFAULT NULL::boolean, new_denied_pages text[] DEFAULT NULL::text[], p_idempotency_key text DEFAULT NULL::text', 'target_user_id uuid, new_role text, new_full_name text, new_phone text, new_is_active boolean, new_denied_pages text[], p_idempotency_key text', 'json', 'public, pg_temp', 'd75578eafde0489fe76466a988474a4d'),
  ('batch_approve_blend_tickets', 'p_ticket_ids uuid[], p_approved_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_ticket_ids uuid[], p_approved_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'f347cd60eec5cc26b6c74c32c4d1bf86'),
  ('batch_reject_blend_tickets', 'p_ticket_ids uuid[], p_rejected_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_ticket_ids uuid[], p_rejected_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'a2d56e0163162296dc7321093404c2ab'),
  ('bulk_create_label_drafts', 'p_drafts jsonb, p_idempotency_key text DEFAULT NULL::text', 'p_drafts jsonb, p_idempotency_key text', 'jsonb', 'public, pg_temp', '95975e8bb75dfd5d89c15922fa194c31'),
  ('commit_label_draft', 'p_draft_id uuid, p_decision text, p_signal_word text DEFAULT NULL::text, p_rei_hours integer DEFAULT NULL::integer, p_phi_days integer DEFAULT NULL::integer, p_epa_registration text DEFAULT NULL::text, p_max_label_rate numeric DEFAULT NULL::numeric, p_max_label_rate_unit text DEFAULT NULL::text, p_force_overwrite boolean DEFAULT false, p_idempotency_key text DEFAULT NULL::text', 'p_draft_id uuid, p_decision text, p_signal_word text, p_rei_hours integer, p_phi_days integer, p_epa_registration text, p_max_label_rate numeric, p_max_label_rate_unit text, p_force_overwrite boolean, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'dee9e34de43295efc9b7aa1bf6a8d809'),
  ('create_label_draft', 'p_product_id uuid, p_signal_word text DEFAULT NULL::text, p_rei_hours integer DEFAULT NULL::integer, p_phi_days integer DEFAULT NULL::integer, p_epa_registration text DEFAULT NULL::text, p_max_label_rate numeric DEFAULT NULL::numeric, p_max_label_rate_unit text DEFAULT NULL::text, p_source_note text DEFAULT ''''::text, p_confidence text DEFAULT ''low''::text, p_status text DEFAULT ''pending''::text, p_idempotency_key text DEFAULT NULL::text', 'p_product_id uuid, p_signal_word text, p_rei_hours integer, p_phi_days integer, p_epa_registration text, p_max_label_rate numeric, p_max_label_rate_unit text, p_source_note text, p_confidence text, p_status text, p_idempotency_key text', 'uuid', 'public, pg_temp', 'd045cb53cc7e121aedc454d9e306cffc'),
  ('create_blend_ticket', 'p_ticket_id uuid, p_ticket_payload jsonb, p_products jsonb DEFAULT ''[]''::jsonb, p_images jsonb DEFAULT ''[]''::jsonb, p_enqueue_ocr boolean DEFAULT false, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text', 'p_ticket_id uuid, p_ticket_payload jsonb, p_products jsonb, p_images jsonb, p_enqueue_ocr boolean, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'bd3c789e4a2dc5affa5114f7dd1602c8'),
  ('save_blend_ticket', 'p_ticket_id uuid, p_ticket_payload jsonb, p_products jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_ticket_id uuid, p_ticket_payload jsonb, p_products jsonb, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', '0512c4c125ad8354372aca2b4cd8bbc6'),
  ('save_blend_ticket_fields', 'p_blend_ticket_id uuid, p_fields jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_blend_ticket_id uuid, p_fields jsonb, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'e369f859b486d4f3fb8bf8205f7a16fe'),
  ('dismiss_watchdog_flag', 'p_flag_id uuid, p_resolution text, p_note text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_flag_id uuid, p_resolution text, p_note text, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'e721b88c2bebbbe1c97c6e5153ef80d6'),
  ('delete_vendor', 'p_vendor_id uuid, p_idempotency_key text DEFAULT NULL::text', 'p_vendor_id uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'f0a348c4198e79a32c12b22802d580b9'),
  ('reactivate_vendor', 'p_vendor_id uuid, p_idempotency_key text DEFAULT NULL::text', 'p_vendor_id uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', '2000945213bc1ced8656fb683b7ff260'),
  ('save_vendor', 'p_vendor_id uuid, p_payload jsonb, p_idempotency_key text DEFAULT NULL::text', 'p_vendor_id uuid, p_payload jsonb, p_idempotency_key text', 'jsonb', 'public, pg_temp', '4bed3d28d859b6e67ffbd69f6f796ec6'),
  ('link_fields_to_parent', 'p_parent_id uuid, p_child_ids uuid[], p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_parent_id uuid, p_child_ids uuid[], p_performed_by uuid, p_idempotency_key text', 'void', 'public, pg_temp', '181333fa3c04e0eea5ffe56325c41926'),
  ('unlink_field_from_parent', 'p_field_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_field_id uuid, p_performed_by uuid, p_idempotency_key text', 'void', 'public, pg_temp', '1469c5f58f91b047ed92e5c5d1e895d7'),
  ('review_customer_fact', 'p_fact_id uuid, p_verdict text, p_review_note text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', 'p_fact_id uuid, p_verdict text, p_review_note text, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'a17fe5f07302a4b896a51d213579e73f'),
  ('supersede_customer_fact', 'p_fact_id uuid, p_value_text text, p_value_json jsonb, p_confidence numeric, p_expires_at timestamp with time zone, p_idempotency_key text DEFAULT NULL::text', 'p_fact_id uuid, p_value_text text, p_value_json jsonb, p_confidence numeric, p_expires_at timestamp with time zone, p_idempotency_key text', 'jsonb', 'public, pg_temp', 'd0623ea7b5a54e7d814232abfe57882d'),
  ('save_blend_recipe', 'p_recipe_id uuid, p_name text, p_recipe_type text, p_items jsonb, p_description text DEFAULT NULL::text, p_crop_type text DEFAULT NULL::text, p_timing text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', 'p_recipe_id uuid, p_name text, p_recipe_type text, p_items jsonb, p_description text, p_crop_type text, p_timing text, p_idempotency_key text', 'jsonb', 'public, pg_temp', '9950c531f279c795658e943069218bbf'),
  ('save_field', 'p_field_id uuid, p_field_payload jsonb, p_billing_defaults jsonb DEFAULT ''[]''::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_field_id uuid, p_field_payload jsonb, p_billing_defaults jsonb, p_performed_by uuid, p_idempotency_key text', 'uuid', 'public, pg_temp', 'b540e435969d29de542ef9ccddaddc31'),
  ('save_field_crop_history', 'p_field_id uuid, p_season integer, p_crop_type text, p_variety text DEFAULT NULL::text, p_planting_date date DEFAULT NULL::date, p_harvest_date date DEFAULT NULL::date, p_yield_per_acre numeric DEFAULT NULL::numeric, p_yield_unit text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_field_id uuid, p_season integer, p_crop_type text, p_variety text, p_planting_date date, p_harvest_date date, p_yield_per_acre numeric, p_yield_unit text, p_notes text, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', '4395eea60420c930dcc3895c6f2757f6'),
  ('save_field_geometry', 'p_field_id uuid, p_centroid_geojson text DEFAULT NULL::text, p_boundary_geojson text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', 'p_field_id uuid, p_centroid_geojson text, p_boundary_geojson text, p_idempotency_key text', 'void', 'public, extensions, pg_temp', '046aa48fec906db224f38d68ffe2a539'),
  ('save_field_polygons', 'p_field_id uuid, p_polygons jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_field_id uuid, p_polygons jsonb, p_performed_by uuid, p_idempotency_key text', 'void', 'public, extensions, pg_temp', '920b182e74a4eaa8041504110c484ae7'),
  ('set_application_record_lots', 'p_application_record_id uuid, p_lots jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_application_record_id uuid, p_lots jsonb, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, pg_temp', '14c6e80590b53cde6060e4dec2e825ec'),
  ('set_field_boundary', 'p_field_id uuid, p_boundary_geojson text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_field_id uuid, p_boundary_geojson text, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, extensions, pg_temp', '0e6bdc2ad4cfc870061d376d9aeb9faf'),
  ('set_field_override_acres', 'p_field_id uuid, p_override_acres numeric, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_field_id uuid, p_override_acres numeric, p_performed_by uuid, p_idempotency_key text', 'jsonb', 'public, extensions, pg_temp', '9940b13cb499f0c1f5aaeaa08021d0fb')
) AS pin(name,args,identity_args,ret,search_path,body_md5);
CREATE TEMP TABLE records_replay_binding_batch4d_helper_pins ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('public.check_idempotency_intent(text,text,uuid,text)', 'edc73be809069669e8441eba7acf443d', true, 'postgres'),
  ('public._replay_fingerprint_20261015(jsonb)', '68d5c0c62579349ced47c89e6b65ccaf', false, 'postgres'),
  ('public._bind_replay_receipt_20261015(text,text,text)', '722ddd3b5d9174c598735cb321088f73', false, 'postgres'),
  ('public._require_bound_replay_receipt_20261015()', '5c0478525131ddbeb7b96ef1535ff91e', true, 'postgres')
) AS h(sig,body_md5,secdef,acl);

DO $preflight$
DECLARE v_drift text;
BEGIN
  IF to_regclass('pg_temp.records_replay_binding_batch4d_tx') IS NULL THEN
    RAISE EXCEPTION 'RECORDS_REPLAY_BINDING_BATCH4D_NOT_IN_TRANSACTION';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.records_replay_binding_batch4d_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'RECORDS_REPLAY_BINDING_BATCH4D_NOT_IN_TRANSACTION';
  END IF;
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_drift
  FROM pg_temp.records_replay_binding_batch4d_pins pin
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
  IF v_drift IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT_4D_BODY_DRIFT: %', v_drift; END IF;

  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname,p.proname) INTO v_drift
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema')
    AND NOT (n.nspname='public' AND p.proname IN (SELECT pin.name FROM pg_temp.records_replay_binding_batch4d_pins pin))
    AND regexp_replace(regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g'), '''[^'']*''', '', 'g')
        ~* '(^|[^_a-z0-9])(admin_update_profile|batch_approve_blend_tickets|batch_reject_blend_tickets|bulk_create_label_drafts|commit_label_draft|create_label_draft|create_blend_ticket|save_blend_ticket|save_blend_ticket_fields|dismiss_watchdog_flag|delete_vendor|reactivate_vendor|save_vendor|link_fields_to_parent|unlink_field_from_parent|review_customer_fact|supersede_customer_fact|save_blend_recipe|save_field|save_field_crop_history|save_field_geometry|save_field_polygons|set_application_record_lots|set_field_boundary|set_field_override_acres)"?\s*\(';
  IF v_drift IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: %', v_drift; END IF;
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $cron$SELECT string_agg(jobname, ', ' ORDER BY jobname) FROM cron.job
      WHERE command ~* '(admin_update_profile|batch_approve_blend_tickets|batch_reject_blend_tickets|bulk_create_label_drafts|commit_label_draft|create_label_draft|create_blend_ticket|save_blend_ticket|save_blend_ticket_fields|dismiss_watchdog_flag|delete_vendor|reactivate_vendor|save_vendor|link_fields_to_parent|unlink_field_from_parent|review_customer_fact|supersede_customer_fact|save_blend_recipe|save_field|save_field_crop_history|save_field_geometry|save_field_polygons|set_application_record_lots|set_field_boundary|set_field_override_acres)'$cron$ INTO v_drift;
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
    SELECT 1 FROM pg_temp.records_replay_binding_batch4d_helper_pins h WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(h.sig)
        AND p.proowner='postgres'::regrole AND p.prosecdef=h.secdef
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND md5(replace(p.prosrc,chr(13),''))=h.body_md5
        AND array_to_string(ARRAY(SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC'
          ELSE a.grantee::regrole::text END FROM aclexplode(p.proacl) a
          WHERE a.privilege_type='EXECUTE' ORDER BY 1), ',')=h.acl)
  ) THEN RAISE EXCEPTION 'PREFLIGHT_4D_HELPER_DRIFT'; END IF;

  LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys k
             WHERE k.operation IN (SELECT pin.name FROM pg_temp.records_replay_binding_batch4d_pins pin)
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
  v_other constant text[] := ARRAY['confirm_job_notification_sent', 'record_job_pre_notifications', 'record_job_post_notifications', 'log_failed_notification', 'apply_remaining_prepayments', 'batch_apply_all_prepayments', 'assign_job_applicator', 'dispatch_job_locations', 'undispatch_job_locations', 'start_job', 'create_job_from_quote_section', 'update_field_app_applied_info', 'create_quote_from_template', 'rollover_quote_to_season', 'save_quote_template'];
  v_this constant text[] := ARRAY['admin_update_profile', 'batch_approve_blend_tickets', 'batch_reject_blend_tickets', 'bulk_create_label_drafts', 'commit_label_draft', 'create_label_draft', 'create_blend_ticket', 'save_blend_ticket', 'save_blend_ticket_fields', 'dismiss_watchdog_flag', 'delete_vendor', 'reactivate_vendor', 'save_vendor', 'link_fields_to_parent', 'unlink_field_from_parent', 'review_customer_fact', 'supersede_customer_fact', 'save_blend_recipe', 'save_field', 'save_field_crop_history', 'save_field_geometry', 'save_field_polygons', 'set_application_record_lots', 'set_field_boundary', 'set_field_override_acres'];
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
        FROM unnest(v_prior) WITH ORDINALITY AS u(o,ord))
    || ']))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()';
  IF v_def = v_expected THEN
    v_ops := v_prior || v_this;
  ELSE
    v_expected := 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
      || (SELECT string_agg(quote_literal(o) || '::text', ', ' ORDER BY ord)
          FROM unnest(v_prior || v_other) WITH ORDINALITY AS u(o,ord))
      || ']))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()';
    IF v_def IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'PREFLIGHT_RECEIPT_GUARD_DRIFT'; END IF;
    v_ops := v_prior || v_other || v_this;
  END IF;
  INSERT INTO pg_temp.records_replay_binding_batch4d_guard_ops(ord,operation)
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

-- 1. admin_update_profile
ALTER FUNCTION public.admin_update_profile(uuid, text, text, text, boolean, text[], text) RENAME TO _admin_update_profile_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._admin_update_profile_replay_impl_20261015(uuid, text, text, text, boolean, text[], text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.admin_update_profile(target_user_id uuid, new_role text DEFAULT NULL::text, new_full_name text DEFAULT NULL::text, new_phone text DEFAULT NULL::text, new_is_active boolean DEFAULT NULL::boolean, new_denied_pages text[] DEFAULT NULL::text[], p_idempotency_key text DEFAULT NULL::text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result json;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: admin_update_profile requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    caller_role text;
    caller_active boolean;
    updated_count int;
    v_final_role text;
    v_existing jsonb;
  BEGIN
  PERFORM require_admin();
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'target_user_id', target_user_id, 'new_role', new_role, 'new_full_name', new_full_name, 'new_phone', new_phone, 'new_is_active', new_is_active, 'new_denied_pages', new_denied_pages));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'admin_update_profile', v_actor, v_fingerprint);
  v_result := public._admin_update_profile_replay_impl_20261015(target_user_id, new_role, new_full_name, new_phone, new_is_active, new_denied_pages, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='admin_update_profile'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'admin_update_profile', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_update_profile(uuid, text, text, text, boolean, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_profile(uuid, text, text, text, boolean, text[], text) TO authenticated, service_role;

-- 2. batch_approve_blend_tickets
ALTER FUNCTION public.batch_approve_blend_tickets(uuid[], uuid, text) RENAME TO _batch_approve_blend_tickets_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._batch_approve_blend_tickets_replay_impl_20261015(uuid[], uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.batch_approve_blend_tickets(p_ticket_ids uuid[], p_approved_by uuid, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: batch_approve_blend_tickets requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid;
    v_count integer := 0;
    v_existing text;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_approved_by IS NOT NULL AND p_approved_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_ticket_ids', p_ticket_ids, 'p_approved_by', p_approved_by));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'batch_approve_blend_tickets', v_actor, v_fingerprint);
  v_result := public._batch_approve_blend_tickets_replay_impl_20261015(p_ticket_ids, p_approved_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='batch_approve_blend_tickets'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'batch_approve_blend_tickets', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.batch_approve_blend_tickets(uuid[], uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_approve_blend_tickets(uuid[], uuid, text) TO authenticated, service_role;

-- 3. batch_reject_blend_tickets
ALTER FUNCTION public.batch_reject_blend_tickets(uuid[], uuid, text) RENAME TO _batch_reject_blend_tickets_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._batch_reject_blend_tickets_replay_impl_20261015(uuid[], uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.batch_reject_blend_tickets(p_ticket_ids uuid[], p_rejected_by uuid, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: batch_reject_blend_tickets requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid;
    v_count integer := 0;
    v_existing text;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_rejected_by IS NOT NULL AND p_rejected_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_ticket_ids', p_ticket_ids, 'p_rejected_by', p_rejected_by));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'batch_reject_blend_tickets', v_actor, v_fingerprint);
  v_result := public._batch_reject_blend_tickets_replay_impl_20261015(p_ticket_ids, p_rejected_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='batch_reject_blend_tickets'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'batch_reject_blend_tickets', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.batch_reject_blend_tickets(uuid[], uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_reject_blend_tickets(uuid[], uuid, text) TO authenticated, service_role;

-- 4. bulk_create_label_drafts
ALTER FUNCTION public.bulk_create_label_drafts(jsonb, text) RENAME TO _bulk_create_label_drafts_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._bulk_create_label_drafts_replay_impl_20261015(jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.bulk_create_label_drafts(p_drafts jsonb, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: bulk_create_label_drafts requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_user_id  uuid := auth.uid();
    v_cached   jsonb;
    v_item     jsonb;
    v_ids      uuid[] := '{}';
    v_draft_id uuid;
  BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: admin role required';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_drafts', p_drafts));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'bulk_create_label_drafts', v_actor, v_fingerprint);
  v_result := public._bulk_create_label_drafts_replay_impl_20261015(p_drafts, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='bulk_create_label_drafts'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'bulk_create_label_drafts', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.bulk_create_label_drafts(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_create_label_drafts(jsonb, text) TO authenticated, service_role;

-- 5. commit_label_draft
ALTER FUNCTION public.commit_label_draft(uuid, text, text, integer, integer, text, numeric, text, boolean, text) RENAME TO _commit_label_draft_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._commit_label_draft_replay_impl_20261015(uuid, text, text, integer, integer, text, numeric, text, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.commit_label_draft(p_draft_id uuid, p_decision text, p_signal_word text DEFAULT NULL::text, p_rei_hours integer DEFAULT NULL::integer, p_phi_days integer DEFAULT NULL::integer, p_epa_registration text DEFAULT NULL::text, p_max_label_rate numeric DEFAULT NULL::numeric, p_max_label_rate_unit text DEFAULT NULL::text, p_force_overwrite boolean DEFAULT false, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: commit_label_draft requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_user_id  uuid := auth.uid();
    v_cached   jsonb;
    v_draft    product_label_drafts%ROWTYPE;
    v_product  products%ROWTYPE;
    v_new_sw   text;
    v_new_rei  integer;
    v_new_phi  integer;
    v_new_epa  text;
    v_new_mlr  numeric;
    v_new_mlru text;
    v_skipped  text[] := '{}';
    v_applied  text[] := '{}';
    v_result   jsonb;
  BEGIN
  -- Auth gate
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: admin role required';
  END IF;

  -- Validate decision
  IF p_decision NOT IN ('accepted', 'edited', 'rejected') THEN
    RAISE EXCEPTION 'INVALID_DECISION: must be accepted, edited, or rejected';
  END IF;

  -- Idempotency
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_draft_id', p_draft_id, 'p_decision', p_decision, 'p_signal_word', p_signal_word, 'p_rei_hours', p_rei_hours, 'p_phi_days', p_phi_days, 'p_epa_registration', p_epa_registration, 'p_max_label_rate', p_max_label_rate, 'p_max_label_rate_unit', p_max_label_rate_unit, 'p_force_overwrite', p_force_overwrite));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'commit_label_draft', v_actor, v_fingerprint);
  v_result := public._commit_label_draft_replay_impl_20261015(p_draft_id, p_decision, p_signal_word, p_rei_hours, p_phi_days, p_epa_registration, p_max_label_rate, p_max_label_rate_unit, p_force_overwrite, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='commit_label_draft'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'commit_label_draft', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.commit_label_draft(uuid, text, text, integer, integer, text, numeric, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_label_draft(uuid, text, text, integer, integer, text, numeric, text, boolean, text) TO authenticated, service_role;

-- 6. create_label_draft
ALTER FUNCTION public.create_label_draft(uuid, text, integer, integer, text, numeric, text, text, text, text, text) RENAME TO _create_label_draft_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_label_draft_replay_impl_20261015(uuid, text, integer, integer, text, numeric, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.create_label_draft(p_product_id uuid, p_signal_word text DEFAULT NULL::text, p_rei_hours integer DEFAULT NULL::integer, p_phi_days integer DEFAULT NULL::integer, p_epa_registration text DEFAULT NULL::text, p_max_label_rate numeric DEFAULT NULL::numeric, p_max_label_rate_unit text DEFAULT NULL::text, p_source_note text DEFAULT ''::text, p_confidence text DEFAULT 'low'::text, p_status text DEFAULT 'pending'::text, p_idempotency_key text DEFAULT NULL::text)
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
  v_requested_status text := p_status;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_label_draft requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_user_id   uuid := auth.uid();
    v_draft_id  uuid;
    v_cached    jsonb;
  BEGIN
  -- Auth gate: admin only
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_user_id AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED: admin role required';
  END IF;

  -- A new draft is never created already-decided: clamp to a reviewable status so a row can't
  -- enter the queue as accepted/edited/rejected (which would bypass human review).
  IF p_status NOT IN ('pending', 'needs_manual') THEN
    p_status := 'pending';
  END IF;

  -- Non-negativity guard: regulatory intervals/rates can never be negative.
  -- (Reject at staging so an impossible value can't even be drafted.)
  IF p_rei_hours IS NOT NULL AND p_rei_hours < 0 THEN
    RAISE EXCEPTION 'INVALID_LABEL_VALUE: rei_hours must be >= 0 (got %)', p_rei_hours;
  END IF;
  IF p_phi_days IS NOT NULL AND p_phi_days < 0 THEN
    RAISE EXCEPTION 'INVALID_LABEL_VALUE: phi_days must be >= 0 (got %)', p_phi_days;
  END IF;
  IF p_max_label_rate IS NOT NULL AND p_max_label_rate < 0 THEN
    RAISE EXCEPTION 'INVALID_LABEL_VALUE: max_label_rate must be >= 0 (got %)', p_max_label_rate;
  END IF;

  -- Idempotency: return cached result if same key already processed
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_product_id', p_product_id, 'p_signal_word', p_signal_word, 'p_rei_hours', p_rei_hours, 'p_phi_days', p_phi_days, 'p_epa_registration', p_epa_registration, 'p_max_label_rate', p_max_label_rate, 'p_max_label_rate_unit', p_max_label_rate_unit, 'p_source_note', p_source_note, 'p_confidence', p_confidence, 'p_status', v_requested_status));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_label_draft', v_actor, v_fingerprint);
  v_result := public._create_label_draft_replay_impl_20261015(p_product_id, p_signal_word, p_rei_hours, p_phi_days, p_epa_registration, p_max_label_rate, p_max_label_rate_unit, p_source_note, p_confidence, p_status, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='create_label_draft'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_label_draft', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_label_draft(uuid, text, integer, integer, text, numeric, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_label_draft(uuid, text, integer, integer, text, numeric, text, text, text, text, text) TO authenticated, service_role;

-- 7. create_blend_ticket
ALTER FUNCTION public.create_blend_ticket(uuid, jsonb, jsonb, jsonb, boolean, uuid, text) RENAME TO _create_blend_ticket_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_blend_ticket_replay_impl_20261015(uuid, jsonb, jsonb, jsonb, boolean, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.create_blend_ticket(p_ticket_id uuid, p_ticket_payload jsonb, p_products jsonb DEFAULT '[]'::jsonb, p_images jsonb DEFAULT '[]'::jsonb, p_enqueue_ocr boolean DEFAULT false, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_blend_ticket requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid := auth.uid();
    v_ticket_number text;
    v_customer_id uuid;
    v_existing jsonb;
    v_result jsonb;
    v_image_count integer;
    v_product jsonb;
    v_image jsonb;
    v_ordinality bigint;
  BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: active admin or sales role required';
  END IF;
  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_ID_REQUIRED';
  END IF;
  IF jsonb_typeof(COALESCE(p_ticket_payload, '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(COALESCE(p_products, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_images, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'BLEND_TICKET_PAYLOAD_INVALID';
  END IF;
  IF jsonb_array_length(COALESCE(p_products, '[]'::jsonb)) > 200 THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_COUNT_INVALID';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_ticket_id', p_ticket_id, 'p_ticket_payload', p_ticket_payload, 'p_products', p_products, 'p_images', p_images, 'p_enqueue_ocr', p_enqueue_ocr));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_blend_ticket', v_actor, v_fingerprint);
  v_result := public._create_blend_ticket_replay_impl_20261015(p_ticket_id, p_ticket_payload, p_products, p_images, p_enqueue_ocr, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='create_blend_ticket'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_blend_ticket', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_blend_ticket(uuid, jsonb, jsonb, jsonb, boolean, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_blend_ticket(uuid, jsonb, jsonb, jsonb, boolean, uuid, text) TO authenticated, service_role;

-- 8. save_blend_ticket
ALTER FUNCTION public.save_blend_ticket(uuid, jsonb, jsonb, uuid, text) RENAME TO _save_blend_ticket_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._save_blend_ticket_replay_impl_20261015(uuid, jsonb, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_blend_ticket(p_ticket_id uuid, p_ticket_payload jsonb, p_products jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: save_blend_ticket requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_ticket public.blend_tickets%ROWTYPE;
    v_existing jsonb;
    v_result jsonb;
    v_actor uuid := auth.uid();
    v_effective_customer uuid;
    v_effective_job_id uuid;
  BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_ticket_id', p_ticket_id, 'p_ticket_payload', p_ticket_payload, 'p_products', p_products));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'save_blend_ticket', v_actor, v_fingerprint);
  v_result := public._save_blend_ticket_replay_impl_20261015(p_ticket_id, p_ticket_payload, p_products, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='save_blend_ticket'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'save_blend_ticket', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.save_blend_ticket(uuid, jsonb, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_blend_ticket(uuid, jsonb, jsonb, uuid, text) TO authenticated, service_role;

-- 9. save_blend_ticket_fields
ALTER FUNCTION public.save_blend_ticket_fields(uuid, jsonb, uuid, text) RENAME TO _save_blend_ticket_fields_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._save_blend_ticket_fields_replay_impl_20261015(uuid, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_blend_ticket_fields(p_blend_ticket_id uuid, p_fields jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: save_blend_ticket_fields requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid;
    v_field jsonb;
    v_count integer := 0;
    v_existing text;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_blend_ticket_id', p_blend_ticket_id, 'p_fields', p_fields));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'save_blend_ticket_fields', v_actor, v_fingerprint);
  v_result := public._save_blend_ticket_fields_replay_impl_20261015(p_blend_ticket_id, p_fields, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='save_blend_ticket_fields'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'save_blend_ticket_fields', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.save_blend_ticket_fields(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_blend_ticket_fields(uuid, jsonb, uuid, text) TO authenticated, service_role;

-- 10. dismiss_watchdog_flag
ALTER FUNCTION public.dismiss_watchdog_flag(uuid, text, text, uuid, text) RENAME TO _dismiss_watchdog_flag_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._dismiss_watchdog_flag_replay_impl_20261015(uuid, text, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.dismiss_watchdog_flag(p_flag_id uuid, p_resolution text, p_note text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: dismiss_watchdog_flag requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor    uuid;
    v_cached   jsonb;
    v_flag     watchdog_flags%ROWTYPE;
    v_dismiss  watchdog_flag_dismissals%ROWTYPE;
    v_result   jsonb;
  BEGIN
  -- Resolve actor (canonical pattern: bind auth.uid first, then validate)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: must be authenticated to dismiss watchdog flags';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;

  -- Gate: actor must be admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND (role IN ('admin','sales_rep')) AND is_active = true
  ) THEN
    RAISE EXCEPTION 'WATCHDOG_ACCESS_DENIED: admin or sales_rep role required';
  END IF;

  -- Validate resolution
  IF p_resolution NOT IN ('looks_fine','needs_fix') THEN
    RAISE EXCEPTION 'INVALID_RESOLUTION: must be looks_fine or needs_fix';
  END IF;

  -- Idempotency check
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_flag_id', p_flag_id, 'p_resolution', p_resolution, 'p_note', p_note));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'dismiss_watchdog_flag', v_actor, v_fingerprint);
  v_result := public._dismiss_watchdog_flag_replay_impl_20261015(p_flag_id, p_resolution, p_note, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='dismiss_watchdog_flag'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'dismiss_watchdog_flag', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.dismiss_watchdog_flag(uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dismiss_watchdog_flag(uuid, text, text, uuid, text) TO authenticated, service_role;

-- 11. delete_vendor
ALTER FUNCTION public.delete_vendor(uuid, text) RENAME TO _delete_vendor_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._delete_vendor_replay_impl_20261015(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.delete_vendor(p_vendor_id uuid, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: delete_vendor requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid; v_actor_role text; v_vendor record;
    v_active_po_count integer; v_active_bill_count integer;
    v_result jsonb; v_existing jsonb;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can delete vendors';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_vendor_id', p_vendor_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'delete_vendor', v_actor, v_fingerprint);
  v_result := public._delete_vendor_replay_impl_20261015(p_vendor_id, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='delete_vendor'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'delete_vendor', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.delete_vendor(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_vendor(uuid, text) TO authenticated, service_role;

-- 12. reactivate_vendor
ALTER FUNCTION public.reactivate_vendor(uuid, text) RENAME TO _reactivate_vendor_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._reactivate_vendor_replay_impl_20261015(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.reactivate_vendor(p_vendor_id uuid, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: reactivate_vendor requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid;
    v_actor_role text;
    v_vendor record;
    v_conflict_name text;
    v_result jsonb;
    v_existing jsonb;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can reactivate vendors';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_vendor_id', p_vendor_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'reactivate_vendor', v_actor, v_fingerprint);
  v_result := public._reactivate_vendor_replay_impl_20261015(p_vendor_id, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='reactivate_vendor'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'reactivate_vendor', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.reactivate_vendor(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reactivate_vendor(uuid, text) TO authenticated, service_role;

-- 13. save_vendor
ALTER FUNCTION public.save_vendor(uuid, jsonb, text) RENAME TO _save_vendor_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._save_vendor_replay_impl_20261015(uuid, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_vendor(p_vendor_id uuid, p_payload jsonb, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: save_vendor requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid; v_actor_role text; v_vendor_id uuid;
    v_is_new boolean := (p_vendor_id IS NULL);
    v_name text; v_result jsonb; v_existing jsonb;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can manage vendors';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_vendor_id', p_vendor_id, 'p_payload', p_payload));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'save_vendor', v_actor, v_fingerprint);
  v_result := public._save_vendor_replay_impl_20261015(p_vendor_id, p_payload, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='save_vendor'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'save_vendor', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.save_vendor(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_vendor(uuid, jsonb, text) TO authenticated, service_role;

-- 14. link_fields_to_parent
ALTER FUNCTION public.link_fields_to_parent(uuid, uuid[], uuid, text) RENAME TO _link_fields_to_parent_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._link_fields_to_parent_replay_impl_20261015(uuid, uuid[], uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.link_fields_to_parent(p_parent_id uuid, p_child_ids uuid[], p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: link_fields_to_parent requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE v_existing jsonb; v_parent_is_child boolean;
  BEGIN
  PERFORM require_admin_or_sales_rep();
  END;
  -- Added (apply-review HIGH): the pinned body never reads p_performed_by; refuse a forged one.
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_parent_id', p_parent_id, 'p_child_ids', p_child_ids, 'p_performed_by', p_performed_by));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'link_fields_to_parent', v_actor, v_fingerprint);
  PERFORM public._link_fields_to_parent_replay_impl_20261015(p_parent_id, p_child_ids, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='link_fields_to_parent'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'link_fields_to_parent', v_fingerprint);
  END IF;
  RETURN;
END;
$function$;
REVOKE ALL ON FUNCTION public.link_fields_to_parent(uuid, uuid[], uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_fields_to_parent(uuid, uuid[], uuid, text) TO authenticated, service_role;

-- 15. unlink_field_from_parent
ALTER FUNCTION public.unlink_field_from_parent(uuid, uuid, text) RENAME TO _unlink_field_from_parent_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._unlink_field_from_parent_replay_impl_20261015(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.unlink_field_from_parent(p_field_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: unlink_field_from_parent requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE v_existing jsonb;
  BEGIN
  PERFORM require_admin_or_sales_rep();
  END;
  -- Added (apply-review HIGH): the pinned body never reads p_performed_by; refuse a forged one.
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_field_id', p_field_id, 'p_performed_by', p_performed_by));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'unlink_field_from_parent', v_actor, v_fingerprint);
  PERFORM public._unlink_field_from_parent_replay_impl_20261015(p_field_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='unlink_field_from_parent'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'unlink_field_from_parent', v_fingerprint);
  END IF;
  RETURN;
END;
$function$;
REVOKE ALL ON FUNCTION public.unlink_field_from_parent(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlink_field_from_parent(uuid, uuid, text) TO authenticated, service_role;

-- 16. review_customer_fact
ALTER FUNCTION public.review_customer_fact(uuid, text, text, text) RENAME TO _review_customer_fact_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._review_customer_fact_replay_impl_20261015(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.review_customer_fact(p_fact_id uuid, p_verdict text, p_review_note text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: review_customer_fact requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_fact public.customer_facts%ROWTYPE;
    v_existing jsonb;
    v_result jsonb;
  BEGIN
  IF p_verdict NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'FACT_VERDICT_INVALID';
  END IF;

  SELECT * INTO v_fact FROM public.customer_facts WHERE id = p_fact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FACT_NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active)
     OR NOT (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
       SELECT 1 FROM public.customers c
       WHERE c.id = v_fact.customer_id
     ))) THEN
    RAISE EXCEPTION 'FACT_ACCESS_DENIED';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_fact_id', p_fact_id, 'p_verdict', p_verdict, 'p_review_note', p_review_note));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'review_customer_fact', v_actor, v_fingerprint);
  v_result := public._review_customer_fact_replay_impl_20261015(p_fact_id, p_verdict, p_review_note, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='review_customer_fact'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'review_customer_fact', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.review_customer_fact(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_customer_fact(uuid, text, text, text) TO authenticated, service_role;

-- 17. supersede_customer_fact
ALTER FUNCTION public.supersede_customer_fact(uuid, text, jsonb, numeric, timestamp with time zone, text) RENAME TO _supersede_customer_fact_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._supersede_customer_fact_replay_impl_20261015(uuid, text, jsonb, numeric, timestamp with time zone, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.supersede_customer_fact(p_fact_id uuid, p_value_text text, p_value_json jsonb, p_confidence numeric, p_expires_at timestamp with time zone, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: supersede_customer_fact requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_fact public.customer_facts%ROWTYPE;
    v_new_fact_id uuid;
    v_existing jsonb;
    v_result jsonb;
  BEGIN
  IF (p_value_text IS NULL) = (p_value_json IS NULL)
     OR (p_value_text IS NOT NULL AND btrim(p_value_text) = '')
     OR (p_value_json IS NOT NULL AND jsonb_typeof(p_value_json) NOT IN ('object', 'array'))
     OR (p_confidence IS NOT NULL AND p_confidence NOT BETWEEN 0 AND 1) THEN
    RAISE EXCEPTION 'FACT_VALUE_INVALID';
  END IF;

  SELECT * INTO v_fact FROM public.customer_facts WHERE id = p_fact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FACT_NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active)
     OR NOT (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
       SELECT 1 FROM public.customers c
       WHERE c.id = v_fact.customer_id
     ))) THEN
    RAISE EXCEPTION 'FACT_ACCESS_DENIED';
  END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_fact_id', p_fact_id, 'p_value_text', p_value_text, 'p_value_json', p_value_json, 'p_confidence', p_confidence, 'p_expires_at', p_expires_at));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'supersede_customer_fact', v_actor, v_fingerprint);
  v_result := public._supersede_customer_fact_replay_impl_20261015(p_fact_id, p_value_text, p_value_json, p_confidence, p_expires_at, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='supersede_customer_fact'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'supersede_customer_fact', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.supersede_customer_fact(uuid, text, jsonb, numeric, timestamp with time zone, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supersede_customer_fact(uuid, text, jsonb, numeric, timestamp with time zone, text) TO authenticated, service_role;

-- 18. save_blend_recipe
ALTER FUNCTION public.save_blend_recipe(uuid, text, text, jsonb, text, text, text, text) RENAME TO _save_blend_recipe_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._save_blend_recipe_replay_impl_20261015(uuid, text, text, jsonb, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_blend_recipe(p_recipe_id uuid, p_name text, p_recipe_type text, p_items jsonb, p_description text DEFAULT NULL::text, p_crop_type text DEFAULT NULL::text, p_timing text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: save_blend_recipe requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor        uuid := auth.uid();
    v_recipe_id    uuid;
    v_existing     jsonb;
    v_result       jsonb;
    v_item         jsonb;
    v_item_count   int := 0;
    v_idx          int := 0;
    v_was_create   boolean := (p_recipe_id IS NULL);
    v_creator      uuid;
  BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_name IS NULL OR p_name = '' THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF;
  IF p_recipe_type NOT IN ('generic', 'crop_specific') THEN RAISE EXCEPTION 'RECIPE_TYPE_INVALID'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'ITEMS_INVALID';
  END IF;
  END;
  -- Added (Sol HIGH): the pinned body lets any signed-in user create a recipe and set its
  -- prices; both app save paths (Blend Recipes page, job "save as recipe") are admin/sales only.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_recipe_id', p_recipe_id, 'p_name', p_name, 'p_recipe_type', p_recipe_type, 'p_items', p_items, 'p_description', p_description, 'p_crop_type', p_crop_type, 'p_timing', p_timing));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'save_blend_recipe', v_actor, v_fingerprint);
  v_result := public._save_blend_recipe_replay_impl_20261015(p_recipe_id, p_name, p_recipe_type, p_items, p_description, p_crop_type, p_timing, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='save_blend_recipe'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'save_blend_recipe', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.save_blend_recipe(uuid, text, text, jsonb, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_blend_recipe(uuid, text, text, jsonb, text, text, text, text) TO authenticated, service_role;

-- 19. save_field
ALTER FUNCTION public.save_field(uuid, jsonb, jsonb, uuid, text) RENAME TO _save_field_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._save_field_replay_impl_20261015(uuid, jsonb, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_field(p_field_id uuid, p_field_payload jsonb, p_billing_defaults jsonb DEFAULT '[]'::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
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
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: save_field requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor uuid;
    v_field_id uuid;
    v_total_pct numeric;
    v_existing jsonb;
  BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_field_id', p_field_id, 'p_field_payload', p_field_payload, 'p_billing_defaults', p_billing_defaults));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'save_field', v_actor, v_fingerprint);
  v_result := public._save_field_replay_impl_20261015(p_field_id, p_field_payload, p_billing_defaults, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='save_field'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'save_field', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.save_field(uuid, jsonb, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_field(uuid, jsonb, jsonb, uuid, text) TO authenticated, service_role;

-- 20. save_field_crop_history
ALTER FUNCTION public.save_field_crop_history(uuid, integer, text, text, date, date, numeric, text, text, uuid, text) RENAME TO _save_field_crop_history_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._save_field_crop_history_replay_impl_20261015(uuid, integer, text, text, date, date, numeric, text, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_field_crop_history(p_field_id uuid, p_season integer, p_crop_type text, p_variety text DEFAULT NULL::text, p_planting_date date DEFAULT NULL::date, p_harvest_date date DEFAULT NULL::date, p_yield_per_acre numeric DEFAULT NULL::numeric, p_yield_unit text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: save_field_crop_history requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor        uuid;
    v_season       integer;
    v_id           uuid;
    v_idemp        jsonb;
    v_result       jsonb;
  BEGIN
  -- strict-actor (canonical) --------------------------------------------------
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- idempotency replay --------------------------------------------------------
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_field_id', p_field_id, 'p_season', p_season, 'p_crop_type', p_crop_type, 'p_variety', p_variety, 'p_planting_date', p_planting_date, 'p_harvest_date', p_harvest_date, 'p_yield_per_acre', p_yield_per_acre, 'p_yield_unit', p_yield_unit, 'p_notes', p_notes));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'save_field_crop_history', v_actor, v_fingerprint);
  v_result := public._save_field_crop_history_replay_impl_20261015(p_field_id, p_season, p_crop_type, p_variety, p_planting_date, p_harvest_date, p_yield_per_acre, p_yield_unit, p_notes, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='save_field_crop_history'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'save_field_crop_history', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.save_field_crop_history(uuid, integer, text, text, date, date, numeric, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_field_crop_history(uuid, integer, text, text, date, date, numeric, text, text, uuid, text) TO authenticated, service_role;

-- 21. save_field_geometry
ALTER FUNCTION public.save_field_geometry(uuid, text, text, text) RENAME TO _save_field_geometry_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._save_field_geometry_replay_impl_20261015(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_field_geometry(p_field_id uuid, p_centroid_geojson text DEFAULT NULL::text, p_boundary_geojson text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: save_field_geometry requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_existing jsonb;
  BEGIN
  PERFORM require_admin_or_sales_rep();
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_field_id', p_field_id, 'p_centroid_geojson', p_centroid_geojson, 'p_boundary_geojson', p_boundary_geojson));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'save_field_geometry', v_actor, v_fingerprint);
  PERFORM public._save_field_geometry_replay_impl_20261015(p_field_id, p_centroid_geojson, p_boundary_geojson, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='save_field_geometry'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'save_field_geometry', v_fingerprint);
  END IF;
  RETURN;
END;
$function$;
REVOKE ALL ON FUNCTION public.save_field_geometry(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_field_geometry(uuid, text, text, text) TO authenticated, service_role;

-- 22. save_field_polygons
ALTER FUNCTION public.save_field_polygons(uuid, jsonb, uuid, text) RENAME TO _save_field_polygons_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._save_field_polygons_replay_impl_20261015(uuid, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_field_polygons(p_field_id uuid, p_polygons jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: save_field_polygons requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE v_existing jsonb; v_poly jsonb; v_total_acres numeric := 0; v_first_geojson jsonb;
  BEGIN
  PERFORM require_admin_or_sales_rep();
  END;
  -- Added (apply-review HIGH): the pinned body never reads p_performed_by; refuse a forged one.
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_field_id', p_field_id, 'p_polygons', p_polygons, 'p_performed_by', p_performed_by));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'save_field_polygons', v_actor, v_fingerprint);
  PERFORM public._save_field_polygons_replay_impl_20261015(p_field_id, p_polygons, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='save_field_polygons'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'save_field_polygons', v_fingerprint);
  END IF;
  RETURN;
END;
$function$;
REVOKE ALL ON FUNCTION public.save_field_polygons(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_field_polygons(uuid, jsonb, uuid, text) TO authenticated, service_role;

-- 23. set_application_record_lots
ALTER FUNCTION public.set_application_record_lots(uuid, jsonb, uuid, text) RENAME TO _set_application_record_lots_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._set_application_record_lots_replay_impl_20261015(uuid, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.set_application_record_lots(p_application_record_id uuid, p_lots jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: set_application_record_lots requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor          uuid := auth.uid();
    v_existing       jsonb;
    v_rec            record;
    v_lot            jsonb;
    v_product_id     uuid;
    v_lot_number     text;
    v_src            uuid;
    v_valid_products uuid[];
    v_seen           text[] := '{}';
    v_key            text;
    v_count          int := 0;
    v_result         jsonb;
  BEGIN
  -- strict-actor (bind auth.uid(); reject a spoofed p_performed_by)
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- in-body role gate (the real gate — the EXECUTE grant is not enough)
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to set application record lots';
  END IF;

  -- lock the parent record FIRST (race safety for the delete+reinsert) and validate it exists
  SELECT * INTO v_rec FROM application_records
   WHERE id = p_application_record_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'APPLICATION_RECORD_NOT_FOUND: %', p_application_record_id;
  END IF;

  -- idempotency check AFTER the lock, BEFORE any mutation: same-key concurrent retries
  -- serialize on the parent FOR UPDATE, so the loser sees the winner's committed key and
  -- replays the cached result instead of re-running the delete/reinsert (Codex P2 — a
  -- pre-lock check let both racers pass before either saved the key).
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_application_record_id', p_application_record_id, 'p_lots', p_lots));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'set_application_record_lots', v_actor, v_fingerprint);
  v_result := public._set_application_record_lots_replay_impl_20261015(p_application_record_id, p_lots, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='set_application_record_lots'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_application_record_lots', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_application_record_lots(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_application_record_lots(uuid, jsonb, uuid, text) TO authenticated, service_role;

-- 24. set_field_boundary
ALTER FUNCTION public.set_field_boundary(uuid, text, uuid, text) RENAME TO _set_field_boundary_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._set_field_boundary_replay_impl_20261015(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.set_field_boundary(p_field_id uuid, p_boundary_geojson text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: set_field_boundary requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor    uuid := auth.uid();
    v_existing jsonb;
    v_customer uuid;
    v_override numeric;
    v_geom     geometry;
    v_mpoly    geometry(MultiPolygon,4326);
    v_largest  geometry;
    v_measured numeric;
    v_billable numeric;
    v_result   jsonb;
  BEGIN
  -- 1) strict-actor + role gate (source-verifiable inline binding + the project role helper)
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();

  -- 2) lock the field row (serialize concurrent boundary writes), then claim idempotency in the lock
  SELECT customer_id, override_acres INTO v_customer, v_override
  FROM fields WHERE id = p_field_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FIELD_NOT_FOUND: %', p_field_id; END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_field_id', p_field_id, 'p_boundary_geojson', p_boundary_geojson));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'set_field_boundary', v_actor, v_fingerprint);
  v_result := public._set_field_boundary_replay_impl_20261015(p_field_id, p_boundary_geojson, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='set_field_boundary'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_field_boundary', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_field_boundary(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_field_boundary(uuid, text, uuid, text) TO authenticated, service_role;

-- 25. set_field_override_acres
ALTER FUNCTION public.set_field_override_acres(uuid, numeric, uuid, text) RENAME TO _set_field_override_acres_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._set_field_override_acres_replay_impl_20261015(uuid, numeric, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.set_field_override_acres(p_field_id uuid, p_override_acres numeric, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: set_field_override_acres requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The pinned body runs these statements before its own receipt lookup.
  DECLARE
    v_actor    uuid := auth.uid();
    v_existing jsonb;
    v_customer uuid;
    v_measured numeric;
    v_total    numeric;
    v_override numeric := round(p_override_acres, 2);   -- validate/store at the column's numeric(10,2) precision
    v_billable numeric;
    v_result   jsonb;
  BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();

  -- validate at STORED precision (numeric(10,2)): NULL clears; otherwise must round to >= 0.01
  -- (so 0.004 -> 0.00 is rejected, not silently stored as zero) and <= 5000 (1000x-typo guard).
  IF v_override IS NOT NULL AND (v_override <= 0 OR v_override > 5000) THEN
    RAISE EXCEPTION 'INVALID_OVERRIDE_ACRES: must round to > 0 and <= 5000 ac at 2dp (or NULL to clear)';
  END IF;

  SELECT customer_id, measured_acres, total_acres INTO v_customer, v_measured, v_total
  FROM fields WHERE id = p_field_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FIELD_NOT_FOUND: %', p_field_id; END IF;
  END;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object('actor_id', v_actor, 'p_field_id', p_field_id, 'p_override_acres', p_override_acres));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'set_field_override_acres', v_actor, v_fingerprint);
  v_result := public._set_field_override_acres_replay_impl_20261015(p_field_id, p_override_acres, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL AND EXISTS (
    SELECT 1 FROM public.idempotency_keys k
    WHERE k.idempotency_key=p_idempotency_key AND k.operation='set_field_override_acres'
      AND k.request_actor_id IS NULL AND k.request_fingerprint IS NULL
  ) THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_field_override_acres', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_field_override_acres(uuid, numeric, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_field_override_acres(uuid, numeric, uuid, text) TO authenticated, service_role;

DO $postflight$
DECLARE v_bad text; v_expected_def text;
BEGIN
  IF to_regclass('pg_temp.records_replay_binding_batch4d_tx') IS NULL THEN RAISE EXCEPTION 'RECORDS_REPLAY_BINDING_BATCH4D_NOT_IN_TRANSACTION'; END IF;
  IF (SELECT transaction_id FROM pg_temp.records_replay_binding_batch4d_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'RECORDS_REPLAY_BINDING_BATCH4D_NOT_IN_TRANSACTION';
  END IF;
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_bad
  FROM pg_temp.records_replay_binding_batch4d_pins pin
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
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'POSTFLIGHT_4D_CONTRACT: %',v_bad; END IF;
  IF (SELECT count(*) FROM pg_temp.records_replay_binding_batch4d_guard_ops) NOT IN (78,93)
    OR (SELECT count(*) FROM pg_temp.records_replay_binding_batch4d_guard_ops g
        JOIN pg_temp.records_replay_binding_batch4d_pins pin ON pin.name=g.operation)<>25 THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECEIPT_GUARD_CONTRACT';
  END IF;
  v_expected_def := 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
    || (SELECT string_agg(quote_literal(operation) || '::text', ', ' ORDER BY ord)
        FROM pg_temp.records_replay_binding_batch4d_guard_ops)
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
  RAISE NOTICE 'POSTFLIGHT_OK: batch 4d bound 25 replay operations';
END
$postflight$;
