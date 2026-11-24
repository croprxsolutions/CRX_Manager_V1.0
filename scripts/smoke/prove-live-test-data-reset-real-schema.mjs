#!/usr/bin/env node
/**
 * Real-schema proof for 20270301100000_live_test_data_reset.sql (one-time live test-data reset, Mason 2026-11-23).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), then seeds:
 *   - every undo-path area's committed fixtures (posted, paid, written-off, voided invoices; deliveries completed and
 *     voided; POs received; vendor bills and payments; returns and credit; a closed month; commission payments),
 *   - one sale through the real signed-in RPCs: quote -> presented -> order -> delivery -> complete (draft invoice) ->
 *     post -> payment of $50 on a $40 invoice ($10 to prepay) -> second sale -> prepay applied; plus a cycle count,
 *   - at least one row in every other public table (a replica-mode filler, then hand-written rows for the tables
 *     whose CHECKs the filler cannot guess), so every cleared table and almost every kept table holds rows,
 *   - a team note linked to a cleared order (the default keeps it).
 * Then:
 *   (a) the checked-in file (no live pins) and a copy pinned to another system_identifier are no-ops
 *       (LIVE_RESET_SKIPPED_NOT_LIVE) and change nothing; a count off by one refuses (LIVE_RESET_COUNT_DRIFT) and a
 *       kept cost basis row on a PO line refuses (LIVE_RESET_COST_BASIS_FROM_PO), each changing nothing.
 *   (b) the file filled with this database's pins (from the file's own PIN QUERY) clears exactly the cleared set,
 *       keeps every kept row byte-identical (customers: only prepay_balance_cents/row_version/updated_at; inventory:
 *       only the quantities, last_counted_at and updated_at), leaves every trigger as it was, puts stock and prepay at 0,
 *       restarts every document number at 0001 (each generator called as an admin), and the app then runs
 *       PO -> receive -> quote -> order -> delivery -> invoice -> payment through the real RPCs, numbered 0001.
 *   (c) a second apply refuses (LIVE_RESET_ALREADY_APPLIED).
 *   (d) reset_backup_20261123 holds every deleted row byte-identical to before the reset.
 *
 * Run: node scripts/smoke/prove-live-test-data-reset-real-schema.mjs   (needs Docker; never touches live)
 * Prints LIVE_RESET_PROOF_PASS on success. KEEP_CONTAINER=1 keeps the container this run built; RESET_REUSE=1 with
 * UNDO_PATHS_CONTAINER=<name> reuses a kept container (development only; it is never removed).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, claims, scalar, docker, USERS, ROOT, NAME } from './undo-paths/harness.mjs';

const CANDIDATE = '20270301100000_live_test_data_reset.sql';
const RAW = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const flag = (n) => ['1', 'true'].includes(String(process.env[n] ?? '').toLowerCase());
const KEEP = flag('KEEP_CONTAINER');
const REUSE = flag('RESET_REUSE'); // with UNDO_PATHS_CONTAINER: a kept, already-built container (development only; never removed)
const ADMIN = USERS.admin;
const PSQL = (user) => ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const run = (sql, user = 'postgres') => docker(PSQL(user), { input: sql, allowFailure: true });
const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r; };
const json = (sql) => JSON.parse(scalar(sql) || 'null');
const year = () => scalar("SELECT extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)");

// The file's own lists, so the proof follows the reviewed file rather than a copy.
const arrayConst = (name) => {
  const m = new RegExp(`${name} constant text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`).exec(RAW);
  assert.ok(m, `${name} not found in the candidate`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};
const CORE = arrayConst('c_core').flatMap((x) => x.split(','));
const SEQS = arrayConst('c_seqs');
const TYPES = arrayConst('c_cleared_types');
const boolConst = (name) => {
  const m = new RegExp(`${name} constant boolean := (true|false);`).exec(RAW);
  assert.ok(m, `${name} not found in the candidate`);
  return m[1] === 'true';
};
assert.equal(boolConst('c_clear_logs'), true, 'this proof covers the default sections (logs on)');
assert.equal(boolConst('c_clear_team_notes_on_cleared'), false, 'this proof covers the default sections (team notes kept)');
assert.equal(boolConst('c_clear_backup_snapshots'), true, 'this proof covers the chosen sections (backup snapshots and runs cleared, Mason 2026-11-24)');
const RECEIPTS = ['idempotency_keys', 'offline_action_receipts', 'retired_uncertain_requests'];
const LOGS_ALL = ['email_log', 'integrity_alerts', 'failed_notifications', 'watchdog_flag_dismissals', 'watchdog_flags',
  ...(boolConst('c_clear_receipts') ? RECEIPTS : []), 'backup_snapshots', 'backup_runs'];
const LOGS_FILTERED = { activity_feed: 'related_entity', notifications: 'related_entity', financial_audit_log: 'entity' };
const PIN_QUERY = (/-- PIN QUERY BEGIN\n([\s\S]*?)-- PIN QUERY END/.exec(RAW)?.[1] ?? '').split('\n').map((l) => l.replace(/^-- ?/, '')).join('\n');
assert.match(PIN_QUERY, /pg_control_system/, 'the PIN QUERY block is missing');
// The pin slot, NULL as reviewed or already filled with live's pins (either way this proof swaps in its own).
const LIVE_SLOT = /c_live constant jsonb := (?:NULL|'(?:[^']|'')*');/;
assert.equal(RAW.match(new RegExp(LIVE_SLOT, 'g'))?.length, 1, 'the live pin slot must appear once');
const FILLED = !RAW.match(LIVE_SLOT)[0].endsWith('NULL;');
// system_identifier is a 64-bit number: it is carried as a string here and written back as a bare JSON number.
const pinned = (pins) => RAW.replace(LIVE_SLOT, () => `c_live constant jsonb := '${JSON.stringify(pins)
  .replace(/"system_identifier":"(\d+)"/, '"system_identifier":$1').replaceAll("'", "''")}';`);
const pins = () => JSON.parse(scalar(PIN_QUERY).replace(/"system_identifier": (\d+)/, '"system_identifier": "$1"'));

const asAdmin = (body) => ok(run(`BEGIN;\n${claims(ADMIN)}\nDO $p$
DECLARE r jsonb; q uuid; o uuid; d uuid; inv uuid; po uuid; pc uuid; cc uuid; v text; n bigint;
BEGIN
${body}
END $p$;
COMMIT;`));
const as = (stmt) => `SET LOCAL ROLE authenticated; ${stmt} RESET ROLE;`;

/** One sale through the signed-in RPCs: quote -> order -> delivery -> posted invoice; returns nothing, notes numbers. */
const SALE_PRODUCT = '7c7a0000-0000-4000-8000-0000000002d2'; // the deliveries area's priced product ($10, cost $6)
const SALE_CUSTOMER = '7c7a0000-0000-4000-8000-0000000002c1';
const sale = (tag, units) => `
  ${as(`r := public.save_quote(NULL, jsonb_build_object('quote_number', public.generate_quote_number(), 'status', 'draft', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'customer_id', '${SALE_CUSTOMER}'),
    jsonb_build_array(jsonb_build_object('section_name', 'S1', 'sort_order', 0, 'items', jsonb_build_array(jsonb_build_object(
      'product_id', '${SALE_PRODUCT}', 'sort_order', 0, 'calc_mode', 'units_direct', 'total_units_needed', ${units}, 'unit_size', 'Gal')))),
    '${ADMIN}', '${tag}-q');`)}
  q := (r->>'quote_id')::uuid;
  ${as(`PERFORM public.create_quote_version(q, '${ADMIN}', 'presented', '${tag}-present', (r->>'row_version')::bigint);`)}
  ${as(`r := public.convert_quote_to_order(q, '${ADMIN}', '${tag}-convert', (SELECT row_version FROM public.quotes WHERE id = q), NULL);`)}
  o := (r->>'order_id')::uuid;
  ${as(`r := public.create_delivery_with_items(o, '${SALE_CUSTOMER}', current_date, (SELECT jsonb_agg(jsonb_build_object('order_item_id', id,
      'product_id', product_id, 'quantity', total_units_needed, 'unit_size', unit_size)) FROM public.order_items WHERE order_id = o),
      NULL, NULL, NULL, NULL, '${tag}-delivery');`)}
  d := (r->>'delivery_id')::uuid;
  ${as(`PERFORM public.confirm_delivery(d, '${ADMIN}', '${tag}-start');
    PERFORM public.complete_delivery(p_delivery_id => d, p_signed_by => 'No proof — recorded by office', p_performed_by => '${ADMIN}',
      p_idempotency_key => '${tag}-complete', p_evidence => 'no_proof', p_evidence_ref => '[PROVER] reset');`)}
  inv := (SELECT id FROM public.invoices WHERE delivery_id = d);
  v := public._invoice_post_version(inv);
  ${as(`PERFORM public.post_invoice(inv, v, '${tag}-post');`)}
  INSERT INTO reset_prover.ids VALUES ('${tag}-quote', q), ('${tag}-order', o), ('${tag}-delivery', d), ('${tag}-invoice', inv);`;
