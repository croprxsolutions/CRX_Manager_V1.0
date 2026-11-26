#!/usr/bin/env node
/**
 * Real-schema proof for 20270311150000_whole_item_quantities.sql (contract
 * docs/plans/2026-11-26-whole-item-quantities-CONTRACT.md). Harness copied from the tiny-line prover (#2562).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, shows the gap, applies the candidate, then checks
 * every proof case through real writes and the real completion RPC as the signed-in admin.
 *
 * Run: node scripts/smoke/prove-whole-item-quantities-real-schema.mjs   (needs Docker)
 * Prints WHOLE_ITEM_QUANTITIES_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a disposable container this run creates (no reuse of another container or database: Sol r1).
const NAME = `crx-wholeitem-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270311150000_whole_item_quantities.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'whole-item-quantities-reverse.sql');
const FOLLOW_UPS = [];
const LATER_READ_ONLY = new Set([]);
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate or its follow-up creates or relies on.
const TOUCHED = /(_enforce_whole_item_quantity|a3_whole_item_quantity)/i;
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
    GRANT ALL ON storage.objects, storage.buckets TO postgres;
    -- Row security on, as live has it: 20261217100000 (the current job completion body) checks it (Sol r1).
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;`, { user: 'supabase_admin' });
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
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
// A rolled-back probe: as postgres with triggers on (uid null) or as a signed-in user. Returns the last row.
function probe(sql, uid = null) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${claims}\n${sql}\nROLLBACK;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '' };
}


const id = (s) => `a7178000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), CUST = id('c1'), PE = id('b1'), PU = id('b2'), PG = id('b3'), IE = id('d1'), IG = id('d2');
const ORD = id('e1'), OE = id('e11'), OG = id('e12'), OL = id('e13');
const Q = id('91'), QS = id('92');
// DF: whole-item line + gallon line, completed with a fraction on the whole-item line (refused).
// DW: whole-item line only, completed whole and partial (1 of 2).
const DF = id('f1'), DFE = id('f11'), DFG = id('f12'), DW = id('f2'), DWE = id('f21'), DS = id('f3'), DSE = id('f31'), DSG = id('f32');
const product = (pid, name, form, unit) => `('${pid}', '${name}', '${name}', '${form}', '${unit}', '${unit}', '${unit}', '${unit}', 1, 8, 10, 10, 10, 1, true)`;

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'wholeitem-admin@example.invalid', '{"full_name":"[PROVER] Whole Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Whole Farm', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ${product(PE, '[PROVER] Seed Ea', 'each', 'Ea')}, ${product(PU, '[PROVER] Seed Unit', 'each', 'Unit')}, ${product(PG, '[PROVER] Gallon', 'liquid', 'Gal')};
    INSERT INTO public.inventory (id, product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order) VALUES
      ('${IE}', '${PE}', 'Main Warehouse', 'Ea', 10, 4, 0), ('${IG}', '${PG}', 'Main Warehouse', 'Gal', 50, 10, 0);
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES ('${ORD}', 'WHOLE-O1', '${CUST}', 'confirmed');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit, cost_per_unit) VALUES
      ('${OE}', '${ORD}', '${PE}', '[PROVER] Seed Ea', 'Ea', 4, 0, 4, 10, 8),
      ('${OG}', '${ORD}', '${PG}', '[PROVER] Gallon', 'Gal', 10, 0, 10, 10, 8),
      ('${OL}', '${ORD}', '${PE}', '[PROVER] Seed Ea', 'Ea', 2.5, 0, 2.5, 10, 8);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, assigned_driver, status, is_quick_delivery) VALUES
      ('${DF}', 'WHOLE-DF', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', 'in_progress', false),
      ('${DW}', 'WHOLE-DW', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', 'in_progress', false),
      ('${DS}', 'WHOLE-DS', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', 'scheduled', false);
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size) VALUES
      ('${DFE}', '${DF}', '${OE}', '${PE}', 2, 'Ea'), ('${DFG}', '${DF}', '${OG}', '${PG}', 2.5, 'Gal'),
      ('${DWE}', '${DW}', '${OE}', '${PE}', 2, 'Ea'),
      ('${DSE}', '${DS}', '${OL}', '${PE}', 2, 'Ea'), ('${DSG}', '${DS}', '${OG}', '${PG}', 2.5, 'Gal');
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by) VALUES ('${Q}', 'WHOLE-Q1', '${CUST}', '${ADMIN}');
    INSERT INTO public.quote_sections (id, quote_id) VALUES ('${QS}', '${Q}');`);
  console.log('[prover] seeded Ea, Unit and Gal products, an order (one legacy 2.5 Ea line), a quote, two loads in progress and one scheduled');
}

const AS_ADMIN = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true); SET LOCAL ROLE authenticated;`;
const completeCall = (d, quantities, key) => `SELECT public.complete_delivery(p_delivery_id => '${d}', p_signed_by => 'No proof — recorded by office',
    p_performed_by => '${ADMIN}', p_quantities => ${quantities === null ? 'NULL' : J(quantities)}, p_idempotency_key => '${key}',
    p_evidence => 'no_proof', p_evidence_ref => '[PROVER] whole item')`;
function committed(sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${AS_ADMIN}\n${sql};\nCOMMIT;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
const quoteLine = (pid, qty) => `INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, current_cost, total_units_needed, unit_size, calc_mode)
  VALUES ('${Q}', '${QS}', '${pid}', 1, 10, 8, ${qty}, (SELECT inventory_unit FROM public.products WHERE id = '${pid}'), 'units_direct');`;
const orderLine = (pid, qty, unit) => `INSERT INTO public.order_items (order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit, cost_per_unit)
  VALUES ('${ORD}', ${pid ? `'${pid}'` : 'NULL'}, 'x', '${unit}', ${qty}, 0, ${qty}, 10, 8);`;
const ok = (sql, what) => { const r = probe(sql); assert.equal(r.status, 0, `${what} should save:\n${r.output}`); };
const WHOLE_MSG = /WHOLE_ITEMS_ONLY: \[PROVER\] Seed (Ea|Unit) is sold by the whole item \((Ea|Unit)\), so [0-9.]+ can't be used\. Enter a whole number/;
const refused = (sql, what, extra) => {
  const r = probe(sql);
  assert.notEqual(r.status, 0, `${what} should be refused`);
  assert.match(r.output, WHOLE_MSG, r.output);
  if (extra) assert.match(r.output, extra, r.output);
};
const stockOf = (inv) => scalar(`SELECT quantity_available || '/' || quantity_prebooked FROM public.inventory WHERE id = '${inv}';`);
const footprint = (d) => scalar(`SELECT jsonb_build_object(
    'status', (SELECT status FROM public.deliveries WHERE id = '${d}'),
    'lines', (SELECT jsonb_agg(jsonb_build_array(id, quantity, quantity_delivered) ORDER BY id) FROM public.delivery_items WHERE delivery_id = '${d}'),
    'order_lines', (SELECT jsonb_agg(jsonb_build_array(id, total_units_needed, quantity_delivered, quantity_remaining) ORDER BY id) FROM public.order_items WHERE order_id = '${ORD}'),
    'ledger', (SELECT count(*) FROM public.inventory_transactions WHERE delivery_id = '${d}'),
    'invoices', (SELECT count(*) FROM public.invoices WHERE delivery_id = '${d}'),
    'stock', (SELECT jsonb_agg(quantity_available || '/' || quantity_prebooked ORDER BY id) FROM public.inventory WHERE id IN ('${IE}', '${IG}')))::text;`);
const receiptOf = (out) => out.split(/\r?\n/).filter((l) => l.includes('"delivery_id"')).at(-1);

function beforeCases() {
  ok(orderLine(PE, 2.5, 'Ea'), 'before the fix, a 2.5 Ea order line');
  console.log('[before] reproduced: a 2.5 Ea order line saves');
}

function applyCandidate() {
  stageText('candidate.sql', lf(CANDIDATE));
  // 9 (Taha LOW 2). The seeded legacy 2.5 Ea line makes the postflight scan (after the triggers lock the tables) refuse, naming its order; the rollback leaves nothing installed.
  const blocked = apply('candidate.sql');
  assert.notEqual(blocked.status, 0, 'the apply must be refused while a fractional Ea line exists');
  assert.match(blocked.output, /WHOLE_ITEMS_POSTFLIGHT: fractional quantities already exist on Ea\/Unit products \(first ten: order WHOLE-O1\)/, blocked.output);
  assert.equal(scalar("SELECT to_regprocedure('public._enforce_whole_item_quantity()') IS NULL;"), 't');
  raw(`UPDATE public.order_items SET total_units_needed = 3, quantity_remaining = 3 WHERE id = '${OL}';`);
  const r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  // Back to a legacy fraction (triggers off), as a row made before a later unit change would be.
  raw(`UPDATE public.order_items SET total_units_needed = 2.5, quantity_remaining = 2.5 WHERE id = '${OL}';`);
  console.log('[case 9] the apply is refused while order WHOLE-O1 holds 2.5 Ea, naming it; once whole, it applies');
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.output, /WHOLE_ITEMS_PREFLIGHT/);
  console.log('[apply] the migration applies (postflight: three triggers, no API-role EXECUTE); a second apply is refused');
}

function afterCases() {
  // 1. Quote lines: a fraction on Ea or Unit is refused with the quote hint; a whole figure (and 2.00) saves.
  refused(quoteLine(PE, 14.8), 'a 14.8 Ea quote line', /Change the rate or acres, or type the number of items\./);
  refused(quoteLine(PU, 2.5), 'a 2.5 Unit quote line');
  ok(quoteLine(PE, 15), 'a 15 Ea quote line');
  ok(quoteLine(PE, '2.00'), 'a 2.00 Ea quote line');
  refused(`${quoteLine(PE, 15)} UPDATE public.quote_items SET total_units_needed = 15.5 WHERE quote_id = '${Q}';`, 'a quote line changed to 15.5');
  console.log('[case 1] quote: 14.8 Ea and 2.5 Unit refused (with the rate/acres hint); 15 and 2.00 save; a change to 15.5 refused');

  // 2. Gallon products are unchanged everywhere.
  ok(quoteLine(PG, 2.5), 'a 2.5 Gal quote line');
  ok(orderLine(PG, 2.5, 'Gal'), 'a 2.5 Gal order line');
  ok(`UPDATE public.delivery_items SET quantity = 1.5 WHERE id = '${DSG}';`, 'a 1.5 Gal delivery line');
  console.log('[case 2] Gal: 2.5 quote line, 2.5 order line and a 1.5 delivery line save');

  // 3. Order lines: insert and update refused on a fraction; whole saves.
  refused(orderLine(PE, 2.5, 'Ea'), 'a 2.5 Ea order line');
  refused(orderLine(PU, 0.5, 'Unit'), 'a 0.5 Unit order line');
  refused(`UPDATE public.order_items SET total_units_needed = 2.5 WHERE id = '${OE}';`, 'an Ea order line changed to 2.5');
  ok(`UPDATE public.order_items SET total_units_needed = 5, quantity_remaining = 5 WHERE id = '${OE}';`, 'an Ea order line changed to 5');
  ok(orderLine(PE, 3, 'Ea'), 'a 3 Ea order line');
  console.log('[case 3] order: 2.5 Ea and 0.5 Unit refused on insert, 2.5 refused on update; whole figures save');

  // 4. Delivery: a scheduled 1.5 Ea refused; completing with 0.5 on the Ea line is refused and nothing moves;
  //    a whole partial (1 of 2) completes.
  refused(`UPDATE public.delivery_items SET quantity = 1.5 WHERE id = '${DSE}';`, 'a 1.5 Ea delivery line');
  const fp = footprint(DF);
  let r = committed(completeCall(DF, { [DFE]: 0.5, [DFG]: 2.5 }, 'whole-4'));
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /WHOLE_ITEMS_ONLY: \[PROVER\] Seed Ea is sold by the whole item \(Ea\), so 0\.5 can't be used/, r.output);
  assert.equal(footprint(DF), fp, 'a refused completion must leave the load, order lines, ledger, invoices and stock unchanged');
  const sE = stockOf(IE);
  r = committed(completeCall(DW, { [DWE]: 1 }, 'whole-4b'));
  assert.equal(r.status, 0, r.output);
  const receipt = receiptOf(r.output);
  assert.ok(receipt, r.output);
  assert.equal(scalar(`SELECT status FROM public.deliveries WHERE id = '${DW}';`), 'completed');
  assert.equal(Number(scalar(`SELECT quantity_delivered FROM public.delivery_items WHERE id = '${DWE}';`)), 1);
  assert.deepEqual(stockOf(IE).split('/').map(Number), sE.split('/').map((x) => Number(x) - 1), 'Ea stock after a whole partial');
  console.log(`[case 4] delivery: 1.5 Ea scheduled refused; completing 0.5 Ea beside 2.5 Gal refused, nothing moved; 1 of 2 Ea completes (Ea stock ${sE} -> ${stockOf(IE)})`);

  // 5. A legacy fractional line (inserted before the rule) still saves an unrelated change.
  ok(`UPDATE public.order_items SET notes = 'legacy', sort_order = 9 WHERE id = '${OL}';`, 'a note on the legacy 2.5 Ea line');
  // The quantity column in the SET list fires the trigger; the figure is unchanged, so it passes.
  ok(`UPDATE public.order_items SET total_units_needed = total_units_needed WHERE id = '${OL}';`, 'a rewrite of the legacy line\'s own 2.5');
  console.log('[case 5] the legacy 2.5 Ea order line saves a note and sort change, and a rewrite of its unchanged 2.5');

  // 10 (Taha LOW 1). The real save_quote re-inserts every line: a 2.5 Unit line is refused, a 3 Unit line saves.
  const saveQuote = (qty, tag) => `SELECT public.save_quote(NULL::uuid,
    ${J({ quote_number: `[PROVER] WIQ ${tag}`, customer_id: CUST, status: 'draft', tier: 1, commission_split: { splits: [] } })},
    ${J([{ section_name: 'North', sort_order: 0, items: [{ product_id: PU, sort_order: 0, calc_mode: 'units_direct', total_units_needed: qty,
      price_override: 12, price_per_unit: 12, current_cost: 8, unit_size: 'Unit', acres: 0, product_name: '[PROVER] Seed Unit' }] }])},
    '${ADMIN}'::uuid, 'wiq-quote-${tag}')`;
  r = committed(saveQuote(2.5, 'frac'));
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /WHOLE_ITEMS_ONLY: \[PROVER\] Seed Unit is sold by the whole item \(Unit\), so 2\.5 can't be used\. Enter a whole number\. Change the rate or acres/, r.output);
  assert.equal(scalar("SELECT count(*) FROM public.quotes WHERE quote_number = '[PROVER] WIQ frac';"), '0', 'no quote survives the refusal');
  r = committed(saveQuote(3, 'whole'));
  assert.equal(r.status, 0, r.output);
  assert.equal(scalar(`SELECT count(*) FROM public.quote_items qi JOIN public.quotes q ON q.id = qi.quote_id WHERE q.quote_number = '[PROVER] WIQ whole' AND qi.total_units_needed = 3;`), '1');
  console.log('[case 10] the real save_quote refuses a 2.5 Unit line (no quote saved) and saves a 3 Unit line');

  // 6. A retry of the completed whole partial returns the saved receipt and moves nothing.
  const s6 = stockOf(IE);
  r = committed(completeCall(DW, { [DWE]: 1 }, 'whole-4b'));
  assert.equal(r.status, 0, r.output);
  assert.equal(receiptOf(r.output), receipt);
  assert.equal(stockOf(IE), s6);
  console.log('[case 6] a retry returns the same receipt; nothing moves again');

  // 8. A product change re-checks every figure.
  refused(`${orderLine(PG, 2.5, 'Gal')} UPDATE public.order_items SET product_id = '${PE}', unit_size = 'Ea' WHERE total_units_needed = 2.5 AND product_id = '${PG}';`, 'a 2.5 Gal line moved to Ea');
  const noProduct = probe(orderLine(null, 2.5, 'Ea'));
  if (noProduct.status === 0) {
    refused(`${orderLine(null, 2.5, 'Ea')} UPDATE public.order_items SET product_id = '${PE}' WHERE product_id IS NULL AND order_id = '${ORD}';`, 'a product-less 2.5 line given the Ea product');
    console.log('[case 8] product change: 2.5 Gal moved to Ea refused; a product-less 2.5 line given Ea refused');
  } else {
    console.log(`[case 8] product change: 2.5 Gal moved to Ea refused (an order line with no product cannot be inserted: ${noProduct.output.trim().split('\n').at(-1)})`);
  }

  // 11. No API role can call the trigger function.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public._enforce_whole_item_quantity()', 'EXECUTE');`), 'f', role);
  }
  console.log('[case 11] anon, authenticated and service_role cannot call the trigger function');
}

function rollbackCases() {
  stageText('reverse.sql', lf(REVERSE));
  const r = apply('reverse.sql');
  assert.equal(r.status, 0, r.output);
  ok(orderLine(PE, 2.5, 'Ea'), 'after the rollback, a 2.5 Ea order line');
  const twice = apply('reverse.sql');
  assert.notEqual(twice.status, 0);
  assert.match(twice.output, /WHOLE_ITEMS_REVERSE/);
  console.log('[rollback] the reverse script removes the rule (2.5 Ea saves again); a second run is refused');
}

function main() {
  buildContainer();
  seed();
  beforeCases();
  applyCandidate();
  afterCases();
  rollbackCases();
  console.log('WHOLE_ITEM_QUANTITIES_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
