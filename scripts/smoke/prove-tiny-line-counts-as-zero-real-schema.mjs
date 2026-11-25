#!/usr/bin/env node
/**
 * Real-schema proof for 20270307200000_tiny_line_counts_as_zero.sql (contract
 * docs/plans/2026-11-25-tiny-line-counts-as-zero-CONTRACT.md). Harness copied from the F05b prover.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, shows the gap, applies the candidate, then checks
 * every proof case through the real RPCs as the signed-in admin, committed and read back.
 *
 * Run: node scripts/smoke/prove-tiny-line-counts-as-zero-real-schema.mjs   (needs Docker)
 * Prints TINY_LINE_COUNTS_AS_ZERO_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a disposable container this run creates (no reuse of another container or database: Sol r1).
const NAME = `crx-tinyline-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270307200000_tiny_line_counts_as_zero.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'tiny-line-counts-as-zero-reverse.sql');
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
const TOUCHED = /(_complete_delivery_(authorized|body)_impl\w*)/i;
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

const id = (s) => `a7177000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), CUST = id('c1'), P = id('b1'), INV = id('d1'), ORD = id('e1'), OI = id('e11'), OI2 = id('e12');
// Each load has a real line R (order line OI, 1) and a second line T (order line OI2, same product; 1 unless noted).
// DA: 0.005 sent for T; DZ: its twin with 0 typed for T; DB: T scheduled at 0.005, no figures sent; DF: T scheduled
// at 0.005 and 1 sent for it; DC: exactly 0.01 for T; DN: a negative figure for T (and first a malformed one);
// DD: every line under 0.01; DE: scheduled, start-and-complete with 0.005 for T; DR: for the rollback probe.
const LOADS = { DA: 'in_progress', DZ: 'in_progress', DB: 'in_progress', DF: 'in_progress', DC: 'in_progress',
  DN: 'in_progress', DD: 'in_progress', DE: 'scheduled', DR: 'in_progress' };
const TINY_SCHEDULE = new Set(['DB', 'DF']);
const D = {}, R = {}, T = {};
Object.keys(LOADS).forEach((k, i) => { D[k] = id(`f${i + 1}`); R[k] = id(`f${i + 1}1`); T[k] = id(`f${i + 1}2`); });
// Two more orders (Taha's review LOW 4). DX (order ORD2): the real line on P, the tiny line on P2, a product with no
// Main Warehouse row. DL (order ORD3): the tiny line is its order line's last leftover (0.005 of 0.005 owed).
const P2 = id('b2'), ORD2 = id('e2'), OI3 = id('e21'), OI4 = id('e22'), ORD3 = id('e3'), OI5 = id('e31'), OI6 = id('e32');
for (const [k, n] of [['DX', 'fa'], ['DL', 'fb']]) { D[k] = id(n); R[k] = id(`${n}1`); T[k] = id(`${n}2`); }

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'tinyline-admin@example.invalid', '{"full_name":"[PROVER] Tiny Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Tiny Farm', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ('${P}', '[PROVER] Tiny Product', 'TINY-P', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 8, 10, 10, 10, 1, true);
    INSERT INTO public.inventory (id, product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order) VALUES
      ('${INV}', '${P}', 'Main Warehouse', 'Gal', 50, 20, 0);
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES ('${ORD}', 'TINY-O1', '${CUST}', 'confirmed');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit, cost_per_unit) VALUES
      ('${OI}', '${ORD}', '${P}', '[PROVER] Tiny Product', 'Gal', 30, 0, 30, 10, 8),
      ('${OI2}', '${ORD}', '${P}', '[PROVER] Tiny Product', 'Gal', 30, 0, 30, 10, 8);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, assigned_driver, status, is_quick_delivery) VALUES
      ${Object.entries(LOADS).map(([k, s]) => `('${D[k]}', 'TINY-${k}', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', '${s}', false)`).join(',\n      ')};
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size) VALUES
      ${Object.keys(LOADS).map((k) => `('${R[k]}', '${D[k]}', '${OI}', '${P}', 1, 'Gal'), ('${T[k]}', '${D[k]}', '${OI2}', '${P}', ${TINY_SCHEDULE.has(k) ? 0.005 : 1}, 'Gal')`).join(',\n      ')};
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ('${P2}', '[PROVER] Tiny Unstocked', 'TINY-P2', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 8, 10, 10, 10, 1, true);
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES
      ('${ORD2}', 'TINY-O2', '${CUST}', 'confirmed'), ('${ORD3}', 'TINY-O3', '${CUST}', 'confirmed');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit, cost_per_unit) VALUES
      ('${OI3}', '${ORD2}', '${P}', '[PROVER] Tiny Product', 'Gal', 30, 0, 30, 10, 8),
      ('${OI4}', '${ORD2}', '${P2}', '[PROVER] Tiny Unstocked', 'Gal', 30, 0, 30, 10, 8),
      ('${OI5}', '${ORD3}', '${P}', '[PROVER] Tiny Product', 'Gal', 1, 0, 1, 10, 8),
      ('${OI6}', '${ORD3}', '${P}', '[PROVER] Tiny Product', 'Gal', 0.005, 0, 0.005, 10, 8);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, assigned_driver, status, is_quick_delivery) VALUES
      ('${D.DX}', 'TINY-DX', '${ORD2}', '${CUST}', '${ADMIN}', '${ADMIN}', 'in_progress', false),
      ('${D.DL}', 'TINY-DL', '${ORD3}', '${CUST}', '${ADMIN}', '${ADMIN}', 'in_progress', false);
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size) VALUES
      ('${R.DX}', '${D.DX}', '${OI3}', '${P}', 1, 'Gal'), ('${T.DX}', '${D.DX}', '${OI4}', '${P2}', 1, 'Gal'),
      ('${R.DL}', '${D.DL}', '${OI5}', '${P}', 1, 'Gal'), ('${T.DL}', '${D.DL}', '${OI6}', '${P}', 0.005, 'Gal');`);
  console.log('[prover] seeded three orders and eleven loads, each with a real line and a second line');
}

const AS_ADMIN = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true); SET LOCAL ROLE authenticated;`;
const completeCall = (d, quantities, key) => `SELECT public.complete_delivery(p_delivery_id => '${d}', p_signed_by => 'No proof — recorded by office',
    p_performed_by => '${ADMIN}', p_quantities => ${quantities === null ? 'NULL' : J(quantities)}, p_idempotency_key => '${key}',
    p_evidence => 'no_proof', p_evidence_ref => '[PROVER] tiny line')`;
const startComplete = (d, quantities, key) => `SELECT public.start_and_complete_delivery(p_delivery_id => '${d}', p_signed_by => 'No proof — recorded by office',
    p_delivered_on => (now() AT TIME ZONE 'America/Chicago')::date, p_performed_by => '${ADMIN}', p_quantities => ${quantities === null ? 'NULL' : J(quantities)},
    p_idempotency_key => '${key}', p_evidence => 'no_proof', p_evidence_ref => '[PROVER] tiny line')`;
function committed(sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${AS_ADMIN}\n${sql};\nCOMMIT;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
const num = (sql) => Number(scalar(sql));
const delivered = (line) => num(`SELECT quantity_delivered FROM public.delivery_items WHERE id = '${line}';`);
const status = (d) => scalar(`SELECT status FROM public.deliveries WHERE id = '${d}';`);
const stock = () => scalar(`SELECT quantity_available || '/' || quantity_prebooked FROM public.inventory WHERE id = '${INV}';`);
const minus = (s, k) => s.split('/').map((x) => Number(x) - k).join('/');
const same = (a, b, what) => assert.deepEqual(a.split('/').map(Number), b.split('/').map(Number), what);
const lineDone = (oi) => num(`SELECT quantity_delivered FROM public.order_items WHERE id = '${oi}';`);
const lineOwed = (oi) => num(`SELECT quantity_remaining FROM public.order_items WHERE id = '${oi}';`);
const orderStatus = (o) => scalar(`SELECT status FROM public.orders WHERE id = '${o}';`);
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: got ${a}, expected ${b}`);
// Everything a completion writes for one load, with ids and names taken out so two loads can be compared.
const footprint = (d) => scalar(`SELECT jsonb_build_object(
    'status', (SELECT status FROM public.deliveries WHERE id = '${d}'),
    'order_status', (SELECT o.status FROM public.orders o JOIN public.deliveries dd ON dd.order_id = o.id WHERE dd.id = '${d}'),
    'lines', (SELECT jsonb_agg(jsonb_build_array(order_item_id, quantity, quantity_delivered, quantity_prebooked_released) ORDER BY order_item_id) FROM public.delivery_items WHERE delivery_id = '${d}'),
    'ledger', (SELECT coalesce(jsonb_agg(jsonb_build_array(transaction_type, quantity, requires_review) ORDER BY quantity), '[]') FROM public.inventory_transactions WHERE delivery_id = '${d}'),
    'remainders', (SELECT coalesce(jsonb_agg(jsonb_build_array(order_item_id, quantity_remaining, status) ORDER BY order_item_id), '[]') FROM public.delivery_remainders WHERE original_delivery_id = '${d}'),
    'invoice_lines', (SELECT coalesce(jsonb_agg(jsonb_build_array(ii.order_item_id, ii.quantity, ii.extended_cents) ORDER BY ii.order_item_id), '[]') FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id WHERE i.delivery_id = '${d}'),
    'invoices', (SELECT coalesce(jsonb_agg(jsonb_build_array(status, total_amount_cents) ORDER BY total_amount_cents), '[]') FROM public.invoices WHERE delivery_id = '${d}'))::text;`);

function beforeCases() {
  const r = probe(`${completeCall(D.DA, { [R.DA]: 1, [T.DA]: 0.005 }, 'tiny-b1')};
    SELECT quantity_delivered FROM public.delivery_items WHERE id = '${T.DA}';`, ADMIN);
  assert.equal(r.status, 0, r.output);
  assert.equal(Number(r.last), 0.005, `before the fix the tiny line should be delivered as sent:\n${r.output}`);
  console.log('[before] reproduced: 0.005 beside a real line is delivered as 0.005');
}

function applyCandidate() {
  stageText('candidate.sql', lf(CANDIDATE));
  const r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  console.log('[apply] the migration applies (preflight body md5; postflight security, grants and both bodies)');
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.output, /TINY_LINE_PREFLIGHT/);
  console.log('[apply] a second apply is refused by the preflight');
}

function afterCases() {
  // 2. 0.005 beside 1 on the same product: completes; only the real line moves stock (available and prebooked by
  //    exactly 1), its order line, and the ledger; the tiny line is 0 and its full quantity is owed as a remainder.
  let s0 = stock(); const r0 = lineDone(OI), t0 = lineDone(OI2), ro0 = lineOwed(OI), to0 = lineOwed(OI2);
  let r = committed(completeCall(D.DA, { [R.DA]: 1, [T.DA]: 0.005 }, 'tiny-2'));
  assert.equal(r.status, 0, r.output);
  const receipt = r.output.split(/\r?\n/).filter((l) => l.includes('"delivery_id"')).at(-1);
  assert.match(receipt, /"status": ?"partial"/);
  assert.equal(status(D.DA), 'completed');
  assert.equal(delivered(T.DA), 0);
  assert.equal(delivered(R.DA), 1);
  same(stock(), minus(s0, 1), 'stock (available/prebooked) after case 2');
  near(lineDone(OI), r0 + 1, 'real order line after case 2');
  near(lineDone(OI2), t0, 'tiny order line after case 2');
  near(lineOwed(OI), ro0 - 1, 'real order line still owed after case 2');
  near(lineOwed(OI2), to0, 'tiny order line still owed after case 2');
  const fpA = footprint(D.DA);
  assert.match(fpA, /"ledger": \[\["delivered", 1(\.0+)?, false\]\]/, fpA);
  assert.match(fpA, new RegExp(`"remainders": \\[\\["${OI2}", 1(\\.0+)?, "pending"\\]\\]`), fpA);
  console.log(`[case 2] 0.005 beside 1: completes (receipt partial); stock ${s0} -> ${stock()}; footprint ${fpA}`);

  // 2z. The typed-0 twin leaves exactly the same footprint.
  s0 = stock(); const zr0 = lineOwed(OI), zt0 = lineOwed(OI2);
  r = committed(completeCall(D.DZ, { [R.DZ]: 1, [T.DZ]: 0 }, 'tiny-2z'));
  assert.equal(r.status, 0, r.output);
  near(lineOwed(OI), zr0 - 1, 'real order line still owed after case 2z');
  near(lineOwed(OI2), zt0, 'zero order line still owed after case 2z');
  assert.equal(footprint(D.DZ), fpA, 'a tiny figure must leave the same footprint as a typed 0');
  same(stock(), minus(s0, 1), 'stock after case 2z');
  console.log('[case 2z] the same load with 0 typed leaves an identical footprint (lines, ledger, remainder, invoice lines and totals)');

  // 7. A retry with the same key and figures returns the same saved receipt and moves nothing.
  s0 = stock();
  r = committed(completeCall(D.DA, { [R.DA]: 1, [T.DA]: 0.005 }, 'tiny-2'));
  assert.equal(r.status, 0, r.output);
  assert.equal(r.output.split(/\r?\n/).filter((l) => l.includes('"delivery_id"')).at(-1), receipt);
  same(stock(), s0, 'stock after the retry');
  assert.equal(footprint(D.DA), fpA);
  console.log('[case 7] a retry returns the same saved receipt; nothing moves again');

  // 3. No figures sent, the second line scheduled at 0.005: it is delivered 0, the real line 1.
  // 3b. 1 sent for a line scheduled at 0.005: capped to 0.005 first, so it is zeroed too.
  for (const [k, q, key] of [['DB', null, 'tiny-3'], ['DF', { [R.DF]: 1, [T.DF]: 1 }, 'tiny-3b']]) {
    s0 = stock();
    r = committed(completeCall(D[k], q, key));
    assert.equal(r.status, 0, r.output);
    assert.equal(status(D[k]), 'completed');
    assert.equal(delivered(T[k]), 0);
    assert.equal(delivered(R[k]), 1);
    same(stock(), minus(s0, 1), `stock after ${key}`);
  }
  console.log('[case 3] no figures sent, a line scheduled at 0.005: delivered 0, the real line 1');
  console.log('[case 3b] 1 sent for a line scheduled at 0.005 (capped to 0.005): delivered 0');

  // 4. Exactly 0.01 is a delivery: not zeroed.
  const t4 = lineDone(OI2);
  r = committed(completeCall(D.DC, { [R.DC]: 1, [T.DC]: 0.01 }, 'tiny-4'));
  assert.equal(r.status, 0, r.output);
  assert.equal(delivered(T.DC), 0.01);
  near(lineDone(OI2), t4 + 0.01, 'order line after case 4');
  console.log('[case 4] exactly 0.01 beside 1: delivered 0.01');

  // 4b. A malformed figure is still refused by #2324's check, untouched; a negative figure is clamped to 0, as before.
  r = committed(completeCall(D.DN, { [R.DN]: 1, [T.DN]: '0.005' }, 'tiny-4b'));
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /DELIVERY_QUANTITIES_INVALID/);
  assert.equal(status(D.DN), 'in_progress');
  r = committed(completeCall(D.DN, { [R.DN]: 1, [T.DN]: -5 }, 'tiny-4c'));
  assert.equal(r.status, 0, r.output);
  assert.equal(delivered(T.DN), 0);
  console.log('[case 4b] a text figure is still refused DELIVERY_QUANTITIES_INVALID; a negative figure beside 1 delivers 0, as before');

  // 5. Every line under 0.01: still refused by #2324's rule; nothing kept.
  s0 = stock();
  r = committed(completeCall(D.DD, { [R.DD]: 0.005, [T.DD]: 0.009 }, 'tiny-5'));
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /DELIVERY_NOTHING_DELIVERED/);
  assert.equal(status(D.DD), 'in_progress');
  same(stock(), s0, 'stock after case 5');
  console.log('[case 5] every line under 0.01: still refused DELIVERY_NOTHING_DELIVERED; nothing kept');

  // 6. Start-and-complete on a scheduled load: same as case 2.
  s0 = stock();
  r = committed(startComplete(D.DE, { [R.DE]: 1, [T.DE]: 0.005 }, 'tiny-6'));
  assert.equal(r.status, 0, r.output);
  assert.equal(status(D.DE), 'completed');
  assert.equal(delivered(T.DE), 0);
  same(stock(), minus(s0, 1), 'stock after case 6');
  console.log('[case 6] start-and-complete with 0.005 beside 1: tiny line delivered 0');

  // 8. Neither function is callable by a client role.
  for (const fn of ['_complete_delivery_authorized_impl_20270122', '_complete_delivery_body_impl_20270307']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public.${fn}(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)', 'EXECUTE');`), 'f', `${role} ${fn}`);
    }
  }
  console.log('[case 8] anon, authenticated and service_role cannot call the wrapper or the renamed body');

  // 9. The tiny line is on another product, P2, which has no Main Warehouse row. The real line moves P only. The
  //    named exception: #2324's step, before the zeroing, still gives P2 an empty flagged 0/0 row; no P2 stock moves.
  s0 = stock();
  r = committed(completeCall(D.DX, { [R.DX]: 1, [T.DX]: 0.005 }, 'tiny-9'));
  assert.equal(r.status, 0, r.output);
  assert.equal(status(D.DX), 'completed');
  assert.equal(delivered(T.DX), 0);
  assert.equal(delivered(R.DX), 1);
  same(stock(), minus(s0, 1), 'P stock after case 9');
  near(lineOwed(OI4), 30, 'P2 order line still owed after case 9');
  assert.equal(scalar(`SELECT count(*) || ':' || string_agg(quantity_available || '/' || quantity_prebooked || '/' || manufactured_at_delivery, ',')
    FROM public.inventory WHERE product_id = '${P2}' AND location = 'Main Warehouse';`), '1:0/0/true', 'the named exception row');
  assert.equal(scalar(`SELECT count(*) FROM public.inventory_transactions WHERE delivery_id = '${D.DX}' AND product_id = '${P2}';`), '0');
  console.log('[case 9] tiny line on an unstocked product beside 1 of another: delivered 0, no P2 movement; the named 0/0 row is created (accepted exception)');

  // 10. The tiny line is its order line's last leftover (Taha's review MED 1). Behaviour as built: zeroed, the 0.005
  //     stays owed as a pending remainder and the order stays partially fulfilled until the office closes it.
  r = committed(completeCall(D.DL, null, 'tiny-10'));
  assert.equal(r.status, 0, r.output);
  assert.equal(delivered(T.DL), 0);
  near(lineOwed(OI5), 0, 'real order line after case 10');
  near(lineOwed(OI6), 0.005, 'tiny leftover still owed after case 10');
  assert.match(scalar(`SELECT count(*) || ':' || max(quantity_remaining) FROM public.delivery_remainders WHERE original_delivery_id = '${D.DL}' AND status = 'pending';`), /^1:0\.0050*$/);
  assert.equal(orderStatus(ORD3), 'partially_fulfilled');
  console.log('[case 10] a 0.005 last leftover beside 1: delivered 0, still owed as a pending remainder; the order stays partially_fulfilled');
}

function rollbackCases() {
  stageText('reverse.sql', lf(REVERSE));
  const r = apply('reverse.sql');
  assert.equal(r.status, 0, r.output);
  assert.equal(scalar("SELECT to_regprocedure('public._complete_delivery_body_impl_20270307(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)') IS NULL;"), 't');
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'::regprocedure;`), 'bbe9c44f7ade7d12f86bfe1c039d16ac');
  const back = probe(`${completeCall(D.DR, { [R.DR]: 1, [T.DR]: 0.005 }, 'tiny-r1')};
    SELECT quantity_delivered FROM public.delivery_items WHERE id = '${T.DR}';`, ADMIN);
  assert.equal(back.status, 0, back.output);
  assert.equal(Number(back.last), 0.005, back.output);
  const twice = apply('reverse.sql');
  assert.notEqual(twice.status, 0);
  assert.match(twice.output, /TINY_LINE_REVERSE/);
  console.log('[rollback] the reverse script restores the old body under its old name (0.005 is delivered as sent again); a second run is refused');
}

function main() {
  buildContainer();
  seed();
  beforeCases();
  applyCandidate();
  afterCases();
  rollbackCases();
  console.log('TINY_LINE_COUNTS_AS_ZERO_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