const idOf = (name) => `(SELECT id FROM reset_prover.ids WHERE name = '${name}')`;

// Replica-mode filler: one row in every empty public table it can build (NOT NULL columns get a type default, a
// referenced row's id or the first literal of their CHECK). Kept tables get rows too, so the byte-identical check has data.
const FILLER = String.raw`SET session_replication_role = replica;
DO $fill$
DECLARE
  t text; pass int; progress bool; cols text; vals text; c record; v text; lit text; err text; errs jsonb := '{}';
BEGIN
  FOR pass IN 1..8 LOOP
    progress := false; errs := '{}';
    FOR t IN SELECT pc.relname FROM pg_class pc JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE pn.nspname='public' AND pc.relkind='r' ORDER BY 1 LOOP
      EXECUTE format('SELECT NOT EXISTS (SELECT 1 FROM public.%I)', t) INTO progress;
      IF NOT progress THEN progress := true; CONTINUE; END IF;
      cols := NULL; vals := NULL;
      FOR c IN
        SELECT a.attname, a.attnotnull, format_type(a.atttypid, a.atttypmod) typ, ty.typtype, a.atttypid,
               (SELECT format('(SELECT %I::text FROM %s ORDER BY 1 LIMIT 1)', fa.attname, k.confrelid::regclass)
                  FROM pg_constraint k JOIN pg_attribute fa ON fa.attrelid = k.confrelid AND fa.attnum = k.confkey[1]
                 WHERE k.conrelid = a.attrelid AND k.contype = 'f' AND k.conkey[1] = a.attnum LIMIT 1) fk,
               (SELECT substring(pg_get_constraintdef(k.oid) FROM '''([^'']*)''') FROM pg_constraint k
                 WHERE k.conrelid = a.attrelid AND k.contype = 'c' AND a.attnum = ANY (k.conkey) AND cardinality(k.conkey) = 1
                   AND pg_get_constraintdef(k.oid) ~ '(= ANY \(ARRAY\[''|= ''[^'']+''::)' LIMIT 1) chk
          FROM pg_attribute a JOIN pg_type ty ON ty.oid = a.atttypid
         WHERE a.attrelid = format('public.%I', t)::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
           AND a.attidentity = '' AND (a.attnotnull AND NOT a.atthasdef OR EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = a.attrelid AND k.contype='f' AND k.conkey[1]=a.attnum))
         ORDER BY a.attnum
      LOOP
        IF c.fk IS NOT NULL THEN v := c.fk || '::' || c.typ;
        ELSIF c.chk IS NOT NULL THEN v := quote_literal(c.chk) || '::' || c.typ;
        ELSIF c.typtype = 'e' THEN v := quote_literal((SELECT enumlabel FROM pg_enum WHERE enumtypid = c.atttypid ORDER BY enumsortorder LIMIT 1)) || '::' || c.typ;
        ELSIF c.typ = 'uuid' THEN v := 'gen_random_uuid()';
        ELSIF c.typ IN ('text','character varying','citext') OR c.typ LIKE 'character%' THEN v := quote_literal('rf-' || t || '-' || c.attname);
        ELSIF c.typ IN ('integer','bigint','smallint') OR c.typ LIKE 'numeric%' OR c.typ IN ('real','double precision') THEN v := '1';
        ELSIF c.typ = 'boolean' THEN v := 'false';
        ELSIF c.typ = 'date' THEN v := 'current_date';
        ELSIF c.typ LIKE 'timestamp%' THEN v := 'now()';
        ELSIF c.typ LIKE 'time%' THEN v := '''12:00''';
        ELSIF c.typ IN ('jsonb','json') THEN v := '''{}''';
        ELSIF c.typ LIKE '%[]' THEN v := '''{}''';
        ELSIF c.typ = 'bytea' THEN v := '''\x00''::bytea';
        ELSIF c.typ = 'xid8' THEN v := 'pg_current_xact_id()';
        ELSIF c.typ = 'inet' THEN v := '''127.0.0.1''';
        ELSE v := 'NULL'; END IF;
        cols := concat_ws(', ', cols, quote_ident(c.attname)); vals := concat_ws(', ', vals, v);
      END LOOP;
      BEGIN
        IF cols IS NULL THEN EXECUTE format('INSERT INTO public.%I DEFAULT VALUES', t);
        ELSE EXECUTE format('INSERT INTO public.%I (%s) VALUES (%s)', t, cols, vals); END IF;
        progress := true;
      EXCEPTION WHEN OTHERS THEN errs := errs || jsonb_build_object(t, SQLERRM);
      END;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'FILL_ERRORS %', errs;
END $fill$;
SET session_replication_role = origin;`;

