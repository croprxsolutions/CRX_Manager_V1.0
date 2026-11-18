-- Rollback for 20270127100000_security_batch_ki121_ki123.sql. Restores exactly what live had on 2026-11-18
-- (read-only inventory of anon grants in public), not a blanket re-grant, and the old last-admin guard.
-- Run as postgres in one transaction. Objects created after the migration stay closed to anon.
-- Objects added after 2026-11-18 are not re-granted, and listed ones that no longer exist are skipped: this fails toward less access.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- KI-121: the original guard (body of 20260727174805) and its deactivation-only trigger.
CREATE OR REPLACE FUNCTION public._guard_last_active_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.is_active = true
     AND NEW.is_active = false
     AND OLD.role = 'admin'
     AND NOT EXISTS (
       SELECT 1
         FROM public.profiles p
        WHERE p.role = 'admin'
          AND p.is_active = true
          AND p.id <> NEW.id
     )
  THEN
    RAISE EXCEPTION 'LAST_ACTIVE_ADMIN: cannot deactivate the only active admin'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
COMMENT ON FUNCTION public._guard_last_active_admin() IS
  'Refuses to deactivate the last active admin, which would lock the account out of its own app now that deactivation bans the auth user.';
DROP TRIGGER IF EXISTS trg_guard_last_active_admin ON public.profiles;
CREATE TRIGGER trg_guard_last_active_admin
  BEFORE UPDATE OF is_active ON public.profiles
  FOR EACH ROW
  WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active)
  EXECUTE FUNCTION public._guard_last_active_admin();
DO $md5$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._guard_last_active_admin()'::regprocedure) <> '411de704268c49ac63b2755486b61ad5' THEN
    RAISE EXCEPTION 'SECURITY_BATCH_REVERSE: restored guard body is not the original';
  END IF;
END $md5$;

-- KI-123: anon's default rights on new postgres-created tables and sequences.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, UPDATE, USAGE ON SEQUENCES TO anon;

-- KI-123: the exact live inventory (95 tables/views with table SELECT, 13 with column-only SELECT, 9 sequences),
-- generated from live by has_table_privilege / has_column_privilege / has_sequence_privilege on 2026-11-18.
-- Plus orders.sales_tax, which 20270109100200 (not yet live on 2026-11-18) grants anon and this migration revokes.

-- Each object is re-granted only if it still exists: a table or column a later migration dropped (or one this
-- database never had) is skipped with a NOTICE rather than aborting the whole rollback.
DO $restore_anon$
DECLARE
  v_rel text;
  v_cols jsonb;
  v_present text;
