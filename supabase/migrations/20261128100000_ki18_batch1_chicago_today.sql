-- KI-18 batch 1: money, compliance and stock decisions take "today" from the Chicago date.
-- The live database clock is UTC, so CURRENT_DATE is tomorrow from 6 pm (CST) / 7 pm (CDT) Central
-- until midnight Central. Each function below is its live definition (2026-11-06, md5 checked) with
-- only CURRENT_DATE replaced by (now() AT TIME ZONE 'America/Chicago')::date, the expression the
-- invoice_date and order_date defaults already use. The database timezone stays UTC.
--   * overdue restore: _reverse_credit_memo_application,
--     _reverse_write_off_replay_impl_20261015
--   * accounting-period checks: apply_credit_memo_to_invoice, _apply_prepay_to_invoice_replay_impl_20261015,
--     _apply_write_off_replay_impl_20261015, and the payment-date fallbacks in
--     _post_commission_payment_intent_impl_20260809, _void_commission_payment_intent_impl_20260809,
--     _void_payment_replay_impl_20261015
--   * commission dates: _create_commission_payment_intent_impl_20260809 (default payment date; the
--     business-date trigger refused the UTC date in the evening), _save_field_app_split_invoice_impl
--     (the commission date passed to _insert_commissions_for_job)
--   * quotes: the 15-day default expiry in _save_quote_below_cost_impl_20260810
--   * AR reminders: get_ar_reminder_candidates counts Chicago calendar days past due
--     (Chicago date - due date) instead of whole 24-hour periods since UTC midnight
--   * applicator licenses and RUP: _enforce_applicator_license, _dispatch_job_locations_replay_impl_20261015,
--     generate_rup_sales_records (the RUP record's sale date is the earlier of the invoice date and the
--     posting day, and its season follows that date, Mason's decisions of 2026-11-06; the applicator license
--     must be unexpired on both the invoice date and today and issued by the sale date, and a license with no
--     issue date on file is a warning)
--   * reversals of a credit application or write-off (reverse_credit_memo_application,
--     _unapply_return_credit_guard_impl_20260826, _void_invoice_split_provenance_impl_20260719,
--     _reverse_write_off_replay_impl_20261015) refuse when the row's UTC or Chicago date is in a closed month:
--     rows made before this file were checked on the UTC date, rows made after on the Chicago date
--     (_fix_delivery_plan already checks both)
--   * holds and stock: get_dispatch_stock_status, get_job_inventory_shortfalls,
--     _get_inventory_position_cost_impl_20261019 (also its season start), _create_inventory_hold_intent_impl_20260905
--   * other business dates: _transition_rebate_claim_replay_impl_20261015, _create_rush_order_below_cost_impl_20260810,
--     _create_followup_delivery_replay_impl_20261015, _create_job_from_quote_section_replay_impl_20261015,
--     _batch_reschedule_deliveries_replay_impl_20261015, _save_field_crop_history_replay_impl_20261015,
--     snapshot_field_crop_history
--   * argument defaults (bodies unchanged): create_vendor_bill, record_vendor_payment,
--     create_order_from_blend_ticket, create_quick_delivery
--   * column defaults: payments.payment_date, commission_payments.payment_date,
--     ar_reminder_tracking.sent_date, deliveries.scheduled_date
-- Signatures, return types, SECURITY DEFINER and search_path are unchanged (each statement is the function's
-- current live definition, reviewed here, with only its dates changed); CREATE OR REPLACE keeps owners and grants. The preflight and postflight pin
-- each function's body md5, argument list (with defaults), search_path, SECURITY DEFINER, owner and exact
-- live EXECUTE grants, and refuse if any replaced function has a second overload. Each has exactly one live
-- signature (2026-11-06); for example the old ten-argument create_vendor_bill is gone and only the twelve-argument
-- one re-emitted here exists. Overload evidence for create_vendor_bill: 20260831161000_require_cumulative_po_bill_confirmation
-- renamed the ten-argument version to _section9_create_vendor_bill_cumulative_impl (ALTER FUNCTION ... RENAME TO) and
-- created the twelve-argument one with CREATE FUNCTION; live read-only check on 2026-11-06,
--   SELECT oid::regprocedure FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'create_vendor_bill'
-- returned exactly one row: create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text).
-- The same live check found exactly one signature for each of the 33 functions replaced here.
-- No row is written; the preflight refuses if any RUP sales record's sale date is not the earlier of its invoice
-- date and its Chicago creation day (live had none on 2026-11-06). Re-runnable: the preflight accepts the pre-image or this file's body.
-- Not changed here: comment-only mentions; the advisory-lock key in _create_blend_ticket_replay_impl_20261015
-- (a lock name, not a business date); internal impls whose date default is never used (their wrapper
-- always passes the date); boards and reports (batch 2); statement and AR aging (batch 3).
-- Rollback: a forward migration re-emitting the pre-images (their md5s are in the preflight).
-- Left out (Mason 2026-11-06, on Sol's advice): mark_overdue_invoices, auto_expire_quotes and
-- run_morning_notification_checks run only from pg_cron at 06:00, 06:05 and 11:20 UTC (midnight to 6 am
-- Central), when the UTC and Chicago dates already agree, so they need no change. _sync_job_holds (evening
-- expiry of a hold that ends today) is a follow-up, done together with its actor and key hardening.
DO $preflight$
DECLARE
  v_row record;
  v_fn pg_proc;
BEGIN
  FOR v_row IN SELECT * FROM (VALUES
    ('_reverse_credit_memo_application(uuid,uuid,text,text)', '3c1b4076e5b2dc3629465f6193236750', '2a47d227e949966990f3f7881951694e', true, '{postgres=X/postgres,service_role=X/postgres}', 'p_application_id uuid, p_actor uuid, p_actor_role text, p_reason text', 'p_application_id uuid, p_actor uuid, p_actor_role text, p_reason text'),
    ('_reverse_write_off_replay_impl_20261015(uuid,text,uuid,text)', '70ef11ccad193eb6ef5ee88dcba6f8cd', '4154cbe9a13aff741d9c8ab72a508acc', true, '{postgres=X/postgres}', 'p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('apply_credit_memo_to_invoice(uuid,uuid,bigint,uuid,text)', 'bcc242c8715aaed81b9455fbc905237f', '9814b487791dc8425fe7d10c1a278394', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_credit_memo_id uuid, p_target_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_credit_memo_id uuid, p_target_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_apply_prepay_to_invoice_replay_impl_20261015(uuid,uuid,bigint,uuid,text)', 'c9377dab8f2534a03af2c27a6e1d510c', '53ac418df8065bd8001136a55e29ebea', true, '{postgres=X/postgres}', 'p_prepay_credit_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_prepay_credit_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_apply_write_off_replay_impl_20261015(uuid,bigint,text,uuid,text)', '00e8d020f9faf6276de8ddaf4f1411fc', '6c89936b2baa95094dbdcf654ad6f89e', true, '{postgres=X/postgres}', 'p_invoice_id uuid, p_amount_cents bigint, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_invoice_id uuid, p_amount_cents bigint, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_post_commission_payment_intent_impl_20260809(uuid,uuid,text)', '240fd81fd597136c195a62e7f60f3fbc', '865aed5ebe639bd2965c97224f484cf6', true, '{postgres=X/postgres}', 'p_payment_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_payment_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', '985fb1a42ab3b4d911c68898c14ce637', '73290904f17b81e50143b7a292d19973', true, '{postgres=X/postgres}', 'p_payment_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_payment_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_void_payment_replay_impl_20261015(uuid,text,uuid,text)', '70fd746c15f4a6629680a724f3588967', '249d13c9887436709119b442a8928ad3', true, '{postgres=X/postgres}', 'p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_create_commission_payment_intent_impl_20260809(uuid[],text,text,date,text,uuid,text)', '3610d803ee9594251ec948f9d4e99ace', 'c03052dc6ce3ba6b1002d5d73aa33d6b', true, '{postgres=X/postgres}', 'p_commission_ids uuid[], p_payment_method text, p_reference text, p_payment_date date, p_notes text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_commission_ids uuid[], p_payment_method text, p_reference text, p_payment_date date, p_notes text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text)', 'ca0da8106b112033e085db0c8d228ed4', '393f4fe11538d55bb849d1224901b0f7', true, '{postgres=X/postgres}', 'p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('get_ar_reminder_candidates()', 'be574e829d67e9e4f26cf8b3c0a6f681', 'b7cf51451ae4f61d1ccc037f95042c16', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', '', ''),
    ('_enforce_applicator_license()', 'ae368db8df03ea3eec8f83ac6de01648', 'b393c688aa54bfa5ee4c47ed65d690fd', false, '{=X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', '', ''),
    ('_dispatch_job_locations_replay_impl_20261015(jsonb,uuid,text,boolean)', 'b6cafd947beaf19678d491e1832f1908', '0cea17840a2d04c414fa0acf136da817', true, '{postgres=X/postgres}', 'p_assignments jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_license_override boolean DEFAULT false', 'p_assignments jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_license_override boolean DEFAULT false'),
    ('generate_rup_sales_records(uuid,text)', 'b3c5e302402b8f54f34a547f2c9ad3d3', '0cb155a27c654dd390a875c3ff3aa507', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text', 'p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('get_dispatch_stock_status(uuid[])', '1ac19ae58f8fde6c34c87962701573d4', '29f717f1d7b43b168ce2d5c2e48de179', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_job_ids uuid[]', 'p_job_ids uuid[]'),
    ('get_job_inventory_shortfalls(integer)', '3dc25a19781765ac939e03c72d980ef1', '453a2460174a68d097e680dca79dc1aa', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_days_ahead integer DEFAULT 7', 'p_days_ahead integer DEFAULT 7'),
    ('_get_inventory_position_cost_impl_20261019()', '6043fa5c13f508bf4c123ccad5d0cb12', '6a74347a299879a3ed5a82f4d5288a4b', true, '{postgres=X/postgres}', '', ''),
    ('_create_inventory_hold_intent_impl_20260905(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)', '30ae56a0e1ee3b472abe5c95508b43fc', 'd7e98a25d9b194e8ede05047c0cb0b6a', true, '{postgres=X/postgres}', 'p_product_id uuid, p_customer_id uuid, p_quantity numeric, p_hold_type text, p_expires_at date, p_notes text, p_performed_by uuid, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', 'p_product_id uuid, p_customer_id uuid, p_quantity numeric, p_hold_type text, p_expires_at date, p_notes text, p_performed_by uuid, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text'),
    ('_transition_rebate_claim_replay_impl_20261015(uuid,text,bigint,text,text)', 'de22ed84218873c02023720f5f4d06e1', 'ab5e9d5210ff4aeabff662b56ff5c85d', true, '{postgres=X/postgres}', 'p_claim_id uuid, p_new_status text, p_paid_amount_cents bigint DEFAULT NULL::bigint, p_manufacturer_ref text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', 'p_claim_id uuid, p_new_status text, p_paid_amount_cents bigint DEFAULT NULL::bigint, p_manufacturer_ref text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text'),
    ('_create_rush_order_below_cost_impl_20260810(uuid,jsonb,text,text,uuid,text)', '00eb8676ef9f214baf0cfa9fc25b1924', '17fa918ed609b079ce8a3c08337368ca', true, '{postgres=X/postgres}', 'p_customer_id uuid, p_items jsonb DEFAULT ''[]''::jsonb, p_notes text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_customer_id uuid, p_items jsonb DEFAULT ''[]''::jsonb, p_notes text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_create_followup_delivery_replay_impl_20261015(uuid,date,uuid,text)', 'da4e748e6139cc43247fdcfbfccf5251', '286023631494a108ad1ecadec3011bff', true, '{postgres=X/postgres}', 'p_original_delivery_id uuid, p_scheduled_date date DEFAULT NULL::date, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_original_delivery_id uuid, p_scheduled_date date DEFAULT NULL::date, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_create_job_from_quote_section_replay_impl_20261015(uuid,uuid,uuid,text)', 'e1e701e0a096c0d022b5ac370aa4bb60', 'b567ac08aef7db8c747af5424439d7de', true, '{postgres=X/postgres}', 'p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_batch_reschedule_deliveries_replay_impl_20261015(uuid[],date,uuid,text)', 'd87ef756d7e5c30e2fe9cf722e68b646', '9e36f19b08770f23b95c106fcdd1ead1', true, '{postgres=X/postgres}', 'p_delivery_ids uuid[], p_new_date date, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_delivery_ids uuid[], p_new_date date, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_save_field_crop_history_replay_impl_20261015(uuid,integer,text,text,date,date,numeric,text,text,uuid,text)', '4395eea60420c930dcc3895c6f2757f6', '602b045178da933f4b21f87493c0c4f2', true, '{postgres=X/postgres}', 'p_field_id uuid, p_season integer, p_crop_type text, p_variety text DEFAULT NULL::text, p_planting_date date DEFAULT NULL::date, p_harvest_date date DEFAULT NULL::date, p_yield_per_acre numeric DEFAULT NULL::numeric, p_yield_unit text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_field_id uuid, p_season integer, p_crop_type text, p_variety text DEFAULT NULL::text, p_planting_date date DEFAULT NULL::date, p_harvest_date date DEFAULT NULL::date, p_yield_per_acre numeric DEFAULT NULL::numeric, p_yield_unit text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_save_field_app_split_invoice_impl(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text,text)', '3df177130debed37484a2cfc7b84b73a', 'a69f21d8e9f32fc6fecb38ac3a54801c', true, '{postgres=X/postgres,service_role=X/postgres}', 'p_billing_set_id uuid, p_source_job_id uuid, p_invoice jsonb, p_fields jsonb, p_lines jsonb, p_performed_by uuid, p_application_service_id uuid, p_idempotency_key text, p_request_hash text', 'p_billing_set_id uuid, p_source_job_id uuid, p_invoice jsonb, p_fields jsonb, p_lines jsonb, p_performed_by uuid, p_application_service_id uuid, p_idempotency_key text, p_request_hash text'),
    ('snapshot_field_crop_history()', '09805ba67e9c29346f0ba75bf9450608', '16443deabc430d2565657b54004b126f', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', '', ''),
    ('create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)', '9f17ea87da9f2323336938e68e7ce72c', '9f17ea87da9f2323336938e68e7ce72c', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_vendor_id uuid, p_purchase_order_id uuid DEFAULT NULL::uuid, p_bill_number text DEFAULT ''''::text, p_bill_date date DEFAULT CURRENT_DATE, p_due_date date DEFAULT NULL::date, p_payment_terms text DEFAULT NULL::text, p_subtotal_cents bigint DEFAULT 0, p_adjustment_cents bigint DEFAULT 0, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_confirm_po_overage boolean DEFAULT false, p_po_overage_reason text DEFAULT NULL::text', 'p_vendor_id uuid, p_purchase_order_id uuid DEFAULT NULL::uuid, p_bill_number text DEFAULT ''''::text, p_bill_date date DEFAULT ((now() AT TIME ZONE ''America/Chicago''::text))::date, p_due_date date DEFAULT NULL::date, p_payment_terms text DEFAULT NULL::text, p_subtotal_cents bigint DEFAULT 0, p_adjustment_cents bigint DEFAULT 0, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_confirm_po_overage boolean DEFAULT false, p_po_overage_reason text DEFAULT NULL::text'),
    ('record_vendor_payment(uuid,bigint,date,text,text,text,text)', '612835148d3ebf0da1127657ce7b1b1a', '612835148d3ebf0da1127657ce7b1b1a', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_vendor_bill_id uuid, p_amount_cents bigint, p_payment_date date DEFAULT CURRENT_DATE, p_payment_method text DEFAULT NULL::text, p_reference_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', 'p_vendor_bill_id uuid, p_amount_cents bigint, p_payment_date date DEFAULT ((now() AT TIME ZONE ''America/Chicago''::text))::date, p_payment_method text DEFAULT NULL::text, p_reference_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text'),
    ('create_order_from_blend_ticket(uuid,text,date,text,uuid,text)', '651a48e7395a003c213038493c0bbd0a', '651a48e7395a003c213038493c0bbd0a', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text', 'p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT ((now() AT TIME ZONE ''America/Chicago''::text))::date, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text'),
    ('create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean)', '69c1d569fb2e9eb913502d59e41a76fe', '69c1d569fb2e9eb913502d59e41a76fe', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_customer_id uuid, p_items jsonb, p_driver_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_delivery_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_skip_invoice boolean DEFAULT false', 'p_customer_id uuid, p_items jsonb, p_driver_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT ((now() AT TIME ZONE ''America/Chicago''::text))::date, p_delivery_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_skip_invoice boolean DEFAULT false'),
    ('reverse_credit_memo_application(uuid,text,uuid,text)', '38cea043fc7dae4e65bc8593c95bddfb', 'c3f9459d3ea8ed998c8271f38b85d6c6', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_application_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_application_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_unapply_return_credit_guard_impl_20260826(uuid,text,uuid,text)', '8a304e41a63cac0043b3fe7bf75cc10b', '1f3a386f35d823fb14b5deb3b5f75170', true, '{postgres=X/postgres}', 'p_credit_memo_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_credit_memo_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_void_invoice_split_provenance_impl_20260719(uuid,text,text)', 'd5ac51bf7ae432e9c8360bc75247c087', '8c20fab6159d67fb7937fd8f48d92a6d', true, '{postgres=X/postgres}', 'p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text', 'p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text')
  ) AS t(sig, pre_md5, post_md5, secdef, acl, args_pre, args_post)
  LOOP
    SELECT * INTO v_fn FROM pg_proc WHERE oid = to_regprocedure('public.' || v_row.sig);
    IF v_fn.oid IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % is missing', v_row.sig;
    END IF;
    IF md5(replace(v_fn.prosrc, chr(13), '')) NOT IN (v_row.pre_md5, v_row.post_md5)
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR v_fn.prosecdef IS DISTINCT FROM v_row.secdef
       OR coalesce((SELECT array_agg(g::text ORDER BY g::text COLLATE "C") FROM unnest(v_fn.proacl) g)::text, 'NULL') IS DISTINCT FROM v_row.acl
       OR pg_get_function_arguments(v_fn.oid) NOT IN (v_row.args_pre, v_row.args_post)
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres' THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % body, arguments, settings, SECURITY DEFINER, owner or grants drifted; re-review the current definition', v_row.sig;
    END IF;
  END LOOP;
  -- The four column defaults this file replaces must still be the UTC date (or already this file's).
  IF EXISTS (
    SELECT 1 FROM (VALUES ('payments', 'payment_date'), ('commission_payments', 'payment_date'), ('ar_reminder_tracking', 'sent_date'), ('deliveries', 'scheduled_date')) AS t(tbl, col)
     WHERE coalesce(pg_get_expr((SELECT adbin FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                         WHERE d.adrelid = ('public.' || t.tbl)::regclass AND a.attname = t.col), ('public.' || t.tbl)::regclass), '')
           NOT IN ('CURRENT_DATE', '((now() AT TIME ZONE ''America/Chicago''::text))::date')
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: a column date default drifted from CURRENT_DATE; re-review before replacing it';
  END IF;
  -- Overloads: every function this file replaces must have exactly one signature (live: one each, 2026-11-06).
  IF EXISTS (SELECT 1 FROM (VALUES ('_reverse_credit_memo_application'), ('_reverse_write_off_replay_impl_20261015'), ('apply_credit_memo_to_invoice'), ('_apply_prepay_to_invoice_replay_impl_20261015'), ('_apply_write_off_replay_impl_20261015'), ('_post_commission_payment_intent_impl_20260809'), ('_void_commission_payment_intent_impl_20260809'), ('_void_payment_replay_impl_20261015'), ('_create_commission_payment_intent_impl_20260809'), ('_save_quote_below_cost_impl_20260810'), ('get_ar_reminder_candidates'), ('_enforce_applicator_license'), ('_dispatch_job_locations_replay_impl_20261015'), ('generate_rup_sales_records'), ('get_dispatch_stock_status'), ('get_job_inventory_shortfalls'), ('_get_inventory_position_cost_impl_20261019'), ('_create_inventory_hold_intent_impl_20260905'), ('_transition_rebate_claim_replay_impl_20261015'), ('_create_rush_order_below_cost_impl_20260810'), ('_create_followup_delivery_replay_impl_20261015'), ('_create_job_from_quote_section_replay_impl_20261015'), ('_batch_reschedule_deliveries_replay_impl_20261015'), ('_save_field_crop_history_replay_impl_20261015'), ('_save_field_app_split_invoice_impl'), ('snapshot_field_crop_history'), ('create_vendor_bill'), ('record_vendor_payment'), ('create_order_from_blend_ticket'), ('create_quick_delivery'), ('reverse_credit_memo_application'), ('_unapply_return_credit_guard_impl_20260826'), ('_void_invoice_split_provenance_impl_20260719')) t(n)
              WHERE (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = t.n) <> 1) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: a function this file replaces has another overload; re-review before replacing it';
  END IF;
  IF EXISTS (SELECT 1 FROM rup_sales_records r JOIN invoices i ON i.id = r.invoice_id
              WHERE r.sale_date IS DISTINCT FROM LEAST(i.invoice_date, (r.created_at AT TIME ZONE 'America/Chicago')::date)) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: RUP sales records exist whose sale date is not the earlier of their invoice date and Chicago creation day; plan their correction before applying';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._reverse_credit_memo_application(p_application_id uuid, p_actor uuid, p_actor_role text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_previous_admin_override text := current_setting('app.admin_override', true);
  v_previous_reversal_status text := current_setting('app.credit_reversal_status', true);
  v_session_actor uuid := auth.uid();
BEGIN
  -- idempotency-body-check: exempt
  -- Internal helper: idempotency is owned by each public SECDEF caller. Keep
  -- the inherited service_role grant, but do not let a direct caller forge the
  -- actor written to the immutable reversal ledger.
  IF v_session_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM v_session_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  PERFORM set_config('app.credit_reversal_status', 'true', true);
  BEGIN
    PERFORM public._reverse_credit_memo_application_status_impl_20260812(
      p_application_id, p_actor, p_actor_role, p_reason
    );

    -- This trusted re-derivation can legitimately move an overdue invoice back
    -- to posted after its due date was corrected forward. Keep the existing
    -- global transition matrix closed and scope its established override to
    -- this one status-only UPDATE, restoring the caller's prior setting.
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE public.invoices i
       SET status = CASE
         WHEN i.due_date < (now() AT TIME ZONE 'America/Chicago')::date THEN 'overdue'
         ELSE 'posted'
       END,
           updated_at = now()
      FROM public.credit_memo_applications a
     WHERE a.id = p_application_id
       AND i.id = a.target_invoice_id
       AND i.status IN ('paid', 'posted', 'overdue')
       AND i.balance_cents > 0;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.admin_override', COALESCE(v_previous_admin_override, ''), true);
    PERFORM set_config('app.credit_reversal_status', COALESCE(v_previous_reversal_status, ''), true);
    RAISE;
  END;
  PERFORM set_config('app.admin_override', COALESCE(v_previous_admin_override, ''), true);
  PERFORM set_config('app.credit_reversal_status', COALESCE(v_previous_reversal_status, ''), true);
END;
$function$;

CREATE OR REPLACE FUNCTION public._reverse_write_off_replay_impl_20261015(p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid;
  v_wo             record;
  v_existing       jsonb;
  v_new_balance    bigint;
  v_old_status     text;
  v_due_date       date;
  v_new_status     text;
  v_status_changed boolean;
  v_result         jsonb;
BEGIN
  -- Strict-actor: derive from JWT, never trust a client-supplied UUID.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF (SELECT role FROM profiles WHERE id = v_actor AND is_active = true) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reverse write-offs';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reverse a write-off';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'reverse_write_off';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_wo
    FROM write_offs
   WHERE id = p_write_off_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Write-off not found: %', p_write_off_id;
  END IF;

  IF v_wo.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Write-off has already been reversed';
  END IF;

  -- OVERNIGHT FIX (finding #2): reversing a write-off retroactively changes AR and writes the
  -- append-only ledger; gate on the write-off's booked date so a closed period blocks it
  -- (Hard Red Line: never bypass check_period_open).
  PERFORM check_period_open((v_wo.created_at AT TIME ZONE 'UTC')::date); PERFORM check_period_open((v_wo.created_at AT TIME ZONE 'America/Chicago')::date);

  SELECT status, due_date INTO v_old_status, v_due_date
    FROM invoices
   WHERE id = v_wo.invoice_id
   FOR UPDATE;

  IF v_old_status IS NULL THEN
    RAISE EXCEPTION 'Invoice not found for write-off %: %', p_write_off_id, v_wo.invoice_id;
  END IF;

  UPDATE invoices
     SET write_off_cents = GREATEST(COALESCE(write_off_cents, 0) - v_wo.amount_cents, 0),
         updated_at      = now()
   WHERE id = v_wo.invoice_id;

  SELECT balance_cents INTO v_new_balance
    FROM invoices
   WHERE id = v_wo.invoice_id;

  IF v_old_status = 'paid' AND v_new_balance > 0 THEN
    IF v_due_date IS NOT NULL AND v_due_date < (now() AT TIME ZONE 'America/Chicago')::date THEN
      v_new_status := 'overdue';
    ELSE
      v_new_status := 'posted';
    END IF;
    UPDATE invoices
       SET status     = v_new_status,
           updated_at = now()
     WHERE id = v_wo.invoice_id;
    v_status_changed := true;
  ELSE
    v_new_status := v_old_status;
    v_status_changed := false;
  END IF;

  UPDATE write_offs
     SET reversed_at     = now(),
         reversed_by     = v_actor,
         reversed_reason = p_reason
   WHERE id = p_write_off_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'write_off_reversed', 'write_off', p_write_off_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'amount_cents',   v_wo.amount_cents,
      'reversed_at',    null,
      'invoice_status', v_old_status
    ),
    jsonb_build_object(
      'reversed_at',       now(),
      'reverse_reason',    p_reason,
      'invoice_status',    v_new_status,
      'new_balance_cents', v_new_balance
    ),
    v_wo.amount_cents,
    'Write-off of ' || (v_wo.amount_cents::numeric / 100)::text ||
      ' reversed on invoice ' || v_wo.invoice_id::text || ': ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'write_off_reversed',
    'Write-off of $' || (v_wo.amount_cents::numeric / 100)::text || ' reversed: ' || p_reason,
    v_actor, 'invoice', v_wo.invoice_id, v_wo.customer_id
  );

  v_result := jsonb_build_object(
    'success',           true,
    'write_off_id',      p_write_off_id,
    'amount_cents',      v_wo.amount_cents,
    'invoice_id',        v_wo.invoice_id,
    'new_balance_cents', v_new_balance,
    'status_changed',    v_status_changed,
    'new_status',        v_new_status
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'reverse_write_off', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_credit_memo_to_invoice(p_credit_memo_id uuid, p_target_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor      uuid;
  v_actor_role text;
  v_memo       record;
  v_target     record;
  v_first      uuid;
  v_second     uuid;
  v_remaining  bigint;
  v_app_id     uuid;
  v_existing   jsonb;
BEGIN
  -- ---- gates (auth / actor / role) ----
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  -- Codex BLOCKER: an inactive/absent profile yields NULL, and `NULL NOT IN (...)` is NOT true,
  -- so the bare NOT IN would let a deactivated-but-still-authenticated user through. Guard the NULL.
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only active admins and sales reps can apply credit memos';
  END IF;

  -- ---- cheap argument guards ----
  IF p_credit_memo_id = p_target_invoice_id THEN
    RAISE EXCEPTION 'INVALID_TARGET: a credit memo cannot be applied to itself';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: application amount must be positive';
  END IF;

  -- ---- idempotency bound to (memo, target, amount) — Codex #3 ----
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'apply_credit_memo_to_invoice');
    IF v_existing IS NOT NULL THEN
      IF (v_existing->>'credit_memo_id')::uuid    IS DISTINCT FROM p_credit_memo_id
      OR (v_existing->>'target_invoice_id')::uuid IS DISTINCT FROM p_target_invoice_id
      OR (v_existing->>'amount_cents')::bigint     IS DISTINCT FROM p_amount_cents THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: key % was already used for a different credit application', p_idempotency_key;
      END IF;
      RETURN (v_existing->>'application_id')::uuid;
    END IF;
  END IF;

  -- ---- lock BOTH invoices, ordered by id (deadlock-safe), then read current state ----
  IF p_credit_memo_id < p_target_invoice_id THEN
    v_first := p_credit_memo_id; v_second := p_target_invoice_id;
  ELSE
    v_first := p_target_invoice_id; v_second := p_credit_memo_id;
  END IF;
  PERFORM 1 FROM invoices WHERE id = v_first  FOR UPDATE;
  PERFORM 1 FROM invoices WHERE id = v_second FOR UPDATE;

  -- Codex BLOCKER (concurrent replay): re-check idempotency AFTER acquiring the locks. Two
  -- simultaneous calls with the same key both pass the pre-lock check (neither committed yet),
  -- serialize on the lock, and would each create a separate application — double-applying the
  -- credit. The winner commits its cached result; the loser now sees it and returns it.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'apply_credit_memo_to_invoice');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'application_id')::uuid;
    END IF;
  END IF;

  SELECT * INTO v_memo   FROM invoices WHERE id = p_credit_memo_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_MEMO_NOT_FOUND'; END IF;
  SELECT * INTO v_target FROM invoices WHERE id = p_target_invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TARGET_INVOICE_NOT_FOUND'; END IF;

  -- ---- eligibility (re-checked after locking) ----
  IF v_memo.deleted_at IS NOT NULL OR v_target.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVOICE_DELETED';
  END IF;
  IF v_memo.invoice_type <> 'credit_memo' THEN
    RAISE EXCEPTION 'NOT_A_CREDIT_MEMO: % is a %', v_memo.invoice_number, v_memo.invoice_type;
  END IF;
  IF v_memo.status <> 'posted' THEN
    RAISE EXCEPTION 'CREDIT_MEMO_NOT_POSTED: % is %', v_memo.invoice_number, v_memo.status;
  END IF;
  IF v_target.invoice_type = 'credit_memo' THEN
    RAISE EXCEPTION 'TARGET_IS_CREDIT_MEMO: cannot apply a credit to another credit memo';
  END IF;
  IF v_target.status NOT IN ('posted', 'overdue') THEN
    RAISE EXCEPTION 'TARGET_NOT_OPEN: % is % (must be posted or overdue)', v_target.invoice_number, v_target.status;
  END IF;
  IF v_memo.customer_id IS DISTINCT FROM v_target.customer_id THEN
    RAISE EXCEPTION 'CUSTOMER_MISMATCH: credit memo and target invoice belong to different customers';
  END IF;

  PERFORM check_period_open((now() AT TIME ZONE 'America/Chicago')::date);

  -- ---- amount bounds ----
  v_remaining := -v_memo.balance_cents;  -- memo balance is <= 0; remaining credit is its magnitude
  IF p_amount_cents > v_remaining THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_CREDIT: $% requested but only $% credit remains on %',
      (p_amount_cents / 100.0)::numeric(12,2), (v_remaining / 100.0)::numeric(12,2), v_memo.invoice_number;
  END IF;
  IF p_amount_cents > v_target.balance_cents THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_BALANCE: $% requested but % only owes $%',
      (p_amount_cents / 100.0)::numeric(12,2), v_target.invoice_number, (v_target.balance_cents / 100.0)::numeric(12,2);
  END IF;

  -- ---- ledger row ----
  INSERT INTO credit_memo_applications (credit_memo_id, target_invoice_id, amount_cents, applied_by)
  VALUES (p_credit_memo_id, p_target_invoice_id, p_amount_cents, v_actor)
  RETURNING id INTO v_app_id;

  -- ---- consume the memo (its negative balance rises toward 0); status unchanged ----
  UPDATE invoices
     SET credit_applied_cents = credit_applied_cents + p_amount_cents,
         updated_at = now()
   WHERE id = p_credit_memo_id;

  -- ---- reduce the target; flip to paid when the (5-lever) balance hits 0 ----
  UPDATE invoices
     SET credit_applied_cents = credit_applied_cents + p_amount_cents,
         status = CASE
           WHEN (total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents
                 - (credit_applied_cents + p_amount_cents)) <= 0
           THEN 'paid' ELSE status END,
         updated_at = now()
   WHERE id = p_target_invoice_id;

  -- ---- audit: net-zero on the ledger (the memo already reduced AR when issued) — Codex #6.
  -- entity_type='credit_memo' (the closest allowed value; 'credit_memo_application' is not in
  -- the financial_audit_log entity_type CHECK). operation_type 'credit_memo_applied' is allowed.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'credit_memo_applied', 'credit_memo', v_app_id, v_actor, v_actor_role,
    jsonb_build_object(
      'application_id', v_app_id,
      'credit_memo_id', p_credit_memo_id, 'credit_memo_number', v_memo.invoice_number,
      'target_invoice_id', p_target_invoice_id, 'target_invoice_number', v_target.invoice_number,
      'amount_cents', p_amount_cents
    ),
    0,
    'Applied $' || (p_amount_cents / 100.0)::numeric(12,2) || ' credit ' || v_memo.invoice_number
      || ' to ' || v_target.invoice_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'apply_credit_memo_to_invoice',
      jsonb_build_object(
        'application_id', v_app_id,
        'credit_memo_id', p_credit_memo_id,
        'target_invoice_id', p_target_invoice_id,
        'amount_cents', p_amount_cents
      ));
  END IF;

  RETURN v_app_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public._apply_prepay_to_invoice_replay_impl_20261015(p_prepay_credit_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_credit    record;
  v_inv       record;
  v_app_id    uuid;
  v_actor     uuid;
  v_actor_role text;
  v_existing  jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  -- H1 fix: an inactive/absent profile yields NULL, and `NULL NOT IN (...)` is
  -- NOT TRUE, so the bare NOT IN would let a deactivated-but-authenticated user
  -- through. Guard the NULL explicitly.
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only active admins and sales reps can apply prepayments';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'apply_prepay_to_invoice');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'application_id')::uuid;
    END IF;
  END IF;

  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_prepay_credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepay credit not found'; END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  IF v_credit.customer_id IS DISTINCT FROM v_inv.customer_id THEN
    RAISE EXCEPTION 'CUSTOMER_MISMATCH: prepay credit % (customer %) cannot be applied to invoice % (customer %)',
      p_prepay_credit_id, v_credit.customer_id, p_invoice_id, v_inv.customer_id;
  END IF;

  IF v_inv.status NOT IN ('posted', 'overdue') THEN
    RAISE EXCEPTION 'Can only apply prepay to posted/overdue invoices (current status: %)', v_inv.status;
  END IF;

  PERFORM check_period_open((now() AT TIME ZONE 'America/Chicago')::date);

  IF p_amount_cents <= 0 THEN RAISE EXCEPTION 'Application amount must be positive'; END IF;

  IF p_amount_cents > v_credit.balance_cents THEN
    RAISE EXCEPTION 'Amount exceeds prepay balance ($%)', (v_credit.balance_cents / 100.0)::numeric(12,2);
  END IF;

  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Amount exceeds invoice balance ($%)', (v_inv.balance_cents / 100.0)::numeric(12,2);
  END IF;

  INSERT INTO prepay_applications (prepay_credit_id, invoice_id, applied_amount_cents)
  VALUES (p_prepay_credit_id, p_invoice_id, p_amount_cents)
  RETURNING id INTO v_app_id;

  UPDATE customers SET
    prepay_balance_cents = GREATEST(COALESCE(prepay_balance_cents, 0) - p_amount_cents, 0),
    updated_at = now()
  WHERE id = v_inv.customer_id;

  UPDATE invoices SET
    prepay_applied_cents = prepay_applied_cents + p_amount_cents,
    status = CASE
      -- CREDIT-APPLY: include credit_applied_cents in the →paid recompute
      WHEN (total_amount_cents - (paid_amount_cents + prepay_applied_cents + p_amount_cents) - write_off_cents - credit_applied_cents) <= 0
      THEN 'paid' ELSE status END,
    updated_at = now()
  WHERE id = p_invoice_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'prepay_applied', 'prepay', v_app_id, v_actor_role,
    jsonb_build_object(
      'prepay_credit_id', p_prepay_credit_id,
      'invoice_id', p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'amount_cents', p_amount_cents,
      'remaining_credit', v_credit.balance_cents - p_amount_cents
    ),
    p_amount_cents,
    'Applied $' || (p_amount_cents / 100.0)::numeric(12,2) || ' prepay to ' || v_inv.invoice_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'apply_prepay_to_invoice',
      jsonb_build_object('application_id', v_app_id)
    );
  END IF;

  RETURN v_app_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public._apply_write_off_replay_impl_20261015(p_invoice_id uuid, p_amount_cents bigint, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_invoice record;
  v_wo_id uuid;
  v_cached_result jsonb;
  v_new_write_off bigint;
  v_new_balance bigint;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := public.check_idempotency(p_idempotency_key, 'apply_write_off');
    IF v_cached_result IS NOT NULL THEN
      RETURN (v_cached_result->>'id')::uuid;
    END IF;
  END IF;

  SELECT id, customer_id, balance_cents, status, write_off_cents,
         invoice_number, invoice_date, total_amount_cents,
         paid_amount_cents, prepay_applied_cents,
         credit_applied_cents  -- CREDIT-APPLY: needed for the settled recompute
    INTO v_invoice
    FROM public.invoices
   WHERE id = p_invoice_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_NOT_FOUND'; END IF;
  IF v_invoice.status NOT IN ('posted', 'overdue') THEN
    RAISE EXCEPTION 'INVALID_INVOICE_STATUS: %', v_invoice.status;
  END IF;
  PERFORM public.check_period_open((now() AT TIME ZONE 'America/Chicago')::date);
  IF p_amount_cents <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_amount_cents > v_invoice.balance_cents THEN RAISE EXCEPTION 'AMOUNT_EXCEEDS_BALANCE'; END IF;

  INSERT INTO public.write_offs (invoice_id, customer_id, amount_cents, reason, approved_by, created_by)
  VALUES (p_invoice_id, v_invoice.customer_id, p_amount_cents, p_reason, v_actor, v_actor)
  RETURNING id INTO v_wo_id;

  v_new_write_off := COALESCE(v_invoice.write_off_cents, 0) + p_amount_cents;
  v_new_balance := v_invoice.total_amount_cents
                 - v_invoice.paid_amount_cents
                 - v_invoice.prepay_applied_cents
                 - v_new_write_off
                 - v_invoice.credit_applied_cents;  -- CREDIT-APPLY

  UPDATE public.invoices
     SET write_off_cents = v_new_write_off,
         status = CASE WHEN v_new_balance <= 0 THEN 'paid' ELSE status END,
         updated_at = now()
   WHERE id = p_invoice_id;

  INSERT INTO public.financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'write_off_applied', 'write_off', v_wo_id,
    v_actor, -p_amount_cents,
    'Write-off of $' || (p_amount_cents / 100.0)::numeric(12,2) ||
    ' on invoice ' || v_invoice.invoice_number || ': ' || p_reason ||
    CASE WHEN v_new_balance <= 0 THEN ' (fully settled - status set to paid)' ELSE '' END
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'apply_write_off',
      jsonb_build_object('id', v_wo_id)
    );
  END IF;

  RETURN v_wo_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public._post_commission_payment_intent_impl_20260809(p_payment_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_existing jsonb;
  v_payment  record;
  v_count    integer;
  v_item_count integer;
  v_item_total numeric;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to post a commission payment';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'post_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_payment FROM commission_payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission payment not found';
  END IF;

  IF v_payment.status = 'posted' THEN
    RAISE EXCEPTION 'Commission payment is already posted';
  END IF;
  IF v_payment.status = 'voided' THEN
    RAISE EXCEPTION 'Cannot post a voided commission payment';
  END IF;

  -- Lock and validate the immutable batch snapshot before changing any status.
  PERFORM 1
    FROM commission_payment_items
   WHERE commission_payment_id = p_payment_id
   FOR UPDATE;

  SELECT count(*), COALESCE(sum(amount), 0)
    INTO v_item_count, v_item_total
    FROM commission_payment_items
   WHERE commission_payment_id = p_payment_id;

  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_EMPTY: commission payment has no items and cannot be posted';
  END IF;
  IF v_item_total IS DISTINCT FROM v_payment.total_amount THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_TOTAL_MISMATCH: item total % does not match header total %',
      v_item_total, v_payment.total_amount;
  END IF;

  PERFORM check_period_open(COALESCE(v_payment.payment_date, (now() AT TIME ZONE 'America/Chicago')::date));

  UPDATE commission_payments
     SET status = 'posted',
         posted_by = v_actor,
         posted_at = now(),
         updated_at = now()
   WHERE id = p_payment_id;

  UPDATE commissions
     SET status = 'paid',
         paid_date = v_payment.payment_date
   WHERE id IN (
     SELECT commission_id FROM commission_payment_items
     WHERE commission_payment_id = p_payment_id
   )
     AND status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Commission batch-freeze guard (overnight bug-hunt HIGH, 20260620): every commission
  -- in this batch must still be 'pending'. If any was cancelled/voided out from under the
  -- batch (or already paid), the count flipped will differ from the batch's item count —
  -- refuse to post the stale batch rather than resurrect a cancelled commission to 'paid'
  -- and pay its retained snapshot. The admin must void and rebuild the batch.
  IF v_count <> v_item_count THEN
    RAISE EXCEPTION 'BATCH_COMMISSION_DRIFT: % of % batched commission(s) are no longer pending (cancelled or already paid). Void and rebuild this commission payment.', (v_item_count - v_count), v_item_count;
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_posted', 'commission_payment', p_payment_id,
    v_actor, (v_payment.total_amount * 100)::bigint,
    'Posted commission payment ' || v_payment.payment_number ||
    ' for $' || to_char(v_payment.total_amount, 'FM999,999,990.00') ||
    ' (' || v_count || ' commissions marked paid)'
  );

  v_result := jsonb_build_object(
    'success',           true,
    'payment_id',        p_payment_id,
    'payment_number',    v_payment.payment_number,
    'commissions_paid',  v_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'post_commission_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._void_commission_payment_intent_impl_20260809(p_payment_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_payment record;
  v_reset_count integer;
  v_cancelled_count integer;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_payment
  FROM commission_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'COMMISSION_PAYMENT_NOT_FOUND'; END IF;
  IF v_payment.status NOT IN ('posted', 'unposted') THEN
    RAISE EXCEPTION 'INVALID_COMMISSION_PAYMENT_STATUS: %', v_payment.status;
  END IF;

  PERFORM check_period_open(COALESCE(v_payment.payment_date, (now() AT TIME ZONE 'America/Chicago')::date));

  UPDATE commission_payments SET
    status = 'voided',
    voided_at = transaction_timestamp(),
    voided_by = v_actor,
    updated_at = now()
  WHERE id = p_payment_id;

  UPDATE commissions c SET
    status = 'pending',
    paid_date = NULL
  WHERE c.id IN (
    SELECT commission_id FROM commission_payment_items
    WHERE commission_payment_id = p_payment_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = c.order_id
      AND (o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL)
  )
  AND NOT (
    c.job_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.id = c.invoice_id
        AND i.status NOT IN ('voided', 'cancelled')
        AND i.deleted_at IS NULL
    )
  )
  AND c.status <> 'cancelled';
  GET DIAGNOSTICS v_reset_count = ROW_COUNT;

  UPDATE commissions c SET
    status = 'cancelled',
    commission_amount = 0,
    paid_date = NULL
  WHERE c.id IN (
    SELECT commission_id FROM commission_payment_items
    WHERE commission_payment_id = p_payment_id
  )
  AND (
    EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = c.order_id
        AND (o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL)
    )
    OR (
      c.job_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM invoices i
        WHERE i.id = c.invoice_id
          AND i.status NOT IN ('voided', 'cancelled')
          AND i.deleted_at IS NULL
      )
    )
  );
  GET DIAGNOSTICS v_cancelled_count = ROW_COUNT;

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_role,
    old_values, new_values, description
  ) VALUES (
    'commission_payment_voided', 'commission_payment', p_payment_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', v_payment.status, 'total_amount', v_payment.total_amount),
    jsonb_build_object('status', 'voided', 'commissions_reset', v_reset_count, 'commissions_cancelled_dead_order', v_cancelled_count),
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id
  ) VALUES (
    'commission_payment_voided',
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason,
    v_actor, 'commission_payment', p_payment_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'payment_number', v_payment.payment_number,
    'commissions_reset', v_reset_count,
    'commissions_cancelled_dead_order', v_cancelled_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_commission_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._void_payment_replay_impl_20261015(p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_set              record;
  v_alloc            record;
  v_actor            uuid;
  v_reversed_cents   bigint := 0;
  v_invoice_count    int    := 0;
  v_prepay_reversed  bigint := 0;
  v_old_balance      bigint;
  v_credit           record;
  v_app              record;
  v_apps_reversed_cents bigint := 0;
  v_existing         jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'void_payment';
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_set FROM allocation_sets WHERE id = p_allocation_set_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allocation set not found: %', p_allocation_set_id; END IF;
  IF NOT v_set.is_active THEN RAISE EXCEPTION 'Payment already voided'; END IF;

  PERFORM check_period_open(COALESCE(v_set.payment_date, (now() AT TIME ZONE 'America/Chicago')::date));

  FOR v_alloc IN
    SELECT ila.invoice_id, SUM(ila.amount_cents) AS total_amount
    FROM invoice_line_allocations ila
    WHERE ila.allocation_set_id = p_allocation_set_id AND ila.invoice_id IS NOT NULL
    GROUP BY ila.invoice_id
  LOOP
    UPDATE invoices
    SET paid_amount_cents = GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
        status = CASE
          WHEN status IN ('paid', 'posted') THEN
            -- CREDIT-APPLY: include credit_applied_cents in the settled recompute
            CASE WHEN (total_amount_cents - (GREATEST(paid_amount_cents - v_alloc.total_amount, 0) + prepay_applied_cents + write_off_cents + credit_applied_cents)) <= 0
                 THEN 'paid' ELSE 'posted' END
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_alloc.invoice_id;
    v_reversed_cents := v_reversed_cents + v_alloc.total_amount;
    v_invoice_count  := v_invoice_count + 1;
  END LOOP;

  FOR v_credit IN
    SELECT id, balance_cents
    FROM prepay_credits
    WHERE source_type = 'overpayment'
      AND customer_id = v_set.customer_id
      AND allocation_set_id = p_allocation_set_id
    FOR UPDATE
  LOOP
    FOR v_app IN
      SELECT pa.invoice_id, pa.applied_amount_cents
      FROM prepay_applications pa
      WHERE pa.prepay_credit_id = v_credit.id
    LOOP
      PERFORM 1 FROM invoices WHERE id = v_app.invoice_id FOR UPDATE;
      UPDATE invoices
      SET prepay_applied_cents = GREATEST(prepay_applied_cents - v_app.applied_amount_cents, 0),
          status = CASE
            WHEN status IN ('paid', 'posted') THEN
              CASE WHEN (total_amount_cents - (paid_amount_cents + GREATEST(prepay_applied_cents - v_app.applied_amount_cents, 0) + write_off_cents + credit_applied_cents)) <= 0
                   THEN 'paid' ELSE 'posted' END
            ELSE status
          END,
          updated_at = now()
      WHERE id = v_app.invoice_id;
      v_apps_reversed_cents := v_apps_reversed_cents + v_app.applied_amount_cents;
    END LOOP;

    DELETE FROM prepay_applications WHERE prepay_credit_id = v_credit.id;

    UPDATE prepay_credits
    SET balance_cents = 0, original_amount_cents = 0, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now()
    WHERE id = v_credit.id;
    v_prepay_reversed := v_prepay_reversed + v_credit.balance_cents;
  END LOOP;

  IF v_prepay_reversed > 0 THEN
    UPDATE customers SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0) WHERE id = v_set.customer_id;
  END IF;

  UPDATE allocation_sets SET is_active = false, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now() WHERE id = p_allocation_set_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
  ) VALUES (
    'payment_voided', 'allocation_set', p_allocation_set_id, v_actor,
    jsonb_build_object('total_payment_cents', v_set.total_payment_cents, 'total_allocated_cents', v_set.total_allocated_cents, 'payment_method', v_set.payment_method, 'check_number', v_set.check_number, 'customer_id', v_set.customer_id),
    jsonb_build_object('reason', p_reason, 'invoices_reversed', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed, 'prepay_applications_reversed_cents', v_apps_reversed_cents),
    -1 * v_reversed_cents,
    'Voided payment ' || COALESCE(v_set.check_number, v_set.reference_number, v_set.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'void_payment', to_jsonb(p_allocation_set_id));
  END IF;

  RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'reversed_cents', v_reversed_cents, 'invoices_affected', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed, 'prepay_applications_reversed_cents', v_apps_reversed_cents);
END;
$function$;

CREATE OR REPLACE FUNCTION public._create_commission_payment_intent_impl_20260809(p_commission_ids uuid[], p_payment_method text, p_reference text, p_payment_date date, p_notes text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor             uuid;
  v_existing          jsonb;
  v_payment_id        uuid;
  v_payment_num       text;
  v_total             numeric := 0;
  v_recipient_id      uuid;
  v_season            integer;
  v_payment_dt        date;
  v_selected_count    integer := 0;
  v_locked_count      integer := 0;
  v_non_pending_count integer := 0;
  v_recipient_count   integer := 0;
  v_already_in_payment integer := 0;
  v_item_count        integer := 0;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to create a commission payment';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_commission_payment');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing #>> '{}')::uuid;
    END IF;
  END IF;

  v_payment_dt := COALESCE(p_payment_date, (now() AT TIME ZONE 'America/Chicago')::date);

  PERFORM check_period_open(v_payment_dt);

  IF array_length(p_commission_ids, 1) IS NULL OR array_length(p_commission_ids, 1) = 0 THEN
    RAISE EXCEPTION 'No commissions selected for payment';
  END IF;

  SELECT count(*)
    INTO v_selected_count
    FROM (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids;

  IF v_selected_count = 0 THEN
    RAISE EXCEPTION 'No commissions selected for payment';
  END IF;

  -- Lock every selected existing row, regardless of status. The later checks
  -- then run against the locked set and cannot silently filter stale rows out.
  PERFORM 1
     FROM commissions c
     JOIN (
       SELECT DISTINCT id
       FROM unnest(p_commission_ids) AS selected(id)
     ) selected_ids ON selected_ids.id = c.id
    FOR UPDATE OF c;

  SELECT count(*)
    INTO v_locked_count
    FROM commissions c
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = c.id;

  IF v_locked_count <> v_selected_count THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_SELECTION_STALE: one or more selected commissions no longer exist';
  END IF;

  SELECT count(*)
    INTO v_non_pending_count
    FROM commissions c
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = c.id
   WHERE c.deleted_at IS NOT NULL
      OR c.status IS DISTINCT FROM 'pending';

  IF v_non_pending_count > 0 THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_SELECTION_STALE: every selected commission must still be pending';
  END IF;

  SELECT count(*)
    INTO v_already_in_payment
    FROM commission_payment_items cpi
    JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = cpi.commission_id
   WHERE cp.status IS DISTINCT FROM 'voided';

  IF v_already_in_payment > 0 THEN
    RAISE EXCEPTION 'One or more commissions are already in an existing (non-voided) payment. Void that payment first or remove those commissions from the selection.';
  END IF;

  SELECT count(DISTINCT c.recipient_user_id)
    INTO v_recipient_count
    FROM commissions c
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = c.id;

  IF v_recipient_count <> 1 THEN
    RAISE EXCEPTION 'All commissions in a payment must belong to the same recipient';
  END IF;

  SELECT c.recipient_user_id
    INTO v_recipient_id
    FROM commissions c
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = c.id
   LIMIT 1;

  SELECT sum(c.commission_amount)
    INTO v_total
    FROM commissions c
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = c.id;

  v_season := compute_season(v_payment_dt);
  v_payment_num := next_commission_payment_number();

  INSERT INTO commission_payments (
    payment_number, recipient_id, total_amount, status,
    payment_method, reference_number, payment_date, notes, season, created_by
  ) VALUES (
    v_payment_num, v_recipient_id, v_total, 'unposted',
    p_payment_method, p_reference, v_payment_dt,
    p_notes, v_season, v_actor
  ) RETURNING id INTO v_payment_id;

  INSERT INTO commission_payment_items (
    commission_payment_id, commission_id, amount
  )
  SELECT v_payment_id, c.id, c.commission_amount
    FROM commissions c
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = c.id
   WHERE c.deleted_at IS NULL
     AND c.status = 'pending';

  GET DIAGNOSTICS v_item_count = ROW_COUNT;
  IF v_item_count <> v_selected_count THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_SELECTION_STALE: expected % commission payment item(s), inserted %',
      v_selected_count, v_item_count;
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_created', 'commission_payment', v_payment_id,
    v_actor, (v_total * 100)::bigint,
    'Commission payment ' || v_payment_num || ' created (UNPOSTED) for $' ||
    to_char(v_total, 'FM999,999,990.00') || ' to ' ||
    (SELECT full_name FROM profiles WHERE id = v_recipient_id)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_commission_payment', to_jsonb(v_payment_id::text));
  END IF;

  RETURN v_payment_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public._save_quote_below_cost_impl_20260810(p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_quote_id uuid;
  v_section_id uuid;
  v_item jsonb;
  v_section jsonb;
  v_status text;
  v_old_status text;
  v_quote_owner uuid;
  v_old_commission_split jsonb;
  v_old_row_version bigint;
  v_expected_row_version bigint;
  v_tier int;
  v_server_totals record;
  v_drawn_guard record;
  v_allowed_transitions jsonb := '{
    "draft": ["sent"],
    "sent": ["revised","accepted","declined","expired"],
    "revised": ["sent","accepted","declined","expired"]
  }'::jsonb;
  v_cached_quote_id uuid;
  v_cached_row_version bigint;
  v_existing jsonb;
  v_result jsonb;
  v_request_fingerprint text;
  -- SNAPSHOT<<< prior-item cost map (id -> {p: product_id, c: cost}) captured
  -- before the delete+reinsert. Strictly id-keyed; no product_id fallback.
  v_prior_item_costs jsonb := '{}'::jsonb;
  -- Ids already claimed by an earlier payload row in THIS save. Each prior id
  -- may be consumed at most once (P1-B); a repeat is a hard domain error.
  v_consumed_item_ids jsonb := '{}'::jsonb;
  -- Per-row scratch for the reinsert loop.
  v_payload_item_id text;
  v_reuse_item_id uuid;
  v_preserved_cost bigint;
  v_consumed_prior_ids jsonb := '{}'::jsonb;
  v_fallback_prior_id text;
  v_fallback_distinct_costs int;
  v_idless_by_product jsonb := '{}'::jsonb;
  v_idless_count int;
  v_fallback_candidates int;
  -- The id actually written for this row, and the client-key -> id map returned
  -- to the caller. save_quote deletes and reinserts every line, so a browser
  -- that added new lines has no way to learn their ids; without this it keeps
  -- sending them id-less forever and the second save trips the ambiguity guard
  -- (two new lines of one product). client_key is an opaque caller-supplied
  -- string used only to address the response -- it is never an id and never
  -- influences which snapshot a row receives. (Codex round 28.)
  v_new_item_id uuid;
  v_client_key text;
  v_item_ids jsonb := '{}'::jsonb;
  -- PRICE OVERRIDE (20261029120000): saved line ids the rep ticked "grower agreed" on.
  v_confirmed_ids jsonb := '{}'::jsonb;
  v_pc record;
  -- >>>SNAPSHOT
  -- PRICE LOCK (20261027040000): a quote that has been sent (it has a quote_versions row) keeps
  -- each existing line's stored price on every save. Only a manual price (price_override) or the
  -- line's use_todays_price flag changes it; a new line takes today's tier price. A draft that was
  -- never sent follows the catalog as before (Mason, 2026-10-14).
  v_price_locked boolean := false;
  v_carry_prices jsonb := '{}'::jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND role IN ('admin','sales_rep') AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not authorized to save quotes';
  END IF;

  v_request_fingerprint := md5(jsonb_build_object(
    'quote_id', p_quote_id,
    'quote_payload', p_quote_payload,
    'sections', p_sections,
    'performed_by', p_performed_by
  )::text);

  -- Quote ownership is checked before the idempotency lookup so a SECURITY
  -- DEFINER replay cannot expose another rep's result. The check is deliberately
  -- non-locking here: every idempotent Quote writer must take the advisory lock
  -- before any Quote row lock. Ownership is checked again under the later row
  -- lock before a replay return or direct mutation.
  IF p_quote_id IS NOT NULL
     AND NOT public.is_admin()
     AND NOT EXISTS (
       SELECT 1 FROM quotes
       WHERE id = p_quote_id
         AND (created_by = v_actor OR current_setting('crx.price_only_quote_save', true) = p_quote_id::text)
     ) THEN
    RAISE EXCEPTION 'NOT_QUOTE_OWNER';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_quote');
    IF v_existing IS NOT NULL THEN
      -- A create replay has no p_quote_id to authorize before the lookup, so
      -- bind the cached result to its real target before releasing it. Existing
      -- saves must also reject a key cached for a different quote.
      v_cached_quote_id := NULLIF(v_existing->>'quote_id', '')::uuid;
      IF v_cached_quote_id IS NULL THEN
        RAISE EXCEPTION 'SAVE_QUOTE_RESULT_INVALID';
      END IF;
      IF p_quote_id IS NOT NULL
         AND p_quote_id IS DISTINCT FROM v_cached_quote_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      IF NOT public.is_admin()
         AND NOT EXISTS (
           SELECT 1 FROM quotes
           WHERE id = v_cached_quote_id
             AND (created_by = v_actor OR current_setting('crx.price_only_quote_save', true) = v_cached_quote_id::text)
      ) THEN
        RAISE EXCEPTION 'NOT_QUOTE_OWNER';
      END IF;
      IF v_existing->>'_request_fingerprint' IS DISTINCT FROM v_request_fingerprint THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      IF jsonb_typeof(v_existing->'row_version') <> 'number'
         OR (v_existing->>'row_version') !~ '^(0|[1-9][0-9]*)$' THEN
        RAISE EXCEPTION 'SAVE_QUOTE_RESULT_INVALID';
      END IF;
      v_cached_row_version := (v_existing->>'row_version')::bigint;
      SELECT created_by, row_version
        INTO v_quote_owner, v_old_row_version
      FROM quotes
      WHERE id = v_cached_quote_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after the saved request completed — reload to review the current quote before continuing';
      END IF;
      IF NOT public.is_admin() AND v_quote_owner IS DISTINCT FROM v_actor AND current_setting('crx.price_only_quote_save', true) IS DISTINCT FROM v_cached_quote_id::text THEN
        RAISE EXCEPTION 'NOT_QUOTE_OWNER';
      END IF;
      IF v_old_row_version IS DISTINCT FROM v_cached_row_version THEN
        RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after the saved request completed — reload to review the current quote before continuing';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  v_status := COALESCE(p_quote_payload->>'status', 'draft');
  v_tier := COALESCE((p_quote_payload->>'tier')::int, 1);

  IF p_quote_id IS NOT NULL THEN
    -- LAYER2-COORD (#5): lock the quote row up front (FOR UPDATE) so the unplan
    -- guard's job_product_draws check below can't be raced by a concurrent job
    -- schedule (_sync_quote_job_reservations locks the same row FOR UPDATE, so
    -- the two serialize). Was: SELECT status ... WHERE id = p_quote_id;
    SELECT created_by, status, commission_split, row_version
      INTO v_quote_owner, v_old_status, v_old_commission_split, v_old_row_version
    FROM quotes WHERE id = p_quote_id FOR UPDATE;
    IF v_old_status IS NULL THEN
      RAISE EXCEPTION 'Quote not found: %', p_quote_id;
    END IF;
    IF NOT public.is_admin() AND v_quote_owner IS DISTINCT FROM v_actor AND current_setting('crx.price_only_quote_save', true) IS DISTINCT FROM p_quote_id::text THEN
      RAISE EXCEPTION 'NOT_QUOTE_OWNER';
    END IF;

    -- Lost-update guard (2026-07-22): when the client passes the split it
    -- originally loaded (commission_split_expected), reject a split overwrite
    -- if a different value landed in between (stale-tab last-write-wins).
    -- Callers that omit commission_split_expected behave exactly as before.
    IF p_quote_payload ? 'commission_split_expected'
       AND p_quote_payload->'commission_split' IS NOT NULL
       AND COALESCE(v_old_commission_split, 'null'::jsonb) IS DISTINCT FROM COALESCE(p_quote_payload->'commission_split_expected', 'null'::jsonb)
       AND COALESCE(v_old_commission_split, 'null'::jsonb) IS DISTINCT FROM p_quote_payload->'commission_split' THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_CONFLICT: this quote''s commission split was changed elsewhere after you opened it — reload the quote and re-apply your change';
    END IF;

    IF NOT (p_quote_payload ? 'row_version_expected')
       OR jsonb_typeof(p_quote_payload->'row_version_expected') <> 'number'
       OR (p_quote_payload->>'row_version_expected') !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after this page opened — reload to review the current quote before saving';
    END IF;
    v_expected_row_version := (p_quote_payload->>'row_version_expected')::bigint;
    IF v_expected_row_version IS DISTINCT FROM v_old_row_version THEN
      RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after this page opened — reload to review the current quote before saving';
    END IF;

    IF v_status IS DISTINCT FROM v_old_status THEN
      IF NOT (
        v_allowed_transitions->v_old_status IS NOT NULL
        AND v_allowed_transitions->v_old_status ? v_status
      ) THEN
        RAISE EXCEPTION 'Invalid status transition: % -> %', v_old_status, v_status;
      END IF;
    END IF;

    -- LAYER2<<< block unplanning a booking a scheduled job is still drawing from
    -- (Codex final push-gate P1 #1): if is_planned would become false while a live
    -- job_product_draws row exists for this quote, the UPDATE below + trailing
    -- _sync_planned_holds release the quote's crop_program holds, and the next job
    -- re-sync drops the draw (quote no longer planned-open) — reopening the full
    -- booking balance while the job still consumes the stock (double-count). Clear the
    -- job reservation via the job lifecycle (cancel/reschedule) before unplanning.
    IF COALESCE((p_quote_payload->>'is_planned')::boolean,
                (SELECT is_planned FROM quotes WHERE id = p_quote_id)) = false
       AND EXISTS (
         SELECT 1 FROM job_product_draws
         WHERE quote_id = p_quote_id AND quantity_drawn > 0
       ) THEN
      RAISE EXCEPTION 'BOOKING_HAS_JOB_RESERVATION: cannot unplan this booking — a scheduled job is still reserving product from it; cancel or reschedule the job first';
    END IF;
    -- >>>LAYER2

    v_quote_id := p_quote_id;
    v_price_locked := EXISTS (SELECT 1 FROM quote_versions WHERE quote_id = p_quote_id);

    -- SNAPSHOT<<< capture the existing lines' immutable quote-time costs BEFORE
    -- the delete+reinsert wipes them. One map, keyed strictly by quote_item id,
    -- each entry carrying the prior line's product_id so the reinsert can
    -- require id AND product to match (an echoed id cannot attach another
    -- line's snapshot to a different product). Deliberately NO product_id
    -- fallback: a genuinely new line for a product already on the quote must
    -- get today's cost from the trigger, not inherit an old snapshot.
    -- The map also drives ID REUSE (P1-A), so it deliberately includes rows
    -- whose cost_at_quote_cents is NULL: their id must stay stable too (their
    -- 'c' is JSON null, so the reinsert passes NULL and the trigger stamps).
    SELECT COALESCE(
             jsonb_object_agg(
               id::text,
               jsonb_build_object('p', product_id::text, 'c', cost_at_quote_cents, 'pp', price_per_unit)
             ),
             '{}'::jsonb)
      INTO v_prior_item_costs
    FROM quote_items
    WHERE quote_id = v_quote_id;

    -- RESERVATION PASS (Codex round 13). Every valid echoed id must be claimed
    -- BEFORE any id-less row is allowed to take a product fallback, because the
    -- payload order is not controlled by us. Changing a line from product A to
    -- product B on a quote that already contains B clears that line's id; if the
    -- changed row happens to be processed first, a single pass would let it
    -- claim the EXISTING B row's uuid and snapshot, and the real B row -- whose
    -- echoed id is now already consumed -- would fall through to a fresh stamp
    -- at today's catalog cost. With different quantities on the two lines that
    -- silently changes stored cost, profit, the converted order and commissions.
    -- Reserving first makes the outcome independent of payload order.
    FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections)
    LOOP
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
      LOOP
        v_payload_item_id := NULLIF(v_item->>'id', '');
        IF v_payload_item_id IS NOT NULL
           AND v_prior_item_costs ? v_payload_item_id
           AND v_prior_item_costs->v_payload_item_id->>'p' = v_item->>'product_id'
           AND NOT (v_consumed_prior_ids ? v_payload_item_id) THEN
          v_consumed_prior_ids := v_consumed_prior_ids || jsonb_build_object(v_payload_item_id, true);
        ELSIF (v_item->>'product_id') IS NOT NULL THEN
          -- Count the rows that will need a fallback, keyed by product. Two or
          -- more competing for the same product is unresolvable (below).
          v_idless_by_product := jsonb_set(
            v_idless_by_product,
            ARRAY[v_item->>'product_id'],
            to_jsonb(COALESCE((v_idless_by_product->>(v_item->>'product_id'))::int, 0) + 1),
            true);
        END IF;
      END LOOP;
    END LOOP;
    -- >>>SNAPSHOT

    DELETE FROM quote_sections WHERE quote_id = v_quote_id;
  ELSE
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'New quotes must start with status draft';
    END IF;

    INSERT INTO quotes (
      id, quote_number, customer_id, created_by, tier, status,
      commission_split, total_price, total_cost, total_profit, total_margin_pct,
      valid_days, expires_at, chosen_expiry_date, header_notes, footer_notes, is_planned, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      p_quote_payload->>'quote_number',
      (p_quote_payload->>'customer_id')::uuid,
      v_actor,
      v_tier,
      'draft',
      COALESCE(p_quote_payload->'commission_split', '{"splits":[]}'::jsonb),
      0, 0, 0, 0,
      COALESCE((p_quote_payload->>'valid_days')::int, 15),
      COALESCE((p_quote_payload->>'expires_at')::date, (now() AT TIME ZONE 'America/Chicago')::date + 15),
      -- SEASON END (20261029100000): the date the rep picked; NULL = season end.
      (p_quote_payload->>'chosen_expiry_date')::date,
      p_quote_payload->>'header_notes',
      p_quote_payload->>'footer_notes',
      COALESCE((p_quote_payload->>'is_planned')::boolean, false),
      now(), now()
    )
    RETURNING id INTO v_quote_id;
  END IF;

  -- SNAPSHOT<<< arm the trigger passthrough for THIS transaction only, right
  -- before the item reinsert loop. _snapshot_quote_item_cost otherwise stamps
  -- cost_at_quote_cents unconditionally from products (anti-forgery); this
  -- txn-local GUC (is_local => true, dies at COMMIT/ROLLBACK) is the trusted
  -- signal that the non-NULL values inserted below are the preserved
  -- quote-time snapshots. Direct PostgREST inserts cannot set it.
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '1', true);
  -- >>>SNAPSHOT

  FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections)
  LOOP
    INSERT INTO quote_sections (
      id, quote_id, section_name, sort_order, section_notes,
      section_header_notes, needed_by_date, field_id
    ) VALUES (
      gen_random_uuid(),
      v_quote_id,
      COALESCE(v_section->>'section_name', 'Section'),
      COALESCE((v_section->>'sort_order')::int, 0),
      v_section->>'section_notes',
      v_section->>'section_header_notes',
      NULLIF(v_section->>'needed_by_date', '')::date,
      NULLIF(v_section->>'field_id', '')::uuid
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      -- SNAPSHOT<<< resolve this payload row's identity BEFORE the INSERT.
      -- (a) consume-once (P1-B): any id repeated within one save is rejected
      --     here, so the caller sees a clear domain error instead of the
      --     primary-key violation that id reuse (below) would raise.
      -- (b) id reuse (P1-A): when the echoed id belongs to a prior line of
      --     THIS quote and that prior line's product matches, the reinserted
      --     row keeps the same uuid, so ids the still-open QuoteBuilder page
      --     holds remain valid across repeated saves without a refetch.
      v_payload_item_id := NULLIF(v_item->>'id', '');
      v_reuse_item_id := NULL;
      v_preserved_cost := NULL;
      IF v_payload_item_id IS NOT NULL THEN
        IF v_consumed_item_ids ? v_payload_item_id THEN
          RAISE EXCEPTION 'QUOTE_ITEM_ID_DUPLICATE: quote item ids must be unique within a save'
            USING ERRCODE = 'P0001';
        END IF;
        v_consumed_item_ids := v_consumed_item_ids || jsonb_build_object(v_payload_item_id, true);
        -- No not-consumed test here: the reservation pass above already claimed
        -- this id for this payload row, and the duplicate check immediately
        -- above guarantees no second row can present the same id.
        IF v_prior_item_costs ? v_payload_item_id
           AND v_prior_item_costs->v_payload_item_id->>'p' = v_item->>'product_id' THEN
          v_reuse_item_id := v_payload_item_id::uuid;
          -- A legacy NULL is not a monetary basis. Leave it NULL so the trusted
          -- INSERT trigger must establish a fresh, positive catalog basis (or
          -- reject the save) instead of manufacturing zero cost and profit.
          v_preserved_cost := (v_prior_item_costs->v_payload_item_id->>'c')::bigint;
        END IF;
      END IF;

      -- SNAPSHOT<<< product fallback when the id did not resolve.
      --
      -- A browser running the pre-snapshot bundle sends no ids at all, and even
      -- a current page clears the id of a line whose product changed. Earlier
      -- attempts to detect that (counting echoed ids, then a caller-declared
      -- capability flag) were both wrong: the count locked users out of a
      -- legitimate replace-every-line save, and the flag was caller-controlled,
      -- so a rep could set it, omit every id, and have unchanged lines
      -- re-stamped at today's catalog cost -- lowering the recorded basis and
      -- inflating profit and commission whenever a product got cheaper.
      --
      -- Match on the line's OWN quote and product instead, consuming each prior
      -- row at most once. This is not forgeable: the map is built only inside
      -- the owner-checked existing-quote branch and scoped to this quote, so the
      -- only cost a caller can inherit is one this very quote already recorded
      -- for that same product. Omitting an id can therefore no longer lower a
      -- cost basis -- at worst it preserves the honest historical value.
      IF v_reuse_item_id IS NULL AND (v_item->>'product_id') IS NOT NULL THEN
        -- AMBIGUITY CHECK. Both tests below apply ONLY when at least one
        -- unconsumed prior line of this product actually exists. With zero
        -- candidates there is no history to allocate and nothing to get wrong:
        -- every unresolved row is genuinely new and takes a fresh id and today's
        -- stamp. Gating on that matters -- an earlier revision refused whenever
        -- two id-less rows shared a product, which blocked the ordinary act of
        -- adding two new lines of a product the quote never carried, and no
        -- reload could clear it because new lines have no ids to supply.
        -- (Codex round 20.)
        SELECT COUNT(*), COUNT(DISTINCT COALESCE(val->>'c', '~'))
          INTO v_fallback_candidates, v_fallback_distinct_costs
        FROM jsonb_each(v_prior_item_costs) AS e(k, val)
        WHERE val->>'p' = v_item->>'product_id'
          AND NOT (v_consumed_prior_ids ? e.k);

        IF v_fallback_candidates > 0 THEN
          -- (a) Several unresolved payload rows competing for the same product's
          -- history: nothing says which is the pre-existing line and which was
          -- just swapped onto it, so iteration order would decide who keeps the
          -- recorded cost.
          v_idless_count := COALESCE((v_idless_by_product->>(v_item->>'product_id'))::int, 0);
          IF v_idless_count > 1 THEN
            RAISE EXCEPTION 'QUOTE_ITEM_AMBIGUOUS_COST: this save sent more than one line of the same product without identifying which existing line each one is. Reload the quote and re-apply your changes so every line keeps its own recorded cost.'
              USING ERRCODE = 'P0001';
          END IF;

          -- (b) Several prior lines of this product recorded at DIFFERENT costs.
          -- Same costs are interchangeable -- any pick is identical, so refusing
          -- there would be a lock-out for no gain.
          IF v_fallback_distinct_costs > 1 THEN
            RAISE EXCEPTION 'QUOTE_ITEM_AMBIGUOUS_COST: this quote has more than one line of the same product recorded at different costs, and this save did not identify which line is which. Reload the quote and re-apply your changes so each line keeps its own recorded cost.'
              USING ERRCODE = 'P0001';
          END IF;
        END IF;

        SELECT k INTO v_fallback_prior_id
        FROM jsonb_each(v_prior_item_costs) AS e(k, val)
        WHERE val->>'p' = v_item->>'product_id'
          AND NOT (v_consumed_prior_ids ? e.k)
        ORDER BY e.k
        LIMIT 1;

        IF v_fallback_prior_id IS NOT NULL THEN
          v_reuse_item_id := v_fallback_prior_id::uuid;
          v_preserved_cost := (v_prior_item_costs->v_fallback_prior_id->>'c')::bigint;
          v_consumed_prior_ids := v_consumed_prior_ids || jsonb_build_object(v_fallback_prior_id, true);
          v_fallback_prior_id := NULL;
        END IF;
      END IF;
      -- SNAPSHOT<<< settle this row's id once, so the same value can be both
      -- written and reported back to the caller under its client key.
      v_new_item_id := COALESCE(v_reuse_item_id, gen_random_uuid());
      -- PRICE LOCK: a line the caller names by its saved id (same product) keeps its stored
      -- price unless the caller asks for today's price on it. A line matched only by the
      -- one-per-product fallback keeps its cost but takes today's price, so the screen (which
      -- names every saved line) and the server agree; if that changes its price, the change is
      -- recorded below like any other (a raise needs the tick) and the sent-price check accepts it.
      IF v_price_locked AND v_reuse_item_id IS NOT NULL
         AND v_reuse_item_id::text = v_payload_item_id
         AND COALESCE((v_item->>'use_todays_price')::boolean, false) = false THEN
        v_carry_prices := v_carry_prices
          || jsonb_build_object(v_new_item_id::text, v_prior_item_costs->(v_reuse_item_id::text)->'pp');
      END IF;
      IF COALESCE((v_item->>'grower_confirmed')::boolean, false) THEN
        v_confirmed_ids := v_confirmed_ids || jsonb_build_object(v_new_item_id::text, true);
      END IF;
      v_client_key := NULLIF(v_item->>'client_key', '');
      IF v_client_key IS NOT NULL THEN
        v_item_ids := v_item_ids || jsonb_build_object(v_client_key, v_new_item_id::text);
      END IF;
      -- >>>SNAPSHOT
      INSERT INTO quote_items (
        id, quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, price_override, current_cost, suggested_rate, actual_rate,
        rate_unit, oz_per_acre, price_per_acre, acres,
        total_units_needed, unit_size, profit, total_price, net_margin,
        calc_mode, price_unit,
        cost_at_quote_cents -- SNAPSHOT: preserved value or NULL (trigger snapshots)
      ) VALUES (
        -- SNAPSHOT: reuse the echoed id when it matched a prior line of this
        -- quote (same product); otherwise mint a fresh one as before.
        v_new_item_id,
        v_quote_id,
        v_section_id,
        (v_item->>'product_id')::uuid,
        COALESCE((v_item->>'sort_order')::int, 0),
        v_item->>'notes',
        COALESCE((v_item->>'price_per_unit')::numeric, 0),
        (v_item->>'price_override')::numeric,
        COALESCE((v_item->>'current_cost')::numeric, 0),
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        -- Preserve 20260810150500 DELTA-B2: normalize transient client money
        -- before the already-live whole-cent constraints inspect the row.
        ROUND(COALESCE((v_item->>'profit')::numeric, 0), 2),
        ROUND(COALESCE((v_item->>'total_price')::numeric, 0), 2),
        COALESCE((v_item->>'net_margin')::numeric, 0),
        COALESCE(v_item->>'calc_mode', 'rate_acres'),
        v_item->>'price_unit',
        -- SNAPSHOT<<< carry the quote-time cost across the reinsert ONLY when
        -- the payload echoes a prior item id AND that prior line's product_id
        -- equals this row's product_id (id-echo forgery cannot move a snapshot
        -- onto a different product), and only once per prior id. Resolved into
        -- v_preserved_cost above; NULL here means the BEFORE INSERT trigger
        -- stamps today's products.current_cost — correct for genuinely new or
        -- changed-product lines (and for a prior line that never snapshotted).
        v_preserved_cost
        -- >>>SNAPSHOT
      );
    END LOOP;
  END LOOP;


  -- Disarm the passthrough the moment the reinsert loop closes (defense in
  -- depth: txn-local anyway, but nothing after this point may pass a supplied
  -- snapshot through the anti-forgery trigger).
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '0', true);

  WITH base AS (
    SELECT
      qi.id AS item_id,
      COALESCE(qi.calc_mode, 'rate_acres') AS calc_mode,
      COALESCE(qi.actual_rate, 0) AS ar,
      COALESCE(qi.acres, 0) AS ac,
      COALESCE(qi.total_units_needed, 0) AS client_units,
      COALESCE(qi.price_override, (v_carry_prices->>(qi.id::text))::numeric, CASE v_tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier3_price, p.tier1_price, 0)
      END) AS ppu,
      -- SNAPSHOT<<< was: COALESCE(p.current_cost, 0). Price cost from the
      -- immutable quote-time snapshot; live catalog cost only for a row the
      -- trigger could not snapshot (product missing a cost).
      (qi.cost_at_quote_cents / 100.0) AS cc,
      -- >>>SNAPSHOT
      COALESCE(rate_conv.factor_oz, 1) AS rate_oz,
      COALESCE(inv_conv.factor_oz, 1) AS inv_oz
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    LEFT JOIN unit_conversions rate_conv
      ON LOWER(rate_conv.unit) = LOWER(qi.rate_unit)
    LEFT JOIN unit_conversions inv_conv
      ON LOWER(inv_conv.unit) = LOWER(COALESCE(p.inventory_unit, p.unit_size, 'Ea'))
    WHERE qi.quote_id = v_quote_id
  ),
  calc AS (
    SELECT
      item_id,
      ppu,
      cc,
      calc_mode,
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0 AND inv_oz > 0
          THEN ROUND((client_units * inv_oz) / ac, 2)
        WHEN calc_mode = 'rate_acres'
          THEN ROUND(ar * rate_oz, 2)
        ELSE 0
      END AS oz_per_acre,
      CASE
        WHEN calc_mode = 'units_direct' THEN ROUND(client_units, 2)
        WHEN inv_oz > 0 THEN ROUND((ac * ar * rate_oz) / inv_oz, 2)
        ELSE 0
      END AS total_units,
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0
          THEN ROUND(ppu * client_units / ac, 2)
        WHEN calc_mode = 'rate_acres' AND inv_oz > 0
          THEN ROUND(ppu * (ar * rate_oz / inv_oz), 2)
        ELSE 0
      END AS price_per_acre
    FROM base
  ),
  final AS (
    SELECT
      item_id,
      ppu,
      cc,
      oz_per_acre,
      total_units,
      price_per_acre,
      ROUND(ppu * total_units, 2) AS total_price,
      -- SNAPSHOT<<< profit is settled revenue MINUS settled extended cost, not
      -- a rounding of the margin per unit. The reports compute it the first
      -- way; rounding (price - cost) * qty as one expression disagrees with
      -- them by a cent on fractional quantities whose extensions land on a
      -- half-cent, and that cent then rides into the converted order and the
      -- commission. One boundary, applied to each side. (Codex round 33.)
      ROUND(ppu * total_units, 2) - ROUND(cc * total_units, 2) AS profit,
      CASE
        WHEN ROUND(ppu * total_units, 2) > 0
          THEN ROUND((ROUND(ppu * total_units, 2) - ROUND(cc * total_units, 2))
                     / ROUND(ppu * total_units, 2) * 100, 2)
        ELSE 0
      END AS net_margin
      -- >>>SNAPSHOT
    FROM calc
  )
  UPDATE quote_items qi SET
    price_per_unit = f.ppu,
    current_cost = f.cc,
    oz_per_acre = f.oz_per_acre,
    total_units_needed = f.total_units,
    price_per_acre = f.price_per_acre,
    total_price = f.total_price,
    profit = f.profit,
    net_margin = f.net_margin
  FROM final f
  WHERE qi.id = f.item_id;

  -- PRICE OVERRIDE (20261029120000, Mason 2026-10-27): on a sent quote a saved line's price may
  -- change straight away, with no re-send. Each change is recorded (who, when, old and new price);
  -- a higher price needs the rep's "grower agreed" tick on this save, a lower one does not. Each
  -- row names the last send, and the price check (_assert_quote_prices_as_sent) trusts only rows
  -- since that send. Below-cost approval is unchanged.
  IF v_price_locked THEN
    FOR v_pc IN
      SELECT qi.id, qi.product_id, p.product_name,
             ROUND((v_prior_item_costs->(qi.id::text)->>'pp')::numeric * 100)::bigint AS old_cents,
             ROUND(qi.price_per_unit * 100)::bigint AS new_cents
        FROM quote_items qi
        JOIN products p ON p.id = qi.product_id
       WHERE qi.quote_id = v_quote_id
         AND v_prior_item_costs ? (qi.id::text)
         AND (v_prior_item_costs->(qi.id::text)->>'p') = qi.product_id::text
         AND ROUND((v_prior_item_costs->(qi.id::text)->>'pp')::numeric * 100)
             IS DISTINCT FROM ROUND(qi.price_per_unit * 100)
       ORDER BY qi.sort_order, qi.id
    LOOP
      IF v_pc.new_cents > v_pc.old_cents AND NOT (v_confirmed_ids ? (v_pc.id::text)) THEN
        RAISE EXCEPTION 'QUOTE_PRICE_RAISE_NEEDS_GROWER_CONFIRMATION: % goes up from $% to $%. Tick "Grower agreed" on that line, then save again.',
          v_pc.product_name, to_char(v_pc.old_cents / 100.0, 'FM999999990.00'), to_char(v_pc.new_cents / 100.0, 'FM999999990.00')
          USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO quote_price_changes (quote_id, quote_item_id, product_id, old_price_cents, new_price_cents,
        changed_by, grower_confirmed_by, grower_confirmed_at, sent_version)
      VALUES (v_quote_id, v_pc.id, v_pc.product_id, v_pc.old_cents, v_pc.new_cents, v_actor,
        CASE WHEN v_pc.new_cents > v_pc.old_cents THEN v_actor END,
        CASE WHEN v_pc.new_cents > v_pc.old_cents THEN now() END,
        (SELECT max(version_number) FROM quote_versions WHERE quote_id = v_quote_id));
    END LOOP;
  END IF;

  -- LAYER2<<< drawn-product guard counts ORDER + JOB draws (§6.5 / Codex round-2 P1):
  -- a line can't be reduced below what an order OR a scheduled job already drew from it.
  SELECT
    COALESCE(p.product_name, d.product_id::text) AS product_name,
    d.quantity_drawn,
    COALESCE(b.booked, 0) AS new_booked
  INTO v_drawn_guard
  FROM (
    SELECT product_id, SUM(qty) AS quantity_drawn
    FROM (
      SELECT product_id, quantity_drawn AS qty FROM quote_product_draws WHERE quote_id = v_quote_id AND quantity_drawn > 0
      UNION ALL
      SELECT product_id, quantity_drawn AS qty FROM job_product_draws WHERE quote_id = v_quote_id AND quantity_drawn > 0
    ) x
    GROUP BY product_id
  ) d
  LEFT JOIN (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items
    WHERE quote_id = v_quote_id
    GROUP BY product_id
  ) b ON b.product_id = d.product_id
  LEFT JOIN products p ON p.id = d.product_id
  WHERE d.quantity_drawn > 0
    AND COALESCE(b.booked, 0) < d.quantity_drawn
  ORDER BY d.quantity_drawn - COALESCE(b.booked, 0) DESC, d.product_id
  LIMIT 1;
  -- >>>LAYER2
  IF FOUND THEN
    IF v_drawn_guard.new_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot remove % — % already drawn',
        v_drawn_guard.product_name, v_drawn_guard.quantity_drawn;
    END IF;
    RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot reduce % below its already-drawn % (new total would be %)',
      v_drawn_guard.product_name, v_drawn_guard.quantity_drawn, v_drawn_guard.new_booked;
  END IF;

  SELECT
    COALESCE(SUM(total_price), 0) AS total_price,
    -- Settle each line's extended cost to cents BEFORE summing, matching the
    -- per-line profit boundary above. Summing raw current_cost * quantity let
    -- sub-cent extended costs into quotes.total_cost, so the header identity
    -- (revenue - cost = profit) broke on fractional quantities and the fraction
    -- rode into versions and conversion. (Codex round 41.)
    COALESCE(SUM(ROUND(current_cost * total_units_needed, 2)), 0) AS total_cost,
    COALESCE(SUM(profit), 0) AS total_profit
  INTO v_server_totals
  FROM quote_items
  WHERE quote_id = v_quote_id;

  -- One logical save must produce exactly one quote UPDATE. The row was
  -- already locked and its expected version checked before any children were
  -- replaced; combining header/status fields with the calculated totals keeps
  -- that lock order while ensuring the row-version trigger advances once.
  UPDATE quotes SET
    customer_id = (p_quote_payload->>'customer_id')::uuid,
    tier = v_tier,
    status = v_status,
    commission_split = CASE
      WHEN p_quote_payload->'commission_split' IS NOT NULL
      THEN p_quote_payload->'commission_split'
      ELSE commission_split
    END,
    valid_days = COALESCE((p_quote_payload->>'valid_days')::int, valid_days),
    -- PRICE LOCK: editing a sent quote keeps its expiry; only a send sets a new one.
    expires_at = CASE WHEN v_price_locked THEN expires_at
      ELSE COALESCE((p_quote_payload->>'expires_at')::date, expires_at) END,
    -- SEASON END (20261029100000): a key sent as null clears the pick (back to season end);
    -- a missing key keeps it. It takes effect at the next send.
    chosen_expiry_date = CASE WHEN p_quote_payload ? 'chosen_expiry_date'
      THEN (p_quote_payload->>'chosen_expiry_date')::date ELSE chosen_expiry_date END,
    header_notes = p_quote_payload->>'header_notes',
    footer_notes = p_quote_payload->>'footer_notes',
    is_planned = COALESCE((p_quote_payload->>'is_planned')::boolean, is_planned),
    sent_at = CASE
      WHEN v_status = 'sent' AND sent_at IS NULL THEN now()
      WHEN v_status = 'sent' THEN sent_at
      ELSE sent_at
    END,
    total_price = v_server_totals.total_price,
    total_cost = v_server_totals.total_cost,
    total_profit = v_server_totals.total_profit,
    total_margin_pct = CASE
      WHEN v_server_totals.total_price > 0
      THEN ROUND(v_server_totals.total_profit / v_server_totals.total_price * 100, 2)
      ELSE 0
    END,
    updated_at = now()
  WHERE id = v_quote_id;

  -- PRICE LOCK: a quote becomes accepted only at the prices, lines and customer last sent.
  -- Only the transition is checked, so a quote accepted earlier (whose last version may predate
  -- line ids) can still be saved.
  IF v_status = 'accepted' AND v_old_status IS DISTINCT FROM 'accepted' THEN
    PERFORM public._assert_quote_prices_as_sent(v_quote_id);
  END IF;

  INSERT INTO activity_feed (id, event_type, description, performed_by, related_entity_type, related_entity_id, created_at)
  VALUES (
    gen_random_uuid(),
    CASE WHEN p_quote_id IS NOT NULL THEN 'quote_updated' ELSE 'quote_created' END,
    'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' saved',
    v_actor,
    'quote',
    v_quote_id,
    now()
  );

  -- LAYER2-COORD (#4): re-sync this quote's ACTIVE jobs to the edited booking,
  -- then resync crop_program holds. _sync_quote_job_reservations rebuilds every
  -- active job's draws+holds (so a grown line re-draws its job, a shrunk line
  -- reallocates siblings) and ends by calling _sync_planned_holds itself, so it
  -- is a strict superset of the prior trailing `_sync_planned_holds(v_quote_id)`
  -- (identical for a quote with no jobs). Was: PERFORM _sync_planned_holds(...).
  PERFORM _sync_quote_job_reservations(v_quote_id, v_actor);

  v_result := jsonb_build_object(
    'status', 'saved',
    'quote_id', v_quote_id,
    '_request_fingerprint', v_request_fingerprint,
    'commission_split', (SELECT commission_split FROM quotes WHERE id = v_quote_id),
    'row_version', (SELECT row_version FROM quotes WHERE id = v_quote_id),
    -- SNAPSHOT<<< client_key -> quote_items.id for every line written by this
    -- save, so the caller can install real ids without a refetch. Included in
    -- the idempotency-stored result, so a replayed save returns the same map
    -- rather than leaving a retrying client id-less. (Codex round 28.)
    'item_ids', v_item_ids,
    -- >>>SNAPSHOT
    -- PRICE LOCK (20261027040000): client_key -> the price_per_unit this save stored, so the
    -- quote screen keeps each saved line at the price the database holds. Prices only; no cost.
    'item_prices', (
      SELECT COALESCE(jsonb_object_agg(e.key, qi.price_per_unit), '{}'::jsonb)
      FROM jsonb_each_text(v_item_ids) AS e(key, value)
      JOIN quote_items qi ON qi.id = e.value::uuid
    ),
    'server_totals', jsonb_build_object(
      'total_price', (SELECT total_price FROM quotes WHERE id = v_quote_id),
      'total_cost', (SELECT total_cost FROM quotes WHERE id = v_quote_id),
      'total_profit', (SELECT total_profit FROM quotes WHERE id = v_quote_id),
      'total_margin_pct', (SELECT total_margin_pct FROM quotes WHERE id = v_quote_id)
    )
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_quote', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_ar_reminder_candidates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result jsonb;
  _role  text;
  v_setting_raw text;
  v_num numeric;
  v_threshold int;
BEGIN
  -- Active admins only, from the profile (no JWT claim shortcut); NULL-safe.
  SELECT role INTO _role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF _role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  -- Configurable threshold (Settings > app_settings.ar_reminder_days). Robust: take the LEADING
  -- integer part (so '30', '30.0', ' 45 ' all read as 30/30/45 — NOT digit-stripping, which would
  -- turn '30.0'->300 or '1e2'->12), default 30 on blank/garbage/missing, clamp 1..3650 so a bad
  -- value can never break the report.
  SELECT setting_value INTO v_setting_raw FROM app_settings WHERE setting_key = 'ar_reminder_days';
  v_num := (regexp_match(COALESCE(v_setting_raw, ''), '^\s*(\d+)'))[1]::numeric;
  v_threshold := CASE WHEN v_num IS NULL THEN 30 ELSE LEAST(GREATEST(v_num, 1), 3650)::int END;

  SELECT COALESCE(jsonb_agg(row_to_json(cust_agg)::jsonb), '[]'::jsonb)
  INTO result
  FROM (
    SELECT
      c.id AS customer_id,
      c.farm_name,
      c.email,
      c.prepay_balance_cents,
      (SELECT COALESCE(-SUM(ci.balance_cents), 0)::bigint
         FROM invoices ci
        WHERE ci.customer_id = c.id
          AND ci.invoice_type = 'credit_memo'
          AND ci.status = 'posted'
          AND ci.balance_cents < 0
          AND ci.deleted_at IS NULL) AS open_credit_cents,
      MAX(((now() AT TIME ZONE 'America/Chicago')::date - COALESCE(i.due_date, i.invoice_date))) AS max_days_past_due,
      COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0) / 100.0 AS total_balance,
      jsonb_agg(jsonb_build_object(
        'invoice_id', i.id,
        'invoice_number', i.invoice_number,
        'invoice_date', i.invoice_date,
        'balance_cents', i.balance_cents,
        'days_past_due', ((now() AT TIME ZONE 'America/Chicago')::date - COALESCE(i.due_date, i.invoice_date))
      ) ORDER BY i.invoice_date) AS invoices
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status IN ('posted', 'overdue')
      AND i.balance_cents > 0
      AND ((now() AT TIME ZONE 'America/Chicago')::date - COALESCE(i.due_date, i.invoice_date)) > v_threshold
      AND c.email IS NOT NULL
      AND c.email <> ''
    GROUP BY c.id, c.farm_name, c.email, c.prepay_balance_cents
    ORDER BY max_days_past_due DESC
  ) cust_agg;

  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._enforce_applicator_license()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_has_licenses boolean;
  v_latest_expiry date;
BEGIN
  IF NEW.applicator_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.applicator_id IS NOT DISTINCT FROM OLD.applicator_id THEN
    RETURN NEW;
  END IF;
  IF _is_admin_override() THEN
    RETURN NEW;
  END IF;

  SELECT count(*) > 0, max(expiry_date)
    INTO v_has_licenses, v_latest_expiry
    FROM applicator_licenses
   WHERE profile_id = NEW.applicator_id
     AND is_active = true;

  IF NOT v_has_licenses THEN
    RETURN NEW;
  END IF;

  IF v_latest_expiry < (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'LICENSE_EXPIRED: applicator license expired %', v_latest_expiry;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public._dispatch_job_locations_replay_impl_20261015(p_assignments jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_license_override boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'dispatch_job_locations');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_PAYLOAD: p_assignments must be a JSON array';
  END IF;
  IF jsonb_array_length(p_assignments) = 0 THEN
    RAISE EXCEPTION 'NO_ASSIGNMENTS: at least one assignment required';
  END IF;

  -- Reject a payload that lists the same location twice: each job_field_id maps to
  -- exactly ONE current dispatch, so a duplicate would upsert the same row twice and
  -- over-count the {dispatched} total + write a duplicate activity row (Codex
  -- re-review-9 P3). The wizard already de-dups via a selection Set; this guards a
  -- direct RPC caller.
  IF (SELECT count(*) FROM jsonb_array_elements(p_assignments) e) <>
     (SELECT count(DISTINCT nullif(e->>'job_field_id','')) FROM jsonb_array_elements(p_assignments) e) THEN
    RAISE EXCEPTION 'DUPLICATE_LOCATION: each job_field_id may appear at most once per dispatch';
  END IF;

  FOR v_assignment IN SELECT * FROM jsonb_array_elements(p_assignments)
  LOOP
    v_job_field  := nullif(v_assignment->>'job_field_id', '')::uuid;
    v_applicator := nullif(v_assignment->>'applicator_id', '')::uuid;
    v_crew       := nullif(v_assignment->>'crew_id', '')::uuid;

    IF v_job_field IS NULL THEN
      RAISE EXCEPTION 'INVALID_ASSIGNMENT: job_field_id is required';
    END IF;

    -- EXACTLY ONE assignee.
    IF (v_applicator IS NOT NULL) = (v_crew IS NOT NULL) THEN
      RAISE EXCEPTION 'ONE_ASSIGNEE_REQUIRED: each location needs exactly one of applicator_id / crew_id (job_field %)', v_job_field;
    END IF;

    -- Derive the real job for this location (never trust a client job_id).
    SELECT jf.job_id INTO v_job_id FROM job_fields jf WHERE jf.id = v_job_field;
    IF v_job_id IS NULL THEN
      RAISE EXCEPTION 'LOCATION_NOT_FOUND: job_field % does not exist', v_job_field;
    END IF;

    -- Only dispatch locations of a DISPATCHABLE job: a LIVE (not soft-deleted)
    -- job in scheduled/in_progress. This RPC is SECURITY DEFINER and bypasses RLS,
    -- so it must enforce deleted_at IS NULL itself — the board filters deleted_at,
    -- but a direct caller would otherwise dispatch a soft-deleted job (Codex #36 P2).
    -- FOR UPDATE locks the job row so a concurrent complete/cancel can't slip the
    -- job into a non-dispatchable status between this check and the upsert — the
    -- status-transition enforcer takes the same row lock, so they serialize and we
    -- never leave a dispatch row on a job that just became completed/cancelled
    -- (Codex re-review-8 P2 TOCTOU).
    SELECT status INTO v_job_status FROM jobs WHERE id = v_job_id AND deleted_at IS NULL FOR UPDATE;
    IF v_job_status IS NULL THEN
      RAISE EXCEPTION 'JOB_NOT_FOUND: job % missing or deleted', v_job_id;
    END IF;
    IF v_job_status NOT IN ('scheduled', 'in_progress') THEN
      RAISE EXCEPTION 'JOB_NOT_DISPATCHABLE: job % is % (must be scheduled or in_progress)', v_job_id, v_job_status;
    END IF;

    -- Validate the assignee.
    IF v_applicator IS NOT NULL THEN
      PERFORM 1 FROM profiles
        WHERE id = v_applicator AND is_active = true AND role = 'applicator';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVALID_APPLICATOR: % is not an active applicator', v_applicator;
      END IF;

      -- LICENSE GATE (Codex re-review P1): dispatching a location to an applicator
      -- whose tracked active licenses are ALL expired is blocked, mirroring the
      -- enforce_applicator_license trigger that guards jobs.applicator_id (this RPC
      -- writes the new table, never jobs, so that trigger does NOT fire — replicate
      -- it here). No license on file = allowed (gate only applies once licenses are
      -- tracked). p_license_override is the admin-only hatch (checked above) and any
      -- ACTUAL override (expired license dispatched anyway) is logged below (P2).
      SELECT count(*) > 0, max(expiry_date)
        INTO v_has_licenses, v_latest_expiry
        FROM applicator_licenses
       WHERE profile_id = v_applicator
         AND is_active = true;
      v_this_override := false;
      IF v_has_licenses AND v_latest_expiry < (now() AT TIME ZONE 'America/Chicago')::date THEN
        IF NOT p_license_override THEN
          RAISE EXCEPTION 'LICENSE_EXPIRED: applicator % license expired %', v_applicator, v_latest_expiry;
        END IF;
        v_this_override := true;          -- override actually exercised on this loc
        v_override_used := v_override_used + 1;
      END IF;
    ELSE
      v_this_override := false;
      PERFORM 1 FROM ground_crews WHERE id = v_crew AND is_active = true;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVALID_CREW: % is not an active crew', v_crew;
      END IF;
    END IF;

    -- UPSERT: one current dispatch per location; re-dispatch replaces assignee.
    INSERT INTO job_location_dispatches
      (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
    VALUES
      (v_job_field, v_job_id, v_applicator, v_crew, now(), 'dispatched', v_actor)
    ON CONFLICT (job_field_id) DO UPDATE
      SET applicator_id   = EXCLUDED.applicator_id,
          crew_id         = EXCLUDED.crew_id,
          job_id          = EXCLUDED.job_id,
          dispatched_at   = now(),
          dispatch_status = 'dispatched',
          dispatched_by   = v_actor;

    -- ACTIVITY LOG (Codex re-review-5 P2): every location dispatch lands on the
    -- job/customer timeline (the replaced assign_job_applicator flow logged each
    -- assignment; keep that audit trail). One row per location, with the assignee
    -- name, the field, and an override note when applicable.
    SELECT customer_id INTO v_job_cust FROM jobs WHERE id = v_job_id;
    IF v_applicator IS NOT NULL THEN
      SELECT full_name INTO v_assignee_label FROM profiles WHERE id = v_applicator;
      v_assignee_label := 'applicator ' || coalesce(v_assignee_label, v_applicator::text);
    ELSE
      SELECT name INTO v_assignee_label FROM ground_crews WHERE id = v_crew;
      v_assignee_label := 'crew ' || coalesce(v_assignee_label, v_crew::text);
    END IF;
    SELECT f.field_name INTO v_field_label
      FROM job_fields jf JOIN fields f ON f.id = jf.field_id WHERE jf.id = v_job_field;
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES (
      'job_location_dispatched',
      'Location ' || coalesce(v_field_label, '') || ' dispatched to ' || v_assignee_label
        || CASE WHEN v_this_override
                THEN ' with EXPIRED license (' || v_latest_expiry || ') — admin license override'
                ELSE '' END,
      v_actor, 'job', v_job_id, v_job_cust
    );

    v_count := v_count + 1;
  END LOOP;

  v_result := jsonb_build_object('dispatched', v_count, 'license_overrides', v_override_used);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'dispatch_job_locations', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_rup_sales_records(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer := 0;
  v_invoice record;
  v_item record;
  v_license record;
  v_compliance_status text;
  v_compliance_notes text;
  v_season integer;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  -- N2-4 role gate (matches the sole caller post_invoice): block applicators/drivers.
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to generate RUP sales records';
  END IF;

  SELECT i.id, i.order_id, o.customer_id, c.farm_name, i.invoice_date,
         i.invoice_number, i.status, i.deleted_at
  INTO v_invoice
  FROM invoices i
  JOIN orders o ON o.id = i.order_id
  JOIN customers c ON c.id = o.customer_id
  WHERE i.id = p_invoice_id
  FOR SHARE OF i;

  IF v_invoice IS NULL THEN RETURN 0; END IF;

  -- KI-05: register rows record a sale, so only a posted invoice may write them.
  IF v_invoice.status IS NULL OR v_invoice.status NOT IN ('posted', 'paid', 'overdue')
     OR v_invoice.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'RUP_INVOICE_NOT_POSTED: invoice % is % and not posted; RUP sales records are written only for a posted invoice',
      v_invoice.invoice_number,
      CASE WHEN v_invoice.deleted_at IS NOT NULL THEN 'deleted' ELSE coalesce(v_invoice.status, 'without a status') END;
  END IF;

  -- Replay only after the posted check, so a key reused for an unposted invoice cannot return a cached success.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'generate_rup_sales_records');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'count')::integer;
    END IF;
  END IF;

  v_season := CASE
    WHEN EXTRACT(MONTH FROM LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date)) >= 10
    THEN EXTRACT(YEAR FROM LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date))::integer + 1
    ELSE EXTRACT(YEAR FROM LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date))::integer
  END;

  FOR v_item IN
    SELECT ii.id, ii.product_id, p.product_name, ii.quantity, ii.unit_size,
           ii.unit_price_cents, ii.extended_cents,
           p.epa_registration, p.signal_word
    FROM invoice_items ii
    JOIN products p ON p.id = ii.product_id
    WHERE ii.invoice_id = p_invoice_id
      AND p.is_rup = true
  LOOP
    SELECT al.license_number, al.license_type, al.expiry_date, al.issued_date
    INTO v_license
    FROM applicator_licenses al
    WHERE al.customer_id = v_invoice.customer_id
      AND al.is_active = true
    ORDER BY ((al.issued_date IS NOT NULL AND al.issued_date <= LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date)) AND al.expiry_date >= GREATEST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date)) DESC, al.expiry_date DESC NULLS LAST
    LIMIT 1;

    IF v_license IS NULL OR v_license.license_number IS NULL THEN
      v_compliance_status := 'non_compliant';
      v_compliance_notes := 'No applicator license on file for this customer';
    ELSIF v_license.expiry_date IS NOT NULL AND v_license.expiry_date < GREATEST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date) THEN
      v_compliance_status := 'warning';
      v_compliance_notes := 'Applicator license expired on ' || v_license.expiry_date::text;
    ELSIF v_license.issued_date IS NULL THEN
      v_compliance_status := 'warning';
      v_compliance_notes := 'Applicator license issue date unknown';
    ELSIF v_license.issued_date > LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date) THEN
      v_compliance_status := 'warning';
      v_compliance_notes := 'Applicator license issued on ' || v_license.issued_date::text || ', after the sale date';
    ELSE
      v_compliance_status := 'compliant';
      v_compliance_notes := NULL;
    END IF;

    -- PARKED-006: dedup ignores voided rows so a legitimate re-post can record
    -- a fresh active sale even when a prior voided row exists.
    IF NOT EXISTS (
      SELECT 1 FROM rup_sales_records
      WHERE invoice_id = p_invoice_id
        AND product_id = v_item.product_id
        AND voided_at IS NULL
    ) THEN
      INSERT INTO rup_sales_records (
        invoice_id, order_id, customer_id, product_id,
        sale_date, product_name, epa_registration, quantity, unit,
        unit_price_cents, total_cents,
        buyer_name, buyer_certification_number,
        buyer_certification_type, buyer_certification_expiry,
        signal_word, compliance_status, compliance_notes,
        season, created_by
      ) VALUES (
        p_invoice_id, v_invoice.order_id, v_invoice.customer_id, v_item.product_id,
        LEAST(v_invoice.invoice_date, (now() AT TIME ZONE 'America/Chicago')::date), v_item.product_name, v_item.epa_registration, v_item.quantity, v_item.unit_size,
        v_item.unit_price_cents, v_item.extended_cents,
        v_invoice.farm_name,
        v_license.license_number,
        v_license.license_type,
        v_license.expiry_date,
        v_item.signal_word, v_compliance_status, v_compliance_notes,
        v_season, auth.uid()
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;

  v_result := jsonb_build_object('count', v_count);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'generate_rup_sales_records', v_result);
  END IF;

  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_dispatch_stock_status(p_job_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF p_job_ids IS NULL OR array_length(p_job_ids, 1) IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN (
    WITH jobs_in AS (
      SELECT j.id
      FROM jobs j
      WHERE j.id = ANY(p_job_ids)
        AND j.deleted_at IS NULL
        AND j.status IN ('scheduled', 'in_progress')
    ),
    demand AS (
      SELECT ji.id AS job_id, jc.product_id,
             SUM(COALESCE(
               -- D2 (U11 follow-up): normalize FIRST — 'pt/ac'-style units NULL out of the converter; mirrors complete_job.
               field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form),
               jc.quantity
             )) AS demand_qty
      FROM jobs_in ji
      JOIN job_chemicals jc ON jc.job_id = ji.id
      JOIN products p ON p.id = jc.product_id
      -- U4<<< a grower-supplied line demands nothing from our shed — exclude it
      -- from the dispatch stock light. (#102)
      WHERE jc.quantity > 0 AND jc.customer_supplied = false
      -- >>>U4
      GROUP BY ji.id, jc.product_id
    ),
    avail AS (
      SELECT i.product_id,
             SUM(i.quantity_available - i.quantity_prebooked) AS free_base,
             MAX(i.reorder_point) AS reorder_point
      FROM inventory i
      GROUP BY i.product_id
    ),
    total_holds AS (
      SELECT ih.product_id, SUM(ih.quantity) AS holds_qty
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= (now() AT TIME ZONE 'America/Chicago')::date)
      GROUP BY ih.product_id
    ),
    own_hold AS (
      SELECT ih.source_id AS job_id, ih.product_id, SUM(ih.quantity) AS own_qty
      FROM inventory_holds ih
      WHERE ih.hold_type = 'job'
        AND ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= (now() AT TIME ZONE 'America/Chicago')::date)
        AND ih.source_id = ANY(p_job_ids)
      GROUP BY ih.source_id, ih.product_id
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
    FROM (
      SELECT
        d.job_id,
        d.product_id,
        d.demand_qty,
        (a.product_id IS NOT NULL) AS has_inventory,
        (COALESCE(a.free_base, 0) - (COALESCE(th.holds_qty, 0) - COALESCE(oh.own_qty, 0)))
          AS free_excluding_own_hold,
        COALESCE(a.reorder_point, 0) AS reorder_point
      FROM demand d
      LEFT JOIN avail a        ON a.product_id  = d.product_id
      LEFT JOIN total_holds th ON th.product_id = d.product_id
      LEFT JOIN own_hold oh    ON oh.job_id = d.job_id AND oh.product_id = d.product_id
    ) r
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_job_inventory_shortfalls(p_days_ahead integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_admin_or_sales_rep();

  RETURN (
    WITH win_jobs AS (
      SELECT j.id, j.job_number, j.quote_id
      FROM jobs j
      WHERE j.status IN ('scheduled', 'in_progress')
        AND j.deleted_at IS NULL
        AND j.job_date >= (now() AT TIME ZONE 'America/Chicago')::date
        AND j.job_date <= ((now() AT TIME ZONE 'America/Chicago')::date + (p_days_ahead || ' days')::interval)::date
    ),
    demand AS (
      -- Codex A+B P2 #3: needed = FULL job demand when the job HAS its own 'job' hold
      -- (that hold is excluded from active_holds below, so free isn't reduced by it);
      -- the leftover quote crop_program hold covers the UN-drawn booking, NOT this job,
      -- so subtracting it too would double-discount and hide real shortfalls (e.g.
      -- 100-booked quote, 60-unit job -> 40 crop hold; with 50 free the true shortfall
      -- is 60 - (50-40) = 50).
      -- Codex round-3 P2: BUT a PRE-EXISTING scheduled/in-progress job (one that
      -- existed before Layer 2 — A4 does no backfill, §6.6) has no own 'job' hold yet,
      -- so nothing is excluded from active_holds; falling through to full demand while
      -- the crop hold is still subtracted from free would report a PHANTOM shortfall.
      -- So: cover = 0 when the job has its own hold; otherwise fall back to the parent
      -- quote's crop coverage (the Layer-1 behavior) until the job is reserved.
      SELECT jc.product_id,
             SUM(GREATEST(cq.demand_qty - cov.covered, 0)) AS needed_qty,
             COUNT(DISTINCT wj.id) FILTER (WHERE cq.demand_qty - cov.covered > 0) AS job_count,
             ARRAY_AGG(DISTINCT wj.job_number ORDER BY wj.job_number)
               FILTER (WHERE cq.demand_qty - cov.covered > 0) AS job_numbers
      FROM win_jobs wj
      JOIN job_chemicals jc ON jc.job_id = wj.id
      JOIN products p ON p.id = jc.product_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(
                 -- D2 (U11 follow-up): normalize FIRST — 'pt/ac'-style units NULL out of the converter; mirrors complete_job.
                 field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form),
                 jc.quantity
               ) AS demand_qty
      ) cq
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN EXISTS (
                   SELECT 1 FROM inventory_holds ih
                   WHERE ih.source_id = wj.id AND ih.hold_type = 'job'
                     AND ih.product_id = jc.product_id AND ih.is_active = true
                     AND (ih.expires_at IS NULL OR ih.expires_at >= (now() AT TIME ZONE 'America/Chicago')::date)
                 ) THEN 0
                 ELSE COALESCE((
                   SELECT SUM(ih.quantity) FROM inventory_holds ih
                   WHERE ih.source_id = wj.quote_id
                     AND ih.product_id = jc.product_id AND ih.is_active = true
                     AND (ih.expires_at IS NULL OR ih.expires_at >= (now() AT TIME ZONE 'America/Chicago')::date)
                 ), 0)
               END AS covered
      ) cov
      -- U4<<< a grower-supplied line demands nothing from our shed — exclude it
      -- from the planning-window shortfall so it never shows a phantom shortage. (#102)
      WHERE jc.quantity > 0 AND jc.customer_supplied = false
      -- >>>U4
      GROUP BY jc.product_id
    ),
    avail AS (
      SELECT i.product_id,
             COALESCE(SUM(i.quantity_available - i.quantity_prebooked), 0) AS avail_less_prebooked
      FROM inventory i
      GROUP BY i.product_id
    ),
    active_holds AS (
      SELECT ih.product_id, SUM(ih.quantity) AS holds_qty
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= (now() AT TIME ZONE 'America/Chicago')::date)
        -- LAYER2<<< don't subtract the window jobs' OWN job holds from free —
        -- their demand is already sized above, so counting their reservation
        -- here too would report a phantom shortfall (§4B.1).
        AND NOT (ih.hold_type = 'job' AND ih.source_id IN (SELECT id FROM win_jobs))
        -- >>>LAYER2
      GROUP BY ih.product_id
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.shortfall_qty DESC), '[]'::jsonb)
    FROM (
      SELECT
        d.product_id,
        p.product_name,
        p.inventory_unit,
        d.needed_qty,
        (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0)) AS available_free,
        (d.needed_qty - (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0))) AS shortfall_qty,
        d.job_count,
        d.job_numbers
      FROM demand d
      JOIN products p ON p.id = d.product_id
      LEFT JOIN avail a          ON a.product_id  = d.product_id
      LEFT JOIN active_holds ah  ON ah.product_id = d.product_id
      WHERE d.needed_qty > 0
        AND d.needed_qty > (COALESCE(a.avail_less_prebooked, 0) - COALESCE(ah.holds_qty, 0))
    ) r
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._get_inventory_position_cost_impl_20261019()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_season_start date;
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF EXTRACT(MONTH FROM (now() AT TIME ZONE 'America/Chicago')::date) >= 10 THEN
    v_season_start := DATE_TRUNC('year', (now() AT TIME ZONE 'America/Chicago')::date)::date + INTERVAL '9 months';
  ELSE
    v_season_start := (DATE_TRUNC('year', (now() AT TIME ZONE 'America/Chicago')::date) - INTERVAL '1 year')::date + INTERVAL '9 months';
  END IF;

  RETURN (
    WITH on_order AS (
      SELECT poi.product_id, SUM(GREATEST(poi.quantity_ordered - COALESCE(poi.quantity_received, 0), 0)) AS qty
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.status IN ('submitted', 'partially_received')
      GROUP BY poi.product_id
    ),
    holds AS (
      SELECT ih.product_id,
             SUM(ih.quantity) AS qty,
             -- LAYER2<<< job-type subset broken out as its own column (§4B.2 #1)
             SUM(ih.quantity) FILTER (WHERE ih.hold_type = 'job') AS job_qty
             -- >>>LAYER2
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= (now() AT TIME ZONE 'America/Chicago')::date)
      GROUP BY ih.product_id
    ),
    planned_quotes AS (
      -- LAYER2<<< quantity-aware dedup (§4B.2 #2): unreserved remainder per booking line.
      -- Codex A+B round-2 P2: AGGREGATE the booking per (quote, product) FIRST, THEN
      -- subtract the product-level hold/draws ONCE. Subtracting them inside a per-line
      -- SUM over-deducts when a product appears on multiple quote lines (two 50-unit
      -- lines with a 60-unit job draw and no hold would report 0 instead of 40 unreserved).
      SELECT pq.product_id, SUM(pq.remainder) AS qty
      FROM (
        SELECT b.quote_id, b.product_id,
               GREATEST(
                 b.booked
                   - COALESCE(lh.linked_hold, 0)
                   - COALESCE(od.order_drawn, 0)
                   - COALESCE(jd.job_drawn, 0),
                 0) AS remainder
        FROM (
          SELECT qi.quote_id, qi.product_id, SUM(COALESCE(qi.total_units_needed, 0)) AS booked
          FROM quote_items qi
          JOIN quotes q ON q.id = qi.quote_id
          WHERE q.is_planned = true AND q.status IN ('draft', 'sent', 'revised')
          GROUP BY qi.quote_id, qi.product_id
        ) b
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ih.quantity), 0) AS linked_hold
          FROM inventory_holds ih
          WHERE ih.source_id = b.quote_id
            AND ih.product_id = b.product_id
            AND ih.is_active = true
            AND (ih.expires_at IS NULL OR ih.expires_at >= (now() AT TIME ZONE 'America/Chicago')::date)
        ) lh ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(qpd.quantity_drawn), 0) AS order_drawn
          FROM quote_product_draws qpd
          WHERE qpd.quote_id = b.quote_id
            AND qpd.product_id = b.product_id
        ) od ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(jpd.quantity_drawn), 0) AS job_drawn
          FROM job_product_draws jpd
          WHERE jpd.quote_id = b.quote_id
            AND jpd.product_id = b.product_id
        ) jd ON true
      ) pq
      GROUP BY pq.product_id
      -- >>>LAYER2
    ),
    order_voided_products AS (
      -- void_order records one product-level reversal for the entire order and
      -- intentionally has no delivery_id. Pair that row back to all delivery
      -- events for the same order/product so its later ledger timestamp cannot
      -- move old delivered volume across season boundaries.
      SELECT DISTINCT it.order_id, it.product_id
      FROM inventory_transactions it
      WHERE it.transaction_type = 'void_delivery_reversal'
        AND it.delivery_id IS NULL
        AND it.order_id IS NOT NULL
    ),
    delivered_ytd AS (
      SELECT it.product_id,
             GREATEST(SUM(
               CASE
                 WHEN it.transaction_type = 'delivered' THEN ABS(it.quantity)
                 WHEN it.transaction_type IN ('cancelled_delivery_reversal', 'void_delivery_reversal')
                   THEN -ABS(it.quantity)
                 ELSE 0
               END
              ), 0) AS qty
      FROM inventory_transactions it
      JOIN deliveries d ON d.id = it.delivery_id
      LEFT JOIN order_voided_products ovp
        ON ovp.order_id = it.order_id
       AND ovp.product_id = it.product_id
      WHERE it.transaction_type IN ('delivered', 'cancelled_delivery_reversal', 'void_delivery_reversal')
        -- Delivery-specific reversals retain delivery_id, so they use the
        -- original delivery business date. Order-level voids are excluded by
        -- the paired order/product key above instead of their reversal date.
        AND (COALESCE(d.completed_at, it.created_at) AT TIME ZONE 'America/Chicago')::date >= v_season_start
        AND ovp.order_id IS NULL
      GROUP BY it.product_id
    ),
    base AS (
      SELECT
        p.id AS product_id, p.product_name, p.inventory_unit,
        p.container_size, p.container_type, p.vendor, p.current_cost, p.is_active,
        i.id AS inventory_id, i.location, i.unit_size,
        COALESCE(i.quantity_available, 0) AS quantity_available,
        COALESCE(i.quantity_prebooked, 0) AS quantity_prebooked,
        COALESCE(i.reorder_point, 0) AS reorder_point,
        COALESCE(i.min_stock_level, 0) AS min_stock_level
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      -- To-Do 0.13: a retired product stays listed while it still has stock on an open PO, so
      -- "what to order" does not undercount. It drops out once nothing is on order.
      WHERE p.is_active = true
         OR COALESCE(i.quantity_available, 0) <> 0
         OR EXISTS (SELECT 1 FROM on_order oo0 WHERE oo0.product_id = p.id AND oo0.qty > 0)
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.product_name), '[]'::jsonb)
    FROM (
      SELECT
        b.inventory_id, b.product_id, b.product_name, b.inventory_unit,
        b.container_size, b.container_type, b.vendor, b.current_cost,
        b.location, b.unit_size,
        b.quantity_available, b.quantity_prebooked,
        COALESCE(oo.qty, 0) AS quantity_on_order,
        COALESCE(h.qty, 0)  AS holds_qty,
        COALESCE(h.job_qty, 0) AS job_holds_qty,   -- LAYER2: new column
        COALESCE(pq.qty, 0) AS planned_qty,
        COALESCE(dy.qty, 0) AS delivered_ytd,
        (b.quantity_available - b.quantity_prebooked + COALESCE(oo.qty, 0)) AS net_position,
        b.reorder_point, b.min_stock_level,
        -- U18 #90: negative on-hand is always a stock problem, reorder_point set or not.
        -- To-Do 0.13: a retired product is listed only for its on-order stock; it is never
        -- "low", so it cannot land in the reorder banner.
        (b.is_active AND ((b.reorder_point > 0 AND b.quantity_available <= b.reorder_point) OR b.quantity_available < 0)) AS is_low_stock
      FROM base b
      LEFT JOIN on_order       oo ON oo.product_id = b.product_id
      LEFT JOIN holds          h  ON h.product_id  = b.product_id
      LEFT JOIN planned_quotes pq ON pq.product_id = b.product_id
      LEFT JOIN delivered_ytd  dy ON dy.product_id = b.product_id
      WHERE b.inventory_id IS NOT NULL OR COALESCE(oo.qty, 0) > 0
    ) r
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._create_inventory_hold_intent_impl_20260905(p_product_id uuid, p_customer_id uuid, p_quantity numeric, p_hold_type text, p_expires_at date, p_notes text, p_performed_by uuid, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_role text;
  v_hold_id uuid;
  v_existing jsonb;
  v_inventory record;
  v_active_holds numeric;
  v_todays_free numeric;
  v_result jsonb;
BEGIN
  -- PARKED-010 (codex-driven cycle 6 #3 MED): auth gate FIRST — without this,
  -- any authenticated caller who learns a known idempotency_key for this op
  -- can read the cached hold_id (+ uncommitted-stock figure) without first
  -- proving they are admin/sales_rep AND the original requester (strict-actor).
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by != v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor;
  IF v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency cache check NOW runs after the caller is authenticated AND
  -- role-gated. Same-key, same-op replay still returns the cached result; an
  -- attacker without the right role hits INSUFFICIENT_ROLE above instead.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'create_inventory_hold';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  IF p_hold_type NOT IN ('manual', 'crop_program') THEN
    RAISE EXCEPTION 'INVALID_HOLD_TYPE: %', p_hold_type;
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY: must be > 0';
  END IF;

  -- F1 fix: validate the force contract BEFORE any inventory-based branching.
  IF p_force THEN
    IF v_role != 'admin' THEN
      RAISE EXCEPTION 'FORCE_REQUIRES_ADMIN';
    END IF;
    IF p_force_reason IS NULL OR length(trim(p_force_reason)) = 0 THEN
      RAISE EXCEPTION 'FORCE_REQUIRES_REASON';
    END IF;
  END IF;

  SELECT id, quantity_available, quantity_prebooked
    INTO v_inventory
    FROM inventory
   WHERE product_id = p_product_id
     AND location = 'Main Warehouse'
   FOR UPDATE;

  IF NOT FOUND THEN
    v_todays_free := 0;
    v_active_holds := 0;
  ELSE
    SELECT COALESCE(SUM(quantity), 0) INTO v_active_holds
      FROM inventory_holds
     WHERE product_id = p_product_id
       AND is_active = true
       AND (expires_at IS NULL OR expires_at >= (now() AT TIME ZONE 'America/Chicago')::date);
    v_todays_free := v_inventory.quantity_available
                     - v_inventory.quantity_prebooked
                     - v_active_holds;
  END IF;

  IF v_todays_free - p_quantity < 0 AND NOT p_force THEN
    RAISE EXCEPTION 'INSUFFICIENT_HOLD_INVENTORY: only % units uncommitted (Available % - Prebooked % - Active Holds %); requested %',
      v_todays_free,
      COALESCE(v_inventory.quantity_available, 0),
      COALESCE(v_inventory.quantity_prebooked, 0),
      v_active_holds,
      p_quantity;
  END IF;

  INSERT INTO inventory_holds (
    product_id, customer_id, quantity, hold_type, expires_at, notes,
    is_active, created_by, created_at, updated_at
  ) VALUES (
    p_product_id, p_customer_id, p_quantity, p_hold_type, p_expires_at,
    p_notes, true, v_actor, NOW(), NOW()
  ) RETURNING id INTO v_hold_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'inventory_hold_created',
    CASE
      WHEN p_force THEN 'WARNING: Hold created with admin override (' || p_force_reason || ')'
      ELSE 'Hold created'
    END,
    v_actor, 'inventory_hold', v_hold_id, p_customer_id
  );

  v_result := jsonb_build_object(
    'hold_id', v_hold_id,
    'todays_free_before', v_todays_free,
    'forced', p_force
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'create_inventory_hold', v_result,
            now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._transition_rebate_claim_replay_impl_20261015(p_claim_id uuid, p_new_status text, p_paid_amount_cents bigint DEFAULT NULL::bigint, p_manufacturer_ref text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor       uuid := auth.uid();
  v_claim       public.rebate_claims%ROWTYPE;
  v_existing    jsonb;
  v_result      jsonb;
  v_paid_cents  bigint;
  v_today       date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  IF p_claim_id IS NULL THEN RAISE EXCEPTION 'CLAIM_ID_REQUIRED'; END IF;
  IF p_new_status IS NULL THEN RAISE EXCEPTION 'STATUS_REQUIRED'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'transition_rebate_claim');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_claim
    FROM public.rebate_claims
   WHERE id = p_claim_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_NOT_FOUND'; END IF;

  IF v_claim.status = 'pending' AND p_new_status IN ('submitted', 'rejected') THEN
    NULL;
  ELSIF v_claim.status = 'submitted' AND p_new_status IN ('approved', 'rejected') THEN
    NULL;
  ELSIF v_claim.status = 'approved' AND p_new_status = 'paid' THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'INVALID_TRANSITION: % -> %', v_claim.status, p_new_status;
  END IF;

  IF p_new_status = 'submitted' THEN
    UPDATE public.rebate_claims
       SET status = 'submitted', submitted_date = v_today, updated_at = now()
     WHERE id = p_claim_id;
  ELSIF p_new_status = 'approved' THEN
    UPDATE public.rebate_claims
       SET status = 'approved', approved_date = v_today, updated_at = now()
     WHERE id = p_claim_id;
  ELSIF p_new_status = 'paid' THEN
    v_paid_cents := COALESCE(p_paid_amount_cents, v_claim.claim_amount_cents);
    IF v_paid_cents <= 0 THEN RAISE EXCEPTION 'PAID_AMOUNT_INVALID'; END IF;
    UPDATE public.rebate_claims
       SET status = 'paid', paid_date = v_today, paid_amount_cents = v_paid_cents,
           manufacturer_ref = COALESCE(p_manufacturer_ref, manufacturer_ref),
           updated_at = now()
     WHERE id = p_claim_id;
  ELSIF p_new_status = 'rejected' THEN
    UPDATE public.rebate_claims
       SET status = 'rejected', updated_at = now()
     WHERE id = p_claim_id;
  END IF;

  v_result := jsonb_build_object(
    'success', true, 'claim_id', p_claim_id,
    'old_status', v_claim.status, 'new_status', p_new_status
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'transition_rebate_claim', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._create_rush_order_below_cost_impl_20260810(p_customer_id uuid, p_items jsonb DEFAULT '[]'::jsonb, p_notes text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor       uuid;
  v_actor_role  text;
  v_order_id    uuid;
  v_order_number text;
  v_item        jsonb;
  v_customer    record;
  v_product     record;
  v_cached      jsonb;
  v_result      jsonb;
  v_inv         record;
  v_warnings    text[] := '{}';
  v_qty         numeric;
  v_net_position numeric;
  v_tier        int;
  v_item_count  int := 0;
BEGIN
  -- ── canonical strict-actor ────────────────────────────────────────────────
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  -- Codex round 3 / Mason 2026-06-13: NARROWED to admin/sales_rep. Field-staff
  -- (driver/applicator) rush ordering is deferred — it needs scoped RLS read
  -- policies on orders/order_items + a PAGE_PERMISSIONS change (a security-model
  -- decision), so it becomes a proper future feature rather than a partial one.
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin','sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    -- Codex round-10 P1: serialize same-key calls BEFORE the cache check. check_idempotency
    -- (read) → save_idempotency (write at end) is a TOCTOU: two concurrent same-key calls
    -- could both miss the cache and both create the order + prebook inventory + notify, with
    -- only the 2nd save_idempotency lost to the unique index (the duplicate business rows
    -- already committed). A transaction-scoped advisory lock keyed on the idempotency key
    -- makes the 2nd caller block until the 1st commits, after which check_idempotency below
    -- finds the saved result and returns it — no duplicate order/prebook/notification.
    -- Targeted (only same-key calls serialize; auto-released at txn end; placed after the
    -- auth/role gate so only authorized callers take it).
    PERFORM pg_advisory_xact_lock(hashtext('create_rush_order:' || p_idempotency_key));
    v_cached := check_idempotency(p_idempotency_key, 'create_rush_order');
    IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;
  v_tier := COALESCE(v_customer.assigned_tier, 1);

  SELECT count(*) INTO v_item_count
  FROM jsonb_array_elements(p_items) e
  WHERE (e->>'product_id') IS NOT NULL
    AND COALESCE((e->>'qty')::numeric, (e->>'quantity')::numeric, 0) > 0;
  IF v_item_count = 0 THEN RAISE EXCEPTION 'ITEMS_REQUIRED'; END IF;

  v_order_number := generate_order_number();

  -- Codex round-7 P1: SNAPSHOT the customer's commission split onto the order NOW,
  -- because rush-order commissions are DEFERRED to price_order (v2). If price_order
  -- re-read customers.default_commission_split at pricing time, a split change between
  -- ship and pricing would mis-attribute this sale. price_order uses orders.commission_split.
  -- (draw_down_quote snapshots the same way from the quote; create_direct_order doesn't
  -- need to — it computes commissions immediately at creation.)
  -- sql-safety: exempt-registry — orders.pricing_status is added by the sibling file-only
  -- migration 20260613170000 (see file header); commission_split is a live column.
  -- Codex round-9 P2: set customer_po_number INSIDE this SECDEF RPC. The orders UPDATE
  -- RLS is is_admin()-only, so the old frontend follow-up `orders.update({customer_po_number})`
  -- failed for a sales_rep AFTER the order was already created (false error + lost PO, not
  -- retryable). Setting it here (owner-privileged INSERT) makes it atomic and role-safe.
  -- sql-safety: exempt-registry — orders.pricing_status is added by the sibling file-only
  -- migration 20260613170000 (see file header); commission_split + customer_po_number are live.
  INSERT INTO orders (
    order_number, customer_id, status, pricing_status,
    commission_split, customer_po_number,
    total_price, total_cost, total_profit, total_margin_pct,
    order_date, notes
  ) VALUES (
    v_order_number, p_customer_id, 'confirmed', 'needs_pricing',
    v_customer.default_commission_split, NULLIF(TRIM(COALESCE(p_customer_po_number, '')), ''),
    0, 0, 0, 0,
    (now() AT TIME ZONE 'America/Chicago')::date,
    NULLIF(TRIM(COALESCE(p_notes, '')), '')
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL THEN CONTINUE; END IF;
    v_qty := COALESCE((v_item->>'qty')::numeric, (v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT
      product_name,
      unit_size,
      CASE v_tier WHEN 2 THEN tier2_price WHEN 3 THEN tier3_price ELSE tier1_price END AS tier_price
      INTO v_product
      FROM products WHERE id = (v_item->>'product_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product not found: %', (v_item->>'product_id'); END IF;

    -- inventory warning (prebook never blocks)
    SELECT * INTO v_inv FROM inventory
      WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      v_warnings := array_append(v_warnings,
        v_product.product_name || ': need ' || v_qty || ', net position is 0 (no inventory record)');
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_qty THEN
        v_warnings := array_append(v_warnings,
          v_product.product_name || ': need ' || v_qty ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;

    -- unpriced line: $ all 0 + pending; tier price snapshot for v2 pricing screen
    INSERT INTO order_items (
      order_id, product_id, product_name,
      price_per_unit, cost_per_unit,
      total_units_needed, unit_size,
      total_price, profit, net_margin,
      quantity_delivered, quantity_remaining,
      pricing_pending, suggested_price
    ) VALUES (
      v_order_id, (v_item->>'product_id')::uuid, v_product.product_name,
      0, 0,
      v_qty, v_product.unit_size,
      0, 0, 0,
      0, v_qty,
      true, v_product.tier_price
    );

    -- prebook (WARN never block)
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + v_qty,
      updated_at = now()
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES ((v_item->>'product_id')::uuid, 'Main Warehouse', 0, v_qty, 0, v_product.unit_size);
    END IF;
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location, order_id, performed_by, notes
    ) VALUES (
      (v_item->>'product_id')::uuid, 'booked', v_qty, 'Main Warehouse', v_order_id, v_actor,
      'Pre-booked for rush order ' || v_order_number || ' (needs pricing)'
    );
  END LOOP;

  -- NO commissions yet — price_order (v2) inserts them on the FINAL profit.

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Rush order ' || v_order_number || ' created for ' || COALESCE(v_customer.farm_name, 'customer') ||
    ' — NEEDS PRICING' ||
    CASE WHEN array_length(v_warnings, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_warnings, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, p_customer_id
  );

  -- #4 (Codex P2): notify admins server-side that this rush order needs pricing.
  -- create_rush_order is SECDEF (owner), so this bypasses the notifications RLS
  -- with_check (is_admin() OR user_id = auth.uid()). A sales_rep creator CANNOT
  -- insert notifications for other (admin) users from the frontend, so the immediate
  -- alert must come from here; the check_unpriced_orders cron is the longer-term backstop.
  INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
  SELECT p.id, 'Order needs pricing',
    'Rush order ' || v_order_number || ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
    ' shipped without pricing — set its prices so it can be invoiced.',
    'needs_pricing', 'order', v_order_id
  FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;

  v_result := jsonb_build_object(
    'status', 'created', 'order_id', v_order_id, 'order_number', v_order_number,
    'pricing_status', 'needs_pricing', 'warnings', to_jsonb(v_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_rush_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._create_followup_delivery_replay_impl_20261015(p_original_delivery_id uuid, p_scheduled_date date DEFAULT NULL::date, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_original record;
  v_rem record;
  v_new_del_id uuid;
  v_del_number text;
  v_item_count integer := 0;
  v_existing jsonb;
  v_result jsonb;
BEGIN
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

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_followup_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_original
  FROM deliveries
  WHERE id = p_original_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'DELIVERY_NOT_FOUND'; END IF;

  PERFORM 1 FROM delivery_remainders
  WHERE original_delivery_id = p_original_delivery_id AND status = 'pending'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_PENDING_REMAINDERS';
  END IF;

  SELECT next_delivery_number() INTO v_del_number;

  INSERT INTO deliveries (
    delivery_number, order_id, customer_id, delivery_address_id,
    assigned_driver, scheduled_date, scheduled_time, delivery_notes,
    status, priority, created_by
  ) VALUES (
    v_del_number,
    v_original.order_id,
    v_original.customer_id,
    v_original.delivery_address_id,
    v_original.assigned_driver,
    COALESCE(p_scheduled_date, (now() AT TIME ZONE 'America/Chicago')::date + interval '1 day'),
    v_original.scheduled_time,
    'Follow-up for ' || v_original.delivery_number,
    'scheduled',
    v_original.priority,
    v_actor
  )
  RETURNING id INTO v_new_del_id;

  FOR v_rem IN
    SELECT * FROM delivery_remainders
    WHERE original_delivery_id = p_original_delivery_id AND status = 'pending'
    FOR UPDATE
  LOOP
    INSERT INTO delivery_items (
      delivery_id, order_item_id, product_id, quantity, unit_size
    ) VALUES (
      v_new_del_id,
      v_rem.order_item_id,
      v_rem.product_id,
      v_rem.quantity_remaining,
      v_rem.unit_size
    );

    UPDATE delivery_remainders SET
      status = 'scheduled',
      followup_delivery_id = v_new_del_id,
      updated_at = now()
    WHERE id = v_rem.id;

    v_item_count := v_item_count + 1;
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id,
    customer_id
  ) VALUES (
    'delivery_created',
    'Follow-up delivery ' || v_del_number || ' created from ' || v_original.delivery_number || ' remainders (' || v_item_count || ' items)',
    v_actor, 'delivery', v_new_del_id, v_original.customer_id
  );

  IF v_original.assigned_driver IS NOT NULL THEN
    INSERT INTO notifications (
      user_id,
      title,
      message,
      notification_type,
      related_entity_type,
      related_entity_id
    )
    VALUES (
      v_original.assigned_driver,
      'Follow-up Delivery Scheduled',
      'Follow-up delivery ' || v_del_number || ' created for remaining items from ' || v_original.delivery_number || '.',
      'delivery_update', 'delivery', v_new_del_id
    );
  END IF;

  v_result := jsonb_build_object(
    'status', 'created',
    'delivery_id', v_new_del_id,
    'delivery_number', v_del_number,
    'item_count', v_item_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_followup_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._create_job_from_quote_section_replay_impl_20261015(p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'create_job_from_quote_section';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- U5 (Codex P2): lock the quote BEFORE the status checks so a concurrent
  -- convert/close (each takes this same row lock first) serializes with job
  -- scheduling — a plain read could pass the guards on a booking another
  -- transaction is mid-way through accepting or closing.
  SELECT q.* INTO v_quote FROM quotes q WHERE q.id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF NOT v_quote.is_planned THEN RAISE EXCEPTION 'Quote must be marked as planned to schedule a job'; END IF;

  -- U5<<< #103: an 'accepted' booking was converted to a chemical SALE (order +
  -- delivery). Scheduling a job from it would re-reserve/double-count the same
  -- product. Block with a distinct token so the UI can point the user to a
  -- standalone job instead. (finding #103, CONFIRMED 2026-07-05)
  IF v_quote.status = 'accepted' THEN
    RAISE EXCEPTION 'QUOTE_ALREADY_CONVERTED: quote % was accepted and converted to a chemical sale (order) — create a standalone job instead of scheduling from this booking', v_quote.quote_number;
  END IF;
  -- >>>U5

  IF v_quote.status IN ('declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short') THEN
    RAISE EXCEPTION 'Cannot schedule job from quote with status: %', v_quote.status;
  END IF;

  -- PRICE LOCK (20261027040000): a job copies the section's prices into job_chemicals, so a
  -- sent booking schedules only at the prices, lines and customer it was last sent with. A
  -- planned draft that was never sent may still be scheduled at its own prices (Mason, 2026-10-14).
  PERFORM public._assert_quote_prices_as_sent(p_quote_id);

  SELECT qs.* INTO v_section FROM quote_sections qs WHERE qs.id = p_section_id AND qs.quote_id = p_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Section not found or does not belong to quote'; END IF;

  IF EXISTS (SELECT 1 FROM jobs WHERE quote_section_id = p_section_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'A job already exists for this quote section. Delete or cancel the existing job first.';
  END IF;

  v_job_date := COALESCE(v_section.needed_by_date, (now() AT TIME ZONE 'America/Chicago')::date);
  v_season := CASE WHEN EXTRACT(MONTH FROM v_job_date) >= 10
    THEN EXTRACT(YEAR FROM v_job_date)::integer + 1 ELSE EXTRACT(YEAR FROM v_job_date)::integer END;
  v_job_number := next_job_number();

  INSERT INTO jobs (
    job_number, customer_id, status, job_date, notes, season, quote_id, quote_section_id,
    total_acres, total_cost_cents, total_price_cents, created_by,
    -- U8 (#99): snapshot the booking's commission split onto the job so pay attribution
    -- is locked at scheduling time (the same snapshot rule orders follow — a later quote
    -- or customer split edit must not re-attribute an already-scheduled job).
    commission_split
  ) VALUES (
    v_job_number, v_quote.customer_id, 'scheduled', v_job_date,
    COALESCE(v_section.section_name, 'Untitled') || COALESCE(': ' || v_section.section_header_notes, ''),
    v_season, p_quote_id, p_section_id, 0, 0, 0, v_actor,
    -- Codex R4 P1: a quote with no split locks the empty sentinel (no commission,
    -- order-channel parity) — NULL is reserved for pre-U8 jobs.
    COALESCE(v_quote.commission_split, '{"splits":[]}'::jsonb)
  ) RETURNING id INTO v_job_id;

  IF v_section.field_id IS NOT NULL THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres FROM quote_items qi WHERE qi.section_id = p_section_id;
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job_id, v_section.field_id, v_total_acres, 1);
  END IF;

  FOR v_item IN
    SELECT qi.product_id, qi.total_units_needed, qi.price_unit, qi.actual_rate, qi.rate_unit,
           qi.price_per_unit, qi.current_cost, qi.acres, qi.sort_order, p.unit_size
    FROM quote_items qi JOIN products p ON p.id = qi.product_id
    WHERE qi.section_id = p_section_id ORDER BY qi.sort_order
  LOOP
    v_sort := v_sort + 1;
    INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents, sort_order
    ) VALUES (v_job_id, v_item.product_id, COALESCE(v_item.total_units_needed, 0),
      COALESCE(v_item.price_unit, v_item.unit_size), v_item.actual_rate, v_item.rate_unit,
      ROUND(COALESCE(v_item.current_cost, 0) * 100)::bigint,
      ROUND(COALESCE(v_item.price_per_unit, 0) * 100)::bigint, v_sort);
    v_total_cost_cents := v_total_cost_cents + ROUND(COALESCE(v_item.current_cost, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
    v_total_price_cents := v_total_price_cents + ROUND(COALESCE(v_item.price_per_unit, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
  END LOOP;

  IF v_total_acres = 0 THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres FROM quote_items qi WHERE qi.section_id = p_section_id;
  END IF;
  UPDATE jobs SET total_acres = v_total_acres, total_cost_cents = v_total_cost_cents, total_price_cents = v_total_price_cents WHERE id = v_job_id;

  -- F1<<< 42P01 fix (plpgsql_check, 2026-06-10): the logging INSERT targeted
  -- the old log relation (named in the migration header; deliberately NOT
  -- spelled here — this comment lands in prosrc, and the self-verification
  -- block asserts the old relation name appears NOWHERE in the deployed
  -- body), which does not exist — every call aborted here at runtime.
  -- Re-pointed to activity_feed using its live column shape, the exact
  -- pattern draw_down_quote logs with; the old jsonb details payload
  -- (job_number / quote_id / quote_number / section_name) is folded into the
  -- description text. Event token 'job_created_from_quote' kept.
  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('job_created_from_quote',
    'Job ' || v_job_number || ' scheduled from quote ' || v_quote.quote_number ||
    COALESCE(' — section ' || v_section.section_name, ''),
    v_actor, 'job', v_job_id, v_quote.customer_id);
  -- >>>F1

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_job_from_quote_section', jsonb_build_object('job_id', v_job_id));
  END IF;

  RETURN jsonb_build_object('job_id', v_job_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public._batch_reschedule_deliveries_replay_impl_20261015(p_delivery_ids uuid[], p_new_date date, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_count    int := 0;
  v_id       uuid;
  v_delivery record;
  v_result   jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to reschedule deliveries';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'batch_reschedule_deliveries');
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  IF p_new_date < (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'Cannot reschedule deliveries to a past date';
  END IF;

  FOREACH v_id IN ARRAY p_delivery_ids LOOP
    SELECT * INTO v_delivery FROM deliveries WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN CONTINUE; END IF;

    UPDATE deliveries SET
      scheduled_date = p_new_date,
      last_edited_by = v_actor,
      last_edited_at = now(),
      updated_at = now()
    WHERE id = v_id;

    v_count := v_count + 1;
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'deliveries_rescheduled',
    v_count || ' delivery(ies) rescheduled to ' || p_new_date::text,
    v_actor, 'delivery', p_delivery_ids[1]
  );

  v_result := jsonb_build_object('status', 'rescheduled', 'count', v_count);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'batch_reschedule_deliveries', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._save_field_crop_history_replay_impl_20261015(p_field_id uuid, p_season integer, p_crop_type text, p_variety text DEFAULT NULL::text, p_planting_date date DEFAULT NULL::date, p_harvest_date date DEFAULT NULL::date, p_yield_per_acre numeric DEFAULT NULL::numeric, p_yield_unit text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF p_idempotency_key IS NOT NULL THEN
    v_idemp := check_idempotency(p_idempotency_key, 'save_field_crop_history');
    IF v_idemp IS NOT NULL THEN RETURN v_idemp; END IF;
  END IF;

  -- validate inputs -----------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM fields WHERE id = p_field_id) THEN
    RAISE EXCEPTION 'FIELD_NOT_FOUND';
  END IF;
  IF p_crop_type IS NULL OR btrim(p_crop_type) = '' THEN
    RAISE EXCEPTION 'CROP_TYPE_REQUIRED';
  END IF;

  -- season: explicit if provided, else derive from planting date / today ------
  v_season := COALESCE(p_season, compute_season(COALESCE(p_planting_date, (now() AT TIME ZONE 'America/Chicago')::date)));

  -- upsert on the (field_id, season) unique index -----------------------------
  INSERT INTO field_crop_history (
    field_id, season, crop_type, variety, planting_date, harvest_date,
    yield_per_acre, yield_unit, notes
  ) VALUES (
    p_field_id, v_season, btrim(p_crop_type), p_variety, p_planting_date, p_harvest_date,
    p_yield_per_acre, p_yield_unit, p_notes
  )
  ON CONFLICT (field_id, season) DO UPDATE SET
    crop_type      = EXCLUDED.crop_type,
    variety        = EXCLUDED.variety,
    planting_date  = EXCLUDED.planting_date,
    harvest_date   = EXCLUDED.harvest_date,
    yield_per_acre = EXCLUDED.yield_per_acre,
    yield_unit     = EXCLUDED.yield_unit,
    notes          = EXCLUDED.notes
  RETURNING id INTO v_id;

  v_result := jsonb_build_object('success', true, 'id', v_id, 'season', v_season);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field_crop_history', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._save_field_app_split_invoice_impl(p_billing_set_id uuid, p_source_job_id uuid, p_invoice jsonb, p_fields jsonb, p_lines jsonb, p_performed_by uuid, p_application_service_id uuid, p_idempotency_key text, p_request_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor              uuid := auth.uid();
  v_req_salesman       uuid;
  v_salesman_id        uuid;
  v_field_ids          uuid[] := '{}';
  v_applied_acres_map  jsonb  := '{}'::jsonb;
  v_fld                jsonb;
  v_this_acres         numeric;
  v_vector             jsonb;          -- default vector [{customer_id, micro_pct}]
  v_micro_map          jsonb := '{}'::jsonb;
  v_members            text[];         -- billing-set member customer_ids, sorted ASC
  v_set_id             uuid;
  v_group_id           uuid;
  v_line               jsonb;
  v_idx                int := 0;
  v_line_id            uuid;
  v_line_kind          text;
  v_product_id         uuid;
  v_app_service_id     uuid;
  v_line_desc          text;
  v_src_qty            numeric;
  v_src_acres          numeric;
  v_src_unit_price     bigint;
  v_src_flat           bigint;
  v_base_source        text;
  v_eff_rate_unit      text;           -- display unit for the line (pricing unit after chemical conversion)
  v_chem_price_map     jsonb;          -- chemical Option B: customer_id -> that customer's own resolved unit price
  v_svc_price_map      jsonb;          -- service Option B: customer_id -> that customer's own per-acre service rate
  v_uniform_price      bigint;         -- chemical/service: the single price when ALL co-owners match (routes round-once)
  v_repr_base_price    bigint;         -- resolved representative base BEFORE the uniform-override penny guard (Codex r7 P2 audit base)
  v_inv_field_names    text[];         -- denormalized field names for the child invoice row (Codex r7 P2)
  v_inv_crop_type      text;           -- denormalized representative crop for the child invoice row (Codex r7 P2)
  v_inv_applicator_name text;          -- source-job applicator, denormalized onto the child (Codex r8 P2)
  v_inv_vehicle_name   text;           -- source-job vehicle, denormalized onto the child (Codex r8 P2)
  v_line_unit_cost     bigint;         -- per-unit COGS for the current line (Codex P1 #3)
  v_invoice_cost       bigint;         -- per-child accumulated total_cost_cents (Codex P1 #3)
  v_is_new_invoice     boolean;        -- true only when a child invoice row is freshly INSERTed (Codex P1 #8)
  v_total_applied_acres numeric := 0;  -- SUM(applied_acres) across p_fields (Codex P2 #9 acre derivation)
  v_shares             jsonb;
  v_line_customers     text[];
  v_calc               jsonb;
  v_app_service        record;
  v_svc_name           text;   -- safe copy of v_app_service.name (fix: unassigned-record crash)
  v_line_plans         jsonb := '[]'::jsonb;   -- [{meta..., alloc}]
  v_plan               jsonb;
  v_cust               text;
  v_customer_id        uuid;
  v_customer_name      text;
  v_is_primary         boolean;
  v_invoice_id         uuid;
  v_invoice_number     text;
  v_invoice_total      bigint;
  v_invoice_ids        uuid[] := '{}';
  v_alloc_row          jsonb;
  v_item_id            uuid;
  v_qty                numeric;
  v_acres_alloc        numeric;
  v_cust_acres         numeric;
  v_send_disposition   text;
  v_line_hashes        jsonb := '[]'::jsonb;
  v_item_price_source  text;
  v_item_cost_cents    bigint;   -- per-item cost_cents (per-unit for chemical, EXTENDED for fee) — Codex r2 #F
  -- #E source-job double-bill guard (Codex round-2 P1) + round-3 season/freeze
  v_job                record;
  v_other_set          uuid;
  v_set_child_ids      uuid[];    -- this set's child invoice ids captured BEFORE orphan-cancel (round-5 B1)
  v_set_source_job     uuid;     -- the set's frozen source_job_id on re-save (round-3 P1)
  v_season             integer;  -- job/invoice season for pricing + stamping (round-3 P1)
  v_job_app_date       date;     -- source job's application/scheduled date for child invoices (round-3 P2)
  -- Commissions on the split (Codex round-4 P1): mirror transfer_job_to_invoice per child
  v_commission_split   jsonb;
  v_child_id           uuid;
  v_child_customer     uuid;
  v_child_profit       numeric;
  -- Codex round-5 P1: per-child CHEMICAL profit using the LR-allocated COGS (not a re-rounded
  -- cost*qty), so commissions tie to the penny-exact allocation already in the header.
  v_invoice_chem_profit  bigint;
  v_chem_profit_by_child jsonb := '{}'::jsonb;   -- child invoice_id::text -> chemical profit cents
  -- #G canonical line COGS + its largest-remainder split (Codex round-2 P1)
  v_line_cogs          bigint;
  v_cogs_weights       jsonb;
  v_cogs_map           jsonb;
  -- #M audited-base + #L reason capture (Codex round-2 P2)
  v_caller_override    text[];   -- customers the caller priced as a genuine manual override
  v_svc_source_map     jsonb;    -- service: customer_id -> 'service_rate' | 'service_default'
  v_reasons_map        jsonb;    -- customer_id -> {split_reason, price_reason}
  v_share_base_price   bigint;
  v_share_base_source  text;
  v_share_price_mode   text;
  v_split_reason       text;
  v_price_reason       text;
  -- invariant probes
  v_sum_cents          bigint;
  v_src_line_cents     bigint;
  v_sum_qty            numeric;
  v_sum_micro          bigint;
  v_line_member_count  int;
  v_line_src_qty       numeric;
  v_result             jsonb;
BEGIN
  -- ---- GUARDS (defense-in-depth; the wrapper already checked these) -----------
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
                   AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: active admin or sales role required';
  END IF;

  -- Codex round-4 P1 (posting-boundary integrity): mark THIS transaction as the legitimate
  -- split writer. The trg_guard_split_invoice_items trigger (below) blocks any other path —
  -- notably the generic save_invoice, whose FIELD_INVOICE_SPLIT_LOCKED guard does NOT fire for
  -- our single-compat-share children — from deleting a split child's invoice_items and
  -- cascading away its invoice_line_shares. is_local = true: auto-resets at txn end.
  PERFORM set_config('crx.split_writer', 'on', true);

  -- Salesman attribution: admin may name anyone; a sales_rep is forced to self.
  v_req_salesman := (p_invoice->>'salesman_id')::uuid;
  IF is_admin() THEN
    v_salesman_id := v_req_salesman;
  ELSE
    IF v_req_salesman IS NOT NULL AND v_req_salesman IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Not authorized: cannot attribute this invoice to another user';
    END IF;
    v_salesman_id := v_actor;
  END IF;

  -- ---- FIELDS + Mode-A rejection ---------------------------------------------
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'array'
     OR jsonb_array_length(p_fields) = 0 THEN
    RAISE EXCEPTION 'SPLIT_NO_FIELDS: at least one field is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_fld IN SELECT * FROM jsonb_array_elements(p_fields)
  LOOP
    v_this_acres := (v_fld->>'applied_acres')::numeric;
    IF v_this_acres IS NULL OR v_this_acres <= 0 THEN
      RAISE EXCEPTION 'SPLIT_ZERO_ACRES: applied acres must be > 0 for field %', v_fld->>'field_id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_field_ids := array_append(v_field_ids, (v_fld->>'field_id')::uuid);
    v_applied_acres_map := v_applied_acres_map
      || jsonb_build_object(v_fld->>'field_id', v_this_acres);
  END LOOP;

  -- Codex round-4 P1: reject a field id appearing more than once. A duplicate would
  -- double-count its acres into the ownership vector / compat share AND write a duplicate
  -- field_app_locations snapshot for the group. (v_applied_acres_map would silently collapse
  -- dupes to one key, so the acres map and the raw field array could disagree.)
  IF (SELECT count(*) FROM unnest(v_field_ids)) <>
     (SELECT count(DISTINCT x) FROM unnest(v_field_ids) AS x) THEN
    RAISE EXCEPTION 'SPLIT_DUPLICATE_FIELD: a field id appears more than once in p_fields'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Mode-A: reject the ENTIRE feature for any grower-share field (spec §5).
  IF EXISTS (
    SELECT 1 FROM field_billing_defaults d
     WHERE d.field_id = ANY(v_field_ids)
       AND d.price_override_cents IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'MODE_A_UNSUPPORTED: per-line split billing is not available for grower-share (Mode A) fields'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ---- DEFAULT VECTOR + member set -------------------------------------------
  v_vector := resolve_line_split_vector(v_field_ids, p_source_job_id, v_applied_acres_map);

  SELECT array_agg(value->>'customer_id' ORDER BY value->>'customer_id')
    INTO v_members
    FROM jsonb_array_elements(v_vector) AS value;

  SELECT COALESCE(jsonb_object_agg(value->>'customer_id', (value->>'micro_pct')::bigint), '{}'::jsonb)
    INTO v_micro_map
    FROM jsonb_array_elements(v_vector) AS value;

  -- ---- CUSTOMER-SCOPE SECURITY (Codex P1 #4, 2026-07-18; widened 2026-10-13) ----
  -- Reps bill ANY customer (Mason, 2026-10-13): 20261013220000 removed the
  -- assigned-rep test. A non-admin is still refused a derived member that is not
  -- a customer row at all.
  IF NOT is_admin() THEN
    IF EXISTS (
      SELECT 1 FROM unnest(v_members) AS m(cust)
      LEFT JOIN customers c ON c.id = m.cust::uuid
      WHERE c.id IS NULL
    ) THEN
      RAISE EXCEPTION 'SPLIT_CUSTOMER_NOT_ASSIGNED: not authorized to bill one or more of these customers'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Total applied acres across the fields — the acre basis for the per-customer compat
  -- share row (Codex P2 #9), derived ONCE here, independent of the billing lines.
  SELECT COALESCE(SUM((f->>'applied_acres')::numeric), 0) INTO v_total_applied_acres
    FROM jsonb_array_elements(p_fields) AS f;

  -- Codex round-7 P2: denormalized field context for the child invoice ROW. FieldInvoicesListPanel +
  -- buildInvoicePdfDataFromRow read invoices.field_names/crop_type/total_acres directly (the dedicated
  -- Drafts/Posted panels hydrate field_app_locations, but the COMBINED list + its PDFs use the row) —
  -- without these each split child shows blank acreage/fields/crop in the combined list and exports.
  SELECT array_agg(fl.field_name ORDER BY t.ord),
         (array_agg(fl.crop_type ORDER BY t.ord) FILTER (WHERE fl.crop_type IS NOT NULL))[1]
    INTO v_inv_field_names, v_inv_crop_type
    FROM jsonb_array_elements(p_fields) WITH ORDINALITY AS t(fld, ord)
    LEFT JOIN fields fl ON fl.id = (t.fld->>'field_id')::uuid;

  -- ---- LINES ------------------------------------------------------------------
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'SPLIT_NO_LINES: at least one billing line is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Codex round-7 P1 (RUP under-reporting): reject the SAME chemical product on more than one line.
  -- Two chemical lines with the same product create two invoice_items with the same
  -- (invoice_id, product_id); generate_rup_sales_records de-dups by (invoice_id, product_id) and
  -- inserts only the FIRST, silently under-reporting the regulated quantity + amount of the second.
  -- The operator must combine them into one line (mirrors the SPLIT_DUPLICATE_FIELD guard).
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_lines) AS l
     WHERE l->>'line_kind' = 'chemical' AND NULLIF(l->>'product_id', '') IS NOT NULL
     GROUP BY l->>'product_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SPLIT_DUPLICATE_PRODUCT: the same chemical product appears on more than one line — combine them into a single line'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
    v_svc_name := v_app_service.name;
  END IF;

  -- ---- RE-SAVE: reuse an existing DRAFT/UNPOSTED billing set -----------------
  -- The wrapper already advisory-locked the set's group and FOR UPDATE-locked the
  -- child invoices, and asserted all draft/unposted. Here we clear the prior child
  -- LINE DATA (invoice_items — cascades invoice_line_shares — plus compat shares and
  -- the billing lines) but we do NOT hard-delete the invoice ROWS: a child that was
  -- posted-then-unposted carries append-only invoice_line_share_snapshots whose FK is
  -- ON DELETE RESTRICT, so a hard invoice delete would abort the whole re-save
  -- (adversarial F1). Instead PASS 2 REUSES the existing child invoice per customer
  -- (UPDATE), preserving its invoice_number + snapshot history, and only INSERTs for a
  -- newly-added customer. The freeze trigger permits the share rewrite because every
  -- member is draft/unposted (not posted).
  IF p_billing_set_id IS NOT NULL THEN
    SELECT id, invoice_group_id, source_job_id INTO v_set_id, v_group_id, v_set_source_job
      FROM field_app_billing_sets WHERE id = p_billing_set_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Billing set not found: %', p_billing_set_id;
    END IF;

    -- Freeze the source job on re-save (Codex round-3 P1): the set's source_job_id is set
    -- once at first Save and drives the #E consume/guard below. Allowing it to change would
    -- let one billing set consume TWO jobs (the new one gets marked invoiced while the old
    -- stays invoiced and linked). Reject any change; the operator must start a new set.
    IF p_source_job_id IS DISTINCT FROM v_set_source_job THEN
      RAISE EXCEPTION 'SPLIT_JOB_IMMUTABLE: the source job cannot be changed on a saved split set (was %, got %)',
        v_set_source_job, p_source_job_id USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Ownership on re-save (Codex P1 #4; narrowed 2026-10-13 by 20261013220000): reps may
    -- re-save a split set for ANY customer (Mason, 2026-10-13), but only when every EXISTING
    -- child is under their own name: they are its salesperson, or it has none and they created
    -- it (before any delete/insert).
    IF NOT is_admin() AND EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.field_app_billing_set_id = v_set_id AND i.deleted_at IS NULL
        AND NOT (i.salesman_id IS NOT DISTINCT FROM v_actor
             OR (i.salesman_id IS NULL AND i.created_by IS NOT DISTINCT FROM v_actor))
    ) THEN
      RAISE EXCEPTION 'SPLIT_SET_NOT_OWNED: not authorized to modify this billing set'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Only EDITABLE children are cleared for the rebuild. A voided/cancelled child keeps its
    -- invoice_items/invoice_shares as the printed audit record of what was billed then reversed
    -- (RLS review M1) — its billing-line links are NULLed below so the line DELETE stays FK-safe.
    -- Posted/paid children can't reach here (the wrapper's already-posted block rejects the set).
    DELETE FROM invoice_items
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL
                              AND status IN ('draft', 'unposted'));
    DELETE FROM invoice_shares
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL
                              AND status IN ('draft', 'unposted'));
    -- Fable-adversarial BLOCKER: a SOFT-deleted child (via the live delete_invoices) is NOT in the
    -- delete above (deleted_at IS NOT NULL), but its invoice_items still reference this set's
    -- field_app_billing_lines (invoice_items.billing_line_id FK, NO ACTION) — so the DELETE below
    -- would 23503-abort and BRICK every future re-save. NULL those dangling refs first (the soft-
    -- deleted invoice keeps its items as history; only the now-meaningless billing-line link is
    -- cleared). PASS 2 then re-creates a child for that customer if they are still a member.
    UPDATE invoice_items SET billing_line_id = NULL
      WHERE billing_line_id IN (SELECT id FROM field_app_billing_lines WHERE billing_set_id = v_set_id);
    DELETE FROM field_app_billing_lines WHERE billing_set_id = v_set_id;
    -- Clear the prior group's field snapshots; PASS 3 re-creates them from p_fields (Codex P1 #7).
    DELETE FROM field_app_locations WHERE invoice_group_id = v_group_id;

    -- Round-5 B1: snapshot this set's current child ids BEFORE the orphan-cancel below detaches any
    -- dropped member (it nulls field_app_billing_set_id). The #E already-invoiced guard uses this so a
    -- re-save that drops the member currently stored in jobs.invoice_id still recognizes that anchor as
    -- OURS — otherwise the just-detached anchor looks like a foreign invoice and trips a false
    -- SPLIT_JOB_ALREADY_INVOICED, blocking the drop-member re-save entirely.
    SELECT array_agg(id) INTO v_set_child_ids
      FROM invoices WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL;

    -- Any existing EDITABLE child whose customer is no longer a billing-set member is
    -- soft-cancelled + detached from the set (its snapshots stay pointing at it,
    -- audit intact) — never hard-deleted. Mirrors the live orphan-cancel path.
    -- Fable-adversarial: only draft/unposted children — a child already voided/cancelled via the
    -- live void_invoice must be skipped, since draft->cancelled is fine but voided->cancelled is a
    -- forbidden status transition that would abort the whole re-save.
    UPDATE invoices
       SET status = 'cancelled', invoice_group_id = NULL, field_app_billing_set_id = NULL,
           total_amount_cents = 0, total_cost_cents = 0, send_disposition = 'normal',
           updated_at = now()
     WHERE field_app_billing_set_id = v_set_id
       AND deleted_at IS NULL
       AND status IN ('draft', 'unposted')
       AND customer_id::text <> ALL (v_members);

    -- Codex round-6 P1: a child VOIDED/CANCELLED (or soft-deleted) via the live void/cancel/delete
    -- path stays attached to this set's invoice_group_id. PASS 2 skips it (reuse is draft/unposted +
    -- not-deleted only) and mints a fresh replacement, BUT post_invoice_group loops EVERY non-filtered
    -- member of the group and RAISES on any status not in (draft,unposted) — so leaving the terminal/
    -- deleted child in the group makes the rebuilt group permanently UNPOSTABLE. Detach such children
    -- from the group (invoice_group_id = NULL) so only active draft/unposted children remain postable;
    -- they keep field_app_billing_set_id as set/audit history and the replacement carries the group.
    UPDATE invoices
       SET invoice_group_id = NULL, updated_at = now()
     WHERE field_app_billing_set_id = v_set_id
       AND invoice_group_id IS NOT NULL
       AND (deleted_at IS NOT NULL OR status IN ('voided', 'cancelled'));
  ELSE
    -- New set. R7: ALWAYS assign an invoice_group_id (even single recipient) so
    -- posting is uniformly post_invoice_group and the set is the durable anchor.
    v_group_id := gen_random_uuid();
    INSERT INTO field_app_billing_sets (invoice_group_id, source_job_id, created_by)
    VALUES (v_group_id, p_source_job_id, p_performed_by)
    RETURNING id INTO v_set_id;
  END IF;

  -- ---- #E SOURCE-JOB DOUBLE-BILL GUARD (Codex round-2 P1, 2026-07-18) ---------
  -- source_job_id was recorded as provenance only, so the SAME job could be billed
  -- here AND again through the normal transfer_job_to_invoice flow (double-bill).
  -- Lock the job, refuse it if it was already billed elsewhere, and (after the child
  -- invoices exist) consume it exactly like transfer_job_to_invoice does — flipping
  -- jobs.status to 'invoiced' so that path's own "Job already invoiced" guard fires.
  -- All checks are re-save-safe: this set's own already-consumed job passes.
  IF p_source_job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM jobs WHERE id = p_source_job_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_FOUND: source job % not found', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Reps bill ANY customer's job (Mason, 2026-10-13; 20261013220000 removed the
    -- assigned-rep test). A job with a NULL or missing customer is still REFUSED for a
    -- non-admin (NOT EXISTS is true when customer_id is null).
    IF NOT is_admin()
       AND NOT EXISTS (SELECT 1 FROM customers c
                        WHERE c.id = v_job.customer_id) THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_ASSIGNED: not authorized to bill source job %', p_source_job_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Already tied to a DIFFERENT split billing set?
    SELECT id INTO v_other_set FROM field_app_billing_sets
      WHERE source_job_id = p_source_job_id AND id IS DISTINCT FROM v_set_id
      LIMIT 1;
    IF v_other_set IS NOT NULL THEN
      RAISE EXCEPTION 'SPLIT_JOB_ALREADY_BILLED: source job % is already on split billing set %',
        p_source_job_id, v_other_set USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Already invoiced by the normal flow (linked to an invoice that is NOT one of THIS set's children)?
    -- Round-5 B1: accept the anchor if it is STILL attached to this set OR was one of this set's
    -- children before the orphan-cancel above detached it (a drop-anchor re-save) — v_set_child_ids is
    -- the pre-cancel snapshot; NULL on a first save (COALESCE to empty, so the EXISTS still governs).
    IF v_job.status = 'invoiced' AND v_job.invoice_id IS NOT NULL
       AND NOT (v_job.invoice_id = ANY (COALESCE(v_set_child_ids, ARRAY[]::uuid[])))
       AND NOT EXISTS (SELECT 1 FROM invoices i
                        WHERE i.id = v_job.invoice_id AND i.field_app_billing_set_id = v_set_id) THEN
      RAISE EXCEPTION 'SPLIT_JOB_ALREADY_INVOICED: source job % was already invoiced (invoice %)',
        p_source_job_id, v_job.invoice_id USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Must be completed (or already this set's) to bill — mirrors transfer_job_to_invoice.
    IF v_job.status NOT IN ('completed', 'invoiced') THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_COMPLETED: source job % must be completed to bill (status: %)',
        p_source_job_id, v_job.status USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Codex round-4 P1 + round-5 P1: the billed fields must EXACTLY EQUAL the job's job_fields.
    -- Consuming the job marks the WHOLE job 'invoiced', so billing only a subset (or unrelated
    -- fields) would silently orphan the job's other fields — normal transfer then refuses the
    -- now-invoiced job, so that work can never be billed. Enforce set equality (⊆ AND ⊇), exactly
    -- like transfer_job_to_invoice which always bills every job_field. (a) no billed field outside
    -- the job:
    IF EXISTS (
      SELECT 1 FROM unnest(v_field_ids) AS fid
       WHERE NOT EXISTS (SELECT 1 FROM job_fields jf
                          WHERE jf.job_id = p_source_job_id AND jf.field_id = fid)
    ) THEN
      RAISE EXCEPTION 'SPLIT_FIELD_NOT_ON_JOB: one or more billed fields do not belong to source job %', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- (b) no job field left unbilled:
    IF EXISTS (
      SELECT 1 FROM job_fields jf
       WHERE jf.job_id = p_source_job_id
         AND NOT (jf.field_id = ANY (v_field_ids))
    ) THEN
      RAISE EXCEPTION 'SPLIT_JOB_FIELDS_INCOMPLETE: billing a source job must include ALL of its fields (the whole job is consumed as invoiced); job % has fields not in this split', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_job_app_date := v_job.job_date;          -- carried onto each child (round-3 P2); the LIVE
                                               -- jobs table has job_date (no scheduled_date), and
                                               -- live transfer_job_to_invoice uses job_date too.
    v_season       := v_job.season;            -- capture here (v_job is a bare record, only assigned
                                               -- inside this guard; referencing v_job.season outside
                                               -- it — even in a not-taken CASE branch — raises 55000).
    -- Codex round-8 P2: denormalize the job's applicator + vehicle onto each child (like
    -- transfer_job_to_invoice) — field-invoice lists and PDFs read these invoice columns, so without
    -- them a split child loses who applied it and with what equipment. Job-less splits stay NULL.
    IF v_job.applicator_id IS NOT NULL THEN
      SELECT full_name INTO v_inv_applicator_name FROM profiles WHERE id = v_job.applicator_id;
    END IF;
    IF v_job.vehicle_id IS NOT NULL THEN
      SELECT vehicle_name INTO v_inv_vehicle_name FROM vehicles WHERE id = v_job.vehicle_id;
    END IF;
  END IF;

  -- Season for per-customer service-rate lookups AND the child invoice stamp (Codex round-3 P1):
  -- the SOURCE JOB's season if billing a job (captured above), else the invoice DATE's season, else
  -- current. current_season() alone mis-priced a backdated/prior-season job and filed the wrong year.
  v_season := COALESCE(
    v_season,
    compute_season(COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date)),  -- America/Chicago business date, never UTC (2026-09-03)
    current_season());

  -- ---- PASS 1: build billing lines + compute allocations ----------------------
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_idx            := v_idx + 1;
    v_line_kind      := v_line->>'line_kind';
    v_product_id     := (v_line->>'product_id')::uuid;
    v_app_service_id := COALESCE((v_line->>'application_service_id')::uuid, p_application_service_id);
    v_line_desc      := v_line->>'description';
    v_src_qty        := (v_line->>'source_quantity')::numeric;
    v_src_acres      := (v_line->>'source_acres')::numeric;
    v_src_flat       := (v_line->>'source_flat_cents')::bigint;
    v_src_unit_price := (v_line->>'source_unit_price_cents')::bigint;
    v_base_source    := v_line->>'base_price_source';
    v_eff_rate_unit  := v_line->>'rate_unit';   -- default; chemical overrides to the pricing unit below
    v_chem_price_map := NULL;                    -- chemical-only; NULL keeps non-chemical lines untouched
    v_svc_price_map  := NULL;                    -- service-only; NULL keeps non-service lines untouched
    v_svc_source_map := NULL;                    -- service-only: customer_id -> resolved source (#M)
    v_line_unit_cost := 0;                       -- per-unit COGS for this line (Codex P1 #3)

    -- #M: customers the CALLER explicitly priced as a genuine manual per-person override
    -- (those stay audited as an 'override'; every other co-owner's resolved per-customer
    -- price is stored as their BASE, not an override vs the largest-share owner). #L: the
    -- operator's reason for a customized split / price, captured per co-owner.
    IF v_line ? 'shares' AND jsonb_typeof(v_line->'shares') = 'array' THEN
      -- Codex round-4 P1 (server defense-in-depth for the editor's per-share guard): a
      -- per-PERSON price override must be a POSITIVE amount. Below, a share flagged
      -- price_mode='override' with a non-null override_unit_price_cents is treated as a genuine
      -- caller override and billed at that price — so a 0 / negative value (e.g. the editor's
      -- "1e5" → 0 path, or a direct RPC call) would bill $0 and give product away. Reject it.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_line->'shares') AS s
         WHERE s->>'price_mode' = 'override'
           AND s->'override_unit_price_cents' IS NOT NULL
           AND jsonb_typeof(s->'override_unit_price_cents') <> 'null'
           AND (s->>'override_unit_price_cents')::bigint <= 0
      ) THEN
        RAISE EXCEPTION 'SPLIT_SHARE_OVERRIDE_INVALID: a per-person price override on line % must be a positive amount', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      SELECT array_agg(s->>'customer_id')
        INTO v_caller_override
        FROM jsonb_array_elements(v_line->'shares') AS s
       WHERE s->>'price_mode' = 'override'
         AND s->'override_unit_price_cents' IS NOT NULL
         AND jsonb_typeof(s->'override_unit_price_cents') <> 'null';
      SELECT jsonb_object_agg(s->>'customer_id', jsonb_build_object(
               'split_reason', NULLIF(btrim(COALESCE(s->>'split_override_reason', '')), ''),
               'price_reason', NULLIF(btrim(COALESCE(s->>'price_override_reason', '')), '')))
        INTO v_reasons_map
        FROM jsonb_array_elements(v_line->'shares') AS s;
    ELSE
      v_caller_override := NULL;
      v_reasons_map     := '{}'::jsonb;
    END IF;

    IF v_line_kind IS NULL
       OR v_line_kind NOT IN ('chemical', 'service', 'fuel_surcharge', 'flat_fee') THEN
      RAISE EXCEPTION 'SPLIT_BAD_LINE_KIND: %', COALESCE(v_line_kind, '<null>')
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Base-price resolution by kind (see SCOPE NOTE at top for the chemical caveat).
    IF v_line_kind = 'service' THEN
      -- Per-line service record (Codex P1 #1): the editor sends the service id on the LINE
      -- (line.application_service_id); the old code only loaded v_app_service from the always-null
      -- top-level p_application_service_id, so v_app_service was never assigned. Load it per line.
      IF v_app_service_id IS NULL THEN
        RAISE EXCEPTION 'SPLIT_SERVICE_NO_SERVICE: service line % requires an application service', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      SELECT * INTO v_app_service FROM application_services WHERE id = v_app_service_id;
      IF NOT FOUND OR NOT v_app_service.is_active THEN
        RAISE EXCEPTION 'Application service not found or inactive: %', v_app_service_id;
      END IF;
      v_svc_name := v_app_service.name;

      IF v_src_acres IS NULL THEN
        v_src_acres := v_total_applied_acres;
      END IF;
      -- Fable-adversarial HIGH: service source_acres is the billable basis and was the one billable
      -- input with no positivity guard (round-5 covered chemical qty, service RATE, flat cents, per-
      -- share override). A direct/modified RPC call with a negative or zero value would mint a NEGATIVE
      -- (credit) invoice that reduces AR and passes every §5 invariant (signed LR; total<>0 so not $0-
      -- suppressed). The editor only sends positive acres; enforce it server-side.
      IF v_src_acres <= 0 THEN
        RAISE EXCEPTION 'SPLIT_SERVICE_ACRES_NONPOSITIVE: service line % requires source_acres > 0', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;

      -- Service COGS: per-acre cost from the service record (mirrors the live field-app path,
      -- which uses application_services.cost_per_acre_cents). Codex P1 #3.
      v_line_unit_cost := COALESCE(v_app_service.cost_per_acre_cents, 0);

      IF COALESCE((v_line->>'manual_override')::boolean, false) THEN
        -- Explicit single negotiated per-acre rate for the whole line (applies to everyone).
        -- Codex round-5 P1: enforce a POSITIVE amount server-side (the editor rejects <=0, but a
        -- direct/modified RPC call could otherwise create a free or negative service line).
        IF v_src_unit_price IS NULL OR v_src_unit_price <= 0 THEN
          RAISE EXCEPTION 'SPLIT_SERVICE_RATE_NONPOSITIVE: a manual service rate must be a positive amount on line %', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_base_source := COALESCE(v_base_source, 'service_rate');
      ELSE
        -- Per-customer service rate (Codex P1 #2 — Option B for service): each co-owner at
        -- their OWN customer_application_rates(service, INVOICE/JOB season) → service default,
        -- exactly like the live per-child field-app save. v_season (round-3 P1) ensures a
        -- backdated/prior-season job uses that season's historical rate, not current_season().
        SELECT COALESCE(jsonb_object_agg(m.cust, COALESCE(
                 (SELECT car.rate_per_acre_cents FROM customer_application_rates car
                   WHERE car.customer_id            = m.cust::uuid
                     AND car.application_service_id = v_app_service_id
                     AND car.season                 = v_season
                   LIMIT 1),
                 v_app_service.default_rate_per_acre_cents, 0)), '{}'::jsonb)
          INTO v_svc_price_map
          FROM unnest(v_members) AS m(cust);
        -- #M: the precise per-customer source (a custom customer_application_rates row =>
        -- 'service_rate', otherwise the service default => 'service_default'), so each
        -- co-owner's audited base_price_source is their OWN resolved source. Same season (round-3).
        SELECT jsonb_object_agg(m.cust, CASE WHEN EXISTS (
                 SELECT 1 FROM customer_application_rates car
                  WHERE car.customer_id            = m.cust::uuid
                    AND car.application_service_id = v_app_service_id
                    AND car.season                 = v_season)
               THEN 'service_rate' ELSE 'service_default' END)
          INTO v_svc_source_map
          FROM unnest(v_members) AS m(cust);
        -- Representative (display + the calculator's default price): the largest-share owner's rate.
        v_src_unit_price := COALESCE((v_svc_price_map->>(
            SELECT (value->>'customer_id') FROM jsonb_array_elements(v_vector) AS value
             ORDER BY (value->>'micro_pct')::bigint DESC, value->>'customer_id' ASC LIMIT 1))::bigint, 0);
        v_base_source := COALESCE(v_base_source, 'service_default');
      END IF;
    ELSIF v_line_kind = 'chemical' THEN
      -- R8 (Option B — Mason 2026-07-18): resolve the price SERVER-SIDE and price EACH
      -- co-owner's share at THAT customer's OWN tier (manual override → field quote apply to
      -- everyone; only the tier fallback differs per customer — exactly like the live per-child
      -- field-app save). Also convert the applied quantity rate-unit → product sold unit.
      DECLARE
        v_chem_manual bigint  := NULL;
        v_rep_tier    integer;
        v_inv_unit    text;
        v_form        text;
        v_priced_qty  numeric;
        v_price_res   jsonb;
        v_rate_unit   text := NULLIF(btrim(coalesce(v_line->>'rate_unit', '')), '');
      BEGIN
        IF v_product_id IS NULL THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_NO_PRODUCT: chemical line % requires product_id', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_src_qty IS NULL OR v_src_qty <= 0 THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_NO_QUANTITY: chemical line % requires source_quantity > 0', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;

        -- Honor a caller price ONLY as an explicit manual override (a single negotiated price
        -- for the whole line — applies to every co-owner).
        IF COALESCE((v_line->>'manual_override')::boolean, false) THEN
          -- Codex round-5 P1: require a POSITIVE manual price server-side (the editor rejects
          -- <=0 / sci-notation, but a direct or modified-client RPC call could otherwise create a
          -- free or negative chemical line despite the UI invariant).
          IF v_src_unit_price IS NULL OR v_src_unit_price <= 0 THEN
            RAISE EXCEPTION 'SPLIT_CHEMICAL_OVERRIDE_PRICE_REQUIRED: manual_override set but source_unit_price_cents is missing or not positive on chemical line %', v_idx
              USING ERRCODE = 'invalid_parameter_value';
          END IF;
          v_chem_manual := v_src_unit_price;
        END IF;

        -- Product units for the rate -> pricing-unit conversion, plus the server-resolved
        -- unit COST (Codex P1 #3). current_cost is dollars per the product's inventory (sold)
        -- unit — the SAME unit as the priced quantity below — so per-unit cents = round(*100),
        -- exactly like _snapshot_order_item_cost and the parked save_invoice.
        SELECT p.inventory_unit, p.product_form,
               COALESCE(round(p.current_cost * 100)::bigint, 0)
          INTO v_inv_unit, v_form, v_line_unit_cost
          FROM products p WHERE p.id = v_product_id;

        -- Per-customer price map (Option B): each billing-set member priced at their OWN
        -- assigned_tier. resolve_field_app_chemical_price() naturally makes manual/quote shared
        -- (tier-independent) and only the tier fallback per-customer, so a manual/quote line
        -- yields identical prices for everyone (calculator collapses to source_lr) while a
        -- pure-tier line prices each co-owner at their own tier (calculator per_person).
        SELECT COALESCE(jsonb_object_agg(
                 m.cust,
                 (resolve_field_app_chemical_price(
                    v_product_id, v_field_ids,
                    COALESCE((SELECT c.assigned_tier FROM customers c WHERE c.id = m.cust::uuid), 1),
                    v_chem_manual)->>'unit_price_cents')::bigint), '{}'::jsonb)
          INTO v_chem_price_map
          FROM unnest(v_members) AS m(cust);

        -- Codex round-11 P1: reject an UNRESOLVED chemical price. Without a manual override, if any
        -- co-owner's resolved price (field quote → their assigned tier) is NULL or <= 0, the line would
        -- bill $0, be flagged suppressed_zero_total, and STILL post — consuming inventory + RUP records
        -- with NO receivable and no operator signal. Require a real positive price for EVERY member. A
        -- manual override (already validated > 0 above) resolves the same for everyone, so it passes.
        IF v_chem_manual IS NULL AND EXISTS (
          SELECT 1 FROM unnest(v_members) AS m(cust)
           WHERE COALESCE((v_chem_price_map->>m.cust)::bigint, 0) <= 0
        ) THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_PRICE_UNRESOLVED: chemical line % has no resolvable price (no field quote and no tier price) for one or more co-owners — set the product''s tier pricing / a field quote, or enter a manual override, before saving', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;

        -- Representative line base (display + the calculator's default price): the largest-share
        -- owner's price. The MONEY comes from the per-customer overrides injected below, not this.
        SELECT c.assigned_tier INTO v_rep_tier
          FROM customers c
         WHERE c.id = (
           SELECT (value->>'customer_id')::uuid
             FROM jsonb_array_elements(v_vector) AS value
            ORDER BY (value->>'micro_pct')::bigint DESC, value->>'customer_id' ASC
            LIMIT 1);
        v_price_res      := resolve_field_app_chemical_price(
                              v_product_id, v_field_ids, COALESCE(v_rep_tier, 1), v_chem_manual);
        v_src_unit_price := (v_price_res->>'unit_price_cents')::bigint;
        v_base_source    := v_price_res->>'price_source';

        -- Convert applied qty (rate unit) -> product sold unit so price x qty is per the
        -- SAME unit (the live 128x guard). No inventory_unit -> identity (price as entered).
        v_priced_qty := field_app_priced_quantity(
                          v_src_qty, v_rate_unit, COALESCE(v_inv_unit, v_rate_unit), v_form);
        IF v_priced_qty IS NULL THEN
          RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: chemical line % — rate unit "%" does not convert to the product''s sold unit "%". Fix this product''s units before invoicing.',
            v_idx, coalesce(v_rate_unit, '<none>'), COALESCE(v_inv_unit, v_rate_unit, '<none>')
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_src_qty := round(v_priced_qty, 4);
        -- Quantity is now in the pricing (sold) unit; show that unit on the invoice line
        -- so the displayed quantity and its unit label agree.
        v_eff_rate_unit := COALESCE(v_inv_unit, v_rate_unit);
      END;
    ELSE
      -- flat_fee / fuel_surcharge: bill from source_flat_cents; unit price is 0.
      -- Codex round-5 P1: require a POSITIVE amount server-side. The editor rejects <=0
      -- ("credits aren't supported here yet"), but a direct RPC call must not create a free or
      -- negative flat charge (a negative flat_cents would post a CHARGE the operator never saw).
      IF v_src_flat IS NULL OR v_src_flat <= 0 THEN
        RAISE EXCEPTION 'SPLIT_FLAT_CENTS_REQUIRED: source_flat_cents must be a positive amount for % line %', v_line_kind, v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_src_unit_price := COALESCE(v_src_unit_price, 0);
      v_base_source    := 'flat';
    END IF;

    INSERT INTO field_app_billing_lines (
      billing_set_id, line_kind, product_id, application_service_id, description,
      source_quantity, source_acres, source_unit_price_cents, sort_order
    ) VALUES (
      v_set_id, v_line_kind, v_product_id, v_app_service_id, v_line_desc,
      -- Codex round-4 P2 #10: persist the source applied-acre basis alongside the quantity.
      -- Service lines bill on acres (source_quantity is NULL for them), so without this a
      -- post-time verifier had no acre basis for a service line. Now every line records both.
      v_src_qty, v_src_acres, v_src_unit_price, v_idx
    ) RETURNING id INTO v_line_id;

    -- Build the calculator share vector. If the caller omitted 'shares' the line
    -- uses the default vector; otherwise each share may override micro_pct/price
    -- (a null micro_pct on a field_default share is filled from the default map).
    IF v_line ? 'shares' AND jsonb_typeof(v_line->'shares') = 'array'
       AND jsonb_array_length(v_line->'shares') > 0 THEN
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', s->>'customer_id',
               'micro_pct',
                 CASE WHEN s->'micro_pct' IS NOT NULL AND jsonb_typeof(s->'micro_pct') <> 'null'
                      THEN (s->>'micro_pct')::bigint
                      ELSE (v_micro_map->>(s->>'customer_id'))::bigint END,
               'split_mode', COALESCE(s->>'split_mode', 'field_default'),
               'price_mode', COALESCE(s->>'price_mode', 'default'),
               'override_unit_price_cents', s->'override_unit_price_cents'
             ))
        INTO v_shares
        FROM jsonb_array_elements(v_line->'shares') AS s;
    ELSE
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', v->>'customer_id',
               'micro_pct',   (v->>'micro_pct')::bigint,
               'split_mode',  'field_default',
               'price_mode',  'default'
             ))
        INTO v_shares
        FROM jsonb_array_elements(v_vector) AS v;
    END IF;

    -- Option B (chemical): price each share at that customer's OWN resolved price from the map,
    -- UNLESS the caller already set an explicit per-person override (a manual draft adjustment,
    -- which wins). The override slot is how per-person prices reach the calculator. Uniform-price
    -- lines are then routed round-once via the penny guard below (source_lr); genuinely mixed
    -- per-customer prices use the calculator's per_person path (exact to its own SUM).
    IF COALESCE(v_chem_price_map, v_svc_price_map) IS NOT NULL THEN
      SELECT jsonb_agg(
               CASE
                 WHEN s->>'price_mode' = 'override'
                      AND s->'override_unit_price_cents' IS NOT NULL
                      AND jsonb_typeof(s->'override_unit_price_cents') <> 'null'
                 THEN s
                 ELSE jsonb_set(
                        jsonb_set(s, '{price_mode}', '"override"'::jsonb),
                        '{override_unit_price_cents}',
                        to_jsonb((COALESCE(v_chem_price_map, v_svc_price_map)->>(s->>'customer_id'))::bigint))
               END)
        INTO v_shares
        FROM jsonb_array_elements(v_shares) AS s;

      -- Penny guard: when EVERY co-owner ends up at the SAME effective price (a manual/quote
      -- line, all-same-tier, OR a uniform manual per-person adjustment that differs from the
      -- representative), align the calculator's source price to that shared value so it routes
      -- through the round-once source_lr path (penny-exact to a single parent total) instead of
      -- per_person (which can differ by up to n-1 cents on the group total). Mixed prices keep
      -- per_person. Adversarial LOW, 2026-07-18.
      SELECT CASE WHEN count(DISTINCT (s->>'override_unit_price_cents')::bigint) = 1
                  THEN max((s->>'override_unit_price_cents')::bigint) END
        INTO v_uniform_price
        FROM jsonb_array_elements(v_shares) AS s
       WHERE s->>'override_unit_price_cents' IS NOT NULL;
      -- Codex round-7 P2: preserve the RESOLVED representative base BEFORE the uniform penny guard may
      -- overwrite v_src_unit_price with a (uniform) caller override. An 'override' share's AUDITED base
      -- must stay the true tier/quote/service base, not the override value — otherwise the audit reads
      -- as if the override equalled the base and the real tier/quote/service price is lost.
      v_repr_base_price := v_src_unit_price;
      IF v_uniform_price IS NOT NULL THEN
        v_src_unit_price := v_uniform_price;
      END IF;
    ELSE
      v_repr_base_price := v_src_unit_price;
    END IF;

    -- Every line's customer set must EXACTLY equal the billing-set members (spec §3).
    SELECT array_agg(value->>'customer_id' ORDER BY value->>'customer_id')
      INTO v_line_customers
      FROM jsonb_array_elements(v_shares) AS value;
    IF v_line_customers IS DISTINCT FROM v_members THEN
      RAISE EXCEPTION 'SPLIT_LINE_MEMBER_MISMATCH: line % customers do not equal the billing-set members', v_idx
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The single shared engine — preview and save both call this exact function.
    v_calc := compute_line_split_allocation(jsonb_build_object(
      'billing_line_id',         v_line_id::text,
      'line_kind',               v_line_kind,
      'source_quantity',         v_src_qty,
      'source_acres',            v_src_acres,
      'source_unit_price_cents', v_src_unit_price,
      'source_flat_cents',       v_src_flat,
      'base_price_source',       v_base_source,
      'shares',                  v_shares
    ));

    -- Persist the canonical source-line total for the invariant check. Fable-adversarial MED: also
    -- re-persist source_unit_price_cents to the price the money ACTUALLY used — the billing line was
    -- INSERTed with the representative resolved price, but the uniform-override penny guard above may
    -- have re-pointed v_src_unit_price (e.g. a uniform per-person override that differs from the base),
    -- leaving the audit row's price × source inconsistent with its own source_line_cents.
    UPDATE field_app_billing_lines
       SET source_line_cents = (v_calc->>'source_line_cents')::bigint,
           source_unit_price_cents = v_src_unit_price
     WHERE id = v_line_id;

    -- #G (Codex round-2 P1): allocate the ONE canonical line COGS across co-owners with the
    -- SAME largest-remainder rule used for revenue, so the group total_cost ties EXACTLY to
    -- unit_cost x source — no per-child independent-rounding drift of up to n-1 cents. The
    -- line's micro_pct weights already sum to 100000000 (enforced by the invariant), so
    -- _lr_allocate_int sums the shares to v_line_cogs exactly. Zero cost => all-zero shares.
    v_line_cogs := CASE
      WHEN v_line_kind = 'service'  THEN safe_cents_qty(v_line_unit_cost, COALESCE(v_src_acres, 0))
      WHEN v_line_kind = 'chemical' THEN safe_cents_qty(v_line_unit_cost, COALESCE(v_src_qty, 0))
      ELSE 0 END;
    SELECT jsonb_agg(jsonb_build_object('customer_id', a->>'customer_id',
                                        'weight', (a->>'micro_pct')::bigint))
      INTO v_cogs_weights
      FROM jsonb_array_elements(v_calc->'allocations') AS a;
    SELECT jsonb_object_agg(x->>'customer_id', (x->>'amount')::bigint)
      INTO v_cogs_map
      FROM jsonb_array_elements(public._lr_allocate_int(v_line_cogs, v_cogs_weights)) AS x;

    v_line_plans := v_line_plans || jsonb_build_array(jsonb_build_object(
      'billing_line_id', v_line_id::text,
      'line_kind',       v_line_kind,
      'product_id',      v_product_id,
      'description',     v_line_desc,
      'rate_unit',       v_eff_rate_unit,
      'sort_order',      v_idx,
      'unit_cost_cents', v_line_unit_cost,   -- per-unit COGS (Codex P1 #3)
      'cogs_by_customer', v_cogs_map,        -- LR-allocated per-child COGS (Codex r2 #G)
      'per_customer_priced', (COALESCE(v_chem_price_map, v_svc_price_map) IS NOT NULL), -- Option B (#M)
      'caller_override_custs', COALESCE(to_jsonb(v_caller_override), '[]'::jsonb),       -- genuine overrides (#M)
      'repr_base_unit_price_cents', v_repr_base_price,   -- resolved representative base for the override audit (Codex r7 P2)
      'resolved_price_map', COALESCE(v_chem_price_map, v_svc_price_map, '{}'::jsonb),    -- customer_id -> OWN resolved pre-override price (Codex r8 P2)
      'svc_source_map',  COALESCE(v_svc_source_map, '{}'::jsonb),  -- per-customer service source (#M)
      'reasons_map',     COALESCE(v_reasons_map, '{}'::jsonb),     -- split/price reasons (#L)
      'service_name',    CASE WHEN v_line_kind = 'service' THEN v_svc_name ELSE NULL END, -- Codex r2 #N (via v_svc_name: referencing the record here crashed service-less saves)
      'alloc',           v_calc
    ));
    v_line_hashes := v_line_hashes || jsonb_build_array(v_calc->>'vector_hash');
  END LOOP;

  -- ---- PASS 2: one child invoice per customer --------------------------------
  FOREACH v_cust IN ARRAY v_members
  LOOP
    v_customer_id := v_cust::uuid;
    SELECT farm_name INTO v_customer_name FROM customers WHERE id = v_customer_id;
    -- Display-only "primary grower" flag on the compat share row.
    v_is_primary := EXISTS (
      SELECT 1 FROM field_billing_defaults d
       WHERE d.field_id = ANY(v_field_ids)
         AND d.customer_id = v_customer_id
         AND d.is_primary);

    -- sql-safety: exempt-registry — invoices.field_app_billing_set_id / send_disposition
    -- are created by the prior parked migration 20260718010000 (see file header).
    -- Reuse an existing child for this customer on re-save (preserves invoice_number
    -- + append-only snapshot history — adversarial F1 fix); INSERT only for a new customer.
    v_invoice_id := NULL;
    IF p_billing_set_id IS NOT NULL THEN
      -- Reuse only an EDITABLE (draft/unposted) child. Fable-adversarial BLOCKER: a child voided/
      -- cancelled via the live void_invoice stays attached to the set; reusing (reviving) it would be a
      -- forbidden voided->draft transition AND resurrect a dead invoice. Skip it — a fresh child is
      -- INSERTed below for this still-member customer; the terminal one stays as voided/cancelled history.
      SELECT id INTO v_invoice_id FROM invoices
       WHERE field_app_billing_set_id = v_set_id
         AND customer_id = v_customer_id
         AND deleted_at IS NULL
         AND status IN ('draft', 'unposted')
       LIMIT 1;
    END IF;

    IF v_invoice_id IS NULL THEN
      v_is_new_invoice := true;
      v_invoice_number := next_invoice_number('field_application');
      -- sql-safety: exempt-registry — invoices.field_app_billing_set_id is created by the prior
      -- parked migration 20260718010000 (not yet in the schema-registry); job_id / application_date
      -- / season are long-standing invoices columns (mirrors transfer_job_to_invoice).
      -- sql-safety: exempt-registry — field_app_billing_set_id is created by the parked migration
      -- 20260718010000 (not yet in the registry); field_names/crop_type/total_acres are long-standing
      -- invoices columns (20260219200000_invoice_statement_enrichment).
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status,
        invoice_date, salesman_id, header_notes, created_by,
        total_amount_cents, total_cost_cents,
        invoice_group_id, application_service_id, season,
        field_app_billing_set_id, job_id, application_date,
        field_names, crop_type, total_acres,   -- Codex r7 P2: denormalized field context for the combined list/PDFs
        applicator_name, vehicle_name           -- Codex r8 P2: source-job applicator/vehicle
      ) VALUES (
        v_invoice_number, v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date),  -- fallback is the America/Chicago business date, never UTC (2026-09-03)
        v_salesman_id, p_invoice->>'header_notes', p_performed_by,
        0, 0,
        v_group_id, p_application_service_id, v_season,   -- season = job/invoice season (round-3 P1)
        -- job_id + application_date on EVERY child so field-invoice lists resolve Job # and the
        -- application date, not just the first child via jobs.invoice_id (round-3 P2).
        v_set_id, p_source_job_id, v_job_app_date,
        v_inv_field_names, v_inv_crop_type, v_total_applied_acres,
        v_inv_applicator_name, v_inv_vehicle_name
      ) RETURNING id INTO v_invoice_id;
    ELSE
      v_is_new_invoice := false;
      -- Load the existing invoice_number so it is never stale/null on a re-save (Codex P1 #8).
      SELECT invoice_number INTO v_invoice_number FROM invoices WHERE id = v_invoice_id;
      -- Keep status as-is (draft or unposted); a non-admin cannot reassign salesman.
      UPDATE invoices SET
        invoice_date           = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
        salesman_id            = CASE WHEN is_admin() THEN v_salesman_id ELSE salesman_id END,
        header_notes           = p_invoice->>'header_notes',
        application_service_id  = p_application_service_id,
        invoice_group_id       = v_group_id,
        season                 = v_season,               -- keep season in sync on re-save (round-3 P1)
        job_id                 = p_source_job_id,         -- round-3 P2 (frozen source job)
        application_date       = v_job_app_date,
        field_names            = v_inv_field_names,        -- Codex r7 P2: keep denormalized field context in sync on re-save
        crop_type              = v_inv_crop_type,
        total_acres            = v_total_applied_acres,
        applicator_name        = v_inv_applicator_name,    -- Codex r8 P2
        vehicle_name           = v_inv_vehicle_name,
        total_amount_cents     = 0,
        total_cost_cents       = 0,
        send_disposition       = 'normal',
        updated_at             = now()
      WHERE id = v_invoice_id;
    END IF;

    v_invoice_total := 0;
    v_invoice_cost  := 0;
    v_invoice_chem_profit := 0;   -- round-5 P1: this child's chemical profit (LR COGS), for commissions
    -- Compat share acres derived ONCE from the ownership vector × total applied acres
    -- (Codex P2 #9), independent of the billing lines — so it neither zeroes out on a
    -- no-service set nor double-counts across multiple service lines.
    v_cust_acres    := round(v_total_applied_acres
                             * COALESCE((v_micro_map->>v_cust)::numeric, 0) / 100000000.0, 2);

    FOR v_plan IN SELECT * FROM jsonb_array_elements(v_line_plans)
    LOOP
      v_line_kind := v_plan->>'line_kind';
      -- this customer's allocation row for this line
      SELECT a INTO v_alloc_row
        FROM jsonb_array_elements(v_plan->'alloc'->'allocations') AS a
       WHERE a->>'customer_id' = v_cust;
      IF v_alloc_row IS NULL THEN
        RAISE EXCEPTION 'SPLIT_MISSING_ALLOCATION: customer % missing on line %', v_cust, v_plan->>'billing_line_id'
          USING ERRCODE = 'internal_error';
      END IF;

      v_qty         := (v_alloc_row->>'allocated_quantity')::numeric;
      v_acres_alloc := (v_alloc_row->>'allocated_acres')::numeric;

      -- #M (Codex round-2 P2) + #L reasons: decide each co-owner's AUDITED base price / source /
      -- mode. A co-owner's OWN resolved per-customer price (Option B) is their BASE with its real
      -- source and price_mode='default'; only a genuine caller-supplied manual per-person override
      -- is audited as an 'override' against the representative base. Non-Option-B lines keep the
      -- calculator's values verbatim. Reasons are captured when the operator supplied them.
      v_split_reason := NULLIF(v_plan->'reasons_map'->v_cust->>'split_reason', '');
      v_price_reason := NULLIF(v_plan->'reasons_map'->v_cust->>'price_reason', '');
      IF (v_plan->'caller_override_custs') ? v_cust THEN
        -- Codex round-7/8 P2: audit THIS customer's OWN resolved pre-override price (Option B), falling
        -- back to the resolved representative base (round-7) then the calculator base. Never the override
        -- value itself — the audit must document what the price WOULD have been before the override.
        v_share_base_price  := COALESCE((v_plan->'resolved_price_map'->>v_cust)::bigint,
                                        (v_plan->>'repr_base_unit_price_cents')::bigint,
                                        (v_alloc_row->>'base_unit_price_cents')::bigint);
        v_share_base_source := CASE WHEN v_line_kind = 'service'
                                    THEN COALESCE(v_plan->'svc_source_map'->>v_cust, v_alloc_row->>'base_price_source')
                                    ELSE v_alloc_row->>'base_price_source' END;
        v_share_price_mode  := 'override';
      ELSIF COALESCE((v_plan->>'per_customer_priced')::boolean, false) THEN
        v_share_base_price  := (v_alloc_row->>'unit_price_cents')::bigint;        -- this co-owner's OWN price
        v_share_base_source := CASE WHEN v_line_kind = 'service'
                                    THEN COALESCE(v_plan->'svc_source_map'->>v_cust, v_alloc_row->>'base_price_source')
                                    ELSE v_alloc_row->>'base_price_source' END;
        v_share_price_mode  := 'default';
      ELSE
        v_share_base_price  := (v_alloc_row->>'base_unit_price_cents')::bigint;
        v_share_base_source := v_alloc_row->>'base_price_source';
        v_share_price_mode  := v_alloc_row->>'price_mode';
      END IF;

      -- Map the AUDITED per-customer source onto the invoice_items.price_source
      -- convention set ('manual'|'quoted'|'tier'); the exact source is preserved
      -- on invoice_line_shares.base_price_source.
      v_item_price_source := CASE v_share_base_source
        WHEN 'quoted' THEN 'quoted'
        WHEN 'tier'   THEN 'tier'
        WHEN 'service_rate'    THEN 'tier'
        WHEN 'service_default' THEN 'tier'
        ELSE 'manual' END;

      -- #G (Codex round-2 P1): this co-owner's LR-allocated COGS share for the line, so the
      -- GROUP total_cost ties EXACTLY to the canonical unit_cost x source (no per-child
      -- independent-round drift of up to n-1 cents). The invoice_items.cost_cents keeps its
      -- display convention (#F): a chemical item carries PER-UNIT cost (PDF/detail render unit
      -- economics), a fee (service) item carries this EXTENDED share. The header total_cost
      -- accumulates the LR share below, so the group total is exact regardless.
      v_item_cost_cents := COALESCE((v_plan->'cogs_by_customer'->>v_cust)::bigint, 0);

      -- sql-safety: exempt-registry — invoice_items.billing_line_id is created by the prior parked
      -- migration 20260718010000 (not yet in the registry); unit_size/total_applied/total_applied_unit
      -- are long-standing invoice_items columns (20260219200000_invoice_statement_enrichment).
      -- Codex round-8 P1: the field-application PDF/email renders the price unit from unit_size and the
      -- applied quantity from total_applied/total_applied_unit. For a chemical child, mirror the canonical
      -- field-app item: unit_size = the pricing unit, total_applied = this co-owner's billed quantity in
      -- that unit. Service/flat leave them null (service bills per acre; flat is flat).
      INSERT INTO invoice_items (
        invoice_id, product_id, description,
        quantity, unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_unit,
        unit_size, total_applied, total_applied_unit,
        is_application_fee, price_source, billing_line_id
      ) VALUES (
        v_invoice_id, (v_plan->>'product_id')::uuid,
        COALESCE(NULLIF(v_plan->>'description', ''),
                 (SELECT product_name FROM products WHERE id = (v_plan->>'product_id')::uuid),
                 NULLIF(v_plan->>'service_name', ''),      -- Codex r2 #N: real service name, not literal 'Service'
                 initcap(v_line_kind)),
        CASE WHEN v_line_kind = 'service' THEN COALESCE(v_acres_alloc, 0)
             WHEN v_line_kind = 'chemical' THEN COALESCE(v_qty, 0)
             ELSE 1 END,
        (v_alloc_row->>'unit_price_cents')::bigint,
        (v_alloc_row->>'amount_cents')::bigint,     -- extended = authoritative allocation
        CASE WHEN v_line_kind = 'chemical' THEN (v_plan->>'unit_cost_cents')::bigint
             ELSE v_item_cost_cents END,            -- chemical: PER-UNIT; fee: EXTENDED LR share (#F/#G)
        (v_plan->>'sort_order')::int,
        v_acres_alloc,
        CASE WHEN v_line_kind = 'service' THEN 'acre' ELSE v_plan->>'rate_unit' END,
        CASE WHEN v_line_kind = 'chemical' THEN NULLIF(v_plan->>'rate_unit', '') END,   -- unit_size = pricing unit
        CASE WHEN v_line_kind = 'chemical' THEN COALESCE(v_qty, 0) END,                  -- total_applied = billed qty
        CASE WHEN v_line_kind = 'chemical' THEN NULLIF(v_plan->>'rate_unit', '') END,   -- total_applied_unit
        (v_line_kind = 'service'),
        v_item_price_source,
        (v_plan->>'billing_line_id')::uuid
      ) RETURNING id INTO v_item_id;

      INSERT INTO invoice_line_shares (
        billing_line_id, invoice_item_id, customer_id,
        split_mode, split_micro_pct, allocated_quantity, allocated_acres,
        base_unit_price_cents, base_price_source, price_mode,
        unit_price_cents, amount_cents,
        split_override_reason, price_override_reason,
        calculation_hash, vector_hash, created_by
      ) VALUES (
        (v_plan->>'billing_line_id')::uuid, v_item_id, v_customer_id,
        v_alloc_row->>'split_mode', (v_alloc_row->>'micro_pct')::bigint,
        v_qty, v_acres_alloc,
        v_share_base_price,          -- #M: co-owner's OWN resolved price is the audited base
        v_share_base_source,         -- #M: their own resolved source (service_rate/tier/...)
        v_share_price_mode,          -- #M: 'default' for resolved pricing, 'override' only for a real one
        (v_alloc_row->>'unit_price_cents')::bigint,
        (v_alloc_row->>'amount_cents')::bigint,
        v_split_reason, v_price_reason,   -- #L: captured reasons when the operator supplied them
        v_alloc_row->>'calculation_hash',
        v_plan->'alloc'->>'vector_hash',
        p_performed_by
      );

      v_invoice_total := v_invoice_total + (v_alloc_row->>'amount_cents')::bigint;
      -- #G: accumulate this co-owner's LR-allocated COGS share directly; the GROUP total_cost
      -- now ties EXACTLY to the canonical unit_cost x source (no per-child rounding drift).
      v_invoice_cost  := v_invoice_cost + v_item_cost_cents;
      -- Codex round-5 P1: chemical-line profit for commissions uses the SAME LR-allocated COGS
      -- (v_item_cost_cents), NOT a re-rounded cost*qty on the per-unit item cost. Only product-
      -- backed chemical lines count toward commission (fees/service/flat are excluded), mirroring
      -- transfer_job_to_invoice's chemical-only profit basis.
      IF v_line_kind = 'chemical' THEN
        v_invoice_chem_profit := v_invoice_chem_profit
          + ((v_alloc_row->>'amount_cents')::bigint - v_item_cost_cents);
      END IF;
    END LOOP;

    -- Stash this child's chemical profit (cents) for the commission mint below (round-5 P1).
    v_chem_profit_by_child := v_chem_profit_by_child
      || jsonb_build_object(v_invoice_id::text, v_invoice_chem_profit);

    v_send_disposition := CASE WHEN v_invoice_total = 0 THEN 'suppressed_zero_total' ELSE 'normal' END;

    UPDATE invoices
       SET total_amount_cents = v_invoice_total,
           total_cost_cents   = v_invoice_cost,
           send_disposition   = v_send_disposition,
           updated_at         = now()
     WHERE id = v_invoice_id;

    -- R2: keep the compatibility invoice_shares self-100% row (statements/year-end
    -- read invoice_shares.amount_cents). Do NOT drop as "redundant".
    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order, price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_cust_acres, v_invoice_total,
      v_is_primary, 0, NULL, NULL
    );

    -- Append-only ledger: emit the 'invoice_created' row ONLY when this child was freshly
    -- INSERTed (Codex P1 #8). On a re-save we reuse the existing child, so a creation row
    -- here would duplicate the invoice's financial impact and (previously) carry a stale/null
    -- invoice_number. A re-save changes draft line detail only; no creation event is due.
    IF v_is_new_invoice THEN
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object('invoice_number', v_invoice_number,
                           'customer_id', v_customer_id,
                           'total_cents', v_invoice_total,
                           'send_disposition', v_send_disposition),
        v_invoice_total,
        'Per-line split field application invoice created'
      );
    END IF;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);
  END LOOP;

  -- ---- #E CONSUME THE SOURCE JOB (Codex round-2 P1) --------------------------
  -- Now that the child invoices exist, mark the source job invoiced exactly like
  -- transfer_job_to_invoice does, so the normal flow's "Job already invoiced" guard
  -- fires and the same work can never be billed twice. Idempotent on re-save (a job
  -- already 'invoiced' by THIS set is left as-is; the guard above already allowed it).
  IF p_source_job_id IS NOT NULL THEN
    -- Resolve the commission split exactly like transfer_job_to_invoice: the job's own
    -- creation-time snapshot, else the parent quote's split, else the customer default (only
    -- pre-U8 jobs reach the fallback). v_job was loaded FOR UPDATE in the #E guard above.
    v_commission_split := v_job.commission_split;
    IF v_commission_split IS NULL THEN
      IF v_job.quote_id IS NOT NULL THEN
        SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
      ELSE
        SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
      END IF;
    END IF;

    -- Consume the job: flip completed->invoiced, set the anchor invoice_id, AND persist the resolved
    -- split — ALL IN ONE statement while OLD.status='completed'. The live enforce_billed_job_immutability
    -- trigger early-returns for a not-yet-billed job, so this is the ONLY point a non-admin may set
    -- invoice_id (drift B1); it is exactly the single-statement shape of transfer_job_to_invoice.
    -- Idempotent: no-ops on re-save (status already 'invoiced').
    UPDATE jobs SET status = 'invoiced', invoice_id = v_invoice_ids[1],
        commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
     WHERE id = p_source_job_id AND status <> 'invoiced';

    -- Codex round-5 P2 / drift B1: on a RE-SAVE that dropped the member previously stored in
    -- jobs.invoice_id, the anchor now points at a cancelled, detached child — repoint it to a surviving
    -- current child (v_invoice_ids only ever holds current members). The job is already 'invoiced', so
    -- the immutability trigger would block a non-admin from changing invoice_id — use the SAME
    -- app.admin_override hatch that trigger sanctions for definer-flow writers (as transfer_invoice_to_job
    -- does), scoped tightly around JUST this repoint, and ONLY when the stored anchor is no longer a live
    -- member child (a no-op when it is unchanged — the common re-save case, no override needed).
    IF NOT EXISTS (
      SELECT 1 FROM invoices i
       WHERE i.id = (SELECT j.invoice_id FROM jobs j WHERE j.id = p_source_job_id)
         AND i.field_app_billing_set_id = v_set_id
         AND i.deleted_at IS NULL AND i.status <> 'cancelled'
    ) THEN
      PERFORM set_config('app.admin_override', 'true', true);
      UPDATE jobs SET invoice_id = v_invoice_ids[1] WHERE id = p_source_job_id;
      PERFORM set_config('app.admin_override', 'false', true);
    END IF;

    -- application_records has no billed-immutability guard (triggers live only on jobs / job_applied_
    -- records) — repoint it unconditionally to the surviving anchor, matching live transfer_job_to_invoice.
    UPDATE application_records SET invoice_id = v_invoice_ids[1]
     WHERE source_type = 'job' AND source_id = p_source_job_id;

    -- ---- Per-child commissions (Codex round-4 P1) ----------------------------
    -- Mirror transfer_job_to_invoice's PER-OWNER GROUP path: each child invoice mints
    -- commissions on ITS OWN chemical-line profit, so the sum across children equals the
    -- whole job's chemical profit and each recipient is paid per invoice they touch. A
    -- split job billed here previously created NO commissions AND the status flip blocked
    -- the normal path from ever creating them.
    --
    -- Profit basis (Codex round-5 P1): each child's CHEMICAL profit accumulated in PASS 2 using the
    -- SAME largest-remainder-allocated COGS (v_item_cost_cents) that the header total_cost carries —
    -- NOT a re-rounded ROUND(cost × qty) on the per-unit item cost, which would drift on fractional
    -- child quantities (1¢/1u/50-50 rounds both 0.5¢ shares up to 1¢, understating profit). Service /
    -- flat / fee lines contribute 0. Sum across children == the whole job's chemical profit.
    --
    -- Re-save safe: a redraw rewrites every child's items (changing profit) and may DROP a member
    -- (whose child was orphan-cancelled above). The #E guard makes this job EXCLUSIVE to this set
    -- (it cannot be on another set or normally invoiced), so EVERY commission carrying this job_id
    -- belongs to this set — clear them ALL (including a dropped member's, which would otherwise leak
    -- a phantom pending commission on a cancelled invoice), then re-mint only for the current
    -- members. First REFUSE if any are already in an active payout batch or already paid (mirrors
    -- the U8 edit guards): the operator must void that commission payment before re-saving. On a
    -- first save there are none, so the guards pass and the clear is a no-op.
    IF EXISTS (
      SELECT 1 FROM commissions c
      JOIN commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
      WHERE c.job_id = p_source_job_id AND c.status = 'pending' AND cp.status <> 'voided'
    ) THEN
      RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this split''s pending commissions are in an active payout batch — void that commission payment before re-saving';
    END IF;
    IF EXISTS (
      SELECT 1 FROM commissions c WHERE c.job_id = p_source_job_id AND c.status = 'paid'
    ) THEN
      RAISE EXCEPTION 'JOB_COMMISSIONS_PAID: this split''s commissions were already paid out — void that commission payment before re-saving';
    END IF;

    -- Fable-adversarial HIGH: SOFT-cancel (never hard-DELETE) the prior commissions, then re-mint.
    -- A hard DELETE FK-violates once any of the job's commissions were EVER in a payout batch — even a
    -- VOIDED one, which is exactly what JOB_HAS_BATCHED_COMMISSIONS tells the operator to do first
    -- (commission_payment_items.commission_id is NO ACTION and void_commission_payment leaves its cpi
    -- rows in place). Soft-cancel mirrors the live convention (delete_invoices / void_invoice cancel+zero
    -- commissions, never delete them) and preserves the audit trail. Re-mint below writes fresh rows.
    UPDATE commissions
       SET status = 'cancelled', commission_amount = 0, deleted_at = now()
     WHERE job_id = p_source_job_id AND deleted_at IS NULL;

    FOREACH v_child_id IN ARRAY v_invoice_ids
    LOOP
      -- Chemical profit for this child from the LR-allocated accumulator (cents -> dollars).
      v_child_profit := COALESCE((v_chem_profit_by_child->>v_child_id::text)::bigint, 0)::numeric / 100.0;

      SELECT customer_id INTO v_child_customer FROM invoices WHERE id = v_child_id;

      PERFORM _insert_commissions_for_job(
        p_source_job_id, v_child_id, v_child_customer,
        COALESCE(v_child_profit, 0), v_commission_split, (now() AT TIME ZONE 'America/Chicago')::date);
    END LOOP;
  END IF;

  -- ---- PASS 3: field snapshots for the group (Codex P1 #7) -------------------
  -- Grouped (multi-customer) field-app invoices carry their field/crop/acre snapshot at the
  -- GROUP level (invoice_id NULL, invoice_group_id set) — exactly how the live field-app save
  -- and the invoice-list panels read them. Without these, lists and PDFs show blank fields,
  -- crops, and zero acres. job_id carries source-job provenance AND satisfies fal_requires_parent
  -- when no invoice_id is present. The prior group's rows were cleared in the re-save block.
  INSERT INTO field_app_locations (
    invoice_group_id, job_id, field_id, applied_acres, total_acres, crop_type, sort_order
  )
  SELECT v_group_id, p_source_job_id, (t.fld->>'field_id')::uuid,
         (t.fld->>'applied_acres')::numeric,
         fl.total_acres, fl.crop_type, (t.ord - 1)::int
    FROM jsonb_array_elements(p_fields) WITH ORDINALITY AS t(fld, ord)
    LEFT JOIN fields fl ON fl.id = (t.fld->>'field_id')::uuid;

  -- ---- §5 INVARIANTS — check the STORED rows, never the allocator's self-report -
  FOR v_line_id, v_src_line_cents, v_line_src_qty IN
    SELECT id, source_line_cents, source_quantity
      FROM field_app_billing_lines WHERE billing_set_id = v_set_id
  LOOP
    SELECT COALESCE(SUM(amount_cents), 0),
           COALESCE(SUM(split_micro_pct), 0),
           count(DISTINCT customer_id),
           SUM(allocated_quantity)
      INTO v_sum_cents, v_sum_micro, v_line_member_count, v_sum_qty
      FROM invoice_line_shares WHERE billing_line_id = v_line_id;

    IF v_sum_cents IS DISTINCT FROM v_src_line_cents THEN
      RAISE EXCEPTION 'INVARIANT_CENTS: line % stored cents % <> source_line_cents %',
        v_line_id, v_sum_cents, v_src_line_cents USING ERRCODE = 'internal_error';
    END IF;
    IF v_sum_micro <> 100000000 THEN
      RAISE EXCEPTION 'INVARIANT_MICRO: line % micro_pct sum % <> 100000000', v_line_id, v_sum_micro
        USING ERRCODE = 'internal_error';
    END IF;
    IF v_line_member_count <> array_length(v_members, 1) THEN
      RAISE EXCEPTION 'INVARIANT_MEMBERS: line % has % customers, expected %',
        v_line_id, v_line_member_count, array_length(v_members, 1) USING ERRCODE = 'internal_error';
    END IF;
    -- quantity ties to source at 4dp when a source quantity was provided
    IF v_line_src_qty IS NOT NULL
       AND round(COALESCE(v_sum_qty, 0), 4) IS DISTINCT FROM round(v_line_src_qty, 4) THEN
      RAISE EXCEPTION 'INVARIANT_QTY: line % qty sum % <> source_quantity %',
        v_line_id, v_sum_qty, v_line_src_qty USING ERRCODE = 'internal_error';
    END IF;
  END LOOP;

  -- ---- RESULT + idempotency ---------------------------------------------------
  v_result := jsonb_build_object(
    'billing_set_id',     v_set_id,
    'invoice_group_id',   v_group_id,
    'invoice_ids',        to_jsonb(v_invoice_ids),
    'line_vector_hashes', v_line_hashes,
    'request_hash',       p_request_hash
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    'field_app_split_invoice_saved',
    'Per-line split field app billing set saved with ' || array_length(v_invoice_ids, 1) || ' invoice(s)',
    p_performed_by, 'invoice', v_invoice_ids[1]
  );

  -- Record the idempotency key (paired with the wrapper's check_idempotency; see the
  -- idempotency-body-check exemption note at the top — canonical wrapper/impl split).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field_app_split_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.snapshot_field_crop_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_season integer;
BEGIN
  IF OLD.crop_type IS NULL OR OLD.crop_type = NEW.crop_type THEN RETURN NEW; END IF;
  v_season := compute_season((now() AT TIME ZONE 'America/Chicago')::date);
  INSERT INTO field_crop_history (field_id, season, crop_type) VALUES (OLD.id, v_season, OLD.crop_type)
  ON CONFLICT (field_id, season) DO UPDATE SET crop_type = EXCLUDED.crop_type;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_vendor_bill(p_vendor_id uuid, p_purchase_order_id uuid DEFAULT NULL::uuid, p_bill_number text DEFAULT ''::text, p_bill_date date DEFAULT (now() AT TIME ZONE 'America/Chicago')::date, p_due_date date DEFAULT NULL::date, p_payment_terms text DEFAULT NULL::text, p_subtotal_cents bigint DEFAULT 0, p_adjustment_cents bigint DEFAULT 0, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_confirm_po_overage boolean DEFAULT false, p_po_overage_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_fingerprint text;
  v_replay jsonb;
  v_bill_id uuid;
  v_candidate_total bigint;
  v_po_total bigint;
  v_active_billed_total bigint;
  v_cumulative_total bigint;
  v_overage_confirmed boolean := false;
  v_reason text := btrim(COALESCE(p_po_overage_reason, ''));
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to create vendor bills';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_vendor_bill requires p_idempotency_key';
  END IF;
  IF p_due_date IS NOT NULL AND p_due_date < p_bill_date THEN
    RAISE EXCEPTION 'INVALID_DUE_DATE: due date cannot precede bill date';
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'vendor_id', p_vendor_id,
        'purchase_order_id', p_purchase_order_id,
        -- These nullable text inputs are passed to the mature implementation
        -- unchanged. Keep their exact SQL values in the fingerprint too:
        -- notably, NULL payment terms invoke vendor defaults while '' means an
        -- explicit empty term with the implementation's fallback due interval.
        'bill_number', p_bill_number,
        'bill_date', p_bill_date,
        'due_date', p_due_date,
        'payment_terms', p_payment_terms,
        'subtotal_cents', p_subtotal_cents,
        'adjustment_cents', COALESCE(p_adjustment_cents, 0),
        'notes', p_notes,
        'confirm_po_overage', COALESCE(p_confirm_po_overage, false),
        'po_overage_reason', v_reason
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'create_vendor_bill', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null'
       OR NULLIF(v_replay #>> '{result,bill_id}', '') IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN (v_replay #>> '{result,bill_id}')::uuid;
  END IF;

  v_candidate_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);

  -- Preserve the established financial lock order used by the delegated bill
  -- implementation and supplier-cost application: vendor before optional PO.
  -- Taking the PO first here would deadlock with vendor -> PO writers.
  PERFORM 1
  FROM public.vendors v
  WHERE v.id = p_vendor_id
    AND v.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND: vendor % does not exist or is soft-deleted', p_vendor_id;
  END IF;

  IF p_purchase_order_id IS NOT NULL THEN
    SELECT po.total_cost_cents
    INTO v_po_total
    FROM public.purchase_orders po
    WHERE po.id = p_purchase_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO_NOT_FOUND: purchase order % does not exist', p_purchase_order_id;
    END IF;

    SELECT COALESCE(SUM(vb.total_cents), 0)::bigint
    INTO v_active_billed_total
    FROM public.vendor_bills vb
    WHERE vb.purchase_order_id = p_purchase_order_id
      AND vb.deleted_at IS NULL
      AND vb.status <> 'voided';

    v_cumulative_total := v_active_billed_total + v_candidate_total;
    IF v_cumulative_total > 0
       AND (v_po_total <= 0 OR v_cumulative_total * 100 > v_po_total * 105) THEN
      IF COALESCE(p_confirm_po_overage, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED'
          USING ERRCODE = '22023',
                DETAIL = jsonb_build_object(
                  'po_total_cents', v_po_total,
                  'active_billed_cents', v_active_billed_total,
                  'candidate_bill_cents', v_candidate_total,
                  'cumulative_bill_cents', v_cumulative_total
                )::text;
      END IF;
      IF v_reason = '' THEN
        RAISE EXCEPTION 'PO_CUMULATIVE_BILLING_REASON_REQUIRED';
      END IF;
      v_overage_confirmed := true;
    END IF;
  END IF;

  v_bill_id := public._section9_create_vendor_bill_cumulative_impl(
    p_vendor_id,
    p_purchase_order_id,
    p_bill_number,
    p_bill_date,
    p_due_date,
    p_payment_terms,
    p_subtotal_cents,
    p_adjustment_cents,
    p_notes,
    p_idempotency_key
  );

  UPDATE public.idempotency_keys
  SET request_fingerprint = v_fingerprint,
      request_actor_id = v_actor
  WHERE idempotency_key = p_idempotency_key
    AND operation = 'create_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;

  IF v_overage_confirmed THEN
    INSERT INTO public.activity_feed (
      event_type, description, performed_by, related_entity_type, related_entity_id
    ) VALUES (
      'po_cumulative_billing_overage_confirmed',
      'Vendor bill ' || v_bill_id::text || ' exceeded the cumulative PO billing threshold: ' || v_reason,
      v_actor,
      'purchase_order',
      p_purchase_order_id
    );
  END IF;

  RETURN v_bill_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_vendor_payment(p_vendor_bill_id uuid, p_amount_cents bigint, p_payment_date date DEFAULT (now() AT TIME ZONE 'America/Chicago')::date, p_payment_method text DEFAULT NULL::text, p_reference_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_fingerprint text;
  v_replay jsonb;
  v_payment_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to record vendor payments';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: record_vendor_payment requires p_idempotency_key';
  END IF;
  PERFORM 1 FROM public.vendor_bills
   WHERE id = p_vendor_bill_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND: vendor bill % does not exist', p_vendor_bill_id; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'vendor_bill_id', p_vendor_bill_id,
    'amount_cents', p_amount_cents, 'payment_date', p_payment_date,
    'payment_method', p_payment_method, 'reference_number', p_reference_number,
    'notes', p_notes
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'record_vendor_payment', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' ->> 'payment_id' IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN (v_replay -> 'result' ->> 'payment_id')::uuid;
  END IF;
  v_payment_id := public._section9_record_vendor_payment_intent_impl_20260831(
    p_vendor_bill_id, p_amount_cents, p_payment_date, p_payment_method,
    p_reference_number, p_notes, p_idempotency_key
  );
  UPDATE public.idempotency_keys SET request_fingerprint = v_fingerprint, request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key AND operation = 'record_vendor_payment';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_payment_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_order_from_blend_ticket(p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT (now() AT TIME ZONE 'America/Chicago')::date, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'BLEND_TICKET_ORDERS_DISABLED: blend tickets are recorded through application records only; create an application record and bill it with a direct invoice.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_quick_delivery(p_customer_id uuid, p_items jsonb, p_driver_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT (now() AT TIME ZONE 'America/Chicago')::date, p_delivery_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_skip_invoice boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_fingerprint text;
  v_existing public.idempotency_keys%ROWTYPE;
  v_result jsonb;
  v_cached_delivery_id uuid;
  v_cached_customer_id uuid;
  v_cached_driver_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role
    FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep', 'driver');
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NULL THEN
    RETURN public._create_quick_delivery_intent_impl_20260802(
      p_customer_id, p_items, p_driver_id, p_scheduled_date,
      p_delivery_notes, p_performed_by, NULL, p_skip_invoice
    );
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'customer_id', p_customer_id,
        'items', p_items,
        'driver_id', p_driver_id,
        'scheduled_date', p_scheduled_date,
        'delivery_notes', p_delivery_notes,
        'skip_invoice', p_skip_invoice
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_idempotency_key, 0)
  );

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = p_idempotency_key
     AND expires_at < now();

  SELECT * INTO v_existing
    FROM public.idempotency_keys
   WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.operation IS DISTINCT FROM 'create_quick_delivery' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE';
    END IF;
    -- Same fail-closed deployment bridge as save_invoice. Validate that the
    -- caller may see the committed delivery before returning its receipt.
    IF v_existing.request_actor_id IS NULL
       AND v_existing.request_fingerprint IS NULL THEN
      v_cached_delivery_id := NULLIF(v_existing.result->>'delivery_id', '')::uuid;
      IF v_cached_delivery_id IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
      END IF;
      SELECT customer_id, assigned_driver
        INTO v_cached_customer_id, v_cached_driver_id
        FROM public.deliveries
       WHERE id = v_cached_delivery_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'DELIVERY_NOT_FOUND';
      END IF;
      IF (v_actor_role = 'sales_rep' AND NOT EXISTS (
            SELECT 1 FROM public.customers
             WHERE id = v_cached_customer_id
               AND assigned_sales_rep = v_actor
          ))
         OR (v_actor_role = 'driver' AND v_cached_driver_id IS DISTINCT FROM v_actor) THEN
        RAISE EXCEPTION 'DELIVERY_SCOPE_DENIED';
      END IF;
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
        USING ERRCODE = '22023',
              DETAIL = jsonb_build_object(
                'operation', v_existing.operation,
                'result', v_existing.result
              )::text;
    END IF;
    IF v_existing.request_actor_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH';
    END IF;
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      v_cached_delivery_id := NULLIF(v_existing.result->>'delivery_id', '')::uuid;
      IF v_cached_delivery_id IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
      END IF;
      SELECT customer_id, assigned_driver
        INTO v_cached_customer_id, v_cached_driver_id
        FROM public.deliveries
       WHERE id = v_cached_delivery_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'DELIVERY_NOT_FOUND';
      END IF;
      IF (v_actor_role = 'sales_rep' AND NOT EXISTS (
            SELECT 1 FROM public.customers
             WHERE id = v_cached_customer_id
               AND assigned_sales_rep = v_actor
          ))
         OR (v_actor_role = 'driver' AND v_cached_driver_id IS DISTINCT FROM v_actor) THEN
        RAISE EXCEPTION 'DELIVERY_SCOPE_DENIED';
      END IF;
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
        USING ERRCODE = '22023',
              DETAIL = jsonb_build_object(
                'operation', v_existing.operation,
                'result', v_existing.result
              )::text;
    END IF;
    RETURN public._create_quick_delivery_intent_impl_20260802(
      p_customer_id, p_items, p_driver_id, p_scheduled_date,
      p_delivery_notes, p_performed_by, p_idempotency_key, p_skip_invoice
    );
  END IF;

  v_result := public._create_quick_delivery_intent_impl_20260802(
    p_customer_id, p_items, p_driver_id, p_scheduled_date,
    p_delivery_notes, p_performed_by, p_idempotency_key, p_skip_invoice
  );

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'create_quick_delivery';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_credit_memo_application(p_application_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor      uuid;
  v_actor_role text;
  v_app        record;
  v_existing   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  -- Codex BLOCKER: NULL (inactive/absent profile) must be rejected — `NULL NOT IN (...)` is not true.
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only active admins and sales reps can reverse credit applications';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason is required to reverse a credit application';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'reverse_credit_memo_application');
    IF v_existing IS NOT NULL THEN
      -- Codex HIGH: bind idempotency to the application id (mirror the apply RPC) so a key reused
      -- for a DIFFERENT application can't silently return the first application's success.
      IF (v_existing->>'application_id')::uuid IS DISTINCT FROM p_application_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: key % was already used to reverse a different application', p_idempotency_key;
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_app FROM credit_memo_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_APPLICATION_NOT_FOUND: %', p_application_id; END IF;
  IF v_app.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'CREDIT_APPLICATION_ALREADY_REVERSED: %', p_application_id;
  END IF;

  -- Codex HIGH: gate on the APPLICATION's own period (applied_at), NOT the memo's ISSUE date. Apply
  -- checks CURRENT_DATE, so an application made in an open period must stay reversible in it even if
  -- the memo was issued in a since-closed period (mirrors void_payment gating on payment_date).
  PERFORM check_period_open((v_app.applied_at AT TIME ZONE 'UTC')::date); PERFORM check_period_open((v_app.applied_at AT TIME ZONE 'America/Chicago')::date);

  PERFORM _reverse_credit_memo_application(p_application_id, v_actor, v_actor_role, p_reason);

  v_existing := jsonb_build_object(
    'success', true, 'application_id', p_application_id,
    'credit_memo_id', v_app.credit_memo_id, 'target_invoice_id', v_app.target_invoice_id,
    'amount_cents', v_app.amount_cents
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'reverse_credit_memo_application', v_existing);
  END IF;
  RETURN v_existing;
END;
$function$;

CREATE OR REPLACE FUNCTION public._unapply_return_credit_guard_impl_20260826(p_credit_memo_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_invoice record; v_return record; v_existing jsonb; v_result jsonb; v_capp record; v_product_ids uuid[];
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'Reason is required to unapply a credit memo'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'unapply_credit_memo';
    IF v_existing IS NOT NULL THEN IF (v_existing->>'credit_memo_id')::uuid IS DISTINCT FROM p_credit_memo_id THEN RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: idempotency key was already used for a different credit memo'; END IF; RETURN v_existing; END IF;
  END IF;
  SELECT * INTO v_invoice FROM invoices WHERE id = p_credit_memo_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_credit_memo_id; END IF;
  IF v_invoice.invoice_type != 'credit_memo' THEN RAISE EXCEPTION 'Invoice % is not a credit memo (type: %)', v_invoice.invoice_number, v_invoice.invoice_type; END IF;
  IF v_invoice.status != 'posted' THEN RAISE EXCEPTION 'Only posted credit memos can be unapplied (current status: %)', v_invoice.status; END IF;
  PERFORM check_period_open(v_invoice.invoice_date);
  -- Acquire Return/Product protocol before reversing applications or voiding the memo.
  SELECT * INTO v_return FROM returns WHERE credit_invoice_id = p_credit_memo_id FOR UPDATE;
  IF v_return.id IS NOT NULL THEN
    SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id) INTO v_product_ids FROM return_items ri WHERE ri.return_id = v_return.id;
    PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  END IF;
  FOR v_capp IN SELECT id, applied_at FROM credit_memo_applications WHERE credit_memo_id = p_credit_memo_id AND reversed_at IS NULL ORDER BY id LOOP
    PERFORM check_period_open((v_capp.applied_at AT TIME ZONE 'UTC')::date); PERFORM check_period_open((v_capp.applied_at AT TIME ZONE 'America/Chicago')::date);
    PERFORM _reverse_credit_memo_application(v_capp.id, v_actor, (SELECT role FROM profiles WHERE id = v_actor), 'Auto-reversed: credit memo ' || v_invoice.invoice_number || ' unapplied — ' || p_reason);
  END LOOP;
  UPDATE invoices SET status = 'voided', voided_by = v_actor, voided_at = now(), void_reason = p_reason, updated_at = now() WHERE id = p_credit_memo_id;
  IF v_return.id IS NOT NULL THEN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE returns SET status = 'received', credit_invoice_id = NULL, total_credit_cents = 0, credited_at = NULL, credited_by = NULL, updated_at = now() WHERE id = v_return.id;
    PERFORM set_config('app.admin_override', 'false', true);
  END IF;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('credit_memo_unapplied', 'invoice', p_credit_memo_id, (SELECT role FROM profiles WHERE id = v_actor), jsonb_build_object('status', 'posted', 'total_amount_cents', v_invoice.total_amount_cents), jsonb_build_object('status', 'voided', 'return_reverted', CASE WHEN v_return.id IS NOT NULL THEN v_return.return_number ELSE NULL END), -v_invoice.total_amount_cents, 'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason);
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('credit_memo_unapplied', 'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason, v_actor, 'invoice', p_credit_memo_id, v_invoice.customer_id);
  v_result := jsonb_build_object('success', true, 'credit_memo_id', p_credit_memo_id, 'invoice_number', v_invoice.invoice_number, 'return_id', v_return.id, 'return_reverted', v_return.id IS NOT NULL);
  IF p_idempotency_key IS NOT NULL THEN INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at) VALUES (p_idempotency_key, 'unapply_credit_memo', v_result, now() + interval '24 hours') ON CONFLICT (idempotency_key) DO NOTHING; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._void_invoice_split_provenance_impl_20260719(p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv record; v_alloc record; v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0; v_prepay_app record; v_actor_role text;
  v_allocation_set_ids uuid[]; v_commissions_cancelled integer := 0; v_existing jsonb;
  v_job record;  -- U6 #65: job-release locals
  v_capp record;  -- CREDIT-APPLY: active-application cursor
BEGIN
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid() AND is_active = true;
  IF v_actor_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Only admin users can void invoices'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_inv.status = 'voided' THEN RAISE EXCEPTION 'Invoice already voided'; END IF;
  IF v_inv.status = 'cancelled' THEN RAISE EXCEPTION 'Cannot void a cancelled invoice'; END IF;

  -- draft/unposted invoices were never posted: no allocations/prepay/commissions to reverse,
  -- and the status trigger only allows →voided from posted/overdue. Route to 'cancelled'
  -- (draft→cancelled / unposted→cancelled are allowed transitions) and return.
  -- (A draft/unposted invoice can never carry a credit application — apply requires posted on
  --  both sides — so no credit reversal is needed on this branch.)
  IF v_inv.status IN ('draft', 'unposted') THEN
    UPDATE invoices SET status = 'cancelled', void_reason = p_void_reason, updated_at = now()
    WHERE id = p_invoice_id;

    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
      IF FOUND AND v_job.status = 'invoiced' THEN
        IF EXISTS (SELECT 1 FROM invoices o
                   WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                     AND o.invoice_type = 'field_application'
                     AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL) THEN
          IF v_job.invoice_id IS NOT DISTINCT FROM p_invoice_id THEN
            UPDATE application_records SET invoice_id = (
              SELECT o.id FROM invoices o
               WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                 AND o.invoice_type = 'field_application'
                 AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
               ORDER BY o.created_at, o.id LIMIT 1)
              WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
            SET LOCAL app.admin_override = 'true';
            UPDATE jobs SET invoice_id = (
              SELECT o.id FROM invoices o
               WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                 AND o.invoice_type = 'field_application'
                 AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
               ORDER BY o.created_at, o.id LIMIT 1)
              WHERE id = v_inv.job_id;
            RESET app.admin_override;
          END IF;
        ELSE
          UPDATE application_records SET invoice_id = NULL
            WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
          SET LOCAL app.admin_override = 'true';
          UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
          RESET app.admin_override;
        END IF;
      END IF;
    END IF;

    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.job_id = v_inv.job_id AND c.invoice_id = p_invoice_id
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this job invoice''s pending commissions are in an active payout batch — void that commission payment first';
      END IF;
      IF EXISTS (
        SELECT 1 FROM commissions
        WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'paid'
      ) THEN
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        SELECT p.id, 'Job invoice cancelled — commissions already paid',
          'Invoice ' || v_inv.invoice_number || ' was cancelled but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
          'commission_review', 'invoice', p_invoice_id
        FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
      END IF;
      UPDATE commissions SET status = 'cancelled', commission_amount = 0
        WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'pending';
      GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
    END IF;

    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
    VALUES ('invoice_cancelled', 'invoice', p_invoice_id, v_actor_role,
      jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents),
      jsonb_build_object('status', 'cancelled', 'void_reason', p_void_reason, 'commissions_cancelled', v_commissions_cancelled),
      0,
      'Cancelled ' || v_inv.invoice_number || ' (was ' || v_inv.status || ') — ' || p_void_reason);

    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_cancelled',
      'Cancelled invoice ' || v_inv.invoice_number || ' — ' || p_void_reason,
      auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);

    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'void_invoice', jsonb_build_object(
        'success', true, 'invoice_id', p_invoice_id, 'status', 'cancelled',
        'allocations_reversed_cents', 0, 'prepay_restored_cents', 0, 'commissions_cancelled', v_commissions_cancelled));
    END IF;
    RETURN;
  END IF;

  -- H3 fix: refuse to void a posted/overdue/paid invoice that still has direct
  -- cash applied. void_invoice reverses prepay + credit-memo applications below,
  -- but does NOT re-bank direct payments (paid_amount_cents) or payment
  -- allocations (invoice_line_allocations) — voiding would strand that cash.
  -- The admin must void/unapply those payments first (void_payment re-banks the
  -- cash as customer prepay), then void the invoice. Prepay-only and
  -- credit-memo-only voids carry neither and are unaffected.
  IF v_inv.paid_amount_cents > 0
     OR EXISTS (
       SELECT 1
       FROM invoice_line_allocations ila
       JOIN allocation_sets aset ON aset.id = ila.allocation_set_id
       WHERE ila.invoice_id = p_invoice_id
         AND aset.entity_type = 'payment'
         AND aset.is_active = true
     ) THEN
    RAISE EXCEPTION 'INVOICE_HAS_APPLIED_PAYMENTS: invoice % has $% in applied payments — void or unapply those payments first (that re-banks the cash as prepay), then void the invoice',
      v_inv.invoice_number, (v_inv.paid_amount_cents / 100.0)::numeric(12,2);
  END IF;

  IF v_inv.status IN ('posted', 'paid', 'overdue') THEN PERFORM check_period_open(v_inv.invoice_date); END IF;

  -- CREDIT-APPLY: reverse every active credit-memo application that touches this invoice
  -- (as the credit memo OR as the target) BEFORE zeroing its levers. This restores the other
  -- side and drains this invoice's credit_applied_cents to 0; without it a voided target would
  -- leave credit_applied_cents set and violate invoices_balance_non_negative, and a voided memo
  -- would strand the credit it handed out (Codex #4).
  -- Codex BLOCKER: the enclosing void only period-checks status='posted', but a credited target is
  -- 'paid'/'overdue'. Each application's reversal is a money movement, so gate it on THAT
  -- application's own period (applied_at) before touching it.
  -- Codex MED (accepted, not fixed): void locks THIS invoice first, then the helper locks both sides
  -- in id order — two concurrent voids of a memo and its target can deadlock. Postgres detects it and
  -- aborts one cleanly (money stays atomic; the operator retries). Rare + non-corrupting, so it is
  -- left as a safe-abort rather than a global pre-lock of all counterparties.
  FOR v_capp IN
    SELECT id, applied_at FROM credit_memo_applications
     WHERE reversed_at IS NULL
       AND (credit_memo_id = p_invoice_id OR target_invoice_id = p_invoice_id)
     ORDER BY id
  LOOP
    PERFORM check_period_open((v_capp.applied_at AT TIME ZONE 'UTC')::date); PERFORM check_period_open((v_capp.applied_at AT TIME ZONE 'America/Chicago')::date);
    PERFORM _reverse_credit_memo_application(v_capp.id, auth.uid(), v_actor_role,
      'Auto-reversed: invoice ' || v_inv.invoice_number || ' voided — ' || p_void_reason);
  END LOOP;

  SELECT ARRAY(SELECT DISTINCT ila.allocation_set_id FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id AND ila.allocation_set_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM allocation_sets hist WHERE hist.id = ila.allocation_set_id
        AND hist.entity_type = 'payment' AND hist.is_active = false)) INTO v_allocation_set_ids;

  FOR v_alloc IN SELECT ila.id, ila.amount_cents, ila.allocation_set_id FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id
      AND NOT EXISTS (SELECT 1 FROM allocation_sets hist WHERE hist.id = ila.allocation_set_id
        AND hist.entity_type = 'payment' AND hist.is_active = false) LOOP
    v_total_allocations_reversed := v_total_allocations_reversed + v_alloc.amount_cents;
    DELETE FROM invoice_line_allocations WHERE id = v_alloc.id;
  END LOOP;

  IF v_total_allocations_reversed > 0 AND array_length(v_allocation_set_ids, 1) > 0 THEN
    UPDATE allocation_sets SET total_allocated_cents = (SELECT COALESCE(SUM(amount_cents), 0)
      FROM invoice_line_allocations WHERE allocation_set_id = allocation_sets.id),
      updated_at = now() WHERE id = ANY(v_allocation_set_ids);
  END IF;

  FOR v_prepay_app IN SELECT pa.id, pa.applied_amount_cents, pa.prepay_credit_id FROM prepay_applications pa
    WHERE pa.invoice_id = p_invoice_id LOOP
    v_total_prepay_restored := v_total_prepay_restored + v_prepay_app.applied_amount_cents;
    UPDATE prepay_credits SET balance_cents = balance_cents + v_prepay_app.applied_amount_cents,
      updated_at = now() WHERE id = v_prepay_app.prepay_credit_id;
    DELETE FROM prepay_applications WHERE id = v_prepay_app.id;
  END LOOP;

  IF v_total_prepay_restored > 0 THEN
    UPDATE customers SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_prepay_restored,
      updated_at = now() WHERE id = v_inv.customer_id;
  END IF;

  -- CREDIT-APPLY: credit_applied_cents = 0 added (all applications reversed above → already 0;
  -- explicit for safety so the voided row's balance is unambiguously 0).
  UPDATE invoices SET status = 'voided', voided_by = auth.uid(), voided_at = now(),
    void_reason = p_void_reason, total_amount_cents = 0, paid_amount_cents = 0,
    prepay_applied_cents = 0, write_off_cents = 0, credit_applied_cents = 0, updated_at = now()
  WHERE id = p_invoice_id;

  -- Codex HIGH: a generic void of a CREDIT MEMO must also release its linked return (mirroring
  -- unapply_credit_memo), or the return stays 'credited' pointing at a voided memo and can never be
  -- re-credited. Regular invoices have no such link, so the guard scopes this to credit memos.
  IF v_inv.invoice_type = 'credit_memo' THEN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE returns SET
      status = 'received', credit_invoice_id = NULL, total_credit_cents = 0,
      credited_at = NULL, credited_by = NULL, updated_at = now()
    WHERE credit_invoice_id = p_invoice_id;
    PERFORM set_config('app.admin_override', 'false', true);
  END IF;

  IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
    IF FOUND AND v_job.status = 'invoiced' THEN
      IF EXISTS (SELECT 1 FROM invoices o
                 WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                   AND o.invoice_type = 'field_application'
                   AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL) THEN
        IF v_job.invoice_id IS NOT DISTINCT FROM p_invoice_id THEN
          UPDATE application_records SET invoice_id = (
            SELECT o.id FROM invoices o
             WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
               AND o.invoice_type = 'field_application'
               AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
             ORDER BY o.created_at, o.id LIMIT 1)
            WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
          SET LOCAL app.admin_override = 'true';
          UPDATE jobs SET invoice_id = (
            SELECT o.id FROM invoices o
             WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
               AND o.invoice_type = 'field_application'
               AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
             ORDER BY o.created_at, o.id LIMIT 1)
            WHERE id = v_inv.job_id;
          RESET app.admin_override;
        END IF;
      ELSE
        UPDATE application_records SET invoice_id = NULL
          WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
        SET LOCAL app.admin_override = 'true';
        UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
        RESET app.admin_override;
      END IF;
    END IF;
  END IF;

  IF v_inv.order_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE order_id = v_inv.order_id
        AND id != p_invoice_id AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL) THEN
      UPDATE commissions SET status = 'cancelled' WHERE order_id = v_inv.order_id AND status = 'pending';
      GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
    END IF;
  END IF;

  IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM commissions c
      JOIN commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
      WHERE c.job_id = v_inv.job_id AND c.invoice_id = p_invoice_id
        AND c.status = 'pending' AND cp.status <> 'voided'
    ) THEN
      RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this job invoice''s pending commissions are in an active payout batch — void that commission payment first';
    END IF;
    IF EXISTS (
      SELECT 1 FROM commissions
      WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'paid'
    ) THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      SELECT p.id, 'Job invoice voided — commissions already paid',
        'Invoice ' || v_inv.invoice_number || ' was voided but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
        'commission_review', 'invoice', p_invoice_id
      FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
    END IF;
    UPDATE commissions SET status = 'cancelled', commission_amount = 0
      WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'pending';
    GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
  END IF;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('invoice_voided', 'invoice', p_invoice_id, v_actor_role,
    jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents, 'paid_amount_cents', v_inv.paid_amount_cents, 'prepay_applied_cents', v_inv.prepay_applied_cents, 'write_off_cents', v_inv.write_off_cents),
    jsonb_build_object('status', 'voided', 'void_reason', p_void_reason, 'allocations_reversed_cents', v_total_allocations_reversed, 'prepay_restored_cents', v_total_prepay_restored, 'commissions_cancelled', v_commissions_cancelled),
    -1 * v_inv.total_amount_cents,
    'Voided ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0 THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.' ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0 THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.' ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0 THEN ' Cancelled ' || v_commissions_cancelled || ' pending commission(s).' ELSE '' END);

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_voided',
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0 THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.' ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0 THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.' ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0 THEN ' Cancelled ' || v_commissions_cancelled || ' pending commission(s).' ELSE '' END,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);

  IF v_total_allocations_reversed > 0 OR v_total_prepay_restored > 0 OR v_commissions_cancelled > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id, 'Invoice Voided — Allocations Reversed',
      'Invoice ' || v_inv.invoice_number || ' voided. $' ||
        (v_total_allocations_reversed / 100.0)::text || ' in allocations reversed, $' ||
        (v_total_prepay_restored / 100.0)::text || ' in prepay credits restored.' ||
        CASE WHEN v_commissions_cancelled > 0 THEN ' ' || v_commissions_cancelled || ' pending commission(s) cancelled.' ELSE '' END,
      'invoice_void_reversal', 'invoice', p_invoice_id
    FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_invoice', jsonb_build_object(
      'success', true, 'invoice_id', p_invoice_id,
      'allocations_reversed_cents', v_total_allocations_reversed,
      'prepay_restored_cents', v_total_prepay_restored,
      'commissions_cancelled', v_commissions_cancelled));
  END IF;
END;
$function$;

-- Each SET DEFAULT takes a brief exclusive table lock; give up rather than queue behind a long transaction.
SET LOCAL lock_timeout = '10s';
ALTER TABLE public.payments ALTER COLUMN payment_date SET DEFAULT ((now() AT TIME ZONE 'America/Chicago'::text))::date;
ALTER TABLE public.commission_payments ALTER COLUMN payment_date SET DEFAULT ((now() AT TIME ZONE 'America/Chicago'::text))::date;
ALTER TABLE public.ar_reminder_tracking ALTER COLUMN sent_date SET DEFAULT ((now() AT TIME ZONE 'America/Chicago'::text))::date;
ALTER TABLE public.deliveries ALTER COLUMN scheduled_date SET DEFAULT ((now() AT TIME ZONE 'America/Chicago'::text))::date;

DO $postflight$
DECLARE
  v_row record;
  v_fn pg_proc;
BEGIN
  FOR v_row IN SELECT * FROM (VALUES
    ('_reverse_credit_memo_application(uuid,uuid,text,text)', '3c1b4076e5b2dc3629465f6193236750', '2a47d227e949966990f3f7881951694e', true, '{postgres=X/postgres,service_role=X/postgres}', 'p_application_id uuid, p_actor uuid, p_actor_role text, p_reason text', 'p_application_id uuid, p_actor uuid, p_actor_role text, p_reason text'),
    ('_reverse_write_off_replay_impl_20261015(uuid,text,uuid,text)', '70ef11ccad193eb6ef5ee88dcba6f8cd', '4154cbe9a13aff741d9c8ab72a508acc', true, '{postgres=X/postgres}', 'p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('apply_credit_memo_to_invoice(uuid,uuid,bigint,uuid,text)', 'bcc242c8715aaed81b9455fbc905237f', '9814b487791dc8425fe7d10c1a278394', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_credit_memo_id uuid, p_target_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_credit_memo_id uuid, p_target_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_apply_prepay_to_invoice_replay_impl_20261015(uuid,uuid,bigint,uuid,text)', 'c9377dab8f2534a03af2c27a6e1d510c', '53ac418df8065bd8001136a55e29ebea', true, '{postgres=X/postgres}', 'p_prepay_credit_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_prepay_credit_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_apply_write_off_replay_impl_20261015(uuid,bigint,text,uuid,text)', '00e8d020f9faf6276de8ddaf4f1411fc', '6c89936b2baa95094dbdcf654ad6f89e', true, '{postgres=X/postgres}', 'p_invoice_id uuid, p_amount_cents bigint, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_invoice_id uuid, p_amount_cents bigint, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_post_commission_payment_intent_impl_20260809(uuid,uuid,text)', '240fd81fd597136c195a62e7f60f3fbc', '865aed5ebe639bd2965c97224f484cf6', true, '{postgres=X/postgres}', 'p_payment_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_payment_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', '985fb1a42ab3b4d911c68898c14ce637', '73290904f17b81e50143b7a292d19973', true, '{postgres=X/postgres}', 'p_payment_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_payment_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_void_payment_replay_impl_20261015(uuid,text,uuid,text)', '70fd746c15f4a6629680a724f3588967', '249d13c9887436709119b442a8928ad3', true, '{postgres=X/postgres}', 'p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_create_commission_payment_intent_impl_20260809(uuid[],text,text,date,text,uuid,text)', '3610d803ee9594251ec948f9d4e99ace', 'c03052dc6ce3ba6b1002d5d73aa33d6b', true, '{postgres=X/postgres}', 'p_commission_ids uuid[], p_payment_method text, p_reference text, p_payment_date date, p_notes text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_commission_ids uuid[], p_payment_method text, p_reference text, p_payment_date date, p_notes text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text)', 'ca0da8106b112033e085db0c8d228ed4', '393f4fe11538d55bb849d1224901b0f7', true, '{postgres=X/postgres}', 'p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('get_ar_reminder_candidates()', 'be574e829d67e9e4f26cf8b3c0a6f681', 'b7cf51451ae4f61d1ccc037f95042c16', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', '', ''),
    ('_enforce_applicator_license()', 'ae368db8df03ea3eec8f83ac6de01648', 'b393c688aa54bfa5ee4c47ed65d690fd', false, '{=X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', '', ''),
    ('_dispatch_job_locations_replay_impl_20261015(jsonb,uuid,text,boolean)', 'b6cafd947beaf19678d491e1832f1908', '0cea17840a2d04c414fa0acf136da817', true, '{postgres=X/postgres}', 'p_assignments jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_license_override boolean DEFAULT false', 'p_assignments jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_license_override boolean DEFAULT false'),
    ('generate_rup_sales_records(uuid,text)', 'b3c5e302402b8f54f34a547f2c9ad3d3', '0cb155a27c654dd390a875c3ff3aa507', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text', 'p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('get_dispatch_stock_status(uuid[])', '1ac19ae58f8fde6c34c87962701573d4', '29f717f1d7b43b168ce2d5c2e48de179', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_job_ids uuid[]', 'p_job_ids uuid[]'),
    ('get_job_inventory_shortfalls(integer)', '3dc25a19781765ac939e03c72d980ef1', '453a2460174a68d097e680dca79dc1aa', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_days_ahead integer DEFAULT 7', 'p_days_ahead integer DEFAULT 7'),
    ('_get_inventory_position_cost_impl_20261019()', '6043fa5c13f508bf4c123ccad5d0cb12', '6a74347a299879a3ed5a82f4d5288a4b', true, '{postgres=X/postgres}', '', ''),
    ('_create_inventory_hold_intent_impl_20260905(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)', '30ae56a0e1ee3b472abe5c95508b43fc', 'd7e98a25d9b194e8ede05047c0cb0b6a', true, '{postgres=X/postgres}', 'p_product_id uuid, p_customer_id uuid, p_quantity numeric, p_hold_type text, p_expires_at date, p_notes text, p_performed_by uuid, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', 'p_product_id uuid, p_customer_id uuid, p_quantity numeric, p_hold_type text, p_expires_at date, p_notes text, p_performed_by uuid, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text'),
    ('_transition_rebate_claim_replay_impl_20261015(uuid,text,bigint,text,text)', 'de22ed84218873c02023720f5f4d06e1', 'ab5e9d5210ff4aeabff662b56ff5c85d', true, '{postgres=X/postgres}', 'p_claim_id uuid, p_new_status text, p_paid_amount_cents bigint DEFAULT NULL::bigint, p_manufacturer_ref text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', 'p_claim_id uuid, p_new_status text, p_paid_amount_cents bigint DEFAULT NULL::bigint, p_manufacturer_ref text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text'),
    ('_create_rush_order_below_cost_impl_20260810(uuid,jsonb,text,text,uuid,text)', '00eb8676ef9f214baf0cfa9fc25b1924', '17fa918ed609b079ce8a3c08337368ca', true, '{postgres=X/postgres}', 'p_customer_id uuid, p_items jsonb DEFAULT ''[]''::jsonb, p_notes text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_customer_id uuid, p_items jsonb DEFAULT ''[]''::jsonb, p_notes text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_create_followup_delivery_replay_impl_20261015(uuid,date,uuid,text)', 'da4e748e6139cc43247fdcfbfccf5251', '286023631494a108ad1ecadec3011bff', true, '{postgres=X/postgres}', 'p_original_delivery_id uuid, p_scheduled_date date DEFAULT NULL::date, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_original_delivery_id uuid, p_scheduled_date date DEFAULT NULL::date, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_create_job_from_quote_section_replay_impl_20261015(uuid,uuid,uuid,text)', 'e1e701e0a096c0d022b5ac370aa4bb60', 'b567ac08aef7db8c747af5424439d7de', true, '{postgres=X/postgres}', 'p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_batch_reschedule_deliveries_replay_impl_20261015(uuid[],date,uuid,text)', 'd87ef756d7e5c30e2fe9cf722e68b646', '9e36f19b08770f23b95c106fcdd1ead1', true, '{postgres=X/postgres}', 'p_delivery_ids uuid[], p_new_date date, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_delivery_ids uuid[], p_new_date date, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_save_field_crop_history_replay_impl_20261015(uuid,integer,text,text,date,date,numeric,text,text,uuid,text)', '4395eea60420c930dcc3895c6f2757f6', '602b045178da933f4b21f87493c0c4f2', true, '{postgres=X/postgres}', 'p_field_id uuid, p_season integer, p_crop_type text, p_variety text DEFAULT NULL::text, p_planting_date date DEFAULT NULL::date, p_harvest_date date DEFAULT NULL::date, p_yield_per_acre numeric DEFAULT NULL::numeric, p_yield_unit text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_field_id uuid, p_season integer, p_crop_type text, p_variety text DEFAULT NULL::text, p_planting_date date DEFAULT NULL::date, p_harvest_date date DEFAULT NULL::date, p_yield_per_acre numeric DEFAULT NULL::numeric, p_yield_unit text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_save_field_app_split_invoice_impl(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text,text)', '3df177130debed37484a2cfc7b84b73a', 'a69f21d8e9f32fc6fecb38ac3a54801c', true, '{postgres=X/postgres,service_role=X/postgres}', 'p_billing_set_id uuid, p_source_job_id uuid, p_invoice jsonb, p_fields jsonb, p_lines jsonb, p_performed_by uuid, p_application_service_id uuid, p_idempotency_key text, p_request_hash text', 'p_billing_set_id uuid, p_source_job_id uuid, p_invoice jsonb, p_fields jsonb, p_lines jsonb, p_performed_by uuid, p_application_service_id uuid, p_idempotency_key text, p_request_hash text'),
    ('snapshot_field_crop_history()', '09805ba67e9c29346f0ba75bf9450608', '16443deabc430d2565657b54004b126f', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', '', ''),
    ('create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)', '9f17ea87da9f2323336938e68e7ce72c', '9f17ea87da9f2323336938e68e7ce72c', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_vendor_id uuid, p_purchase_order_id uuid DEFAULT NULL::uuid, p_bill_number text DEFAULT ''''::text, p_bill_date date DEFAULT CURRENT_DATE, p_due_date date DEFAULT NULL::date, p_payment_terms text DEFAULT NULL::text, p_subtotal_cents bigint DEFAULT 0, p_adjustment_cents bigint DEFAULT 0, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_confirm_po_overage boolean DEFAULT false, p_po_overage_reason text DEFAULT NULL::text', 'p_vendor_id uuid, p_purchase_order_id uuid DEFAULT NULL::uuid, p_bill_number text DEFAULT ''''::text, p_bill_date date DEFAULT ((now() AT TIME ZONE ''America/Chicago''::text))::date, p_due_date date DEFAULT NULL::date, p_payment_terms text DEFAULT NULL::text, p_subtotal_cents bigint DEFAULT 0, p_adjustment_cents bigint DEFAULT 0, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_confirm_po_overage boolean DEFAULT false, p_po_overage_reason text DEFAULT NULL::text'),
    ('record_vendor_payment(uuid,bigint,date,text,text,text,text)', '612835148d3ebf0da1127657ce7b1b1a', '612835148d3ebf0da1127657ce7b1b1a', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_vendor_bill_id uuid, p_amount_cents bigint, p_payment_date date DEFAULT CURRENT_DATE, p_payment_method text DEFAULT NULL::text, p_reference_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text', 'p_vendor_bill_id uuid, p_amount_cents bigint, p_payment_date date DEFAULT ((now() AT TIME ZONE ''America/Chicago''::text))::date, p_payment_method text DEFAULT NULL::text, p_reference_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text'),
    ('create_order_from_blend_ticket(uuid,text,date,text,uuid,text)', '651a48e7395a003c213038493c0bbd0a', '651a48e7395a003c213038493c0bbd0a', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text', 'p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT ((now() AT TIME ZONE ''America/Chicago''::text))::date, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text'),
    ('create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean)', '69c1d569fb2e9eb913502d59e41a76fe', '69c1d569fb2e9eb913502d59e41a76fe', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_customer_id uuid, p_items jsonb, p_driver_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_delivery_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_skip_invoice boolean DEFAULT false', 'p_customer_id uuid, p_items jsonb, p_driver_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT ((now() AT TIME ZONE ''America/Chicago''::text))::date, p_delivery_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_skip_invoice boolean DEFAULT false'),
    ('reverse_credit_memo_application(uuid,text,uuid,text)', '38cea043fc7dae4e65bc8593c95bddfb', 'c3f9459d3ea8ed998c8271f38b85d6c6', true, '{authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres}', 'p_application_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_application_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_unapply_return_credit_guard_impl_20260826(uuid,text,uuid,text)', '8a304e41a63cac0043b3fe7bf75cc10b', '1f3a386f35d823fb14b5deb3b5f75170', true, '{postgres=X/postgres}', 'p_credit_memo_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'p_credit_memo_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'),
    ('_void_invoice_split_provenance_impl_20260719(uuid,text,text)', 'd5ac51bf7ae432e9c8360bc75247c087', '8c20fab6159d67fb7937fd8f48d92a6d', true, '{postgres=X/postgres}', 'p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text', 'p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text')
  ) AS t(sig, pre_md5, post_md5, secdef, acl, args_pre, args_post)
  LOOP
    SELECT * INTO v_fn FROM pg_proc WHERE oid = to_regprocedure('public.' || v_row.sig);
    IF v_fn.oid IS NULL
       OR md5(replace(v_fn.prosrc, chr(13), '')) <> v_row.post_md5
       OR regexp_replace(v_fn.prosrc, '--[^\n]*', '', 'g') ~* '\mcurrent_date\M'
       OR pg_get_function_arguments(v_fn.oid) <> v_row.args_post
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR v_fn.prosecdef IS DISTINCT FROM v_row.secdef
       OR coalesce((SELECT array_agg(g::text ORDER BY g::text COLLATE "C") FROM unnest(v_fn.proacl) g)::text, 'NULL') IS DISTINCT FROM v_row.acl
       OR pg_get_userbyid(v_fn.proowner) <> 'postgres' THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % still uses the UTC date or did not take the new body', v_row.sig;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM (VALUES ('payments', 'payment_date'), ('commission_payments', 'payment_date'), ('ar_reminder_tracking', 'sent_date'), ('deliveries', 'scheduled_date')) AS t(tbl, col)
     WHERE pg_get_expr((SELECT adbin FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                         WHERE d.adrelid = ('public.' || t.tbl)::regclass AND a.attname = t.col), ('public.' || t.tbl)::regclass)
           IS DISTINCT FROM '((now() AT TIME ZONE ''America/Chicago''::text))::date'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a column date default is not the Chicago date';
  END IF;
END;
$postflight$;