function seedAll() {
  ok(run('CREATE SCHEMA reset_prover; CREATE TABLE reset_prover.ids (name text PRIMARY KEY, id uuid);'));
  // Sale 1 ($40) paid with $50: $10 becomes a prepay credit; sale 2 ($20) is paid from that prepay.
  asAdmin(`${sale('seed1', 4)}
    ${as(`r := public.allocate_payment('${SALE_CUSTOMER}', 5000, 'check', 'RESET-SEED-1', '1001', current_date, '[PROVER] overpay',
      jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount_cents', 4000)), '${ADMIN}', 'seed1-pay');`)}
    ${sale('seed2', 2)}
    pc := (SELECT id FROM public.prepay_credits WHERE customer_id = '${SALE_CUSTOMER}' ORDER BY created_at DESC LIMIT 1);
    ${as(`PERFORM public.apply_prepay_to_invoice(pc, inv, 1000, '${ADMIN}', 'seed2-prepay');`)}
    ${as(`PERFORM public.create_cycle_count('Main Warehouse', '[PROVER] count', '${ADMIN}', 'seed-cc');`)}`);
  assert.equal(scalar(`SELECT prepay_balance_cents FROM public.customers WHERE id = '${SALE_CUSTOMER}';`), '0', 'the prepay was used');
  assert.equal(scalar(`SELECT count(*) FROM public.prepay_applications;`), '1');
  // A customer with prepay left over, so the reset has a balance to zero.
  asAdmin(`${as(`r := public.allocate_payment('${SALE_CUSTOMER}', 700, 'check', 'RESET-SEED-2', '1002', current_date, '[PROVER] prepay',
      '[]'::jsonb, '${ADMIN}', 'seed-prepay-2');`)}`);
  assert.equal(scalar(`SELECT prepay_balance_cents FROM public.customers WHERE id = '${SALE_CUSTOMER}';`), '700');

  // Every other empty public table gets a row (replica mode: triggers off), then the hand-written ones.
  ok(run(FILLER, 'supabase_admin'));
  ok(run(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.delivery_item_brands (delivery_item_id, delivery_id, product_id, source, brand_name, quantity, review_state)
      SELECT id, delivery_id, product_id, 'typed', 'Prover Brand', 1, 'pending' FROM public.delivery_items ORDER BY id LIMIT 1;
    INSERT INTO public.offline_action_receipts (client_action_id, actor_id, operation, entity_id, schema_version, client_created_at, request_payload, idempotency_key, status)
      VALUES (gen_random_uuid(), '${ADMIN}', 'complete_delivery', ${idOf('seed1-delivery')}, 1, now(), '{}', 'reset-prover-offline', 'received');
    INSERT INTO public.tote_fills (tote_product_id, bulk_product_id, totes, gallons, bulk_unit, bulk_quantity, bulk_before, bulk_after,
        tote_before, tote_after, bulk_ledger_rows, tote_ledger_rows, out_transaction_id, in_transaction_id, performed_by)
      SELECT (SELECT id FROM public.products ORDER BY id LIMIT 1), (SELECT id FROM public.products ORDER BY id DESC LIMIT 1), 1, 1, 'Gal', 1, 1, 0, 0, 1, 1, 1,
        (SELECT id FROM public.inventory_transactions ORDER BY id LIMIT 1), (SELECT id FROM public.inventory_transactions ORDER BY id DESC LIMIT 1), '${ADMIN}';
    INSERT INTO public.job_loader_worksheet_weights (worksheet_id, product_id, job_id, product_name, weight_kind, lb_per_unit, per_unit, unit_factors, source)
      SELECT w.id, (SELECT id FROM public.products ORDER BY id LIMIT 1), w.job_id, 'Prover', 'unit_weight', 1, 'Gal', '{}', 'unit' FROM public.job_loader_worksheets w LIMIT 1;
    INSERT INTO public.blend_ticket_product_weights (blend_ticket_id, product_id, product_name, weight_kind, lb_per_unit, per_unit, unit_factors, source, captured_how)
      SELECT b.id, (SELECT id FROM public.products ORDER BY id LIMIT 1), 'Prover', 'unit_weight', 1, 'Gal', '{}', 'unit', 'at_save' FROM public.blend_tickets b LIMIT 1;
    INSERT INTO public.delivery_receipt_queue (delivery_id, customer_id, receipt, status)
      VALUES (${idOf('seed1-delivery')}, '${SALE_CUSTOMER}', '{"lines": []}', 'pending');
    INSERT INTO public.payments (order_id, customer_id, amount, payment_method, recorded_by)
      VALUES (${idOf('seed1-order')}, '${SALE_CUSTOMER}', 1, 'check', '${ADMIN}');
    INSERT INTO public.split_invoice_provenance (invoice_id, order_id, invoice_group_id, customer_id, invoice_type, season, total_amount_cents, content_claim, created_by, contract_version)
      VALUES (${idOf('seed1-invoice')}, ${idOf('seed1-order')}, gen_random_uuid(), '${SALE_CUSTOMER}', 'chemical_sale', 2026, 0, '{}', '${ADMIN}', 'split_invoice_provenance_v1');
    INSERT INTO public.job_attachments (job_id, storage_path, file_name) SELECT id, id || '/prover.pdf', 'prover.pdf' FROM public.jobs LIMIT 1;
    INSERT INTO public.job_location_dispatches (job_field_id, job_id, applicator_id) SELECT id, job_id, '${USERS.applicator}' FROM public.job_fields LIMIT 1;
    INSERT INTO public.credit_memo_applications (credit_memo_id, target_invoice_id, amount_cents, applied_by)
      VALUES (${idOf('seed1-invoice')}, ${idOf('seed2-invoice')}, 1, '${ADMIN}');
    INSERT INTO public.quote_price_changes (quote_id, quote_item_id, product_id, old_price_cents, new_price_cents, changed_by)
      SELECT quote_id, id, product_id, 1000, 900, '${ADMIN}' FROM public.quote_items ORDER BY id LIMIT 1;
    INSERT INTO public.job_dispatch_preservation (job_id, field_id, applicator_id) SELECT id, (SELECT id FROM public.fields LIMIT 1), '${USERS.applicator}' FROM public.jobs LIMIT 1;
    INSERT INTO public.retired_uncertain_requests (request_key, retired_by, reason)
      VALUES ('prover:' || gen_random_uuid() || ':' || gen_random_uuid(), '${ADMIN}', 'recorded');
    INSERT INTO public.ar_reminder_tracking (customer_id, reminder_level) VALUES ('${SALE_CUSTOMER}', 30);
    INSERT INTO public.customer_documents (customer_id, document_type, storage_path, filename, mime_type, size_bytes, uploaded_by)
      VALUES ('${SALE_CUSTOMER}', 'license', '${SALE_CUSTOMER}/prover.pdf', 'prover.pdf', 'application/pdf', 1, '${ADMIN}');
    INSERT INTO public.customer_contacts (customer_id, name) VALUES ('${SALE_CUSTOMER}', 'Prover Contact');
    INSERT INTO public.team_notes (title, content, note_type, priority, created_by, linked_entity_type, linked_entity_id)
      VALUES ('[PROVER] about an order', 'kept by default', 'note', 'low', '${ADMIN}', 'order', ${idOf('seed1-order')});
    INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
      VALUES ('product_updated', '[PROVER] kept: about a product', '${ADMIN}', 'product', '${SALE_PRODUCT}'),
             ('order_created', '[PROVER] cleared: about an order', '${ADMIN}', 'order', ${idOf('seed1-order')});
    INSERT INTO public.notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES ('${ADMIN}', 'kept', '[PROVER] about a customer', 'info', 'customer', '${SALE_CUSTOMER}');
    COMMIT;`, 'supabase_admin'));
  // Every number sequence in use (MC, CM and INV are not issued by the flows above), so a restart and its undo show.
  ok(run(`SELECT nextval(format('public.%I', s)::regclass) FROM unnest('{${SEQS.join(',')}}'::text[]) s, generate_series(1, 3);`));
  const empty = CORE.filter((t) => scalar(`SELECT count(*) FROM public.${t};`) === '0');
  assert.deepEqual(empty, [], `every cleared table must hold a row before the reset (empty: ${empty.join(', ')})`);
  const keptEmpty = json(`SELECT coalesce(jsonb_agg(c.relname ORDER BY c.relname), '[]') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT (c.relname = ANY ('{${CORE.join(',')}}'::text[]))
      AND (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text::int = 0;`);
  console.log(`[seed] every one of the ${CORE.length} cleared tables holds rows; kept tables left empty by the filler: ${keptEmpty.length} (${keptEmpty.join(', ')})`);
}

