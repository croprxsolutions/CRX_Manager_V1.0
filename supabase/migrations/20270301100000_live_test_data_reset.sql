-- One-time live test-data reset (Mason, 2026-11-23): data only, one-shot (registered in
-- supabase/baselines/one-shot-migrations.json). Runs ONLY on Mason's live database; everywhere else it is a no-op.
--
-- WHY: live holds only old test data. Before the Dec 15 trial Mason asked (Slack, 2026-11-23, written answers) for:
--   1. stock to 0; 2. the field side cleared (jobs, field applications, blend tickets, record book);
--   3. purchasing cleared (POs, receiving, vendor bills, vendor payments); 4. all money cleared (invoices, payments,
--   prepay, credit memos, returns, commissions), every customer at $0; 5. document numbering restarted at 0001.
-- KEPT: products and every product / pricing / cost / EPA / ingredient table, vendors (+ aliases), customers (+ contacts,
-- addresses, fields, polygons, splits, settings), profiles, app_settings, warehouses, vehicles, application_services,
-- unit_conversions, quote_pdf_templates, quote_templates, blend_recipes, field_billing_defaults, job_tags, the switch and
-- config rows, and every public table not named below. Inventory ROWS are kept with every quantity at 0.
--
-- LIVE-ONLY GUARD: c_live below is NULL in the reviewed file, so it does nothing anywhere (NOTICE
-- LIVE_RESET_SKIPPED_NOT_LIVE, no error: the staging Database job applies every merged migration). The main session
-- fills c_live with the single JSON value returned by the read-only PIN QUERY below, run on live right before the
-- apply. Even then it runs only where pg_control_system().system_identifier and the pinned admin profile, customer
-- and product ids all match; anywhere else it is again a no-op notice. A pin older than 6 hours refuses
-- (LIVE_RESET_PIN_EXPIRED), so a later replay onto a clone or restore of live cannot run it either. Never apply the
-- unfilled file to live (it would be recorded as applied with nothing done); fill and restamp first.
--
-- PIN QUERY (read-only; run on live; paste its one value, as a quoted jsonb literal, into c_live):
-- PIN QUERY BEGIN
-- SET TIME ZONE 'UTC';
-- SELECT jsonb_build_object(
--   'system_identifier', (SELECT system_identifier FROM pg_control_system()),
--   'admin_profile_id', (SELECT id FROM public.profiles WHERE role = 'admin' ORDER BY created_at, id LIMIT 1),
--   'customer_id', (SELECT id FROM public.customers ORDER BY created_at, id LIMIT 1),
--   'product_id', (SELECT id FROM public.products ORDER BY created_at, id LIMIT 1),
--   'pinned_at', now(),
--   'counts', (SELECT jsonb_object_agg(c.relname, (xpath('/row/n/text()', query_to_xml(
--                 format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text::bigint)
--                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--               WHERE n.nspname = 'public' AND c.relkind = 'r'),
--   'digests', (SELECT jsonb_object_agg(c.relname, (xpath('/row/h/text()', query_to_xml(format(
--                 'SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text), '''' ORDER BY md5(to_jsonb(x)::text)), '''')) AS h FROM public.%I x',
--                 c.relname), false, true, '')))[1]::text)
--                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--               WHERE n.nspname = 'public' AND c.relkind = 'r'),
--   'delete_triggers', (SELECT coalesce(jsonb_object_agg(s.relname, s.g), '{}') FROM (
--                 SELECT c.relname, jsonb_agg(t.tgname ORDER BY t.tgname) AS g
--                   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
--                  WHERE n.nspname = 'public' AND NOT t.tgisinternal AND (t.tgtype & 8) <> 0 GROUP BY c.relname) s)
-- )::text AS live_reset_pins;
-- PIN QUERY END
--
-- PREFLIGHT (on live; refuses with an exception and changes nothing): not a read committed transaction with
-- session_replication_role = origin (LIVE_RESET_SESSION); the backup schema already exists
-- (LIVE_RESET_ALREADY_APPLIED); c_live is malformed (LIVE_RESET_PINS_MISSING); the public table set differs from the
-- pinned one or from the set this file classified (c_table_set_md5), or a foreign key outside public points at a table
-- it deletes from (LIVE_RESET_SCHEMA_DRIFT); any public table's row count or content differs from its pin
-- (LIVE_RESET_COUNT_DRIFT / LIVE_RESET_CONTENT_DRIFT: someone used the app after the read, re-pin); a kept cost basis row points at a
-- PO line (LIVE_RESET_COST_BASIS_FROM_PO: product_cost_basis keeps its history, so that needs a decision); the DELETE
-- triggers on a table it deletes from are not exactly the pinned names (LIVE_RESET_TRIGGER_DRIFT: a guard added after
-- the pin is never switched off unreviewed); a trigger
-- that must be switched off is not in its normal on state (LIVE_RESET_GUARD_STATE). Every public table is locked
-- IN EXCLUSIVE MODE (reads go on, writes wait) before the counts, with a 10-second lock_timeout.
--
-- BACKUP FIRST: every row this deletes is copied into a new schema reset_backup_20261123 (CREATE TABLE AS, one table per
-- source table), plus full pre-images of public.inventory and public.customers, the six number sequences
-- (_sequences), the triggers switched off (_triggers_off) and a manifest (_manifest). Only its owner can read it
-- (every other grant on the schema and its tables is revoked).
--
-- GUARDS: on each table it deletes from, every user trigger that fires on DELETE is switched off with
-- ALTER TABLE ... DISABLE TRIGGER <name> (each must be on, 'O', first), only around the deletes, then switched back on.
-- They are the delete guards (posted / immutable / append-only / lifecycle) and delete side effects that would write
-- stock, audit or brand rows about the rows being removed (the backup is the record instead). Foreign keys stay
-- enforced throughout. The postflight proves every public trigger is back in exactly its earlier state.
--
-- DELETE ORDER: children before parents (c_core below; jobs, invoices, blend_tickets and field_app_billing_sets
-- reference each other, so they go in one statement). Then the sections (each one flips with its constant):
--   c_clear_logs     (default on)  activity_feed, notifications and financial_audit_log rows about cleared records (their
--                                  entity type is in c_cleared_types or their entity id is a cleared row's id), and all of
--                                  email_log, integrity_alerts, failed_notifications, watchdog_flags (+ dismissals).
--   c_clear_receipts (default OFF, Taha 2026-11-24) idempotency_keys, offline_action_receipts, retired_uncertain_requests
--                                  (all). Kept so a request whose response was lost before the reset cannot run again
--                                  after it as a new one; a kept receipt only replays its old answer.
--   c_clear_team_notes_on_cleared (default OFF) team notes linked to a cleared record, with their comments,
--                                  attachments, tags and note_activity_log. Off: every note stays (its link dangles).
--   c_clear_backup_snapshots (ON, Mason 2026-11-24) every backup_snapshots row (the app's weekly copies, which hold the
--                                  test rows) and every backup_runs row; both are backed up first like everything else.
-- Then: inventory quantity_available / quantity_prebooked / quantity_on_order to 0 and last_counted_at to NULL (rows
-- kept); customers.prepay_balance_cents to 0; the six number sequences restarted so the next number is 0001.
-- NUMBERING: ORD (order_number_seq), Q (quote_number_seq), INV / CS / MC / CM (invoice_number_seq, cs_, mc_,
-- cm_invoice_number_seq) restart with ALTER SEQUENCE ... RESTART WITH 1, which a rollback undoes. RC (rebate_claim_counters) restarts because the counter
-- table is emptied. DEL, JOB, PO, RMA, CC, CP, BT and APP numbers are max+1 over their own (now empty) tables. The
-- customer account number sequence is kept (customers are kept).
--
-- POSTFLIGHT (else the whole transaction rolls back): every cleared table has 0 rows; each section table lost exactly
-- its backed-up rows; every kept table has its pinned count and the same content (md5 over every row; customers
-- without prepay_balance_cents/row_version/updated_at, inventory without its quantity columns, last_counted_at and
-- updated_at); every public trigger is in its earlier state; no customer has a prepay balance; every inventory
-- quantity is 0; the six sequences give 0001 next; each backup table holds exactly the rows deleted; the backup
-- schema has no grant to anon, authenticated or service_role.
--
-- NOT TOUCHED: storage files (delivery photos, receiving photos, blend ticket images, job attachments, note
-- attachments) stay in their buckets; their paths are in the backup tables. Internal id sequences are not restarted.
--
-- ROLLBACK: reversible from reset_backup_20261123 (a new reviewed migration: INSERT each table back from its backup in
-- reverse delete order, generated columns left out, with the same triggers off; inventory and customers columns
-- restored from their pre-images; each sequence put back with ALTER SEQUENCE ... RESTART WITH <n> from _sequences,
-- never setval, which a rollback does not undo). Drop the schema only once Mason confirms.

DO $live_reset$
DECLARE
  -- LIVE_FINGERPRINT_TODO: the PIN QUERY's one value from live, as a quoted jsonb literal. NULL = not live: no-op.
  c_live constant jsonb := '{"counts": {"jobs": 4, "fields": 5, "orders": 69, "quotes": 7, "returns": 1, "vendors": 15, "invoices": 19, "job_tags": 5, "payments": 0, "products": 606, "profiles": 13, "vehicles": 3, "customers": 154, "email_log": 59, "inventory": 117, "note_tags": 0, "deliveries": 110, "job_fields": 5, "team_notes": 55, "tote_fills": 0, "warehouses": 1, "write_offs": 0, "backup_runs": 9, "commissions": 37, "epa_lookups": 276, "job_batches": 0, "order_items": 297, "quote_items": 28, "rate_limits": 1, "app_settings": 22, "cost_history": 638, "cycle_counts": 17, "ground_crews": 0, "order_shares": 0, "return_items": 1, "vendor_bills": 6, "activity_feed": 1894, "blend_recipes": 0, "blend_tickets": 0, "invoice_items": 30, "job_chemicals": 4, "notifications": 7015, "product_rates": 705, "rebate_claims": 0, "customer_facts": 0, "delivery_items": 406, "field_polygons": 4, "ingredient_map": 0, "invoice_shares": 3, "prepay_credits": 1, "product_brands": 162, "quote_sections": 8, "quote_versions": 6, "rate_limit_log": 0, "team_note_tags": 0, "vendor_aliases": 4, "watchdog_flags": 0, "allocation_sets": 1, "delivery_photos": 12, "field_obstacles": 0, "finance_charges": 0, "inventory_holds": 29, "job_attachments": 0, "job_epa_sprayed": 1, "job_product_epa": 1, "product_parents": 458, "purchase_orders": 34, "quote_templates": 0, "rebate_programs": 0, "vendor_payments": 2, "backup_snapshots": 1626, "idempotency_keys": 1941, "integrity_alerts": 2, "job_applied_info": 2, "job_field_shares": 5, "product_families": 0, "receiving_photos": 0, "unit_conversions": 14, "billing_m4_switch": 1, "customer_contacts": 135, "cycle_count_items": 1395, "epa_registrations": 347, "job_notifications": 0, "job_product_draws": 0, "note_activity_log": 158, "order_item_shares": 0, "product_rate_lock": 1, "receiving_records": 130, "rup_sales_records": 0, "accounting_periods": 9, "active_ingredients": 135, "blend_recipe_items": 0, "customer_addresses": 5, "customer_documents": 2, "field_crop_history": 0, "product_categories": 12, "product_cost_basis": 606, "product_form_units": 4, "product_rate_units": 9, "team_note_comments": 21, "user_list_settings": 0, "application_records": 1, "applicator_licenses": 0, "blend_ticket_fields": 0, "blend_ticket_images": 0, "commission_payments": 8, "delivery_remainders": 0, "epa_lookup_failures": 1, "external_identities": 0, "field_app_locations": 2, "financial_audit_log": 250, "ground_crew_members": 0, "invoice_line_shares": 0, "job_applied_records": 0, "job_tag_assignments": 1, "label_draft_targets": 295, "prepay_applications": 0, "pricing_change_sets": 7, "product_rate_events": 3, "quote_pdf_templates": 3, "quote_price_changes": 0, "quote_product_draws": 7, "application_services": 4, "ar_reminder_tracking": 0, "below_cost_approvals": 0, "delivery_item_brands": 0, "failed_notifications": 3, "ocr_processing_queue": 0, "product_crop_options": 8, "product_label_drafts": 295, "purchase_order_items": 194, "blend_ticket_products": 0, "credit_memo_sales_tax": 0, "customer_interactions": 0, "delivery_brand_events": 0, "job_loader_worksheets": 1, "product_margin_floors": 0, "product_parent_brands": 221, "product_parent_events": 548, "product_weight_events": 268, "rebate_claim_counters": 0, "team_note_attachments": 0, "delivery_receipt_queue": 1, "field_app_billing_sets": 0, "field_billing_defaults": 6, "inventory_transactions": 763, "order_line_allocations": 0, "product_change_history": 1321, "product_parent_members": 596, "product_supplier_links": 598, "supplier_price_imports": 2, "application_record_lots": 0, "epa_chemistry_proposals": 275, "epa_registration_events": 390, "field_app_billing_lines": 0, "interaction_transcripts": 0, "invoice_sales_tax_rates": 0, "job_applied_record_crew": 0, "job_location_dispatches": 3, "offline_action_receipts": 0, "pricing_change_set_rows": 5, "active_ingredient_events": 135, "commission_payment_items": 0, "credit_memo_applications": 0, "invoice_line_allocations": 1, "legacy_vendor_resolution": 5, "pricing_workbook_exports": 3, "product_chemistry_events": 235, "product_parent_proposals": 11, "profile_public_directory": 13, "split_invoice_provenance": 0, "watchdog_flag_dismissals": 0, "application_record_fields": 1, "blend_ticket_weight_basis": 0, "epa_registration_seed_run": 1, "field_app_location_shares": 2, "invoice_line_rup_captures": 28, "job_applied_record_fields": 0, "job_dispatch_preservation": 0, "product_rate_draft_events": 2119, "chemistry_change_proposals": 0, "commission_history_cutover": 1, "customer_application_rates": 0, "customer_document_restores": 0, "delivery_external_billings": 53, "product_cost_basis_rollout": 10, "product_parent_copy_passes": 0, "product_parent_ingredients": 425, "product_use_timing_options": 10, "retired_uncertain_requests": 0, "supplier_price_import_rows": 20, "blend_ticket_to_order_items": 0, "integrity_negative_baseline": 17, "pricing_change_set_warnings": 1, "product_parent_brand_events": 286, "product_rate_cutover_passes": 0, "supplier_price_observations": 10, "vendor_alias_stage_receipts": 0, "blend_ticket_product_weights": 0, "commission_settlement_events": 0, "invoice_line_share_snapshots": 0, "job_loader_worksheet_weights": 0, "order_item_field_allocations": 0, "pricing_change_set_approvals": 0, "pricing_workbook_export_rows": 1787, "product_info_change_set_rows": 0, "product_margin_floor_changes": 0, "product_parent_brand_sources": 162, "product_parent_density_state": 268, "product_parent_rate_outcomes": 413, "product_parent_cost_reference": 1, "product_parent_density_values": 268, "product_size_net_weight_state": 596, "purchase_order_import_intents": 0, "return_credit_customer_claims": 0, "split_invoice_creation_claims": 0, "split_invoice_mutation_claims": 0, "commission_earned_state_ledger": 72, "product_cost_basis_change_rows": 4, "product_parent_chemistry_state": 235, "product_parent_modes_of_action": 0, "product_parent_proposal_groups": 2151, "product_rate_correction_passes": 0, "product_size_net_weight_values": 0, "invoice_line_brand_rup_captures": 0, "invoice_standing_discount_rates": 15, "pricing_change_set_preview_rows": 7, "purchase_order_item_cost_changes": 2, "active_ingredient_modes_of_action": 0, "uncertain_request_clear_check_key": 1, "product_parent_fertilizer_analysis": 0, "invoice_delivery_recovery_capabilities": 0}, "digests": {"jobs": "5a0d59b7d609f86d15c2954a375515b2", "fields": "4cc156c614516f80b08c7cc34bee2c67", "orders": "8a2feb7b0d68bce40d1cadf4af11178f", "quotes": "95b21e3e7fb6a19942c18c3514e8817d", "returns": "22034396c13519bad13ec49168167935", "vendors": "3a3e961b8be238a28819803344a0c637", "invoices": "cdb796727ad8810321e1996c80fd43e8", "job_tags": "7268fd58cec143c38f352dcf82bc9d2f", "payments": "d41d8cd98f00b204e9800998ecf8427e", "products": "06f655726b9ccb0f3d297b1a6add7b88", "profiles": "2474f9bd3cc122582fb016f2b17951f2", "vehicles": "20158cbbfbceb61a30c4cab56b9405ca", "customers": "0dac8de484420b5238e89382482a5b30", "email_log": "e16f32cc85fae8d2b13b2572c77cf147", "inventory": "caa2fb9342dc00174c04be3dbaaa1010", "note_tags": "d41d8cd98f00b204e9800998ecf8427e", "deliveries": "5ad08e12216433eda054f32b6236317a", "job_fields": "2c8ea2e67a454843f052e2f4c06aa153", "team_notes": "a14030b48b00cb4914d76a458821343b", "tote_fills": "d41d8cd98f00b204e9800998ecf8427e", "warehouses": "583ea33f1e65a31fa9aa3aeb7d65fdc2", "write_offs": "d41d8cd98f00b204e9800998ecf8427e", "backup_runs": "69d2bc1ac26f6facb2174f161f64a5c7", "commissions": "83dbce6eabf35670a0af394e77061bfb", "epa_lookups": "d62b3efedac5d36871d07d6bb15e8f23", "job_batches": "d41d8cd98f00b204e9800998ecf8427e", "order_items": "fabf822cd4a4eab2426a9586259f60c1", "quote_items": "0ba1763f6b77fdda80edd18d79087724", "rate_limits": "661ad30f3ee432ebfc1ecdb6be193662", "app_settings": "b3ececf992f15492f6a86ea48e1087c7", "cost_history": "d5b21f4c510ec52b4e2eb536ce171180", "cycle_counts": "e1ef88551e6f9c5da5820820c8c72f33", "ground_crews": "d41d8cd98f00b204e9800998ecf8427e", "order_shares": "d41d8cd98f00b204e9800998ecf8427e", "return_items": "a73c4c5d535c0e953beeb772428bac0f", "vendor_bills": "70ece14074114787efcfc7dcd9c260c3", "activity_feed": "0976cbeb30d474e3b00e86b32512618d", "blend_recipes": "d41d8cd98f00b204e9800998ecf8427e", "blend_tickets": "d41d8cd98f00b204e9800998ecf8427e", "invoice_items": "ff116f21d1e6bcfdf26a512ff7082570", "job_chemicals": "a99bab509dc0d3ba59f3436dd0fd2cfe", "notifications": "ea58729027f3c69a5481ec78dbaf1174", "product_rates": "52e8a6221c3e04e61c977bf68c685d32", "rebate_claims": "d41d8cd98f00b204e9800998ecf8427e", "customer_facts": "d41d8cd98f00b204e9800998ecf8427e", "delivery_items": "b0e615c828e5f32386c9a24b5a926b9b", "field_polygons": "9ebeb167d8275c24393f4f0f4dc768da", "ingredient_map": "d41d8cd98f00b204e9800998ecf8427e", "invoice_shares": "f541eebb064d5bcdbd3395901ae50a4e", "prepay_credits": "f57861b1e4fb5a71eef4edee6a1cc21a", "product_brands": "c188d737dff1220ee151024f992a31d2", "quote_sections": "714496dbad7d02df5ede2ff9019cae77", "quote_versions": "ed05a644263e145bc26dee0cf0695bd0", "rate_limit_log": "d41d8cd98f00b204e9800998ecf8427e", "team_note_tags": "d41d8cd98f00b204e9800998ecf8427e", "vendor_aliases": "0cf4742bb5ad1888c9f8439429875deb", "watchdog_flags": "d41d8cd98f00b204e9800998ecf8427e", "allocation_sets": "e861c6f1e33a7e292183d9488502a680", "delivery_photos": "0faeee15a1ddde82651edf0b7d83ceef", "field_obstacles": "d41d8cd98f00b204e9800998ecf8427e", "finance_charges": "d41d8cd98f00b204e9800998ecf8427e", "inventory_holds": "7233986d6d13546b7076957a64734af5", "job_attachments": "d41d8cd98f00b204e9800998ecf8427e", "job_epa_sprayed": "539c67c72e0f6c18ff294e83d077e0ec", "job_product_epa": "378f93692a794568b71891d70f03a434", "product_parents": "a5c37889f729f115b156b683440b5f7c", "purchase_orders": "c39a31349576a012ef669129fb41d582", "quote_templates": "d41d8cd98f00b204e9800998ecf8427e", "rebate_programs": "d41d8cd98f00b204e9800998ecf8427e", "vendor_payments": "7e7898aba2e3611b837bee31d9795b44", "backup_snapshots": "e50a04f2d9d60fdbff01a730da1eba91", "idempotency_keys": "4b32ef5a6b95aeb7fd907d5feb24b6a5", "integrity_alerts": "637396dc0368256f7b3c174237d8a40f", "job_applied_info": "766d707d4c28dab067ad49ea0c01a781", "job_field_shares": "30ce19b956ec99cc68a7281b94174e6e", "product_families": "d41d8cd98f00b204e9800998ecf8427e", "receiving_photos": "d41d8cd98f00b204e9800998ecf8427e", "unit_conversions": "931d897b28ede9345d1a0680ccf75ba5", "billing_m4_switch": "2f19dca76381f1d44b751a91609f1a59", "customer_contacts": "48cc4a1ed9437d791816a9574a831fd7", "cycle_count_items": "a169a7fe400bba28b4f5f9ae4cb094ad", "epa_registrations": "a351010e7a777e6184f4f5a18fa29e39", "job_notifications": "d41d8cd98f00b204e9800998ecf8427e", "job_product_draws": "d41d8cd98f00b204e9800998ecf8427e", "note_activity_log": "35a57d44da60ca21e1aa2454e04769e1", "order_item_shares": "d41d8cd98f00b204e9800998ecf8427e", "product_rate_lock": "8adc4fb41d23a28a101c37cebfc9bcaf", "receiving_records": "347ed79378cafd233e616ffa12daa7ec", "rup_sales_records": "d41d8cd98f00b204e9800998ecf8427e", "accounting_periods": "2215511fdb4b760bf481c876545ff686", "active_ingredients": "0713eb16842b3d643bfd77c379a53389", "blend_recipe_items": "d41d8cd98f00b204e9800998ecf8427e", "customer_addresses": "082d2c7c36d87f781100aa33378426fc", "customer_documents": "868a98b0b59d67b974ce5fddbec61d5b", "field_crop_history": "d41d8cd98f00b204e9800998ecf8427e", "product_categories": "ed9bd5dfc334aee7bf450166af6b5dcf", "product_cost_basis": "f54505efd71b901a62fc3c75c4617653", "product_form_units": "8ea9f8bda29c0805e796cd34b456febd", "product_rate_units": "0c4a82b205975898a089170e1e052f9e", "team_note_comments": "869743ab1bb2de52ee6da0046ae3d12a", "user_list_settings": "d41d8cd98f00b204e9800998ecf8427e", "application_records": "844e1f42bf9d31db334931560676d01d", "applicator_licenses": "d41d8cd98f00b204e9800998ecf8427e", "blend_ticket_fields": "d41d8cd98f00b204e9800998ecf8427e", "blend_ticket_images": "d41d8cd98f00b204e9800998ecf8427e", "commission_payments": "0fa05720979b25462ac1bedb4e4cd7df", "delivery_remainders": "d41d8cd98f00b204e9800998ecf8427e", "epa_lookup_failures": "ff0d3fbcd8ac02bb06c643dffa71e17c", "external_identities": "d41d8cd98f00b204e9800998ecf8427e", "field_app_locations": "4fdb2a36eba0832e3c3a057ca8a6e35c", "financial_audit_log": "b4591a59803e006488bb203a22c94473", "ground_crew_members": "d41d8cd98f00b204e9800998ecf8427e", "invoice_line_shares": "d41d8cd98f00b204e9800998ecf8427e", "job_applied_records": "d41d8cd98f00b204e9800998ecf8427e", "job_tag_assignments": "9994ecc1961d44edbceeca394617ac68", "label_draft_targets": "112c8e6a7ae602a231ea376f81bb0f25", "prepay_applications": "d41d8cd98f00b204e9800998ecf8427e", "pricing_change_sets": "f75ae0cc2f33e34d708579141cbcdfdb", "product_rate_events": "88bd9e92806d88f82681aa59fc16e49b", "quote_pdf_templates": "f374152633f272c7b886ecf914a35fb5", "quote_price_changes": "d41d8cd98f00b204e9800998ecf8427e", "quote_product_draws": "a697962ee0d5345e4c986bba380b2ae5", "application_services": "5660c516f6a84ec8c1efdfc1d7405eb4", "ar_reminder_tracking": "d41d8cd98f00b204e9800998ecf8427e", "below_cost_approvals": "d41d8cd98f00b204e9800998ecf8427e", "delivery_item_brands": "d41d8cd98f00b204e9800998ecf8427e", "failed_notifications": "cb3bc9ad1d48ff96cd676f3a1e30f7b3", "ocr_processing_queue": "d41d8cd98f00b204e9800998ecf8427e", "product_crop_options": "69a826d3923001c6ba6e0ef07f913ecc", "product_label_drafts": "8fd651a702186e250338e016b652c5e4", "purchase_order_items": "629d6a8dae2258e6eeb79d20fc3c797d", "blend_ticket_products": "d41d8cd98f00b204e9800998ecf8427e", "credit_memo_sales_tax": "d41d8cd98f00b204e9800998ecf8427e", "customer_interactions": "d41d8cd98f00b204e9800998ecf8427e", "delivery_brand_events": "d41d8cd98f00b204e9800998ecf8427e", "job_loader_worksheets": "5643c996dcbacf50d9cf3947e8cdde15", "product_margin_floors": "d41d8cd98f00b204e9800998ecf8427e", "product_parent_brands": "c8e40a322af36376a62494f899881d0c", "product_parent_events": "58e3f75fd8934d482083512d6aafa65b", "product_weight_events": "168aa0a04dc7a546ab48f3d09512f121", "rebate_claim_counters": "d41d8cd98f00b204e9800998ecf8427e", "team_note_attachments": "d41d8cd98f00b204e9800998ecf8427e", "delivery_receipt_queue": "f756d570845b6801ff8961d041d09536", "field_app_billing_sets": "d41d8cd98f00b204e9800998ecf8427e", "field_billing_defaults": "c357bf38c46d8c7813fb81511c856be1", "inventory_transactions": "0f74d5c761466ab4dd4d5adcf602dfbc", "order_line_allocations": "d41d8cd98f00b204e9800998ecf8427e", "product_change_history": "47e568122250f2f448028b5a7dfe48c5", "product_parent_members": "a75cb1f3110669f7c596e4c1ee530f13", "product_supplier_links": "f9f4e5f6dfaec3deb12929b7c62b7b80", "supplier_price_imports": "516837581f1729e3cafd7a236a6d1748", "application_record_lots": "d41d8cd98f00b204e9800998ecf8427e", "epa_chemistry_proposals": "9a5eb86d65962c2139769f6428c3d458", "epa_registration_events": "13bc193ab5f2acbea6dfe37dc178aa9e", "field_app_billing_lines": "d41d8cd98f00b204e9800998ecf8427e", "interaction_transcripts": "d41d8cd98f00b204e9800998ecf8427e", "invoice_sales_tax_rates": "d41d8cd98f00b204e9800998ecf8427e", "job_applied_record_crew": "d41d8cd98f00b204e9800998ecf8427e", "job_location_dispatches": "2f2b8cbf4d4eed44aaf197b83d85e495", "offline_action_receipts": "d41d8cd98f00b204e9800998ecf8427e", "pricing_change_set_rows": "17b73cabcf0110f29b58592f8b625835", "active_ingredient_events": "4a77961ee0943dbfcce3822c1b9a09dc", "commission_payment_items": "d41d8cd98f00b204e9800998ecf8427e", "credit_memo_applications": "d41d8cd98f00b204e9800998ecf8427e", "invoice_line_allocations": "d751223e6d36c73a8ec5725b18e9d05f", "legacy_vendor_resolution": "ec8118f1c935b41677e01d00e0725945", "pricing_workbook_exports": "b85e8675fa69e8d04927f38a5ff59ce2", "product_chemistry_events": "1b0143863fd906e2637b3991381d778e", "product_parent_proposals": "90423358124fac63d2cf00794be1d858", "profile_public_directory": "cbab2b93a708edbfa3e662b94650abb3", "split_invoice_provenance": "d41d8cd98f00b204e9800998ecf8427e", "watchdog_flag_dismissals": "d41d8cd98f00b204e9800998ecf8427e", "application_record_fields": "3591f710257737c82230138808121a2b", "blend_ticket_weight_basis": "d41d8cd98f00b204e9800998ecf8427e", "epa_registration_seed_run": "534b90b206aec514c4c15518a7563b58", "field_app_location_shares": "71917d77fd310218f65b3383d5db2ff8", "invoice_line_rup_captures": "8d3e61048ec9db3e16e3014921110fba", "job_applied_record_fields": "d41d8cd98f00b204e9800998ecf8427e", "job_dispatch_preservation": "d41d8cd98f00b204e9800998ecf8427e", "product_rate_draft_events": "3afbf0f0e8f3b3643b230f41aec69d71", "chemistry_change_proposals": "d41d8cd98f00b204e9800998ecf8427e", "commission_history_cutover": "41068867349a4767bf302415b4ea6b71", "customer_application_rates": "d41d8cd98f00b204e9800998ecf8427e", "customer_document_restores": "d41d8cd98f00b204e9800998ecf8427e", "delivery_external_billings": "ff8a7eeaab93f062624947aa43b62291", "product_cost_basis_rollout": "c0d2ee3280dd3f3201f66daef5d22430", "product_parent_copy_passes": "d41d8cd98f00b204e9800998ecf8427e", "product_parent_ingredients": "6321b2c15d89089a58e1bf2c71ca2ddd", "product_use_timing_options": "4449888b33a67678fd52b93e958029dd", "retired_uncertain_requests": "d41d8cd98f00b204e9800998ecf8427e", "supplier_price_import_rows": "05f19f21427a164bb1dbab746f92d1a1", "blend_ticket_to_order_items": "d41d8cd98f00b204e9800998ecf8427e", "integrity_negative_baseline": "c7a45ec96d997af502c2dc7b63c7694f", "pricing_change_set_warnings": "21a26b1bfdda608c5bd015c65087a3c3", "product_parent_brand_events": "e5966e12a6f56fe190f08c8318a8da09", "product_rate_cutover_passes": "d41d8cd98f00b204e9800998ecf8427e", "supplier_price_observations": "9d8b74514c4918c9f912e7f75ff79533", "vendor_alias_stage_receipts": "d41d8cd98f00b204e9800998ecf8427e", "blend_ticket_product_weights": "d41d8cd98f00b204e9800998ecf8427e", "commission_settlement_events": "d41d8cd98f00b204e9800998ecf8427e", "invoice_line_share_snapshots": "d41d8cd98f00b204e9800998ecf8427e", "job_loader_worksheet_weights": "d41d8cd98f00b204e9800998ecf8427e", "order_item_field_allocations": "d41d8cd98f00b204e9800998ecf8427e", "pricing_change_set_approvals": "d41d8cd98f00b204e9800998ecf8427e", "pricing_workbook_export_rows": "e83a5d9a2e1d358d4d3b3530dc6739b1", "product_info_change_set_rows": "d41d8cd98f00b204e9800998ecf8427e", "product_margin_floor_changes": "d41d8cd98f00b204e9800998ecf8427e", "product_parent_brand_sources": "b837965c7747f4cb360289d8cafa77be", "product_parent_density_state": "42b5b54cef8d7b11d377ad07de8e8034", "product_parent_rate_outcomes": "2711147a5e1ae43aae12797395856426", "product_parent_cost_reference": "0e5ef3053da7c27e35f1d721abbd5df7", "product_parent_density_values": "9903bc244d5295d1061da501caf2365f", "product_size_net_weight_state": "52bdc36d73c7bddc5d3fd4dde4654ba0", "purchase_order_import_intents": "d41d8cd98f00b204e9800998ecf8427e", "return_credit_customer_claims": "d41d8cd98f00b204e9800998ecf8427e", "split_invoice_creation_claims": "d41d8cd98f00b204e9800998ecf8427e", "split_invoice_mutation_claims": "d41d8cd98f00b204e9800998ecf8427e", "commission_earned_state_ledger": "5bf3009953c6f2742f46b01bcc81f341", "product_cost_basis_change_rows": "f31c525dd8007d8ad3ea97a5c24209cb", "product_parent_chemistry_state": "85513929b4c46c1f47a28f5d943cda54", "product_parent_modes_of_action": "d41d8cd98f00b204e9800998ecf8427e", "product_parent_proposal_groups": "38e22dec9f38e2a8f4b4a3b86b1ac156", "product_rate_correction_passes": "d41d8cd98f00b204e9800998ecf8427e", "product_size_net_weight_values": "d41d8cd98f00b204e9800998ecf8427e", "invoice_line_brand_rup_captures": "d41d8cd98f00b204e9800998ecf8427e", "invoice_standing_discount_rates": "0d5b366eed8b08473a6e3302311b458e", "pricing_change_set_preview_rows": "e7a82353da3073559e548235c5f03bbd", "purchase_order_item_cost_changes": "a2e80209b8848bccf98a713812a71bbb", "active_ingredient_modes_of_action": "d41d8cd98f00b204e9800998ecf8427e", "uncertain_request_clear_check_key": "fc23aa8680605c852f52febd44ac3208", "product_parent_fertilizer_analysis": "d41d8cd98f00b204e9800998ecf8427e", "invoice_delivery_recovery_capabilities": "d41d8cd98f00b204e9800998ecf8427e"}, "pinned_at": "2026-11-24T06:43:44.830045+00:00", "product_id": "6fd3adc1-909f-4b63-98fa-73028a780a7c", "customer_id": "d8bd091a-64ea-4550-a0c4-16ccb66ec1e9", "delete_triggers": {"orders": ["guard_order_delete"], "returns": ["aa_crx_guard_recognized_return_credit_delete", "trg_return_lifecycle_rpc_owned"], "invoices": ["aa_crx_guard_return_credit_source_recognition", "guard_invoice_delete", "guard_split_invoice_provenance_identity", "zz_snapshot_invoice_hard_delete"], "payments": ["zz_snapshot_payment_hard_delete"], "profiles": ["trg_sync_profile_public_directory"], "deliveries": ["guard_delivery_delete"], "job_fields": ["trg_preserve_job_location_dispatch_on_field_delete"], "team_notes": ["log_team_note_changes"], "tote_fills": ["tote_fills_append_only"], "epa_lookups": ["epa_lookups_status"], "order_items": ["after_order_items_change", "guard_deleted_order_lines_locked", "order_items_bump_edit_version", "trg_order_items_bill_split_move"], "order_shares": ["trg_order_shares_lock_when_posted"], "blend_tickets": ["trigger_delete_blend_ticket_weights"], "invoice_items": ["aa_crx_guard_return_credit_lineage", "guard_split_invoice_provenance_items", "invoice_items_standing_discount_20261231", "trg_guard_split_invoice_items", "trg_guard_terminal_order_invoice_items", "trg_refuse_posted_invoice_child_write"], "job_chemicals": ["trg_sync_job_holds_del"], "product_rates": ["trg_product_rates_clear_outcome", "trg_product_rates_guard_change", "trg_product_rates_guard_rate_source"], "delivery_items": ["delivery_items_brand_line_removed", "enforce_delivery_items_parent_lock"], "ingredient_map": ["ingredient_map_read_only"], "invoice_shares": ["trg_refuse_posted_invoice_child_write"], "allocation_sets": ["zz_snapshot_allocation_set_hard_delete"], "delivery_photos": ["protect_accepted_delivery_photo"], "purchase_orders": ["guard_po_delete", "invalidate_deleted_purchase_order_retry_state"], "unit_conversions": ["unit_conversions_rate_lock"], "cycle_count_items": ["trg_bump_cycle_count_item_revision"], "order_item_shares": ["trg_guard_order_item_shares"], "product_rate_lock": ["product_rate_lock_keep_row"], "receiving_records": ["trg_receiving_records_before_delete"], "product_cost_basis": ["trigger_protect_product_cost_basis_history"], "team_note_comments": ["log_comment_changes"], "blend_ticket_fields": ["trg_blend_ticket_fields_billed_lock", "trg_blend_ticket_fields_downstream_lock"], "epa_lookup_failures": ["epa_lookup_failures_append_only"], "field_app_locations": ["trg_serialize_invoice_group_writes", "trg_zz_refuse_posted_invoice_child_write"], "financial_audit_log": ["trg_guard_audit_log_immutable"], "invoice_line_shares": ["trg_invoice_line_shares_lock_when_posted", "trg_refuse_posted_invoice_child_write"], "job_applied_records": ["enforce_billed_job_applied_record_immutability", "job_applied_record_recompute_ad"], "prepay_applications": ["trg_recompute_prepay_credit_balance"], "product_rate_events": ["product_rate_events_append_only"], "below_cost_approvals": ["a_below_cost_approvals_immutable"], "purchase_order_items": ["trg_po_items_recompute_on_order", "trigger_0_guard_closed_po_item"], "blend_ticket_products": ["trg_blend_ticket_product_parent_version", "trg_blend_ticket_products_billed_lock", "trg_linked_blend_ticket_product_lock"], "delivery_brand_events": ["delivery_brand_events_no_change"], "product_parent_events": ["product_parent_events_append_only"], "product_weight_events": ["product_weight_events_append_only"], "delivery_receipt_queue": ["delivery_receipt_keep_owed"], "field_billing_defaults": ["enforce_field_billing_defaults_sum_100"], "inventory_transactions": ["trg_guard_inventory_transactions_immutable"], "product_change_history": ["product_change_history_no_update_delete"], "product_parent_members": ["product_parent_members_fill_source", "trg_product_parent_members_guard_rate_source", "trigger_bump_member_generation"], "product_supplier_links": ["trg_product_supplier_links_one_preferred"], "epa_chemistry_proposals": ["epa_chemistry_proposals_status"], "epa_registration_events": ["epa_registration_events_append_only"], "job_applied_record_crew": ["enforce_billed_jarc_immutability"], "active_ingredient_events": ["active_ingredient_events_append_only"], "credit_memo_applications": ["trg_guard_cma_immutable"], "product_chemistry_events": ["product_chemistry_events_append_only"], "job_applied_record_fields": ["enforce_billed_jarf_immutability", "jarf_recompute_aiud"], "product_rate_draft_events": ["trg_product_rate_draft_events_append_only"], "commission_history_cutover": ["trg_commission_history_cutover_immutable"], "product_parent_brand_events": ["product_parent_brand_events_append_only"], "supplier_price_observations": ["trg_supplier_price_observations_immutable"], "commission_settlement_events": ["trg_commission_settlement_events_immutable"], "order_item_field_allocations": ["trg_oifa_lock_when_posted"], "product_margin_floor_changes": ["trigger_product_margin_floor_changes_append_only"], "product_parent_rate_outcomes": ["trg_product_parent_rate_outcomes_guard_rate_source"], "commission_earned_state_ledger": ["trg_commission_earned_state_ledger_immutable"], "purchase_order_item_cost_changes": ["trigger_po_item_cost_changes_append_only"]}, "admin_profile_id": "0b03fc35-49b5-454c-b7ca-eb56b20e8a5e", "system_identifier": 7581440907192989109}';

  -- Sections: flip to change what is cleared (see the header).
  c_clear_logs constant boolean := true;
  c_clear_receipts constant boolean := false;
  c_clear_team_notes_on_cleared constant boolean := false;
  c_clear_backup_snapshots constant boolean := true;

  c_backup constant text := 'reset_backup_20261123';
  -- md5 of the sorted, comma-joined public table names this file classified (the proof checks it against the schema).
  c_table_set_md5 constant text := '39cd9a9a0e89506e92bd5d9e5a27f7ac';
  -- Delete order, children first; a comma groups tables that reference each other (one statement).
  c_core constant text[] := ARRAY[
    'accounting_periods', 'invoice_line_allocations', 'order_line_allocations', 'prepay_applications', 'prepay_credits',
    'allocation_sets', 'application_record_fields', 'application_record_lots', 'application_records',
    'ar_reminder_tracking', 'below_cost_approvals', 'blend_ticket_fields', 'blend_ticket_images',
    'blend_ticket_product_weights', 'blend_ticket_to_order_items', 'blend_ticket_products', 'blend_ticket_weight_basis',
    'ocr_processing_queue', 'field_app_location_shares', 'field_app_locations', 'job_applied_record_crew',
    'job_applied_record_fields', 'job_applied_records', 'invoice_line_rup_captures', 'rup_sales_records',
    'invoice_line_shares', 'invoice_line_brand_rup_captures', 'invoice_items', 'field_app_billing_lines',
    'job_location_dispatches', 'job_notifications', 'job_attachments', 'job_chemicals', 'job_loader_worksheet_weights',
    'job_loader_worksheets', 'job_applied_info', 'job_fields', 'job_field_shares', 'job_product_draws', 'tote_fills',
    'inventory_transactions', 'job_tag_assignments', 'commission_earned_state_ledger', 'commission_settlement_events',
    'commission_payment_items', 'commissions', 'invoice_line_share_snapshots', 'split_invoice_provenance',
    'finance_charges', 'credit_memo_sales_tax', 'invoice_sales_tax_rates', 'write_offs', 'invoice_shares',
    'return_items', 'return_credit_customer_claims', 'returns', 'credit_memo_applications',
    'invoice_standing_discount_rates', 'split_invoice_mutation_claims',
    'blend_tickets,field_app_billing_sets,invoices,jobs',
    'commission_payments', 'cycle_count_items', 'cycle_counts', 'delivery_item_brands', 'delivery_items',
    'delivery_brand_events', 'delivery_external_billings', 'delivery_remainders', 'delivery_receipt_queue',
    'delivery_photos', 'deliveries', 'integrity_negative_baseline', 'inventory_holds',
    'invoice_delivery_recovery_capabilities', 'job_batches', 'job_dispatch_preservation', 'job_epa_sprayed',
    'job_product_epa', 'order_item_field_allocations', 'order_item_shares', 'order_items', 'order_shares', 'payments',
    'rebate_claims', 'split_invoice_creation_claims', 'orders', 'purchase_order_import_intents',
    'purchase_order_item_cost_changes', 'receiving_photos', 'receiving_records', 'purchase_order_items',
    'vendor_payments', 'vendor_bills', 'purchase_orders', 'quote_items', 'quote_price_changes', 'quote_product_draws',
    'quote_sections', 'quote_versions', 'quotes', 'rebate_claim_counters'];
  -- Entity types whose log rows are about cleared records.
  c_cleared_types constant text[] := ARRAY['accounting_period', 'allocation_set', 'application_record', 'batch',
    'blend_ticket', 'booking', 'commission', 'commission_payment', 'credit_memo', 'cycle_count', 'delivery',
    'field_app', 'field_application', 'finance_charge', 'inventory', 'inventory_hold', 'invoice', 'job', 'order',
    'payment', 'prepay', 'prepay_credit', 'purchase_order', 'quote', 'rebate_claim', 'receiving', 'receiving_record',
    'return', 'split', 'vendor_bill', 'vendor_payment', 'void', 'write_off'];
  c_seqs constant text[] := ARRAY['order_number_seq', 'quote_number_seq', 'invoice_number_seq', 'cs_invoice_number_seq',
    'mc_invoice_number_seq', 'cm_invoice_number_seq'];

  v_sysid bigint;
  v_counts jsonb;
  v_tables text[];      -- every public table, sorted
  v_core text[];        -- c_core flattened
  v_plan jsonb := '[]'; -- [{t, where}] section deletes
  v_deleting text[];    -- every table rows are deleted from
  v_kept text[];
  v_bad text;
  v_t text;
  v_e text;
  v_where text;
  v_n bigint;
  v_m bigint;
  v_sql text;
  v_trig_before text;
  v_trig_after text;
  v_off jsonb;
  v_md5_before jsonb := '{}';
  v_md5 text;
  v_ok boolean;
  v_excl jsonb := jsonb_build_object(
    'customers', ARRAY['prepay_balance_cents', 'row_version', 'updated_at'],
    'inventory', ARRAY['quantity_available', 'quantity_prebooked', 'quantity_on_order', 'last_counted_at', 'updated_at']);
  r record;
BEGIN
  -- ===== Live-only guard: anything but Mason's live database is a no-op. =====
  IF c_live IS NULL THEN
    RAISE NOTICE 'LIVE_RESET_SKIPPED_NOT_LIVE: the live pins are not filled in; nothing was changed.';
    RETURN;
  END IF;
  SELECT system_identifier INTO v_sysid FROM pg_control_system();
  IF jsonb_typeof(c_live->'system_identifier') IS DISTINCT FROM 'number'
     OR v_sysid IS DISTINCT FROM (c_live->>'system_identifier')::bigint
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id::text = c_live->>'admin_profile_id' AND role = 'admin')
     OR NOT EXISTS (SELECT 1 FROM public.customers WHERE id::text = c_live->>'customer_id')
     OR NOT EXISTS (SELECT 1 FROM public.products WHERE id::text = c_live->>'product_id') THEN
    RAISE NOTICE 'LIVE_RESET_SKIPPED_NOT_LIVE: this is not the pinned live database; nothing was changed.';
    RETURN;
  END IF;

  -- ===== Preflight =====
  IF current_setting('transaction_isolation') <> 'read committed' OR current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'LIVE_RESET_SESSION: run it in a read committed transaction with session_replication_role = origin (now % / %). Nothing was changed.',
      current_setting('transaction_isolation'), current_setting('session_replication_role');
  END IF;
  -- The pin digests were read in UTC; to_jsonb renders timestamps in the session time zone.
  PERFORM set_config('TimeZone', 'UTC', true);
  PERFORM set_config('DateStyle', 'ISO, MDY', true);
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = c_backup) THEN
    RAISE EXCEPTION 'LIVE_RESET_ALREADY_APPLIED: schema % exists; the reset ran already. Nothing was changed.', c_backup;
  END IF;
  v_counts := c_live->'counts';
  IF jsonb_typeof(v_counts) IS DISTINCT FROM 'object' OR jsonb_typeof(c_live->'digests') IS DISTINCT FROM 'object'
     OR jsonb_typeof(c_live->'delete_triggers') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'LIVE_RESET_PINS_MISSING: c_live has no counts, digests or delete_triggers object. Nothing was changed.';
  END IF;

  PERFORM set_config('lock_timeout', '10s', true);
  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO v_tables
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r';
  FOREACH v_t IN ARRAY v_tables LOOP
    EXECUTE format('LOCK TABLE public.%I IN EXCLUSIVE MODE', v_t);
  END LOOP;
  -- Checked after the locks, on the wall clock: a pin older than 6 hours (or from the future) refuses.
  IF (c_live->>'pinned_at') IS NULL OR clock_timestamp() > (c_live->>'pinned_at')::timestamptz + interval '6 hours'
     OR (c_live->>'pinned_at')::timestamptz > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'LIVE_RESET_PIN_EXPIRED: the pins were read at %, not within the last 6 hours; re-pin. Nothing was changed.', c_live->>'pinned_at';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'p')
     OR EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhparent IN (SELECT format('public.%I', x)::regclass FROM unnest(v_tables) x)) THEN
    RAISE EXCEPTION 'LIVE_RESET_SCHEMA_DRIFT: a public table is partitioned or has child tables. Nothing was changed.';
  END IF;
  SELECT string_agg(x, ', ') INTO v_bad FROM unnest(c_seqs) x WHERE to_regclass(format('public.%I', x)) IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIVE_RESET_SCHEMA_DRIFT: number sequences missing (%). Nothing was changed.', v_bad;
  END IF;

  SELECT string_agg(x, ', ') INTO v_bad FROM (
    (SELECT unnest(v_tables) EXCEPT SELECT jsonb_object_keys(v_counts)) UNION ALL
    (SELECT jsonb_object_keys(v_counts) EXCEPT SELECT unnest(v_tables))) s(x);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIVE_RESET_SCHEMA_DRIFT: the public tables differ from the pinned set (%). Nothing was changed.', v_bad;
  END IF;
  IF md5(array_to_string(v_tables, ',')) IS DISTINCT FROM c_table_set_md5 THEN
    RAISE EXCEPTION 'LIVE_RESET_SCHEMA_DRIFT: the public tables are not the % this file classified (a table was added or removed); classify it first. Nothing was changed.', c_table_set_md5;
  END IF;

  v_core := string_to_array(array_to_string(c_core, ','), ',');
  SELECT string_agg(x, ', ') INTO v_bad FROM unnest(v_core) x WHERE x <> ALL (v_tables);
  IF v_bad IS NOT NULL OR (SELECT count(DISTINCT x) FROM unnest(v_core) x) <> cardinality(v_core) THEN
    RAISE EXCEPTION 'LIVE_RESET_SCHEMA_DRIFT: the delete list names missing or repeated tables (%). Nothing was changed.', v_bad;
  END IF;

  v_bad := NULL;
  FOREACH v_t IN ARRAY v_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', v_t) INTO v_n;
    IF v_n IS DISTINCT FROM (v_counts->>v_t)::bigint THEN
      v_bad := concat_ws(', ', v_bad, format('%s %s (pinned %s)', v_t, v_n, v_counts->>v_t));
    END IF;
  END LOOP;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIVE_RESET_COUNT_DRIFT: rows changed since the pin: %. Nothing was changed.', v_bad;
  END IF;
  v_bad := NULL;
  FOREACH v_t IN ARRAY v_tables LOOP
    EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text), '''' ORDER BY md5(to_jsonb(x)::text)), '''')) FROM public.%I x', v_t) INTO v_md5;
    IF v_md5 IS DISTINCT FROM c_live->'digests'->>v_t THEN v_bad := concat_ws(', ', v_bad, v_t); END IF;
  END LOOP;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIVE_RESET_CONTENT_DRIFT: rows were edited since the pin: %. Nothing was changed.', v_bad;
  END IF;

  SELECT (SELECT count(*) FROM public.product_cost_basis WHERE purchase_order_item_id IS NOT NULL)
       + (SELECT count(*) FROM public.product_cost_basis_change_rows WHERE purchase_order_item_id IS NOT NULL) INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'LIVE_RESET_COST_BASIS_FROM_PO: % kept cost basis row(s) point at a PO line; deleting the POs needs a decision. Nothing was changed.', v_n;
  END IF;

  -- ===== Backup every row it will delete =====
  EXECUTE format('CREATE SCHEMA %I', c_backup);
  EXECUTE format('CREATE TABLE %I._manifest (table_name text PRIMARY KEY, scope text NOT NULL, rows_backed_up bigint NOT NULL, rows_deleted bigint)', c_backup);
  FOREACH v_t IN ARRAY v_core LOOP
    EXECUTE format('CREATE TABLE %I.%I AS SELECT * FROM public.%I', c_backup, v_t, v_t);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    EXECUTE format('INSERT INTO %I._manifest VALUES (%L, %L, %s, NULL)', c_backup, v_t, 'all rows', v_n);
  END LOOP;

  -- Ids of every cleared row (the uuid id column of each core table), for the section filters.
  CREATE TEMP TABLE reset_ids (id uuid PRIMARY KEY) ON COMMIT DROP; -- always read as pg_temp.reset_ids
  FOR r IN SELECT table_name FROM information_schema.columns
            WHERE table_schema = c_backup AND column_name = 'id' AND data_type = 'uuid' ORDER BY table_name LOOP
    EXECUTE format('INSERT INTO pg_temp.reset_ids SELECT id FROM %I.%I WHERE id IS NOT NULL ON CONFLICT DO NOTHING', c_backup, r.table_name);
  END LOOP;

  IF c_clear_logs THEN
    v_plan := v_plan || jsonb_build_array(
      jsonb_build_object('t', 'activity_feed', 'w', format('related_entity_type = ANY (%L::text[]) OR related_entity_id IN (SELECT id FROM pg_temp.reset_ids)', c_cleared_types)),
      jsonb_build_object('t', 'notifications', 'w', format('related_entity_type = ANY (%L::text[]) OR related_entity_id IN (SELECT id FROM pg_temp.reset_ids)', c_cleared_types)),
      jsonb_build_object('t', 'financial_audit_log', 'w', format('entity_type = ANY (%L::text[]) OR entity_id IN (SELECT id FROM pg_temp.reset_ids)', c_cleared_types)),
      jsonb_build_object('t', 'email_log', 'w', 'true'),
      jsonb_build_object('t', 'integrity_alerts', 'w', 'true'),
      jsonb_build_object('t', 'failed_notifications', 'w', 'true'),
      jsonb_build_object('t', 'watchdog_flag_dismissals', 'w', 'true'),
      jsonb_build_object('t', 'watchdog_flags', 'w', 'true'));
  END IF;
  IF c_clear_receipts THEN
    v_plan := v_plan || jsonb_build_array(
      jsonb_build_object('t', 'idempotency_keys', 'w', 'true'),
      jsonb_build_object('t', 'offline_action_receipts', 'w', 'true'),
      jsonb_build_object('t', 'retired_uncertain_requests', 'w', 'true'));
  END IF;
  IF c_clear_team_notes_on_cleared THEN
    v_where := 'note_id IN (SELECT id FROM public.team_notes WHERE linked_entity_id IN (SELECT id FROM pg_temp.reset_ids))';
    v_plan := v_plan || jsonb_build_array(
      jsonb_build_object('t', 'note_activity_log', 'w', v_where),
      jsonb_build_object('t', 'team_note_tags', 'w', v_where),
      jsonb_build_object('t', 'team_note_attachments', 'w', v_where),
      jsonb_build_object('t', 'team_note_comments', 'w', v_where),
      jsonb_build_object('t', 'team_notes', 'w', 'linked_entity_id IN (SELECT id FROM pg_temp.reset_ids)'));
  END IF;
  IF c_clear_backup_snapshots THEN
    v_plan := v_plan || jsonb_build_array(jsonb_build_object('t', 'backup_snapshots', 'w', 'true'),
      jsonb_build_object('t', 'backup_runs', 'w', 'true'));
  END IF;
  FOR r IN SELECT e->>'t' t, e->>'w' w FROM jsonb_array_elements(v_plan) e LOOP
    EXECUTE format('CREATE TABLE %I.%I AS SELECT * FROM public.%I WHERE %s', c_backup, r.t, r.t, r.w);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    EXECUTE format('INSERT INTO %I._manifest VALUES (%L, %L, %s, NULL)', c_backup, r.t, 'section: ' || r.w, v_n);
  END LOOP;

  EXECUTE format('CREATE TABLE %I._inventory_before AS SELECT * FROM public.inventory', c_backup);
  EXECUTE format('CREATE TABLE %I._customers_before AS SELECT * FROM public.customers', c_backup);
  EXECUTE format('CREATE TABLE %I._sequences (seq text PRIMARY KEY, last_value bigint NOT NULL, is_called boolean NOT NULL)', c_backup);
  FOREACH v_t IN ARRAY c_seqs LOOP
    EXECUTE format('INSERT INTO %I._sequences SELECT %L, last_value, is_called FROM public.%I', c_backup, v_t, v_t);
  END LOOP;

  v_deleting := v_core || ARRAY(SELECT e->>'t' FROM jsonb_array_elements(v_plan) e);
  v_kept := ARRAY(SELECT x FROM unnest(v_tables) x WHERE x <> ALL (v_deleting) ORDER BY x);

  -- Every table it deletes from (core and section tables): no foreign key from outside public may point at it (a
  -- cascade there would delete rows with no backup), and its DELETE triggers must be exactly the pinned names.
  SELECT string_agg(k.conrelid::regclass::text || ' -> ' || k.confrelid::regclass::text, ', ') INTO v_bad
    FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE k.contype = 'f' AND n.nspname <> 'public'
     AND k.confrelid IN (SELECT format('public.%I', x)::regclass FROM unnest(v_deleting) x);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIVE_RESET_SCHEMA_DRIFT: a table outside public references a table this deletes from (%). Nothing was changed.', v_bad;
  END IF;
  SELECT string_agg(x, ', ') INTO v_bad FROM unnest(v_deleting) x
   WHERE coalesce((SELECT jsonb_agg(t.tgname ORDER BY t.tgname) FROM pg_catalog.pg_trigger t
                    WHERE t.tgrelid = format('public.%I', x)::regclass AND NOT t.tgisinternal AND (t.tgtype & 8) <> 0), '[]')
         IS DISTINCT FROM coalesce(c_live->'delete_triggers'->x, '[]');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIVE_RESET_TRIGGER_DRIFT: the DELETE triggers on % are not the pinned ones; review them and re-pin. Nothing was changed.', v_bad;
  END IF;

  -- Content of every kept row (section tables: the rows that stay).
  FOREACH v_t IN ARRAY v_kept || ARRAY(SELECT e->>'t' FROM jsonb_array_elements(v_plan) e) LOOP
    EXECUTE format('SELECT md5(coalesce(string_agg(h, '''' ORDER BY h), '''')) FROM (SELECT md5((to_jsonb(x) - %L::text[])::text) h FROM public.%I x %s) s',
      coalesce(ARRAY(SELECT jsonb_array_elements_text(v_excl->v_t)), '{}'::text[]), v_t,
      CASE WHEN v_t = ANY (v_kept) THEN '' ELSE format('WHERE (%s) IS NOT TRUE', (SELECT e->>'w' FROM jsonb_array_elements(v_plan) e WHERE e->>'t' = v_t)) END) INTO v_md5;
    v_md5_before := v_md5_before || jsonb_build_object(v_t, v_md5);
  END LOOP;

  -- ===== Guards off, only on the tables it deletes from =====
  SELECT string_agg(c.relname || '.' || t.tgname || '=' || t.tgenabled::text, ',' ORDER BY c.relname, t.tgname) INTO v_trig_before
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal;
  SELECT coalesce(jsonb_agg(jsonb_build_object('t', c.relname, 'g', t.tgname, 'on', t.tgenabled::text) ORDER BY c.relname, t.tgname), '[]')
    INTO v_off
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal AND c.relname = ANY (v_deleting) AND (t.tgtype & 8) <> 0;
  SELECT string_agg((e->>'t') || '.' || (e->>'g') || '=' || (e->>'on'), ', ') INTO v_bad
    FROM jsonb_array_elements(v_off) e WHERE e->>'on' <> 'O';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIVE_RESET_GUARD_STATE: a delete trigger is not in its normal on state (%). Nothing was changed.', v_bad;
  END IF;
  EXECUTE format('CREATE TABLE %I._triggers_off AS SELECT e->>''t'' AS table_name, e->>''g'' AS trigger_name FROM jsonb_array_elements(%L::jsonb) e', c_backup, v_off);
  FOR r IN SELECT e->>'t' t, e->>'g' g FROM jsonb_array_elements(v_off) e LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', r.t, r.g);
  END LOOP;

  -- ===== Delete =====
  FOREACH v_e IN ARRAY c_core LOOP
    IF strpos(v_e, ',') = 0 THEN
      EXECUTE format('DELETE FROM public.%I', v_e);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      EXECUTE format('UPDATE %I._manifest SET rows_deleted = %s WHERE table_name = %L', c_backup, v_n, v_e);
    ELSE
      SELECT 'WITH ' || string_agg(format('%I AS (DELETE FROM public.%I RETURNING 1)', 'd_' || x, x), ', ')
             || ' SELECT jsonb_build_object(' || string_agg(format('%L, (SELECT count(*) FROM %I)', x, 'd_' || x), ', ') || ')'
        INTO v_sql FROM unnest(string_to_array(v_e, ',')) x;
      EXECUTE v_sql INTO v_off;
      FOR r IN SELECT key, value FROM jsonb_each_text(v_off) LOOP
        EXECUTE format('UPDATE %I._manifest SET rows_deleted = %s WHERE table_name = %L', c_backup, r.value, r.key);
      END LOOP;
    END IF;
  END LOOP;
  FOR r IN SELECT e->>'t' t, e->>'w' w FROM jsonb_array_elements(v_plan) e LOOP
    EXECUTE format('DELETE FROM public.%I WHERE %s', r.t, r.w);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    EXECUTE format('UPDATE %I._manifest SET rows_deleted = %s WHERE table_name = %L', c_backup, v_n, r.t);
  END LOOP;

  -- ===== Guards back on =====
  FOR r IN EXECUTE format('SELECT table_name, trigger_name FROM %I._triggers_off', c_backup) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I', r.table_name, r.trigger_name);
  END LOOP;

  -- ===== Stock 0, customers $0, numbering 0001 =====
  UPDATE public.inventory
     SET quantity_available = 0, quantity_prebooked = 0, quantity_on_order = 0, last_counted_at = NULL, updated_at = now()
   WHERE quantity_available IS DISTINCT FROM 0 OR quantity_prebooked IS DISTINCT FROM 0
      OR quantity_on_order IS DISTINCT FROM 0 OR last_counted_at IS NOT NULL;
  -- row_version is bumped by customers_bump_row_version, so an open customer screen refuses a stale save.
  UPDATE public.customers SET prepay_balance_cents = 0, updated_at = now() WHERE prepay_balance_cents IS DISTINCT FROM 0;
  -- ALTER SEQUENCE ... RESTART is transactional (a new sequence relfilenode): if anything later fails, including the
  -- runner's own ledger insert after this block, the rollback puts every sequence back. (setval is not undone.)
  FOREACH v_t IN ARRAY c_seqs LOOP
    EXECUTE format('ALTER SEQUENCE public.%I RESTART WITH 1', v_t);
    EXECUTE format('SELECT last_value = 1 AND NOT is_called FROM public.%I', v_t) INTO v_ok;
    IF v_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'LIVE_RESET_POSTFLIGHT: % would not give 0001 next.', v_t;
    END IF;
  END LOOP;

  -- ===== Postflight =====
  SELECT string_agg(c.relname || '.' || t.tgname || '=' || t.tgenabled::text, ',' ORDER BY c.relname, t.tgname) INTO v_trig_after
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal;
  IF v_trig_after IS DISTINCT FROM v_trig_before THEN
    RAISE EXCEPTION 'LIVE_RESET_POSTFLIGHT: a trigger is not back in its earlier state.';
  END IF;

  FOREACH v_t IN ARRAY v_core LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', v_t) INTO v_n;
    IF v_n <> 0 THEN RAISE EXCEPTION 'LIVE_RESET_POSTFLIGHT: % still has % rows.', v_t, v_n; END IF;
  END LOOP;
  FOR r IN EXECUTE format('SELECT table_name, rows_backed_up, rows_deleted FROM %I._manifest', c_backup) LOOP
    IF r.rows_deleted IS DISTINCT FROM r.rows_backed_up THEN
      RAISE EXCEPTION 'LIVE_RESET_POSTFLIGHT: % deleted % rows but backed up %.', r.table_name, r.rows_deleted, r.rows_backed_up;
    END IF;
    EXECUTE format('SELECT count(*) FROM %I.%I', c_backup, r.table_name) INTO v_n;
    EXECUTE format('SELECT count(*) FROM public.%I', r.table_name) INTO v_m;
    IF v_n <> r.rows_backed_up OR v_m <> (v_counts->>r.table_name)::bigint - v_n THEN
      RAISE EXCEPTION 'LIVE_RESET_POSTFLIGHT: % backup has % rows, % left of % pinned.', r.table_name, v_n, v_m, v_counts->>r.table_name;
    END IF;
    IF r.table_name = ANY (v_core) AND v_n <> (v_counts->>r.table_name)::bigint THEN
      RAISE EXCEPTION 'LIVE_RESET_POSTFLIGHT: % backup has % rows, pinned %.', r.table_name, v_n, v_counts->>r.table_name;
    END IF;
  END LOOP;

  FOREACH v_t IN ARRAY v_kept LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', v_t) INTO v_n;
    IF v_n <> (v_counts->>v_t)::bigint THEN
      RAISE EXCEPTION 'LIVE_RESET_POSTFLIGHT: kept table % has % rows, pinned %.', v_t, v_n, v_counts->>v_t;
    END IF;
  END LOOP;
  FOR r IN SELECT key, value #>> '{}' AS md5 FROM jsonb_each(v_md5_before) LOOP
    EXECUTE format('SELECT md5(coalesce(string_agg(h, '''' ORDER BY h), '''')) FROM (SELECT md5((to_jsonb(x) - %L::text[])::text) h FROM public.%I x) s',
      coalesce(ARRAY(SELECT jsonb_array_elements_text(v_excl->r.key)), '{}'::text[]), r.key) INTO v_md5;
    IF v_md5 IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'LIVE_RESET_POSTFLIGHT: kept rows of % changed.', r.key;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.customers WHERE prepay_balance_cents IS DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'LIVE_RESET_POSTFLIGHT: a customer still has a prepay balance.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inventory
              WHERE quantity_available IS DISTINCT FROM 0 OR quantity_prebooked IS DISTINCT FROM 0
                 OR quantity_on_order IS DISTINCT FROM 0 OR last_counted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'LIVE_RESET_POSTFLIGHT: an inventory row still holds stock.';
  END IF;

  -- The backup is for its owner only: every other grant (PUBLIC, API roles, default-privilege grantees) is revoked.
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', c_backup);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC', c_backup);
  FOR r IN SELECT DISTINCT a.grantee::regrole::text AS g
             FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = c_backup AND a.grantee <> 0 AND a.grantee <> n.nspowner
           UNION
           SELECT DISTINCT a.grantee::regrole::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
            WHERE n.nspname = c_backup AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %s', c_backup, r.g);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %s', c_backup, r.g);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = c_backup AND a.grantee <> n.nspowner)
     OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
                 WHERE n.nspname = c_backup AND a.grantee <> c.relowner) THEN
    RAISE EXCEPTION 'LIVE_RESET_POSTFLIGHT: a role other than the owner can still reach the backup schema.';
  END IF;

  EXECUTE format('SELECT sum(rows_deleted) FROM %I._manifest', c_backup) INTO v_n;
  RAISE NOTICE 'LIVE_RESET_DONE: % rows deleted from % tables (all backed up in %); % delete triggers were off and are back on; stock 0, prepay 0, numbering restarts at 0001.',
    v_n, (SELECT count(*) FROM reset_backup_20261123._manifest), c_backup,
    (SELECT count(*) FROM reset_backup_20261123._triggers_off);
END
$live_reset$;
