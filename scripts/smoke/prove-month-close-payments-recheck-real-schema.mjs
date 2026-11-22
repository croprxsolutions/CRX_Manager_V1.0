#!/usr/bin/env node
/**
 * Real-schema proof for 20270220110000_month_close_payments_received_recheck (KI-129 payments received / #2175 close re-check).
 * Container setup and replay copied from prove-pnl-commission-share-billed-real-schema.mjs. Then, on synthetic rows:
 *   1. BEFORE: Month-End shows only legacy payments; the close receipt even counts a deleted legacy payment.
 *   2. The candidate applies; a second apply is refused by its preflight.
 *   3. AFTER: payments received = active Record Payment checks + prepayment checks + live legacy payments (expected
 *      values written from the rule); every other figure unchanged.
 *   4. The close refuses a missing or stale review token and unconfirmed payments/commission; a retry replays.
 *   5. A rep and an inactive admin are refused; the helpers and the impl are refused to signed-in and signed-out callers.
 *
 * Run: node scripts/smoke/prove-month-close-payments-recheck-real-schema.mjs   (needs Docker)
 * Prints MONTH_CLOSE_RECHECK_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-mclose-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270220110000_month_close_payments_received_recheck.sql');
const FOLLOW_UPS = [];
const LATER_READ_ONLY = new Set();
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
  // Need live's storage.objects policies, which this database does not have; neither touches units or stock.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate changes or relies on.
const TOUCHED = /(_month_close_figures_20270208|_month_payments_received_20270208|get_monthly_summary|close_accounting_period)/i;
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const LIVE_UNIT_ROWS = "('3f5c3827-8523-4b42-9913-ad479588ff95'::uuid, 'Dry oz', 1, 'dry', '1 dry ounce'), ('5ed18e4b-c4d9-42fc-b85e-22babd3fc098'::uuid, 'Ea', 1, 'both', 'Each / unit'), ('f9e10e66-5027-464e-bb9e-ed9800875256'::uuid, 'fl oz', 1, 'liquid', '1 fluid ounce'), ('4406cacd-a7fe-42db-8c84-694e61bb937b'::uuid, 'g', 0.03527396, 'dry', '1 gram = 0.03527396 dry ounces (1000 mg)'), ('29d05e43-cb40-461b-a969-88ee299faca8'::uuid, 'Gal', 128, 'liquid', '1 gallon = 128 fluid ounces'), ('53997e31-d152-4ab6-b768-d1aa81b657bf'::uuid, 'Lb', 16, 'dry', '1 pound = 16 dry ounces'), ('fc5d349f-b58c-48f1-991d-fa0161fd3d01'::uuid, 'LB', 16, 'dry', '1 pound (capitalized alias)'), ('ddde7daf-8090-492b-aed9-c0b7f8ecfd34'::uuid, 'MG', 0.00003527396, 'dry', '1 milligram = 0.00003527396 dry ounces'), ('438d5f7b-f015-4319-b2b7-4f9a672cb350'::uuid, 'oz', 1, 'liquid', '1 fluid ounce (alias for fl oz)'), ('b69ddac6-68ed-4f1d-8e09-e63a7fa6635a'::uuid, 'Oz', 1, 'liquid', '1 fluid ounce (capitalized alias)'), ('a31f95a0-df80-4025-977f-f1fb4e5c8d53'::uuid, 'Pt', 16, 'liquid', '1 pint = 16 fluid ounces'), ('35532f45-2fd0-4400-87d8-3509a58377c0'::uuid, 'qt', 32, 'liquid', '1 quart lowercase (alias for Qt)'), ('915f25ff-8876-4a49-a375-940047e38313'::uuid, 'Qt', 32, 'liquid', '1 quart = 32 fluid ounces'), ('722e8d86-8e68-47d8-a940-209fad38c70e'::uuid, 'Unit', 1, 'both', 'Each / unit (alias for Ea)')";

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', DB, '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
function psql(sql, options = {}) { return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure }); }
function scalar(sql) { return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''; }
function lf(file) { return readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
function stageText(name, text) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  writeFileSync(staged, text, 'utf8');
  try { docker(['cp', staged, `${NAME}:/tmp/${name}`]); } finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove ${staged}: ${e.message}`); }
  }
}
function apply(name) {
  const r = docker([...psqlArgs(), '-1', '-f', `/tmp/${name}`], { allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ready() {
  for (let i = 0; i < 120; i += 1) {
    if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) return;
    wait(500);
  }
  throw new Error('disposable PostgreSQL did not become ready');
}
function ledger(stem) {
  psql(`INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    SELECT '${stem.slice(0, 14)}', '${stem}', ARRAY[]::text[]
     WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '${stem}')
    ON CONFLICT (version) DO NOTHING;`);
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${stem}';`), '1', `${stem} is not in the ledger`);
}
function restoreLiveCrLfCloseRemainder() {
  const source = lf(path.join(MIGRATIONS, '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql'));
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = source.indexOf(tag[0], bodyStart);
  const body = source.slice(bodyStart, bodyEnd).replace(/\n/g, '\r\n');
  assert.equal(body.length, 15910, 'close-remainder live CRLF body length drifted');
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`);
}
// 20261104150000 (WP-PM-9, live) pins three live function bodies that the historical LF replay
// does not reproduce; install them exactly as PM-9's own prover does, right before that file.
const FORMS_SEED_EACH = '20261104150000_product_forms_seed_each.sql';
const LIVE_BODY_MD5 = {
  'public.field_app_priced_quantity(numeric,text,text,text)': 'bc91a52577840973f18f1710e47edf2b',
  'public.convert_to_gl_lb(numeric,text,text)': 'ce9265521821c09b0cf74de45afb375b',
  'public.validate_product_units()': '83a51c58c83cd83bea760bd117410a38',
};

function bodyFrom(file, expression) {
  const match = expression.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  assert.ok(match, `${file} no longer contains its pinned function body`);
  return match[1];
}
function restoreLiveBodies() {
  // Historical replay uses LF staging; validate_product_units had CRLF in live prosrc.
  const validate = bodyFrom('20260211000000_unit_tracking_pricing_overhaul.sql',
    /CREATE OR REPLACE FUNCTION validate_product_units\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)
    .replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');  // same bytes on an LF or CRLF checkout
  const field = bodyFrom('20260630180000_field_app_pricing_unit_fix.sql',
    /CREATE OR REPLACE FUNCTION public.field_app_priced_quantity\([\s\S]*?AS \$fapq\$([\s\S]*?)\$fapq\$;/);
  const seededConvert = bodyFrom(FORMS_SEED_EACH,
    /CREATE OR REPLACE FUNCTION public.convert_to_gl_lb\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/).replaceAll('\r\n', '\n');
  const seedArm = "  IF lower(coalesce(p_product_form, '')) IN ('seed','each') THEN RETURN QUERY SELECT NULL::numeric, NULL::text; RETURN; END IF;\n";
  assert.equal(seededConvert.split(seedArm).length - 1, 1);
  const convert = seededConvert.replace(seedArm, '');
  psql(`CREATE OR REPLACE FUNCTION public.validate_product_units() RETURNS trigger LANGUAGE plpgsql
    SET search_path = public, pg_temp AS $live_validate$${validate}$live_validate$;`);
  psql(`CREATE OR REPLACE FUNCTION public.field_app_priced_quantity(
      p_applied_qty numeric, p_rate_unit text, p_inventory_unit text, p_product_form text)
    RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp
    AS $live_field$${field}$live_field$;`);
  psql(`CREATE OR REPLACE FUNCTION public.convert_to_gl_lb(
      p_total_applied numeric, p_rate_unit text, p_product_form text)
    RETURNS TABLE(converted_value numeric, converted_unit text) LANGUAGE plpgsql IMMUTABLE
    SET search_path = public AS $live_convert$${convert}$live_convert$;`);
  for (const [signature, expected] of Object.entries(LIVE_BODY_MD5)) {
    assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = '${signature}'::regprocedure;`),
      expected, `${signature} is not the pinned live body before the candidate`);
  }
}
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs', '--include-one-shot'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  // Others' migrations may sort between the candidate and a follow-up (live applied them in between);
  // they are not replayed, so each must leave alone what this proof covers.
  let last = at;
  for (const file of FOLLOW_UPS) {
    const i = all.indexOf(file);
    assert.ok(i > last, `${path.basename(file)} must sort after the candidate and earlier follow-ups`);
    last = i;
  }
  for (const file of all.slice(at + 1).filter((f) => !FOLLOW_UPS.includes(f) && !LATER_READ_ONLY.has(path.basename(f)))) {
    assert.ok(!TOUCHED.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches what it relies on; re-think this proof`);
  }
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!TOUCHED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return before;
}
function installLiveAuthUid() {
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
}
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  // storage.objects carries metadata and a (bucket_id, name) key, and postgres may read it, as live
  // has them: 20261022075000 (replayed before the candidate) checks that shape in its preflight.
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, created_at timestamptz DEFAULT now(), UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres;
    GRANT ALL ON storage.objects, storage.buckets TO postgres;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    // Other one-shot data migrations rewrite live rows this database does not have: ledger only, as live has them.
    if (ONE_SHOT.has(base.slice(0, -4))) { ledger(base.slice(0, -4)); continue; }
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    // BLK-1a's preflight needs live's count units (live has Ea and Unit, factor 1, both).
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
    }
    // RT-1's preflight pins live's unit factors; give it live's 14 unit rows (read live 2026-11-10).
    if (base === '20261229110000_product_rates_draft.sql') {
      raw(`DELETE FROM public.unit_conversions;
        INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};`);
    }
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') {
      psql(`UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
        INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
        WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');`);
    }
    if (base === '20270106110000_invoice_brands_rup.sql') {
      // Live ran REG-1's one-time seed before this file; its preflight refuses without the seed row.
      raw(`INSERT INTO public.epa_registration_seed_run (seeded_by, rup_default, fingerprint)
        SELECT '00000000-0000-4000-8000-000000000000', 'unknown', 'units-proof' WHERE NOT EXISTS (SELECT 1 FROM public.epa_registration_seed_run);`);
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}



const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
// A rolled-back probe: as postgres with triggers on (uid null) or as a signed-in user. Returns the last row.
function probe(sql, uid = null) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${claims}\n${sql}\nROLLBACK;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '' };
}
function okProbe(sql, uid) { const r = probe(sql, uid); assert.equal(r.status, 0, r.output); return r.last; }
function refusedProbe(sql, pattern, uid) {
  const r = probe(sql, uid);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}\n${r.output}`);
  assert.match(r.output, pattern);
}

const ADMIN = 'c1290000-0000-4000-8000-0000000000a1';
const OLD_ADMIN = 'c1290000-0000-4000-8000-0000000000a2';
const REP = 'c1290000-0000-4000-8000-0000000000b2';
const CUSTOMER = 'c1290000-0000-4000-8000-0000000000c1';
const ORDER = 'c1290000-0000-4000-8000-0000000000d1';
const FEE_INVOICE = 'c1290000-0000-4000-8000-0000000000e1';

function seed() {
  psql('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;', { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'mc-a@example.invalid', '{"full_name":"[PROVER] MC admin","role":"admin"}'::jsonb),
    ('${OLD_ADMIN}', 'mc-o@example.invalid', '{"full_name":"[PROVER] MC old admin","role":"admin"}'::jsonb),
    ('${REP}', 'mc-r@example.invalid', '{"full_name":"[PROVER] MC rep","role":"sales_rep"}'::jsonb);`);
  raw(`BEGIN;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'admin', is_active = false WHERE id = '${OLD_ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUSTOMER}', '[PROVER] MC Farm', true);
    INSERT INTO public.orders (id, order_number, customer_id, total_price, status, order_date) VALUES ('${ORDER}', 'MC-O1', '${CUSTOMER}', 100.00, 'fulfilled', DATE '2025-11-03');
    -- A field application billed in November with a $30 commission, so November's commission is not $0.
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by, posted_at)
      VALUES ('${FEE_INVOICE}', 'MC-1', '${CUSTOMER}', 'field_application', 'posted', DATE '2025-11-25', 50000, '${ADMIN}', '2025-11-25 12:00Z');
    INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price_cents, extended_cents, cost_cents, is_application_fee)
      VALUES ('${FEE_INVOICE}', '[PROVER] fee', 100, 500, 50000, 20000, true);
    INSERT INTO public.commissions (customer_id, job_id, invoice_id, recipient, commission_amount, status, order_date)
      VALUES ('${CUSTOMER}', gen_random_uuid(), '${FEE_INVOICE}', '[PROVER] rep', 30, 'pending', DATE '2025-11-25');
    -- Record Payment: a $1,500 check ($300 of it kept as prepay), a voided payment, one dated Nov 30 but recorded the
    -- evening of Nov 30 Chicago (Dec 1 UTC), one dated Oct 31 recorded that evening (Nov 1 UTC): the date wins.
    INSERT INTO public.allocation_sets (entity_type, entity_id, customer_id, is_active, total_payment_cents, total_allocated_cents, payment_date, created_at) VALUES
      ('payment', gen_random_uuid(), '${CUSTOMER}', true, 150000, 120000, DATE '2025-11-10', '2025-11-10 15:00Z'),
      ('payment', gen_random_uuid(), '${CUSTOMER}', false, 99900, 99900, DATE '2025-11-12', '2025-11-12 15:00Z'),
      ('payment', gen_random_uuid(), '${CUSTOMER}', true, 20000, 20000, DATE '2025-11-30', '2025-12-01 03:00Z'),
      ('payment', gen_random_uuid(), '${CUSTOMER}', true, 7000, 7000, DATE '2025-10-31', '2025-11-01 04:00Z');
    -- Legacy payments: one live $50.00, one deleted $77.00.
    INSERT INTO public.payments (order_id, customer_id, payment_date, amount, recorded_by, deleted_at) VALUES
      ('${ORDER}', '${CUSTOMER}', DATE '2025-11-15', 50.00, '${ADMIN}', NULL),
      ('${ORDER}', '${CUSTOMER}', DATE '2025-11-16', 77.00, '${ADMIN}', now());
    -- Prepayment checks: #5150 for $300 in two buckets (one bucket's reference later corrected to 5151); a check
    -- deleted with nothing applied ($0 left); a $90 check of which $40 was applied, then deleted ($40 left).
    -- The overpayment credit from the $1,500 payment is not money received again.
    INSERT INTO public.prepay_credits (customer_id, season, original_amount_cents, balance_cents, source_type, reference_number, source_reference, allocation_set_id, created_by, created_at) VALUES
      ('${CUSTOMER}', 2026, 20000, 20000, 'check', '5150', '5150', NULL, '${ADMIN}', '2025-11-20 16:00Z'),
      ('${CUSTOMER}', 2026, 10000, 10000, 'check', '5151', '5150', NULL, '${ADMIN}', '2025-11-20 16:00Z'),
      ('${CUSTOMER}', 2026, 0, 0, 'check', '6000', '6000', NULL, '${ADMIN}', '2025-11-21 16:00Z'),
      ('${CUSTOMER}', 2026, 4000, 0, 'check', '6001', '6001', NULL, '${ADMIN}', '2025-11-22 16:00Z'),
      ('${CUSTOMER}', 2026, 30000, 30000, 'overpayment', 'x', 'From payment', (SELECT id FROM public.allocation_sets WHERE total_payment_cents = 150000), '${ADMIN}', '2025-11-10 15:00Z');
    COMMIT;`);
}

const NOV = ['2025-11-01', '2025-11-30'];
const summary = (a, b) => `public.get_monthly_summary(DATE '${a}', DATE '${b}')`;
const month = (a, b) => `SELECT ${summary(a, b)}::text;`;
const tokenOf = (a, b) => `(${summary(a, b)} ->> 'review_token')`;
const close = (key, token, pay = 'true', comm = 'true', actor = ADMIN) =>
  `public.close_accounting_period(DATE '${NOV[1]}', '${actor}', '${key}', ${token}, ${pay}, ${comm})`;
const closeSql = (...a) => `SELECT ${close(...a)}::text;`;
const AS_ADMIN = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);`;
const THIS_MONTH = "public.get_monthly_summary(date_trunc('month', now() AT TIME ZONE 'America/Chicago')::date, (now() AT TIME ZONE 'America/Chicago')::date)";

async function main() {
  buildContainer();
  seed();

  // 1. BEFORE
  const before = JSON.parse(okProbe(month(...NOV), ADMIN));
  const closeBefore = JSON.parse(okProbe(`SELECT public.close_accounting_period(DATE '2025-11-30', '${ADMIN}', 'mc-before')::text;`, ADMIN));
  console.log('[before] Nov payments', JSON.stringify(before.payments), 'close receipt payments', closeBefore.payments_received_cents);
  assert.deepEqual(before.payments, { count: 1, total_cents: 5000 }, 'BEFORE: only the legacy table, so Record Payment money is missed');
  assert.equal(closeBefore.payments_received_cents, 12700, 'BEFORE: the close receipt even counts the deleted legacy payment');
  assert.equal(before.review_token, undefined);
  console.log('[case] BEFORE: Month-End shows 1 payment / $50.00; the close receipt saves $127.00 (a deleted payment counted); Record Payment money missing');

  // 2. Apply; a second apply is refused. An undated payment set stops the apply (none live).
  stageText('candidate.sql', lf(CANDIDATE));
  const UNDATED = `INSERT INTO public.allocation_sets (entity_type, entity_id, customer_id, is_active, total_payment_cents, total_allocated_cents, payment_date)
    VALUES ('payment', gen_random_uuid(), '${CUSTOMER}', true, 1, 1, NULL);`;
  raw(UNDATED);
  const blocked = apply('candidate.sql');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.output, /MONTH_CLOSE_RECHECK_PREFLIGHT: 1 payment set\(s\) have no payment_date/);
  raw(`DELETE FROM public.allocation_sets WHERE total_payment_cents = 1;`);
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /MONTH_CLOSE_RECHECK_PREFLIGHT: already applied/);
  const undatedAfter = psql(`SET session_replication_role = replica; ${UNDATED}`, { user: 'supabase_admin', allowFailure: true });
  assert.notEqual(undatedAfter.status, 0);
  assert.match(undatedAfter.stderr, /allocation_sets_payment_has_date/);
  console.log('[case] an undated payment set stops the apply; the candidate applies; a second apply stops at its preflight; afterwards a payment set without a date is refused (so a void always checks the month of the payment)');

  // 3. Payments received (expected from the rule): $1,500 payment + $200 dated Nov 30 + $50 legacy
  //    + check #5150 $300 (two buckets = one payment, even with a corrected reference) + $40 left of the deleted check.
  const after = JSON.parse(okProbe(month(...NOV), ADMIN));
  console.log('[after] Nov payments', JSON.stringify(after.payments));
  assert.deepEqual(after.payments, { count: 5, total_cents: 209000 });
  const oct = JSON.parse(okProbe(month('2025-10-01', '2025-10-31'), ADMIN));
  assert.deepEqual(oct.payments, { count: 1, total_cents: 7000 }, 'the payment dated Oct 31 (recorded Nov 1 UTC) is October');
  for (const k of ['invoices', 'orders', 'deliveries', 'applications', 'commissions', 'ar_balance_cents', 'period_start', 'period_end']) {
    assert.deepEqual(after[k], before[k], `${k} unchanged`);
  }
  assert.equal(after.commissions.earned_cents, 3000);
  assert.match(after.review_token, /^[0-9a-f]{32}$/);
  console.log('[case] AFTER: November = 5 payments / $2,090.00 (voided payment, deleted legacy row, $0 deleted check and the overpayment credit left out; one check in two buckets is one payment); October gets its own evening payment; every other figure unchanged');
  const edited = JSON.parse(okProbe(`UPDATE public.prepay_credits SET original_amount_cents = 25000 WHERE original_amount_cents = 20000;
    SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true); SET LOCAL ROLE authenticated; ${month(...NOV)}`));
  assert.deepEqual(edited.payments, { count: 5, total_cents: 214000 }, 'a check edited to a new amount counts at its current amount');
  const writer = JSON.parse(okProbe(`SELECT public.create_prepay_check_splits('${CUSTOMER}', '7000', '[{"label":"A","amount_cents":11100},{"label":"B","amount_cents":22200}]'::jsonb, '${ADMIN}', 'mc-writer')::text;
    SELECT public.create_prepay_check_splits('${CUSTOMER}', '7001', '[{"label":"A","amount_cents":5000}]'::jsonb, '${ADMIN}', 'mc-writer-2')::text;
    SELECT json_build_object('times', (SELECT count(DISTINCT created_at) FROM public.prepay_credits WHERE reference_number = '7000'),
      'rows', (SELECT count(*) FROM public.prepay_credits WHERE reference_number = '7000'),
      'summary', ${THIS_MONTH})::text;`, ADMIN));
  assert.equal(writer.rows, 2);
  assert.equal(writer.times, 1, 'the real writer stamps both buckets of one check with one created_at');
  assert.deepEqual(writer.summary.payments, { count: 2, total_cents: 38300 },
    'one check through the real writer is one payment; a second check entered in the same transaction (same created_at) stays its own payment');
  console.log('[case] AFTER: an edited check counts at its new amount; the real Prepayment Manager writer gives a two-bucket check one created_at, so it is one payment; a second check in the same transaction is a second payment');

  // 4. Close re-check (each probe is rolled back, so November stays open for the next).
  const ok = JSON.parse(okProbe(closeSql('mc-ok', tokenOf(...NOV)), ADMIN));
  console.log('[after] Nov close receipt', JSON.stringify(ok));
  assert.equal(ok.payments_received_cents, 209000);
  assert.deepEqual(Object.keys(ok).sort(), Object.keys(closeBefore).sort(), 'receipt keys unchanged');
  for (const k of ['invoices_posted', 'total_invoiced_cents', 'orders_count', 'deliveries_count', 'period_start', 'period_end']) assert.deepEqual(ok[k], closeBefore[k], `receipt ${k} unchanged`);
  console.log('[case] a close with the reviewed token and both ticks closes; the receipt saves $2,090.00 received, other receipt figures unchanged');
  refusedProbe(`SELECT public.close_accounting_period(DATE '2025-11-30', '${ADMIN}', 'mc-old')::text;`, /CLOSE_REVIEW_REQUIRED: reload Month-End Close/, ADMIN);
  refusedProbe(closeSql('mc-pay', tokenOf(...NOV), 'false'), /CLOSE_REVIEW_REQUIRED: confirm you reviewed this month's payments/, ADMIN);
  refusedProbe(closeSql('mc-comm', tokenOf(...NOV), 'true', 'NULL'), /CLOSE_REVIEW_REQUIRED: confirm you reviewed this month's commissions/, ADMIN);
  refusedProbe(closeSql('mc-part', tokenOf('2025-11-02', '2025-11-30')), /CLOSE_FIGURES_CHANGED/, ADMIN);
  refusedProbe(closeSql('mc-oct', tokenOf('2025-10-01', '2025-10-31')), /CLOSE_FIGURES_CHANGED/, ADMIN);
  console.log('[case] refused: the old 3-argument call (reload), payments or commission not confirmed, a token for a partial range or another month');
  // Stale: the admin reviewed, then a check was edited before the click. The period stays open; after a fresh review
  // the same key closes.
  const stale = okProbe(`${AS_ADMIN}
    DO $$ DECLARE t text := ${tokenOf(...NOV)}; r jsonb; BEGIN
      UPDATE public.prepay_credits SET original_amount_cents = original_amount_cents + 100 WHERE reference_number = '6001';
      BEGIN PERFORM ${close('mc-stale', 't')}; RAISE EXCEPTION 'STALE_CLOSE_ACCEPTED';
      EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'CLOSE_FIGURES_CHANGED:%' THEN RAISE; END IF; END;
      IF EXISTS (SELECT 1 FROM public.accounting_periods WHERE period_end = DATE '2025-11-30' AND status = 'closed') THEN RAISE EXCEPTION 'CLOSED_AFTER_REFUSAL'; END IF;
      r := ${close('mc-stale', tokenOf(...NOV))};
      IF (r ->> 'payments_received_cents')::bigint <> 209100 THEN RAISE EXCEPTION 'FRESH_CLOSE_WRONG %', r; END IF;
    END $$; SELECT 'stale-ok';`);
  assert.equal(stale, 'stale-ok');
  console.log('[case] a figure changed after review: CLOSE_FIGURES_CHANGED, the month stays open; after a fresh review the same key closes with $2,091.00');
  // Today's AR alone changing (a December invoice) does not block November.
  const nov = JSON.parse(okProbe(month(...NOV), ADMIN));
  raw(`INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by, posted_at)
    VALUES ('MC-AR', '${CUSTOMER}', 'misc_charge', 'posted', DATE '2025-12-05', 999, '${ADMIN}', now());`);
  const arMoved = JSON.parse(okProbe(month(...NOV), ADMIN));
  assert.notEqual(arMoved.ar_balance_cents, nov.ar_balance_cents, "a December invoice moves today's AR");
  assert.equal(arMoved.review_token, nov.review_token, "today's AR is not part of the review token");
  okProbe(closeSql('mc-ar', `'${nov.review_token}'`), ADMIN);
  console.log("[case] a change only to today's AR does not block closing November");
  // A retry of a close that succeeded replays its receipt, even after a figure moved and with no token.
  const replay = okProbe(`${AS_ADMIN}
    DO $$ DECLARE r1 jsonb; r2 jsonb; BEGIN
      r1 := ${close('mc-replay', tokenOf(...NOV))};
      UPDATE public.allocation_sets SET total_payment_cents = total_payment_cents + 1 WHERE total_payment_cents = 150000;
      r2 := public.close_accounting_period(DATE '2025-11-30', '${ADMIN}', 'mc-replay');
      IF r1 IS DISTINCT FROM r2 THEN RAISE EXCEPTION 'REPLAY_DIFFERS % %', r1, r2; END IF;
    END $$; SELECT 'replay-ok';`);
  assert.equal(replay, 'replay-ok');
  console.log('[case] a retry with the same key replays the saved receipt, even after a figure moved');

  // 5. Who may call
  refusedProbe(month(...NOV), /admin/i, REP);
  refusedProbe(month(...NOV), /admin/i, OLD_ADMIN);
  refusedProbe(`SELECT ${close('mc-rep', 'NULL', 'true', 'true', REP)};`, /Only admin users/, REP);
  refusedProbe(`SELECT ${close('mc-old-admin', 'NULL', 'true', 'true', OLD_ADMIN)};`, /Only admin users/, OLD_ADMIN);
  for (const fn of ["_month_payments_received_20270208(DATE '2025-11-01', DATE '2025-11-30')", "_month_close_figures_20270208(DATE '2025-11-01', DATE '2025-11-30')",
    "_close_accounting_period_replay_impl_20261015(DATE '2025-11-30', NULL, 'x', NULL, NULL, NULL)"]) {
    refusedProbe(`SELECT public.${fn};`, /permission denied for function/, REP);
    refusedProbe(`SELECT public.${fn};`, /permission denied for function/, ADMIN);
    const anon = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\nSET LOCAL ROLE anon;\nSELECT public.${fn};\nROLLBACK;\n` });
    assert.match(`${anon.stdout}\n${anon.stderr}`, /permission denied for function/);
  }
  const anonClose = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\nSET LOCAL ROLE anon;\nSELECT ${close('mc-anon', 'NULL')};\nROLLBACK;\n` });
  assert.match(`${anonClose.stdout}\n${anonClose.stderr}`, /permission denied for function/);
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('close_accounting_period', '_close_accounting_period_replay_impl_20261015');"), '2', 'no old overload left');
  console.log('[case] a rep and an inactive admin are refused the summary and the close; the helpers and the impl are refused to signed-in and signed-out callers; one close signature left');
  console.log('MONTH_CLOSE_RECHECK_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