// Whole-database fingerprint: every public table's rows (md5) plus the six sequences and every trigger's state.
const dbState = () => scalar(`SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
  SELECT c.relname || ':' || (xpath('/row/h/text()', query_to_xml(format(
    'SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text), '''' ORDER BY md5(to_jsonb(x)::text)), '''')) AS h FROM public.%I x', c.relname), false, true, '')))[1]::text x
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'
  UNION ALL SELECT s || '=' || (xpath('/row/v/text()', query_to_xml(format('SELECT last_value || ''/'' || is_called AS v FROM public.%I', s), false, true, '')))[1]::text
    FROM unnest('{${SEQS.join(',')}}'::text[]) s
  UNION ALL SELECT c.relname || '.' || t.tgname || '=' || t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal
  UNION ALL SELECT 'backup_schema=' || count(*) FROM pg_namespace WHERE nspname = 'reset_backup_20261123') s;`);
// Per-table md5 with some columns left out, for the kept/backup comparisons.
const tableMd5 = (schema, t, excl = []) => scalar(`SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) FROM (
  SELECT md5((to_jsonb(x) - '{${excl.join(',')}}'::text[])::text) h FROM ${schema}.${t} x) s;`);
const EXCL = { customers: ['prepay_balance_cents', 'row_version', 'updated_at'],
  inventory: ['quantity_available', 'quantity_prebooked', 'quantity_on_order', 'last_counted_at', 'updated_at'] };
