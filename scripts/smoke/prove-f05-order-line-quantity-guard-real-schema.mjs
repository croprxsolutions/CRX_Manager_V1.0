#!/usr/bin/env node
/**
 * Real-schema proof for 20270224100000_f05_order_line_quantity_guard.sql (F05; contract
 * docs/plans/2026-11-22-f05-delivery-remaining-qty-CONTRACT.md).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (harness from prove-inventory-edge-cases-1942-real-schema.mjs),
 * shows the bug before the candidate, applies it, then checks every proof case through the real RPCs as the signed-in
 * admin (rolled back), plus a real two-session race.
 *
 * Run: node scripts/smoke/prove-f05-order-line-quantity-guard-real-schema.mjs   (needs Docker)
 * Prints F05_QUANTITY_GUARD_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a disposable container this run creates (no reuse of another container or database: Sol r1).
const NAME = `crx-f05-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270224100000_f05_order_line_quantity_guard.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'f05-order-line-quantity-guard-reverse.sql');
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
const TOUCHED = /(_delivery_line_within_order|_delivery_reopen_within_order|_order_line_within_deliveries|_order_line_committed|_order_line_open_loads|_assert_order_line_fits)/i;
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
const n = (sql) => Number(scalar(sql));
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
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

// A real concurrent session (its own connection), started after delayMs. Resolves with its exit code and output.
function session(sql, delayMs = 0) {
  return new Promise((resolve) => setTimeout(() => {
    const c = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
    c.stdin.end(sql);
  }, delayMs));
}



const id = (s) => `af050000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), CUST = id('c1'), P = id('b1'), INV = id('d1');
// O17: ORD-2026-0017 replay (2 ordered). O14: ORD-2026-0014 replay (10 ordered). OL: legacy double schedule (1 ordered, two open loads of 1).
const O17 = id('e17'), L17 = id('e171'), O14 = id('e14'), L14 = id('e141'), OL = id('e99'), LL = id('e991');
const DLA = id('f1'), DLB = id('f2'), DLA1 = id('f11'), DLB1 = id('f21');

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'f05-admin@example.invalid', '{"full_name":"[PROVER] F05 Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] F05 Farm', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ('${P}', '[PROVER] F05 Product', 'F05-P', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 8, 10, 10, 10, 1, true);
    INSERT INTO public.inventory (id, product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order) VALUES
      ('${INV}', '${P}', 'Main Warehouse', 'Gal', 50, 13, 0);
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES
      ('${O17}', 'F05-O17', '${CUST}', 'confirmed'), ('${O14}', 'F05-O14', '${CUST}', 'confirmed'), ('${OL}', 'F05-OL', '${CUST}', 'confirmed');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit, cost_per_unit) VALUES
      ('${L17}', '${O17}', '${P}', '[PROVER] F05 Product', 'Gal', 2, 0, 2, 10, 8),
      ('${L14}', '${O14}', '${P}', '[PROVER] F05 Product', 'Gal', 10, 0, 10, 10, 8),
      ('${LL}', '${OL}', '${P}', '[PROVER] F05 Product', 'Gal', 1, 0, 1, 10, 8);
    -- Legacy: two open loads for the one ordered unit, written with triggers off (as the old code allowed).
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, is_quick_delivery) VALUES
      ('${DLA}', 'F05-DLA', '${OL}', '${CUST}', '${ADMIN}', 'in_progress', false),
      ('${DLB}', 'F05-DLB', '${OL}', '${CUST}', '${ADMIN}', 'in_progress', false);
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size) VALUES
      ('${DLA1}', '${DLA}', '${LL}', '${P}', 1, 'Gal'), ('${DLB1}', '${DLB}', '${LL}', '${P}', 1, 'Gal');`);
  console.log('[prover] seeded a 2-unit order (ORD-2026-0017 replay), a 10-unit order (ORD-2026-0014 replay) and a legacy 1-unit order with two open loads of 1');
}

// Everything runs as postgres with the admin's identity, through the public RPCs the screens call.
const GSET = '\\gset';
const AS_ADMIN = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);`;
const line = (oi, qty) => `'[{"order_item_id":"${oi}","product_id":"${P}","quantity":${qty},"unit_size":"Gal"}]'::jsonb`;
const schedule = (order, oi, qty, key, v) => `SELECT public.create_delivery_with_items('${order}', '${CUST}', current_date, ${line(oi, qty)}, NULL, NULL, NULL, NULL, '${key}')->>'delivery_id' AS ${v} ${GSET}`;
const followUp = (v, key) => `SELECT public.create_followup_delivery(:'${v}'::uuid, current_date, '${ADMIN}', '${key}');`;
// The completion step behind complete_delivery's role, receipt and evidence checks (evidence marker set as it does).
const complete = (v, qty, key) => `UPDATE public.deliveries SET status = 'in_progress' WHERE id = :'${v}'::uuid AND status = 'scheduled';
  SELECT id AS ${v}_line FROM public.delivery_items WHERE delivery_id = :'${v}'::uuid ${GSET}
  SELECT set_config('crx.delivery_completion_evidence', :'${v}', true);
  SELECT public._complete_delivery_authorized_impl(:'${v}'::uuid, 'Prover', '${ADMIN}', jsonb_build_object(:'${v}_line', ${qty}), NULL, NULL, '${key}');`;
const completeLegacy = (d, di, qty, key) => `SELECT set_config('crx.delivery_completion_evidence', '${d}', true);
  SELECT public._complete_delivery_authorized_impl('${d}', 'Prover', '${ADMIN}', jsonb_build_object('${di}', ${qty}), NULL, NULL, '${key}');`;
const editLine = (v, oi, qty, key) => `SELECT public.edit_delivery(:'${v}'::uuid, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${line(oi, qty)}, '${ADMIN}', '${key}');`;
const cutOrder = (order, oi, qty, key) => `SELECT public.update_order_items('${order}', jsonb_build_array(jsonb_build_object('id', '${oi}', 'product_id', '${P}', 'product_name', '[PROVER] F05 Product', 'unit_size', 'Gal', 'cost_per_unit', 8, 'price_per_unit', 10, 'total_units_needed', ${qty})), '${ADMIN}', '${key}', (SELECT row_version FROM public.orders WHERE id = '${order}'));`;
const delivered = (oi) => `SELECT quantity_delivered FROM public.order_items WHERE id = '${oi}';`;
const openScheduled = (oi) => `SELECT coalesce(sum(di.quantity), 0) FROM public.delivery_items di JOIN public.deliveries d ON d.id = di.delivery_id WHERE di.order_item_id = '${oi}' AND d.status IN ('scheduled', 'in_progress');`;

// Case 1 chain: order 2, schedule 2, deliver 1 (remainder of 1), schedule the last unit on the New Delivery path, then Follow-up.
const ord17Chain = `${AS_ADMIN}
  ${schedule(O17, L17, 2, 'f05-1a', 'd1')}
  ${complete('d1', 1, 'f05-1b')}
  ${schedule(O17, L17, 1, 'f05-1c', 'd2')}
  ${followUp('d1', 'f05-1d')}`;

function beforeCases() {
  // The bug, before the candidate: both loads are accepted and both complete, so 2 ordered ends 3 delivered.
  const out = okProbe(`${ord17Chain}
    SELECT followup_delivery_id AS d3 FROM public.delivery_remainders WHERE original_delivery_id = :'d1'::uuid ${GSET}
    ${complete('d2', 1, 'f05-1e')}
    ${complete('d3', 1, 'f05-1f')}
    ${delivered(L17)}`);
  assert.equal(Number(out), 3, `before the fix the replay should reproduce 3 delivered on a 2-unit line, got ${out}`);
  // And a 10-unit line cuts to 6 with 10 still scheduled.
  okProbe(`${AS_ADMIN}
    ${schedule(O14, L14, 10, 'f05-0a', 'd1')}
    ${cutOrder(O14, L14, 6, 'f05-0b')}`);
  console.log('[before] reproduced: ORD-2026-0017 replay ends 2 ordered / 3 delivered; ORD-2026-0014 replay cuts to 6 with 10 still scheduled');
}

async function afterCases() {
  stageText('candidate.sql', lf(CANDIDATE));
  // Sol r3: a legacy over line whose order has an active return (its extra load cannot be cancelled) blocks the apply.
  psql(`INSERT INTO public.returns (id, return_number, customer_id, order_id, status, requested_by)
    VALUES ('${id('f9')}', 'RET-F05-PROVER', '${CUST}', '${OL}', 'requested', '${ADMIN}');`);
  const stuck = apply('candidate.sql');
  assert.notEqual(stuck.status, 0, 'an over line with a return on its order must block the apply');
  assert.match(stuck.output, new RegExp(`F05_PREFLIGHT: 1 order line\\(s\\) have open loads beyond what was ordered and a return on the order[^\\n]*${LL}`), stuck.output);
  psql(`DELETE FROM public.returns WHERE id = '${id('f9')}';`);
  console.log('[preflight] an over line with an active return on its order blocks the apply and is listed; without the return it applies');
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  // Luna r8: the preflight lists the already-over lines by id (scanned under the table lock), for the F05b cleanup.
  assert.match(first.output, new RegExp(`open loads beyond what was ordered: [^\\n]*${LL}`), first.output);
  assert.match(first.output, /0 order line\(s\) are already delivered beyond what was ordered: none/, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /F05_PREFLIGHT: already applied/, again.output);
  for (const sig of ['public._delivery_line_within_order()', 'public._delivery_reopen_within_order()', 'public._order_line_within_deliveries()', 'public._order_line_committed(uuid,uuid,uuid)', 'public._order_line_open_loads(uuid,uuid,uuid)', 'public._assert_order_line_fits(uuid,numeric,uuid,uuid)']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(scalar(`SELECT has_function_privilege('${role}', '${sig}', 'EXECUTE');`), 'f', `${role} must not execute ${sig}`);
    }
  }

  // 1. The F05 replay: Follow-up for the unit already on the New Delivery load is refused, naming that load.
  refusedProbe(ord17Chain, /DELIVERY_OVER_ORDER: \[PROVER\] F05 Product — only 0 left to schedule \(ordered 2(\.0+)?, delivered 1(\.0+)?, on other open deliveries 1(\.0+)?: DEL-/);
  console.log('[case 1] ORD-2026-0017 replay: Follow-up for the last unit, already on a New Delivery load, is refused (DELIVERY_OVER_ORDER)');

  // 2. Reverse order: Follow-up first stands; New Delivery for the same unit is refused.
  const followFirst = `${AS_ADMIN}
    ${schedule(O17, L17, 2, 'f05-2a', 'd1')}
    ${complete('d1', 1, 'f05-2b')}
    ${followUp('d1', 'f05-2c')}`;
  assert.equal(Number(okProbe(`${followFirst} ${openScheduled(L17)}`)), 1);
  refusedProbe(`${followFirst} ${schedule(O17, L17, 1, 'f05-2d', 'd2')}`, /ITEM_OVER_REMAINING_INCL_ACTIVE|DELIVERY_OVER_ORDER/);
  console.log('[case 2] reverse order: Follow-up first is allowed, then New Delivery for the same unit is refused');

  // 3. Legacy double schedule (two open loads of 1 for 1 ordered): neither completes while the other is open, the whole
  // call rolls back (no stock, line or draft change); once the office cancels the extra load, the other completes.
  refusedProbe(`${AS_ADMIN} ${completeLegacy(DLA, DLA1, 1, 'f05-3a')}`,
    /DELIVERY_EXCEEDS_ORDER: \[PROVER\] F05 Product — this would deliver more than was ordered\. Call the office before completing this delivery\.$/m);
  assert.equal(scalar(`SELECT quantity_available || '/' || quantity_prebooked FROM public.inventory WHERE id = '${INV}';`).replace(/\.0+/g, ''), '50/13');
  assert.equal(scalar(`SELECT quantity_delivered || '/' || (SELECT count(*) FROM public.invoices WHERE order_id = '${OL}') || '/' || (SELECT status FROM public.deliveries WHERE id = '${DLA}') FROM public.order_items WHERE id = '${LL}';`).replace(/\.0+/g, ''), '0/0/in_progress');
  assert.equal(Number(okProbe(`${AS_ADMIN}
    SELECT public.cancel_delivery('${DLB}', 'Prover: legacy duplicate load', '${ADMIN}', 'f05-3b');
    ${completeLegacy(DLA, DLA1, 1, 'f05-3c')}
    ${delivered(LL)}`)), 1);
  console.log('[case 3] legacy double schedule: completing either load is refused (DELIVERY_EXCEEDS_ORDER, without naming the other load) and nothing is kept; after the office cancels the extra load the other completes');

  // The same refusal through the public completion call, signed in (Sol r1: not only the private body as postgres).
  refusedProbe(`SELECT public.complete_delivery(p_delivery_id => '${DLA}', p_signed_by => 'No proof — recorded by office', p_performed_by => '${ADMIN}', p_quantities => jsonb_build_object('${DLA1}', 1), p_idempotency_key => 'f05-3p', p_evidence => 'no_proof', p_evidence_ref => '[PROVER] F05 public path');`,
    /DELIVERY_EXCEEDS_ORDER: \[PROVER\] F05 Product.*Call the office/, ADMIN);
  // No 0-delivered way out is offered: the screens refuse an all-zero completion (Sol r2). A leftover double booking the
  // office cannot cancel is fixed by hand in the F05b cleanup (Mason, 2026-11-22: "drop it").
  console.log('[case 3p] signed in through the public completion call: refused the same way, telling the driver to call the office');

  // 3b. A delivered rise that would use units held by another open load is refused.
  refusedProbe(`${AS_ADMIN}
    ${schedule(O14, L14, 8, 'f05-3d', 'd1')}
    UPDATE public.order_items SET quantity_delivered = 3 WHERE id = '${L14}';`, /DELIVERY_EXCEEDS_ORDER/);
  console.log('[case 3b] raising delivered past what other open loads leave (3 delivered + 8 open > 10) is refused');

  // 3c. Through the admin override restore_cancelled_delivery uses, a cancelled load cannot come back to scheduled once its
  // units went to another load; it can when they are free. (Without the override the status guard already refuses.)
  const cancelled = `${AS_ADMIN}
    ${schedule(O17, L17, 2, 'f05-3e', 'd1')}
    SELECT public.cancel_delivery(:'d1'::uuid, 'Prover', '${ADMIN}', 'f05-3f');`;
  refusedProbe(`${cancelled}
    ${schedule(O17, L17, 2, 'f05-3g', 'd2')}
    SET LOCAL app.admin_override = 'true';
    UPDATE public.deliveries SET status = 'scheduled' WHERE id = :'d1'::uuid;`, /DELIVERY_OVER_ORDER/);
  assert.equal(okProbe(`${cancelled}
    SET LOCAL app.admin_override = 'true';
    UPDATE public.deliveries SET status = 'scheduled' WHERE id = :'d1'::uuid;
    SELECT status FROM public.deliveries WHERE id = :'d1'::uuid;`), 'scheduled');
  console.log('[case 3c] reopening a cancelled load is refused when its units are already on another load, allowed when they are free');

  // 3d. An order line written already over (delivered > ordered) is refused.
  refusedProbe(`INSERT INTO public.order_items (order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit, cost_per_unit)
    VALUES ('${O17}', '${P}', '[PROVER] F05 Product', 'Gal', 2, 3, 0, 10, 8);`, /DELIVERY_EXCEEDS_ORDER/);
  // Luna r12: NaN would sort above every number and switch the check off.
  refusedProbe(`INSERT INTO public.order_items (order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit, cost_per_unit)
    VALUES ('${O17}', '${P}', '[PROVER] F05 Product', 'Gal', 'NaN', 0, 0, 10, 8);`, /ORDER_LINE_QUANTITY_NOT_FINITE/);
  refusedProbe(`UPDATE public.order_items SET total_units_needed = 'NaN' WHERE id = '${L17}';`, /ORDER_LINE_QUANTITY_NOT_FINITE/);
  refusedProbe(`UPDATE public.order_items SET total_units_needed = 'Infinity' WHERE id = '${L17}';`, /ORDER_LINE_QUANTITY_NOT_FINITE/);
  console.log('[case 3d] an order line written already over its order, or with a NaN or infinite quantity, is refused');

  // 3i (Luna r5, Sol r1). The check reads after the lock, which needs READ COMMITTED; a stricter level is refused.
  refusedProbe(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
    ${AS_ADMIN}
    ${schedule(O14, L14, 1, 'f05-3i', 'd1')}`, /ORDER_LINE_CHECK_ISOLATION/);
  refusedProbe(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
    UPDATE public.order_items SET total_units_needed = 9 WHERE id = '${L14}';`, /ORDER_LINE_CHECK_ISOLATION/);
  console.log('[case 3i] a repeatable-read transaction cannot schedule or cut an order line (the check needs a fresh read after the lock)');

  // 3e (Sol r1 #2). A soft-deleted open load holds nothing: the line can be cut past it (as Cancel Remaining does), and
  // un-deleting it is refused once its units are taken.
  const deletedLoad = `${AS_ADMIN}
    ${schedule(O14, L14, 10, 'f05-3e', 'd1')}
    UPDATE public.deliveries SET deleted_at = now() WHERE id = :'d1'::uuid;`;
  assert.equal(okProbe(`${deletedLoad}
    UPDATE public.order_items SET total_units_needed = 4 WHERE id = '${L14}';
    SELECT total_units_needed FROM public.order_items WHERE id = '${L14}';`).replace(/\.0+$/, ''), '4');
  refusedProbe(`${deletedLoad}
    UPDATE public.order_items SET total_units_needed = 4 WHERE id = '${L14}';
    UPDATE public.deliveries SET deleted_at = NULL WHERE id = :'d1'::uuid;`, /DELIVERY_OVER_ORDER: \[PROVER\] F05 Product — only 4(\.0+)? left/);
  console.log('[case 3e] a soft-deleted open load holds nothing (the line can be cut past it); un-deleting it is checked like a reopen');

  // 4. ORD-2026-0014 replay: cut 10 -> 6 with 10 scheduled is refused; after editing the load to 6, the cut goes through.
  refusedProbe(`${AS_ADMIN}
    ${schedule(O14, L14, 10, 'f05-4a', 'd1')}
    ${cutOrder(O14, L14, 6, 'f05-4b')}`, /ORDER_LINE_BELOW_DELIVERIES: \[PROVER\] F05 Product cannot go below 10(\.0+)? \(delivered 0(\.0+)?, on open deliveries 10(\.0+)?: DEL-/);
  const four = okProbe(`${AS_ADMIN}
    ${schedule(O14, L14, 10, 'f05-4a', 'd1')}
    ${editLine('d1', L14, 6, 'f05-4c')}
    ${cutOrder(O14, L14, 6, 'f05-4d')}
    SELECT total_units_needed FROM public.order_items WHERE id = '${L14}';`);
  assert.equal(Number(four), 6);
  console.log('[case 4] ORD-2026-0014 replay: cutting 10 to 6 with 10 scheduled is refused; after the load is edited to 6 the cut succeeds');

  // 5 + 6. Partial delivery (6 of 10) is allowed and its Follow-up for 4 is allowed; cutting below the 6 delivered is refused.
  const six = okProbe(`${AS_ADMIN}
    ${schedule(O14, L14, 10, 'f05-6a', 'd1')}
    ${complete('d1', 6, 'f05-6b')}
    ${followUp('d1', 'f05-6c')}
    SELECT quantity_delivered FROM public.order_items WHERE id = '${L14}';
    ${openScheduled(L14)}`);
  assert.equal(Number(six), 4);
  refusedProbe(`${AS_ADMIN}
    ${schedule(O14, L14, 10, 'f05-5a', 'd1')}
    ${complete('d1', 6, 'f05-5b')}
    UPDATE public.order_items SET total_units_needed = 5 WHERE id = '${L14}';`, /ORDER_LINE_BELOW_DELIVERIES: \[PROVER\] F05 Product cannot go below 6(\.0+)? .*That much has already been delivered\./);
  console.log('[case 5/6] partial 6 of 10 completes and its Follow-up for 4 is allowed; cutting the line below the 6 delivered is refused (written directly: the order edit RPC already refuses partly delivered orders)');

  // 7. edit_delivery: raising a load past the line is refused; lowering it is allowed.
  const twoLoads = `${AS_ADMIN}
    ${schedule(O14, L14, 4, 'f05-7a', 'd1')}
    ${schedule(O14, L14, 6, 'f05-7b', 'd2')}`;
  refusedProbe(`${twoLoads}
    ${editLine('d1', L14, 5, 'f05-7c')}`, /Cannot schedule 5 units .* only 4 available/);
  refusedProbe(`${twoLoads}
    UPDATE public.delivery_items SET quantity = 5 WHERE delivery_id = :'d1'::uuid;`, /DELIVERY_OVER_ORDER: \[PROVER\] F05 Product — only 4 left to schedule/);
  assert.equal(Number(okProbe(`${twoLoads}
    ${editLine('d1', L14, 3, 'f05-7d')}
    ${openScheduled(L14)}`)), 9);
  console.log('[case 7] edit_delivery: raising a load past what the line has left is refused; lowering it is allowed');

  // 9a. A refused Follow-up saves no idempotency result, so a retry with the same key re-checks.
  refusedProbe(ord17Chain, /DELIVERY_OVER_ORDER/);
  assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'f05-1d';`), '0');
  console.log('[case 9a] a refused Follow-up saves no result under its key, so a retry re-checks');


  await race();
}

// 9b. Two staff at once on the last unit: New Delivery in one session, Follow-up in another. Exactly one wins.
async function race() {
  psql(`BEGIN; ${AS_ADMIN}
    ${schedule(O17, L17, 2, 'f05-ra', 'd1')}
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = :'d1'::uuid;
    SELECT id AS d1_line FROM public.delivery_items WHERE delivery_id = :'d1'::uuid ${GSET}
    SET LOCAL ROLE authenticated;
    SELECT public.complete_delivery(p_delivery_id => :'d1'::uuid, p_signed_by => 'No proof — recorded by office', p_performed_by => '${ADMIN}', p_quantities => jsonb_build_object(:'d1_line', 1), p_idempotency_key => 'f05-rb', p_evidence => 'no_proof', p_evidence_ref => '[PROVER] F05 race setup');
    COMMIT;`);
  const d1 = scalar(`SELECT id FROM public.deliveries WHERE order_id = '${O17}' AND status = 'completed';`);
  const a = session(`BEGIN; ${AS_ADMIN} SET LOCAL ROLE authenticated;
    ${schedule(O17, L17, 1, 'f05-rc', 'd2')}
    SELECT pg_sleep(3); COMMIT;`);
  const b = session(`BEGIN; ${AS_ADMIN} SET LOCAL ROLE authenticated; SELECT public.create_followup_delivery('${d1}', current_date, '${ADMIN}', 'f05-rd'); COMMIT;`, 1000);
  // Sol r2: prove the Follow-up is really waiting on a lock while New Delivery is still open (not just arriving late).
  const w = session(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%create_followup_delivery%' AND pid <> pg_backend_pid();`, 2200);
  const [ra, rb, rw] = await Promise.all([a, b, w]);
  assert.equal(rw.code, 0, rw.out);
  assert.equal(rw.out.trim().split(/\r?\n/).filter(Boolean).at(-1), '1', `the Follow-up must be waiting on a lock mid-race:\n${rw.out}`);
  assert.equal(ra.code, 0, ra.out);
  assert.notEqual(rb.code, 0, `the second scheduler must be refused:\n${rb.out}`);
  assert.match(rb.out, /DELIVERY_OVER_ORDER/);
  assert.equal(Number(scalar(openScheduled(L17))), 1);
  console.log('[case 9b] two signed-in sessions at once, as the authenticated role (New Delivery commits first, Follow-up waits for it — on the delivery-number or order-line lock — then re-checks): the Follow-up is refused; exactly one load holds the last unit');
}

function rollbackCases() {
  stageText('reverse.sql', lf(REVERSE));
  const r = apply('reverse.sql');
  assert.equal(r.status, 0, r.output);
  assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgname IN ('zz_delivery_line_within_order', 'zz_order_line_within_deliveries');`), '0');
  assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgname = 'zz_delivery_reopen_within_order';`), '0');
  assert.equal(Number(okProbe(`${AS_ADMIN} ${completeLegacy(DLA, DLA1, 1, 'f05-ra1')} ${completeLegacy(DLB, DLB1, 1, 'f05-ra2')} ${delivered(LL)}`)), 2);
  console.log('[case R] rollback removes the three triggers and the old behaviour returns (both legacy loads complete: 2 delivered on 1 ordered)');
}

async function main() {
  buildContainer();
  seed();
  beforeCases();
  await afterCases();
  rollbackCases();
  console.log('F05_QUANTITY_GUARD_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