BEGIN
  FOR v_rel IN SELECT jsonb_array_elements_text('["public.activity_feed", "public.allocation_sets", "public.app_settings", "public.application_record_fields", "public.application_record_lots", "public.application_records", "public.applicator_licenses", "public.ar_reminder_tracking", "public.blend_recipe_items", "public.blend_recipes", "public.blend_ticket_fields", "public.blend_ticket_images", "public.blend_ticket_to_order_items", "public.blend_tickets", "public.commission_payment_items", "public.commission_payments", "public.customer_addresses", "public.customers", "public.cycle_count_items", "public.cycle_counts", "public.deliveries", "public.delivery_items", "public.delivery_photos", "public.delivery_remainders", "public.email_log", "public.failed_notifications", "public.field_app_location_shares", "public.field_app_locations", "public.field_billing_defaults", "public.field_crop_history", "public.field_polygons", "public.fields", "public.finance_charges", "public.financial_audit_log", "public.ground_crew_members", "public.ground_crews", "public.idempotency_keys", "public.ingredient_map", "public.inventory", "public.inventory_holds", "public.inventory_transactions", "public.invoice_line_allocations", "public.invoice_shares", "public.job_applied_info", "public.job_applied_record_crew", "public.job_applied_record_fields", "public.job_applied_records", "public.job_attachments", "public.job_batches", "public.job_field_shares", "public.job_fields", "public.job_location_dispatches", "public.job_notifications", "public.job_product_draws", "public.job_tag_assignments", "public.job_tags", "public.note_activity_log", "public.note_tags", "public.notifications", "public.ocr_processing_queue", "public.order_item_field_allocations", "public.order_line_allocations", "public.order_shares", "public.payments", "public.prepay_applications", "public.prepay_credits", "public.product_label_drafts", "public.profiles", "public.quote_pdf_templates", "public.quote_product_draws", "public.quote_sections", "public.quote_templates", "public.rate_limit_log", "public.rate_limits", "public.rebate_claim_counters", "public.rebate_claims", "public.receiving_photos", "public.receiving_records", "public.return_items", "public.returns", "public.team_note_attachments", "public.team_note_comments", "public.team_note_tags", "public.team_notes", "public.unit_conversions", "public.user_list_settings", "public.vehicles", "public.vendor_bills", "public.vendor_payments", "public.vendors", "public.view_unmigrated_products", "public.warehouses", "public.watchdog_flag_dismissals", "public.watchdog_flags", "public.write_offs"]'::jsonb) LOOP
    IF to_regclass(v_rel) IS NULL THEN RAISE NOTICE 'anon restore: % no longer exists, skipped', v_rel; CONTINUE; END IF;
    EXECUTE format('GRANT SELECT ON %s TO anon', to_regclass(v_rel));
  END LOOP;

  FOR v_rel, v_cols IN SELECT key, value FROM jsonb_each('{"public.application_services": ["id", "name", "vehicle_id", "default_rate_per_acre_cents", "is_active", "sort_order", "created_by", "created_at", "updated_at"], "public.blend_ticket_products": ["id", "blend_ticket_id", "product_id", "product_name", "quantity", "unit", "lot_number", "sequence_order", "confidence_score", "manually_corrected", "created_at", "rate_per_acre", "rate_per_acre_unit", "unit_price_cents"], "public.commissions": ["id", "order_id", "customer_id", "recipient", "split_percentage", "commission_amount", "order_date", "status", "created_at", "paid_date", "paid_note", "recipient_user_id", "season", "deleted_at", "order_number", "customer_name", "job_id", "invoice_id", "cancelled_at", "cancelled_amount_cents", "replaces_commission_id"], "public.invoice_items": ["id", "invoice_id", "order_item_id", "product_id", "description", "quantity", "unit_price_cents", "extended_cents", "sort_order", "rate_per_acre", "acres", "unit_size", "notes", "created_at", "updated_at", "rate_unit", "total_applied", "total_applied_unit", "total_applied_gl_lb", "gl_lb_unit", "epa_registration", "product_form", "is_application_fee", "tote_number", "quoted_price_cents", "price_source", "warehouse", "vendor", "billing_line_id", "return_credit_source_item_id", "charge_type", "price_tier_at_sale", "brand_lines"], "public.invoices": ["id", "invoice_number", "order_id", "blend_ticket_id", "customer_id", "invoice_type", "status", "season", "salesman_id", "created_by", "total_amount_cents", "paid_amount_cents", "prepay_applied_cents", "posted_by", "posted_at", "voided_by", "voided_at", "void_reason", "invoice_date", "due_date", "purchase_order_ref", "header_notes", "footer_notes", "parent_invoice_id", "deleted_at", "created_at", "updated_at", "crop_type", "field_names", "total_acres", "applicator_name", "vehicle_name", "application_date", "job_id", "is_quick_delivery", "write_off_cents", "invoice_group_id", "application_service_id", "delivery_id", "wind_direction", "temperature_text", "pricing_pending", "payment_terms", "internal_notes", "discount_earned_cents", "discount_date", "start_temp_f", "start_wind_mph", "start_wind_direction", "start_humidity_pct", "start_weather_time", "start_weather_source", "end_temp_f", "end_wind_mph", "end_wind_direction", "end_humidity_pct", "end_weather_time", "end_weather_source", "weather_manual_override", "diluent_rate_gpa", "credit_applied_cents", "balance_cents", "send_disposition", "field_app_billing_set_id", "due_date_is_custom"], "public.job_chemicals": ["id", "job_id", "product_id", "quantity", "unit", "rate_per_acre", "rate_unit", "price_per_unit_cents", "sort_order", "diluent_rate", "rei_hours", "phi_days", "warehouse", "vendor", "customer_supplied", "driver"], "public.jobs": ["id", "job_number", "customer_id", "status", "job_date", "scheduled_time", "applicator_id", "vehicle_id", "recipe_id", "notes", "tags", "batch_id", "season", "total_acres", "total_price_cents", "invoice_id", "created_by", "deleted_at", "created_at", "updated_at", "priority", "estimated_hours", "quote_id", "quote_section_id", "application_service_id", "call_date", "date_proposed", "time_proposed", "schedule_date", "date_expires", "consultant_id", "loader_comment", "additional_info", "internal_memo", "applied_acres", "updated_by", "printed_at", "remaining_acres", "ground_crew_id", "batch_ref", "last_printed_by", "carrier_rate_gpa", "loader_tank_capacity", "commission_split", "completed_at"], "public.order_items": ["id", "order_id", "product_id", "quote_item_id", "section_name", "product_name", "price_per_unit", "actual_rate", "rate_unit", "acres", "total_units_needed", "unit_size", "total_price", "quantity_delivered", "quantity_remaining", "sort_order", "notes", "pricing_pending", "suggested_price", "price_tier_at_sale", "vendor"], "public.orders": ["id", "order_number", "quote_id", "customer_id", "status", "commission_split", "total_price", "order_date", "notes", "created_at", "updated_at", "season", "salesman_id", "deleted_at", "order_name", "customer_po_number", "is_planned", "program_notes", "booking_draw", "pricing_status", "pricing_reminder_sent_at", "pricing_escalation_sent_at", "needs_split_billing", "row_version", "sales_tax"], "public.products": ["id", "product_name", "sku", "category", "vendor", "manufacturer", "container_size", "unit_size", "tier1_price", "tier2_price", "tier3_price", "tier1_price_per_acre", "tier2_price_per_acre", "tier3_price_per_acre", "suggested_rate", "rate_per_acre", "rate_unit", "notes", "is_active", "created_at", "updated_at", "epa_registration", "product_form", "inventory_unit", "container_unit", "container_type", "is_rup", "signal_word", "internal_notes", "rei_hours", "phi_days", "max_label_rate", "max_label_rate_unit", "use_timing", "pricing_version", "quoting_notes", "product_family_id", "return_policy", "packaging_variant", "is_full_tote_only", "use_timings"], "public.purchase_order_items": ["id", "purchase_order_id", "product_id", "quantity_ordered", "quantity_received", "unit_size", "notes", "product_name", "product_supplier_link_id", "supplier_price_observation_id", "inventory_units_per_supplier_unit_snapshot", "cost_provenance", "cost_snapshot_at", "inventory_unit_snapshot", "cost_needs_review"], "public.purchase_orders": ["id", "po_number", "vendor", "status", "submitted_date", "expected_delivery_date", "notes", "created_by", "created_at", "updated_at", "cancelled_at", "cancelled_by", "cancel_reason", "closed_at", "closed_by", "close_reason"], "public.quotes": ["id", "quote_number", "customer_id", "created_by", "tier", "status", "commission_split", "total_price", "valid_days", "expires_at", "header_notes", "footer_notes", "created_at", "updated_at", "sent_at", "is_planned", "season", "salesman_id", "deleted_at", "pdf_template_id", "pdf_columns_override", "row_version", "chosen_expiry_date"]}'::jsonb) LOOP
    IF to_regclass(v_rel) IS NULL THEN RAISE NOTICE 'anon restore: % no longer exists, skipped', v_rel; CONTINUE; END IF;
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_present
      FROM pg_attribute a
     WHERE a.attrelid = to_regclass(v_rel) AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname IN (SELECT jsonb_array_elements_text(v_cols));
    IF v_present IS NULL THEN RAISE NOTICE 'anon restore: no listed column of % exists, skipped', v_rel; CONTINUE; END IF;
    EXECUTE format('GRANT SELECT (%s) ON %s TO anon', v_present, to_regclass(v_rel));
  END LOOP;

  FOR v_rel IN SELECT jsonb_array_elements_text('["public.backup_runs_id_seq", "public.backup_snapshots_id_seq", "public.cm_invoice_number_seq", "public.cs_invoice_number_seq", "public.customer_account_number_seq", "public.invoice_number_seq", "public.mc_invoice_number_seq", "public.product_change_history_id_seq", "public.quote_price_changes_id_seq"]'::jsonb) LOOP
    IF to_regclass(v_rel) IS NULL THEN RAISE NOTICE 'anon restore: % no longer exists, skipped', v_rel; CONTINUE; END IF;
    EXECUTE format('GRANT SELECT, UPDATE, USAGE ON SEQUENCE %s TO anon', to_regclass(v_rel));
  END LOOP;
END
$restore_anon$;

COMMIT;