// -1 with -f - : one transaction around the whole file, as a migration runner applies it.
const apply = (sql) => docker([...PSQL('postgres'), '-1', '-f', '-'], { input: sql, allowFailure: true });
const refused = (label, r, pattern) => {
  assert.notEqual(r.status, 0, `${label}: must refuse`);
  assert.match(r.stderr, pattern, `${label}: ${r.stderr}`);
  console.log(`[refuse ${label}] ${r.stderr.match(/LIVE_RESET_[A-Z_]+[^\n]*/)[0].slice(0, 200)}`);
};

let built = false;
try {
  if (REUSE) {
    // Only a network-less container this harness could have built: never a shared or development database.
    const net = docker(['inspect', '-f', '{{.HostConfig.NetworkMode}} {{.Config.Image}}', NAME]).stdout.trim();
    assert.match(net, /^none public\.ecr\.aws\/supabase\/postgres:/, `refusing to reuse ${NAME} (${net}): not a harness container`);
    assert.match(NAME, /^crx-(undo-paths|reset)-/, `refusing to reuse ${NAME}: only a crx-undo-paths-* or crx-reset-* proof container`);
    assert.equal(docker(['inspect', '-f', '{{len .Mounts}}', NAME]).stdout.trim(), '0', `refusing to reuse ${NAME}: it has a mounted volume`);
    console.log(`[prover] reusing ${NAME}`);
  }
  else { buildContainer({ stopBefore: CANDIDATE }); built = true; seedUsers(); }
  if (!REUSE || scalar("SELECT count(*) FROM pg_namespace WHERE nspname = 'reset_prover';") === '0') {
    for (const area of ['invoices', 'deliveries', 'purchasing', 'payables', 'returns', 'periods-pricing', 'commission']) {
      (await import(`./undo-paths/${area}.mjs`)).run();
    }
    seedAll();
  }
  const start = dbState();

  // The file classified exactly this schema's tables.
  const setMd5 = scalar("SELECT md5(string_agg(c.relname::text, ',' ORDER BY c.relname)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r';");
  assert.match(RAW, new RegExp(`c_table_set_md5 constant text := '${setMd5}';`), `c_table_set_md5 must be '${setMd5}' for this schema (classify any new table first)`);

  // (a) Not live: the checked-in file and a copy pinned to another database change nothing.
  const asIs = apply(RAW);
  assert.equal(asIs.status, 0, asIs.stderr);
  assert.match(asIs.stderr, FILLED ? /LIVE_RESET_SKIPPED_NOT_LIVE: this is not the pinned live database/ : /LIVE_RESET_SKIPPED_NOT_LIVE: the live pins are not filled in/);
  assert.equal(dbState(), start, 'the checked-in file changed something');
  const live = pins();
  const other = apply(pinned({ ...live, system_identifier: String(BigInt(live.system_identifier) + 1n) }));
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stderr, /LIVE_RESET_SKIPPED_NOT_LIVE: this is not the pinned live database/);
  for (const k of ['admin_profile_id', 'customer_id', 'product_id']) {
    const r = apply(pinned({ ...live, [k]: '00000000-0000-4000-8000-000000000000' }));
    assert.match(r.stderr, /LIVE_RESET_SKIPPED_NOT_LIVE: this is not the pinned live database/, `${k}: ${r.stderr}`);
  }
  assert.equal(dbState(), start, 'a non-live copy changed something');
  console.log('[a not live] the checked-in file and copies pinned to another system id, admin, customer or product: LIVE_RESET_SKIPPED_NOT_LIVE, nothing changed');

  // Refusals on the pinned database, each changing nothing.
  refused('count drift', apply(pinned({ ...live, counts: { ...live.counts, orders: live.counts.orders + 1 } })),
    /LIVE_RESET_COUNT_DRIFT: rows changed since the pin: orders \d+ \(pinned \d+\)/);
  refused('schema drift', apply(pinned({ ...live, counts: { ...live.counts, not_a_table: 0 } })), /LIVE_RESET_SCHEMA_DRIFT: .*not_a_table/);
  refused('stale pin', apply(pinned({ ...live, pinned_at: '2026-01-01T00:00:00Z' })), /LIVE_RESET_PIN_EXPIRED/);
  // An edit that keeps every count (a quote renamed) is still caught.
  const editQuote = (to) => ok(run(`SET session_replication_role = replica; UPDATE public.quotes SET quote_number = '${to}' WHERE id = ${idOf('seed1-quote')};`, 'supabase_admin'));
  const oldNumber = scalar(`SELECT quote_number FROM public.quotes WHERE id = ${idOf('seed1-quote')};`);
  editQuote('[PROVER] now a real customer quote');
  refused('content drift', apply(pinned(live)), /LIVE_RESET_CONTENT_DRIFT: rows were edited since the pin: quotes/);
  editQuote(oldNumber);
  // A cascade from outside public onto a log table it deletes from refuses (those rows would go with no backup).
  ok(run(`CREATE SCHEMA reset_ops; CREATE TABLE reset_ops.notification_deliveries (id uuid PRIMARY KEY,
    notification_id uuid REFERENCES public.notifications (id) ON DELETE CASCADE);`));
  refused('cascade from outside public', apply(pinned(live)),
    /LIVE_RESET_SCHEMA_DRIFT: a table outside public references a table this deletes from \(reset_ops\.notification_deliveries -> notifications\)/);
  ok(run('DROP SCHEMA reset_ops CASCADE;'));
  // A DELETE guard added after the pin (counts and rows unchanged) refuses instead of being switched off unreviewed.
  ok(run(`CREATE FUNCTION reset_prover.legal_hold() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'LEGAL_HOLD'; END $f$;
    CREATE TRIGGER zz_prover_legal_hold BEFORE DELETE ON public.invoices FOR EACH ROW EXECUTE FUNCTION reset_prover.legal_hold();`));
  refused('new delete trigger', apply(pinned(live)), /LIVE_RESET_TRIGGER_DRIFT: the DELETE triggers on invoices are not the pinned ones/);
  ok(run('DROP TRIGGER zz_prover_legal_hold ON public.invoices; DROP FUNCTION reset_prover.legal_hold();'));
  assert.ok(Array.isArray(live.delete_triggers.invoices) && live.delete_triggers.invoices.length > 0, 'the pin lists the invoice delete guards');
  ok(run(`SET session_replication_role = replica;
    INSERT INTO public.product_cost_basis (product_id, basis_type, cost_cents, purchase_order_item_id, selection_source, reason, effective_from, effective_to)
      SELECT product_id, 'actual_purchase', 600, id, 'migration_baseline', '[PROVER] from a PO line', now() - interval '1 day', now() FROM public.purchase_order_items ORDER BY id LIMIT 1;`, 'supabase_admin'));
  refused('cost basis on a PO line', apply(pinned(pins())), /LIVE_RESET_COST_BASIS_FROM_PO: 1 kept cost basis row/);
  ok(run("SET session_replication_role = replica; DELETE FROM public.product_cost_basis WHERE reason = '[PROVER] from a PO line';", 'supabase_admin'));
  assert.equal(dbState(), start, 'a refusal changed something');

  // A failure after the reset (standing in for the runner's ledger insert) undoes everything, the sequences included.
  const seqState = () => scalar(`SELECT string_agg(s || '=' || (xpath('/row/v/text()', query_to_xml(format('SELECT last_value || ''/'' || is_called AS v FROM public.%I', s), false, true, '')))[1]::text, ' ' ORDER BY s) FROM unnest('{${SEQS.join(',')}}'::text[]) s;`);
  const seqsBefore = seqState();
  assert.ok(seqsBefore.split(' ').every((x) => x.endsWith('/true')), `the seed must have used every sequence: ${seqsBefore}`);
  const aborted = docker(PSQL('postgres'), { input: `BEGIN;\n${pinned(live)}\nINSERT INTO public.not_the_ledger VALUES (1);\nCOMMIT;`, allowFailure: true });
  assert.notEqual(aborted.status, 0, 'the forced failure must abort');
  assert.match(aborted.stderr, /LIVE_RESET_DONE/, 'the reset itself ran before the forced failure');
  assert.match(aborted.stderr, /relation "public\.not_the_ledger" does not exist/);
  assert.equal(seqState(), seqsBefore, 'an aborted reset must leave every number sequence where it was');
  assert.equal(dbState(), start, 'an aborted reset must leave every row, trigger and sequence as it was');
  console.log(`[rollback] reset then a failing statement in the same transaction: aborted; sequences still ${seqsBefore}; every row and trigger unchanged`);

  // (b) Apply on "live".
  const before = { counts: pins().counts };
  assert.deepEqual(before.counts, live.counts);
  const keptTables = Object.keys(before.counts).filter((t) => !CORE.includes(t) && !LOGS_ALL.includes(t) && !(t in LOGS_FILTERED));
  const keptMd5 = Object.fromEntries(keptTables.map((t) => [t, tableMd5('public', t, EXCL[t])]));
  const deletedMd5 = Object.fromEntries([...CORE, ...LOGS_ALL].map((t) => [t, tableMd5('public', t)]));
  const logGone = (schema, t) => scalar(`SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text), '' ORDER BY md5(to_jsonb(x)::text)), '')) FROM ${schema}.${t} x
    WHERE ${LOGS_FILTERED[t]}_type = ANY ('{${TYPES.join(',')}}'::text[]) OR ${LOGS_FILTERED[t]}_id IN (SELECT id FROM reset_prover.cleared_ids);`);
  const idTables = CORE.filter((c) => scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${c}' AND column_name = 'id' AND data_type = 'uuid'`) === '1');
  ok(run(`CREATE TABLE reset_prover.cleared_ids AS ${idTables.map((c) => `SELECT id FROM public.${c}`).join(' UNION ')};`));
  const logKept = (t) => scalar(`SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text), '' ORDER BY md5(to_jsonb(x)::text)), '')) FROM public.${t} x
    WHERE (${LOGS_FILTERED[t]}_type = ANY ('{${TYPES.join(',')}}'::text[]) OR ${LOGS_FILTERED[t]}_id IN (SELECT id FROM reset_prover.cleared_ids)) IS NOT TRUE;`);
  const logKeptBefore = Object.fromEntries(Object.keys(LOGS_FILTERED).map((t) => [t, logKept(t)]));
  const logGoneBefore = Object.fromEntries(Object.keys(LOGS_FILTERED).map((t) => [t, logGone('public', t)]));
  const triggers = () => scalar(`SELECT string_agg(c.relname || '.' || t.tgname || '=' || t.tgenabled::text, ',' ORDER BY c.relname, t.tgname)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal;`);
  const trigBefore = triggers();
  assert.ok(Number(scalar(`SELECT sum(quantity_available) + sum(quantity_prebooked) FROM public.inventory;`)) > 0, 'the seed holds stock');

  const done = apply(pinned(live));
  assert.equal(done.status, 0, done.stderr);
  const note = done.stderr.match(/LIVE_RESET_DONE[^\n]*/)?.[0];
  assert.ok(note, done.stderr);
  console.log(`[b apply] ${note}`);
  for (const t of [...CORE, ...LOGS_ALL]) assert.equal(scalar(`SELECT count(*) FROM public.${t};`), '0', `${t} is not empty`);
  for (const t of keptTables) {
    assert.equal(scalar(`SELECT count(*) FROM public.${t};`), String(before.counts[t]), `${t} count moved`);
    assert.equal(tableMd5('public', t, EXCL[t]), keptMd5[t], `kept rows of ${t} changed`);
  }
  for (const t of Object.keys(LOGS_FILTERED)) {
    assert.equal(logKept(t), logKeptBefore[t], `kept ${t} rows changed`);
    assert.equal(scalar(`SELECT count(*) FROM public.${t} WHERE ${LOGS_FILTERED[t]}_type = ANY ('{${TYPES.join(',')}}'::text[]);`), '0', `${t} still has rows about cleared records`);
  }
  assert.equal(scalar("SELECT count(*) FROM public.activity_feed WHERE description = '[PROVER] kept: about a product';"), '1');
  assert.equal(scalar("SELECT count(*) FROM public.team_notes WHERE title = '[PROVER] about an order';"), '1', 'team notes are kept by default');
  assert.equal(triggers(), trigBefore, 'every trigger is back in its earlier state');
  assert.equal(scalar('SELECT count(*) FROM public.customers WHERE prepay_balance_cents <> 0;'), '0');
  assert.equal(scalar('SELECT count(*) FROM public.inventory WHERE quantity_available <> 0 OR quantity_prebooked <> 0 OR quantity_on_order <> 0 OR last_counted_at IS NOT NULL;'), '0');
  assert.equal(scalar('SELECT count(*) FROM public.inventory;'), String(before.counts.inventory), 'stock rows are kept');
  console.log(`[b apply] ${CORE.length + LOGS_ALL.length} tables empty, logs about cleared records gone (others kept), ${keptTables.length} kept tables byte-identical, every trigger as before, prepay 0, stock 0 on ${before.counts.inventory} kept rows`);

  // Every number generator gives 0001 next (called as an admin, rolled back).
  const Y = year();
  // Called with an admin signed in, as the RPCs that hand out numbers call them (several are not granted to the app).
  const nums = ok(docker([...PSQL('postgres'), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${claims(ADMIN)}
    SELECT concat_ws(' ', public.generate_quote_number(), public.generate_order_number(), public.next_delivery_number(), public.next_po_number(),
      public.next_job_number(), public.next_return_number(), public.next_cycle_count_number(), public.next_commission_payment_number(),
      public.next_invoice_number('chemical_sale'), public.next_invoice_number('misc_charge'), public.next_invoice_number('credit_memo'),
      public.next_invoice_number('field_application'), public.generate_ticket_number(), public.next_application_record_number(), (SELECT 'RC:' || count(*) FROM public.rebate_claim_counters));
    -- nextval is not rolled back: put the six sequences back where the reset left them.
    SELECT setval(format('public.%I', x)::regclass, 1, false) FROM unnest('{${SEQS.join(',')}}'::text[]) x;
    ROLLBACK;` })).stdout.split('\n').find((l) => l.startsWith('Q-')) ?? '';
  for (const want of [`Q-${Y}-0001`, `ORD-${Y}-0001`, 'DEL-00001', `PO-${Y}-0001`, `JOB-${Y}-0001`, `RMA-${Y}-0001`, `CC-${Y}-00001`,
    `CP-${Y}-0001`, `CS-${Y}-0001`, `MC-${Y}-0001`, `CM-${Y}-0001`, `INV-${Y}-0001`, `BT-${Y}-0001`, `APP-${Y}-0001`, 'RC:0']) {
    assert.ok(nums.split(/\s+/).includes(want), `numbering: expected ${want} in ${nums}`);
  }
  console.log(`[b numbering] next numbers: ${nums}`);

  // The app works at once: receive stock, then a full sale and its payment, all numbered 0001.
  asAdmin(`v := public.next_po_number();
    ${as(`r := public.save_purchase_order(NULL, jsonb_build_object('po_number', v, 'vendor', '[UNDO] Vendor', 'status', 'draft'),
      jsonb_build_array(jsonb_build_object('product_id', '${SALE_PRODUCT}', 'product_name', '[UNDO] Delivery Product', 'quantity_ordered', 10,
        'unit_cost_cents', 600, 'unit_size', 'Gal')), '${ADMIN}', 'after-po');`)}
    po := (r->>'po_id')::uuid;
    ${as(`PERFORM public.submit_purchase_order(po, '${ADMIN}', 'after-po-submit');
      PERFORM public.receive_po_items(jsonb_build_array(jsonb_build_object('po_item_id', (SELECT id FROM public.purchase_order_items WHERE purchase_order_id = po),
        'quantity', 10, 'storage_location', 'Main Warehouse', 'condition', 'good')), '${ADMIN}', 'after-receive', false);`)}
    ${sale('after', 3)}
    ${as(`r := public.allocate_payment('${SALE_CUSTOMER}', 3000, 'check', 'RESET-AFTER-1', '2001', current_date, '[PROVER] after reset',
      jsonb_build_array(jsonb_build_object('invoice_id', inv, 'amount_cents', 3000)), '${ADMIN}', 'after-pay');`)}`);
  const after = scalar(`SELECT concat_ws(' ', (SELECT po_number || ':' || status FROM public.purchase_orders),
      (SELECT quote_number || ':' || status FROM public.quotes), (SELECT order_number || ':' || status FROM public.orders),
      (SELECT delivery_number || ':' || status FROM public.deliveries), (SELECT invoice_number || ':' || status || ':' || balance_cents FROM public.invoices),
      (SELECT 'stock=' || quantity_available FROM public.inventory WHERE product_id = '${SALE_PRODUCT}'));`);
  assert.equal(after, `PO-${Y}-0001:fully_received Q-${Y}-0001:accepted ORD-${Y}-0001:fulfilled DEL-00001:completed CS-${Y}-0001:paid:0 stock=7.00`, after);
  console.log(`[b app] after the reset: ${after}`);

  // (c) A second apply refuses.
  refused('second apply', apply(pinned(live)), /LIVE_RESET_ALREADY_APPLIED/);

  // (d) The backup holds every deleted row, byte-identical.
  for (const t of [...CORE, ...LOGS_ALL]) {
    assert.equal(scalar(`SELECT count(*) FROM reset_backup_20261123.${t};`), String(before.counts[t]), `backup of ${t}`);
    assert.equal(tableMd5('reset_backup_20261123', t), deletedMd5[t], `backup rows of ${t} differ from the originals`);
  }
  for (const t of Object.keys(LOGS_FILTERED)) assert.equal(logGone('reset_backup_20261123', t), logGoneBefore[t], `backup rows of ${t} differ from the originals`);
  assert.equal(scalar("SELECT count(*) FROM reset_backup_20261123._manifest WHERE rows_deleted IS DISTINCT FROM rows_backed_up;"), '0');
  assert.equal(scalar(`SELECT count(*) FROM reset_backup_20261123._sequences WHERE NOT (seq = ANY ('{${SEQS.join(',')}}'::text[]));`), '0');
  assert.equal(scalar("SELECT has_schema_privilege('authenticated', 'reset_backup_20261123', 'USAGE') OR has_schema_privilege('anon', 'reset_backup_20261123', 'USAGE');"), 'f');
  console.log(`[d backup] reset_backup_20261123 holds every deleted row of ${CORE.length + LOGS_ALL.length} tables (+ log rows), md5-identical to before; no API role can reach it`);

  console.log('\nLIVE_RESET_PROOF_PASS');
} finally {
  if (built && !KEEP) removeContainer();
}
