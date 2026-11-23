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
--               WHERE n.nspname = 'public' AND c.relkind = 'r')
-- )::text AS live_reset_pins;
-- PIN QUERY END
--
-- PREFLIGHT (on live; refuses with an exception and changes nothing): not a read committed transaction with
-- session_replication_role = origin (LIVE_RESET_SESSION); the backup schema already exists
-- (LIVE_RESET_ALREADY_APPLIED); c_live is malformed (LIVE_RESET_PINS_MISSING); the public table set differs from the
-- pinned one or from the set this file classified (c_table_set_md5), or a foreign key outside public points at a table
-- it deletes from (LIVE_RESET_SCHEMA_DRIFT); any public table's row count or content differs from its pin
-- (LIVE_RESET_COUNT_DRIFT / LIVE_RESET_CONTENT_DRIFT: someone used the app after the read, re-pin); a kept cost basis row points at a
-- PO line (LIVE_RESET_COST_BASIS_FROM_PO: product_cost_basis keeps its history, so that needs a decision); a trigger
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
--   c_clear_backup_snapshots (default OFF) backup_snapshots rows of cleared tables. backup_runs always stay.
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
-- restored from their pre-images; setval each sequence from _sequences). Drop the schema only once Mason confirms.

DO $live_reset$
DECLARE
  -- LIVE_FINGERPRINT_TODO: the PIN QUERY's one value from live, as a quoted jsonb literal. NULL = not live: no-op.
  c_live constant jsonb := NULL;

  -- Sections: flip to change what is cleared (see the header).
  c_clear_logs constant boolean := true;
  c_clear_receipts constant boolean := false;
  c_clear_team_notes_on_cleared constant boolean := false;
  c_clear_backup_snapshots constant boolean := false;

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
  IF jsonb_typeof(v_counts) IS DISTINCT FROM 'object' OR jsonb_typeof(c_live->'digests') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'LIVE_RESET_PINS_MISSING: c_live has no counts or digests object. Nothing was changed.';
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
  SELECT string_agg(k.conrelid::regclass::text || ' -> ' || k.confrelid::regclass::text, ', ') INTO v_bad
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE k.contype = 'f' AND n.nspname <> 'public'
     AND k.confrelid IN (SELECT format('public.%I', x)::regclass FROM unnest(v_core) x);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIVE_RESET_SCHEMA_DRIFT: a table outside public references a table this deletes from (%). Nothing was changed.', v_bad;
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
    v_plan := v_plan || jsonb_build_array(jsonb_build_object('t', 'backup_snapshots', 'w', format('table_name = ANY (%L::text[])', v_core)));
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
