#!/usr/bin/env node
/**
 * Real-schema proof for 20270228260000_f05b_delivery_line_checks.sql (F05b #2274; contract
 * docs/plans/2026-11-22-f05b-delivery-line-checks-CONTRACT.md).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (harness from the F05 prover), shows the gap before
 * the candidate, applies it, then checks every proof case through the real RPCs as the signed-in admin. Refusals that
 * matter to the office are run as real committed calls and read back from a new connection.
 *
 * Run: node scripts/smoke/prove-f05b-delivery-line-checks-real-schema.mjs   (needs Docker)
 * Prints F05B_DELIVERY_LINE_CHECKS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a disposable container this run creates (no reuse of another container or database: Sol r1).
const NAME = `crx-f05b-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270228260000_f05b_delivery_line_checks.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'f05b-delivery-line-checks-reverse.sql');
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
const TOUCHED = /(_complete_delivery_authorized_impl\w*)/i;
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



const id = (s) => `af05b000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), CUST = id('c1'), P = id('b1'), INV = id('d1'), ORD = id('e1'), OI = id('e11'), OI2 = id('e12');
// D1 all-zero target; D2 mixed (two lines); D3 scheduled, for start-and-complete; D4 in progress with no lines;
// DL legacy completed with no lines (the March 2026 shape); D5 offline target; D6 completes, then replays its key;
// D7 scheduled, for the line-delete race; D8 completes while the migration is being applied.
const D1 = id('f1'), D1A = id('f11'), D2 = id('f2'), D2A = id('f21'), D2B = id('f22'), D3 = id('f3'), D3A = id('f31');
const D4 = id('f4'), DL = id('f9'), D5 = id('f5'), D5A = id('f51'), D6 = id('f6'), D6A = id('f61'), D7 = id('f7'), D7A = id('f71');
const D8 = id('f8'), D8A = id('f81');
const OFF = id('ab1'), OFF_KEY = 'f05b-offline-1';

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'f05b-admin@example.invalid', '{"full_name":"[PROVER] F05b Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] F05b Farm', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ('${P}', '[PROVER] F05b Product', 'F05B-P', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 8, 10, 10, 10, 1, true);
    INSERT INTO public.inventory (id, product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order) VALUES
      ('${INV}', '${P}', 'Main Warehouse', 'Gal', 50, 7, 0);
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES ('${ORD}', 'F05B-O1', '${CUST}', 'confirmed');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit, cost_per_unit) VALUES
      ('${OI}', '${ORD}', '${P}', '[PROVER] F05b Product', 'Gal', 10, 0, 10, 10, 8),
      ('${OI2}', '${ORD}', '${P}', '[PROVER] F05b Product', 'Gal', 5, 0, 5, 10, 8);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, assigned_driver, status, is_quick_delivery) VALUES
      ('${D1}', 'F05B-D1', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', 'in_progress', false),
      ('${D2}', 'F05B-D2', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', 'in_progress', false),
      ('${D3}', 'F05B-D3', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', 'scheduled', false),
      ('${D4}', 'F05B-D4', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', 'in_progress', false),
      ('${D5}', 'F05B-D5', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', 'in_progress', false),
      ('${D6}', 'F05B-D6', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', 'in_progress', false),
      ('${D7}', 'F05B-D7', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', 'scheduled', false),
      ('${D8}', 'F05B-D8', '${ORD}', '${CUST}', '${ADMIN}', '${ADMIN}', 'in_progress', false);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, is_quick_delivery, completed_at, signed_by) VALUES
      ('${DL}', 'F05B-DL', '${ORD}', '${CUST}', '${ADMIN}', 'completed', false, '2026-03-20', 'Legacy');
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size) VALUES
      ('${D1A}', '${D1}', '${OI}', '${P}', 2, 'Gal'),
      ('${D2A}', '${D2}', '${OI2}', '${P}', 1, 'Gal'), ('${D2B}', '${D2}', '${OI}', '${P}', 1, 'Gal'),
      ('${D3A}', '${D3}', '${OI}', '${P}', 1, 'Gal'),
      ('${D5A}', '${D5}', '${OI}', '${P}', 1, 'Gal'),
      ('${D6A}', '${D6}', '${OI}', '${P}', 1, 'Gal'),
      ('${D7A}', '${D7}', '${OI}', '${P}', 1, 'Gal'),
      ('${D8A}', '${D8}', '${OI}', '${P}', 1, 'Gal');`);
  console.log('[prover] seeded one order (10 and 5 units) with eight open loads and one line-less legacy completed load');
}

const AS_ADMIN = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true); SET LOCAL ROLE authenticated;`;
const completeCall = (d, quantities, key) => `SELECT public.complete_delivery(p_delivery_id => '${d}', p_signed_by => 'No proof — recorded by office',
    p_performed_by => '${ADMIN}', p_quantities => ${quantities === null ? 'NULL' : J(quantities)}, p_idempotency_key => '${key}',
    p_evidence => 'no_proof', p_evidence_ref => '[PROVER] F05b')`;
const startComplete = (d, quantities, key) => `SELECT public.start_and_complete_delivery(p_delivery_id => '${d}', p_signed_by => 'No proof — recorded by office',
    p_delivered_on => (now() AT TIME ZONE 'America/Chicago')::date, p_performed_by => '${ADMIN}', p_quantities => ${quantities === null ? 'NULL' : J(quantities)},
    p_idempotency_key => '${key}', p_evidence => 'no_proof', p_evidence_ref => '[PROVER] F05b')`;
// A real call as the signed-in admin that COMMITS when it succeeds; a refusal aborts it. State is read back from a
// new connection afterwards, so a refusal is shown to keep nothing (not only a rolled-back probe).
function committed(sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${AS_ADMIN}\n${sql};\nCOMMIT;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
// status | delivered per line (in line-id order) | remainders made from this load
const state = (d) => scalar(`SELECT d.status || '|' || coalesce((SELECT string_agg(coalesce(di.quantity_delivered::text, 'null'), ',' ORDER BY di.id)
    FROM public.delivery_items di WHERE di.delivery_id = d.id), '') || '|' ||
    (SELECT count(*) FROM public.delivery_remainders r WHERE r.original_delivery_id = d.id) FROM public.deliveries d WHERE d.id = '${d}';`);
const stock = () => scalar(`SELECT quantity_available || '/' || quantity_prebooked FROM public.inventory WHERE id = '${INV}';`);
const orderLine = () => scalar(`SELECT quantity_delivered || '/' || quantity_remaining FROM public.order_items WHERE id = '${OI}';`);

function beforeCases() {
  // The gap, before the candidate: an all-zero completion goes through (rolled back).
  const r = probe(`${completeCall(D1, { [D1A]: 0 }, 'f05b-b1')};
    SELECT status FROM public.deliveries WHERE id = '${D1}';`, ADMIN);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.last, 'completed', `before the fix an all-zero completion should go through:\n${r.output}`);
  console.log('[before] reproduced: an all-zero completion completes the load');
}

async function applyCandidate() {
  stageText('candidate.sql', lf(CANDIDATE));
  // Apply it while a live completion is half done (Sol r1 HIGH): the completion has read D8's lines and not yet
  // written them when the migration starts. Both must finish (no deadlock, nothing lost). The migration takes no
  // table lock, so it need not wait for the completion.
  const mark = (name) => `SELECT '${name}=' || extract(epoch FROM clock_timestamp());`;
  const completer = session(`BEGIN;\nSELECT count(*) FROM public.delivery_items WHERE delivery_id = '${D8}';\n${mark('read')}\n`
    + `SELECT pg_sleep(3);\n${AS_ADMIN}\n${completeCall(D8, null, 'f05b-apply-load')};\nCOMMIT;\n${mark('committed')}\n`);
  const applier = session(`${mark('applying')}\nBEGIN;\n\\i /tmp/candidate.sql\nCOMMIT;\n${mark('applied')}\n`, 1000);
  const [c, a] = await Promise.all([completer, applier]);
  assert.equal(c.code, 0, `the completion must not be lost to the apply:\n${c.out}`);
  assert.equal(a.code, 0, `the apply must not fail beside a live completion:\n${a.out}`);
  const at = (out, name) => Number(out.match(new RegExp(`${name}=([0-9.]+)`))?.[1]);
  const [read, applying, committedAt, applied] = [at(c.out, 'read'), at(a.out, 'applying'), at(c.out, 'committed'), at(a.out, 'applied')];
  // The migration must finish while the completion is still open: it may not wait for it (Sol r5 MED).
  assert.ok(read < applying && applying < applied && applied < committedAt,
    `the apply did not overlap the completion: read ${read}, applying ${applying}, committed ${committedAt}, applied ${applied}`);
  assert.equal(state(D8), 'completed|1|0');
  console.log('[apply] the migration applies (pre- and postflight pass) beside a half-done completion: no deadlock, nothing lost');
}

function afterCases() {
  // 1. All-zero completion: refused with the named code, as a real committed call; nothing kept.
  const stock0 = stock(), line0 = orderLine();
  let r = committed(completeCall(D1, { [D1A]: 0 }, 'f05b-1'));
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /DELIVERY_NOTHING_DELIVERED: every product on it has a delivered quantity of zero\. If nothing was delivered, call the office\./);
  assert.equal(state(D1), 'in_progress|0|0');
  assert.equal(stock(), stock0);
  assert.equal(orderLine(), line0);
  assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'f05b-1';`), '0');
  // A negative figure is clamped to 0, so it counts as nothing delivered too.
  r = committed(completeCall(D1, { [D1A]: -5 }, 'f05b-1n'));
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /DELIVERY_NOTHING_DELIVERED/);
  assert.equal(state(D1), 'in_progress|0|0');
  console.log(`[case 1] all-zero (and negative) figures: refused DELIVERY_NOTHING_DELIVERED; load still in progress, no line delivered, no remainder; stock ${stock0} and order line ${line0} unchanged; no key saved`);

  // 2. One line 0, the other 1: completes as a partial delivery, and the order line moves by 1.
  r = committed(completeCall(D2, { [D2A]: 0, [D2B]: 1 }, 'f05b-2'));
  assert.equal(r.status, 0, r.output);
  const [s2, q2] = state(D2).split('|');
  assert.equal(s2, 'completed');
  assert.deepEqual(q2.split(',').sort(), ['0', '1']);
  assert.equal(orderLine().split('/')[0], String(Number(line0.split('/')[0]) + 1));
  console.log(`[case 2] mixed 0 and 1: completes; one line delivered; order line now ${orderLine()}`);

  // 3. Start-and-complete on a scheduled load: all zero is refused and the load stays scheduled; no figures sent
  //    (the full scheduled amounts) completes.
  r = committed(startComplete(D3, { [D3A]: 0 }, 'f05b-3a'));
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /DELIVERY_NOTHING_DELIVERED/);
  assert.equal(state(D3), 'scheduled|0|0');
  r = committed(startComplete(D3, null, 'f05b-3b'));
  assert.equal(r.status, 0, r.output);
  assert.equal(state(D3), 'completed|1|0');
  console.log('[case 3] start-and-complete: all zero refused (load stays scheduled); full quantities complete');

  // 4. A delivery with no lines cannot be completed.
  r = committed(completeCall(D4, null, 'f05b-4'));
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /DELIVERY_NOTHING_DELIVERED/);
  assert.equal(state(D4), 'in_progress||0');
  console.log('[case 4] a delivery with no lines: refused');

  // 5. The legacy line-less completed load is untouched and still editable.
  r = committed(`UPDATE public.deliveries SET delivery_notes = '[PROVER] note' WHERE id = '${DL}'`);
  assert.equal(r.status, 0, r.output);
  assert.equal(scalar(`SELECT status || '|' || delivery_notes FROM public.deliveries WHERE id = '${DL}';`), 'completed|[PROVER] note');
  console.log('[case 5] legacy completed load with no lines: left as is; editing its notes still works');

  // 6. A retry of a saved completion (same key, same figures) returns its saved receipt; the load is now completed,
  //    so the new check does not run again. (A different payload under the same key was, and stays, refused
  //    IDEMPOTENCY_INTENT_MISMATCH.)
  const receiptLine = (out) => out.split(/\r?\n/).filter((l) => l.includes('"delivery_id"')).at(-1);
  r = committed(completeCall(D6, { [D6A]: 1 }, 'f05b-6'));
  assert.equal(r.status, 0, r.output);
  const first = receiptLine(r.output);
  r = committed(completeCall(D6, { [D6A]: 1 }, 'f05b-6'));
  assert.equal(r.status, 0, `a retry of a saved completion must return its receipt, not be refused:\n${r.output}`);
  assert.ok(first);
  assert.equal(receiptLine(r.output), first, 'the retry must return the same saved receipt');
  assert.equal(state(D6), 'completed|1|0');
  console.log('[case 6] a retry of a saved completion returns the same saved receipt (not refused, not re-run)');

  // 7. Offline sync of an all-zero completion still goes to office review, committed, attempt counted. Offline
  //    completions carry no proof, so the proof check refuses them before the new rule is reached (Sol r1 MED): this
  //    shows only that nothing changed for offline sync, not the new rule.
  raw(`INSERT INTO public.offline_action_receipts (client_action_id, actor_id, operation, entity_id, schema_version, client_created_at,
      entity_snapshot_at, request_payload, idempotency_key)
    VALUES ('${OFF}', '${ADMIN}', 'complete_delivery', '${D5}', 1, now(), (SELECT updated_at FROM public.deliveries WHERE id = '${D5}'),
      ${J({ signed_by: 'Prover driver', quantities: { [D5A]: 0 } })}, '${OFF_KEY}');`);
  r = committed(`SELECT public.process_offline_action('${OFF}', '${OFF_KEY}')`);
  assert.equal(r.status, 0, r.output);
  const rec = scalar(`SELECT status || '|' || coalesce(failure_code, '') || '|' || attempt_count FROM public.offline_action_receipts WHERE client_action_id = '${OFF}';`);
  assert.equal(rec, 'needs_review|PAYLOAD_INVALID|1');  // the proof check's own code, exactly as before (Sol r5 LOW)
  assert.equal(state(D5), 'in_progress|0|0');
  console.log(`[case 7] offline sync unchanged: an all-zero completion still goes to office review (${rec}); the load stays in progress`);

  // 8. Grants: the completion step stays callable only through complete_delivery.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(scalar(`SELECT has_function_privilege('${role}', 'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)', 'EXECUTE');`), 'f', role);
  }
  console.log('[case 8] anon, authenticated and service_role cannot call the completion step directly');
}

function rollbackCases() {
  stageText('reverse.sql', lf(REVERSE));
  const r = apply('reverse.sql');
  assert.equal(r.status, 0, r.output);
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'::regprocedure;`), '7efd361c003d860361992711e3b15e92');
  const back = probe(`${completeCall(D1, { [D1A]: 0 }, 'f05b-r1')}; SELECT status FROM public.deliveries WHERE id = '${D1}';`, ADMIN);
  assert.equal(back.status, 0, back.output);
  assert.equal(back.last, 'completed', back.output);
  console.log('[rollback] the reverse script restores the old completion step: an all-zero completion goes through again');
}

// 9. Race (Luna r2 HIGH): a direct line delete that began while the load was scheduled is still open when
//     start-and-complete runs. The check must wait for it and see the load has no lines left, not complete it empty.
//     Today the parent-lock trigger makes the delete lock the delivery row, so the completion waits there; the new
//     line lock is a second guard this case does not separately exercise (Sol r1 LOW).
async function raceCase() {
  // Each side prints clock_timestamp() marks, so the proof shows the two really overlapped: the delete was made,
  // then the completion began, and only then did the delete commit.
  const mark = (name) => `SELECT '${name}=' || extract(epoch FROM clock_timestamp());`;
  const deleter = session(`BEGIN; DELETE FROM public.delivery_items WHERE id = '${D7A}'; ${mark('deleted')} SELECT pg_sleep(8); ${mark('committing')} COMMIT;`);
  const completer = session(`${mark('started')}\nBEGIN;\n${AS_ADMIN}\n${startComplete(D7, null, 'f05b-10')};\nCOMMIT;\n`, 4000);
  const [d, c] = await Promise.all([deleter, completer]);
  assert.equal(d.code, 0, d.out);
  const at = (out, name) => Number(out.match(new RegExp(`${name}=([0-9.]+)`))?.[1]);
  const [deleted, committing, started] = [at(d.out, 'deleted'), at(d.out, 'committing'), at(c.out, 'started')];
  assert.ok(deleted < started && started < committing, `the race did not overlap: deleted ${deleted}, started ${started}, committing ${committing}`);
  assert.notEqual(c.code, 0, `start-and-complete must be refused once the in-flight delete lands:\n${c.out}`);
  assert.match(c.out, /DELIVERY_NOTHING_DELIVERED/);
  assert.equal(state(D7), 'scheduled||0');
  console.log('[case 9] race: a line delete in flight when start-and-complete runs is waited for; the now-empty load is refused and stays scheduled');
}

async function main() {
  buildContainer();
  seed();
  beforeCases();
  await applyCandidate();
  afterCases();
  await raceCase();
  rollbackCases();
  console.log('F05B_DELIVERY_LINE_CHECKS_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
