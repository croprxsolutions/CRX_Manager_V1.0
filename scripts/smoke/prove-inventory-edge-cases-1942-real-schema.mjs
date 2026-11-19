#!/usr/bin/env node
/**
 * Real-schema proof for 20270129150000_inventory_edge_cases_1942.sql (#1942, follow-ups of #1940; contract
 * docs/plans/2026-11-19-inventory-edge-cases-1942-CONTRACT.md).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (harness from prove-units-batch-real-schema.mjs),
 * applies the candidate, seeds invented rows, then checks every proof case: rolled-back probes as postgres or as the
 * signed-in admin through the real RPCs, and real concurrent sessions for the lock-order cases.
 *
 * Run: node scripts/smoke/prove-inventory-edge-cases-1942-real-schema.mjs   (needs Docker)
 * Prints INVENTORY_EDGE_CASES_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Iterating: CRX_PROVER_REUSE=<kept container> CRX_PROVER_DB=<a copy of its replayed database> skips the replay.
const REUSE = process.env.CRX_PROVER_REUSE;
const NAME = REUSE || `crx-invedge-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270129150000_inventory_edge_cases_1942.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'inventory-edge-cases-1942-reverse.sql');
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
const TOUCHED = /(_complete_delivery_authorized_impl|update_cycle_count_item|_guard_order_item_delivery_lineage|cycle_count_items|complete_cycle_count)/i;
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


const id = (s) => `a9420000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), CUST = id('c1');
// P4 < P5 by id; neither has a stock row. P6 has 10 on hand; P3 holds a 7-place on-hand for the count.
const P3 = id('b3'), P4 = id('b4'), P5 = id('b5'), P6 = id('b6');
const INV3 = id('d03'), INV6 = id('d06');
const OC = id('e1'), OD = id('e2'), OE = id('e3'), OX = id('e4');
const OC4 = id('e14'), OC5 = id('e15'), OD4 = id('e24'), OD5 = id('e25'), OE1 = id('e31'), OE2 = id('e32'), OX1 = id('e41');
const DC = id('f1'), DD = id('f2'), DE = id('f3');
const E1 = id('f31'), E2 = id('f32');
const CC = id('cc1'), CCI = id('cc2');
const NOT_A_LINE = id('fff');

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'invedge-admin@example.invalid', '{"full_name":"[PROVER] Edge Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Edge Farm', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ('${P3}', '[PROVER] Counted', 'IE-P3', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${P4}', '[PROVER] New Four', 'IE-P4', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${P5}', '[PROVER] New Five', 'IE-P5', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${P6}', '[PROVER] Two Lines', 'IE-P6', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 24, 30, 30, 30, 1, true);
    -- Filler so the products table is real-sized: the planner then walks a delivery's lines in line order, as live does.
    INSERT INTO public.products (product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active)
      SELECT '[PROVER] Filler ' || g, 'IE-F' || g, 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 24, 30, 30, 30, 1, false FROM generate_series(1, 2000) g;
    INSERT INTO public.inventory (id, product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order) VALUES
      ('${INV3}', '${P3}', 'Main Warehouse', 'Gal', 12.3456789, 0, 0),
      ('${INV6}', '${P6}', 'Main Warehouse', 'Gal', 10, 0, 0);
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES
      ('${OC}', 'IE-OC', '${CUST}', 'confirmed'), ('${OD}', 'IE-OD', '${CUST}', 'confirmed'),
      ('${OE}', 'IE-OE', '${CUST}', 'confirmed'), ('${OX}', 'IE-OX', '${CUST}', 'confirmed');
    INSERT INTO public.order_items (id, order_id, product_id, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit) VALUES
      ('${OC4}', '${OC}', '${P4}', 'Gal', 2, 0, 2, 30), ('${OC5}', '${OC}', '${P5}', 'Gal', 3, 0, 3, 30),
      ('${OD4}', '${OD}', '${P4}', 'Gal', 2, 0, 2, 30), ('${OD5}', '${OD}', '${P5}', 'Gal', 3, 0, 3, 30),
      ('${OE1}', '${OE}', '${P6}', 'Gal', 6, 0, 6, 30), ('${OE2}', '${OE}', '${P6}', 'Gal', 6, 0, 6, 30),
      ('${OX1}', '${OX}', '${P6}', 'Gal', 1, 0, 1, 30);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, is_quick_delivery) VALUES
      ('${DC}', 'IE-DC', '${OC}', '${CUST}', '${ADMIN}', 'in_progress', false),
      ('${DD}', 'IE-DD', '${OD}', '${CUST}', '${ADMIN}', 'in_progress', false),
      ('${DE}', 'IE-DE', '${OE}', '${CUST}', '${ADMIN}', 'in_progress', false);
    -- Opposite line order for the two products with no stock row: DC is P5 then P4, DD is P4 then P5.
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size) VALUES
      ('${id('f11')}', '${DC}', '${OC5}', '${P5}', 3, 'Gal'), ('${id('f12')}', '${DC}', '${OC4}', '${P4}', 2, 'Gal'),
      ('${id('f21')}', '${DD}', '${OD4}', '${P4}', 2, 'Gal'), ('${id('f22')}', '${DD}', '${OD5}', '${P5}', 3, 'Gal'),
      ('${E1}', '${DE}', '${OE1}', '${P6}', 6, 'Gal'), ('${E2}', '${DE}', '${OE2}', '${P6}', 6, 'Gal');
    INSERT INTO public.cycle_counts (id, count_number, status, initiated_by) VALUES ('${CC}', 'IE-CC1', 'in_progress', '${ADMIN}');
    INSERT INTO public.cycle_count_items (id, cycle_count_id, product_id, inventory_id, expected_qty) VALUES ('${CCI}', '${CC}', '${P3}', '${INV3}', 12.3457);`);
  psql('ANALYZE public.products; ANALYZE public.delivery_items;', { user: 'supabase_admin' });
  // Test-only: a new stock row created at delivery takes 1.5 s, so the two completions' row creations overlap every run.
  psql(`CREATE FUNCTION public.zz_prover_slow_new_stock_row() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN IF NEW.manufactured_at_delivery THEN PERFORM pg_sleep(1.5); END IF; RETURN NEW; END $fn$;
    CREATE TRIGGER zz_prover_slow_new_stock_row BEFORE INSERT ON public.inventory FOR EACH ROW EXECUTE FUNCTION public.zz_prover_slow_new_stock_row();`, { user: 'supabase_admin' });
  console.log('[prover] seeded two products with no stock row on two deliveries in opposite line order, one product on two lines of one delivery (10 on hand), a 7-place stock row under an open count, and an order line with no delivery');
}

// The completion step behind complete_delivery's role, receipt and evidence checks (its evidence marker set as it does),
// run as postgres with the admin's identity. q is a SQL jsonb expression or null.
const claims = (d) => `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true), set_config('crx.delivery_completion_evidence', '${d}', true);`;
const call = (d, q = null, key = null) => `public._complete_delivery_authorized_impl('${d}', 'Prover', '${ADMIN}', ${q ?? 'NULL'}, NULL, NULL, ${key ? `'${key}'` : 'NULL'})`;
const complete = (d, q = null, key = null) => `${claims(d)} SELECT ${call(d, q, key)};`;
const rowCount = (p) => `(SELECT count(*) FROM public.inventory WHERE product_id = '${p}' AND location = 'Main Warehouse')`;
const onHand = (p) => `(SELECT quantity_available FROM public.inventory WHERE product_id = '${p}' AND location = 'Main Warehouse')`;
const replica = (sql) => `SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`;

// A: two completions creating rows for P4 and P5 in opposite line order, at once. With this tiny products table the
// planner hash-joins from products (product order); with a larger products table it walks the delivery's lines
// (line order), the order that can deadlock, so the race sessions are held to that plan.
const LIVE_PLAN = 'SET enable_hashjoin = off; SET enable_mergejoin = off;';
async function creationRace() {
  const [t1, t2] = await Promise.all([
    session(`${LIVE_PLAN} BEGIN; ${complete(DC)} SELECT 'T1 done ' || ${onHand(P4)} || ' ' || ${onHand(P5)}; ROLLBACK;`),
    session(`${LIVE_PLAN} BEGIN; ${complete(DD)} SELECT 'T2 done ' || ${onHand(P4)} || ' ' || ${onHand(P5)}; ROLLBACK;`, 500),
  ]);
  return { t1, t2, deadlocked: /deadlock detected/.test(t1.out + t2.out) };
}

// B: count 12.35 on the 7-place row (as the signed-in admin), optionally move stock between Save and Complete.
const asAdmin = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true); SET LOCAL ROLE authenticated;`;
const countAndComplete = (moveBy = 0) => okProbe(`SELECT public.update_cycle_count_item('${CCI}', 12.35, NULL, '${ADMIN}', 'ie-cc-1');
  ${moveBy ? `RESET ROLE; ${replica(`UPDATE public.inventory SET quantity_available = quantity_available + ${moveBy} WHERE id = '${INV3}';`)} ${asAdmin}` : ''}
  SELECT public.complete_cycle_count('${CC}', '${ADMIN}', 'ie-cc-2', (SELECT item_revision FROM public.cycle_counts WHERE id = '${CC}'));
  SELECT (SELECT quantity_available FROM public.inventory WHERE id = '${INV3}') || '/' || (SELECT expected_qty FROM public.cycle_count_items WHERE id = '${CCI}');`, ADMIN)
  .split('/').map(Number);

// C: a flow with app.admin_override on moves an order line's product or order.
const override = (sql) => `SELECT set_config('app.admin_override', 'true', true); ${sql}`;
const moveLine = (line, set) => override(`UPDATE public.order_items SET ${set} WHERE id = '${line}'; SELECT product_id || '/' || order_id FROM public.order_items WHERE id = '${line}';`);

// D + E: complete DE (E1, E2 both 6 of P6) with on-hand set first; report on-hand / review-flagged rows / short warnings.
const twoLines = (q = null, stock = 10) => okProbe(`${replica(`UPDATE public.inventory SET quantity_available = ${stock} WHERE id = '${INV6}';`)}
  ${complete(DE, q)}
  SELECT ${onHand(P6)} || '/' || (SELECT count(*) FROM public.inventory_transactions WHERE delivery_id = '${DE}' AND requires_review)
    || '/' || (SELECT count(*) FROM public.activity_feed WHERE event_type = 'delivery_short_stock' AND related_entity_id = '${DE}');`)
  .split('/').map(Number).join('/');
const shortText = () => okProbe(`${complete(DE)}
  SELECT description FROM public.activity_feed WHERE event_type = 'delivery_short_stock' AND related_entity_id = '${DE}';`);
// A refused completion inside a caught block (as process_offline_action catches it): what is left afterwards.
const refusedLeaves = (d, q) => okProbe(`${claims(d)}
  DO $do$ BEGIN PERFORM ${call(d, q)}; RAISE EXCEPTION 'expected a refusal'; EXCEPTION WHEN check_violation THEN NULL; END $do$;
  SELECT (SELECT status FROM public.deliveries WHERE id = '${d}') || '/' || coalesce(${onHand(P6)}::text, '-') || '/' || ${rowCount(P4)} || '/' || ${rowCount(P5)}
    || '/' || (SELECT count(*) FROM public.inventory_transactions WHERE delivery_id = '${d}');`);

const STALE = /DELIVERY_QUANTITIES_STALE/;
const INVALID = /DELIVERY_QUANTITIES_INVALID/;
const payloads = {
  notALine: J({ [E1]: 3, [NOT_A_LINE]: 1 }),
  missingLine: J({ [E1]: 3 }),
  allLines: J({ [E1]: 3, [E2]: 6 }),
  nullValue: J({ [E1]: 3, [E2]: null }),
  stringValue: J({ [E1]: '3', [E2]: 6 }),
  array: `'[]'::jsonb`,
  jsonNull: `'null'::jsonb`,
  upperKey: J({ [E1.toUpperCase()]: 3, [E2]: 6 }),
};

async function beforeCases() {
  const race = await creationRace();
  assert.ok(race.deadlocked, `today two completions creating the same two stock rows deadlock:\n${race.t1.out}\n${race.t2.out}`);
  assert.deepEqual(countAndComplete(), [12.3499789, 12.3457], 'today a 12.35 count on 12.3456789 completes at 12.3499789');
  assert.match(okProbe(moveLine(OE1, `product_id = '${P4}'`)), new RegExp(`^${P4}/`), 'today the override moves a delivered line to another product');
  assert.equal(twoLines(payloads.notALine), '1/0/0', 'today a key that is not a line is ignored and E2 ships in full');
  assert.equal(twoLines(payloads.missingLine), '1/0/0', 'today a missing line ships in full');
  assert.equal(twoLines(payloads.nullValue), '1/0/0', 'today a blank figure ships the line in full');
  assert.equal(twoLines(), '-2/0/0', 'today two lines of 6 against 10 go to -2 with no warning');
  console.log('[case] before: two completions creating rows for two new products deadlock; a 12.35 count on 12.3456789 completes at 12.3499789; the override moves a delivered order line to another product; a stale key, a missing line or a blank figure ships the line in full; two lines of 6 against 10 go to -2 with no warning');
}

async function afterCases() {
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /INV_EDGE_PREFLIGHT/, again.output);
  for (const sig of [
    '_complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)',
    '_complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)',
    '_guard_order_item_delivery_lineage()',
  ]) {
    assert.equal(scalar(`SELECT p.prosecdef::text || ',' || array_to_string(p.proconfig, ';') || ',' || has_function_privilege('authenticated', p.oid, 'EXECUTE') || ',' || has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = 'public.${sig}'::regprocedure;`),
      'true,search_path=public, pg_temp,false,false', sig);
  }
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)', 'EXECUTE')::text || has_function_privilege('anon', 'public.update_cycle_count_item(uuid,numeric,text,uuid,text)', 'EXECUTE');`), 'truefalse');
  console.log('[case] P the migration applies once (a second apply refuses); every function stays SECURITY DEFINER with search_path = public, pg_temp and no anon execute; only update_cycle_count_item keeps authenticated execute (the count screen)');

  // A
  const race = await creationRace();
  assert.ok(!race.deadlocked, `no deadlock expected:\n${race.t1.out}\n${race.t2.out}`);
  assert.match(race.t1.out, /T1 done -2 -3/, race.t1.out);
  assert.match(race.t2.out, /T2 done -2 -3/, race.t2.out);
  assert.equal(okProbe(`${complete(DC)} SELECT ${onHand(P4)} || '/' || ${onHand(P5)} || '/' || (SELECT bool_and(manufactured_at_delivery) FROM public.inventory WHERE product_id IN ('${P4}', '${P5}'))
    || '/' || (SELECT count(*) FROM public.inventory_transactions WHERE delivery_id = '${DC}' AND requires_review);`), '-2/-3/true/2');
  // A retry of a completed delivery returns its saved receipt and creates no row, even for a product it now lists.
  const P7 = id('b7');
  assert.equal(okProbe(`${replica(`INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit, rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active)
      VALUES ('${P7}', '[PROVER] Late', 'IE-P7', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 24, 30, 30, 30, 1, true);
      INSERT INTO public.order_items (id, order_id, product_id, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit)
      VALUES ('${id('e17')}', '${OC}', '${P7}', 'Gal', 1, 0, 1, 30);`)}
    ${complete(DC, null, 'ie-replay')}
    ${replica(`INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size) VALUES ('${DC}', '${id('e17')}', '${P7}', 1, 'Gal');`)}
    ${complete(DC, null, 'ie-replay')}
    SELECT (SELECT status FROM public.deliveries WHERE id = '${DC}') || '/' || ${rowCount(P7)};`), 'completed/0');
  assert.match(probe(complete(id('f9'))).output, /Delivery not found/);
  console.log('[case] A two completions creating rows for the same two new products in opposite line order both finish (one waits, no deadlock); a completion ends at minus its quantities on rows flagged manufactured at delivery, its delivered rows flagged for review; a retry of a completed delivery returns its receipt and creates no row; an unknown delivery is still refused by the body');

  // B
  assert.deepEqual(countAndComplete(), [12.35, 12.3456789]);
  assert.deepEqual(countAndComplete(1), [13.35, 12.3456789]);
  console.log('[case] B as the signed-in admin, a 12.35 count on 12.3456789 stores the exact on-hand and completes at exactly 12.35; a +1 stock move between Save and Complete carries through (13.35)');

  // C
  refusedProbe(moveLine(OE1, `product_id = '${P4}'`), /ORDER_ITEM_DELIVERY_LINEAGE_LOCKED/);
  refusedProbe(moveLine(OE1, `order_id = '${OX}'`), /ORDER_ITEM_DELIVERY_LINEAGE_LOCKED/);
  assert.equal(okProbe(moveLine(OX1, `product_id = '${P4}'`)), `${P4}/${OX}`);
  assert.equal(Number(okProbe(override(`UPDATE public.order_items SET total_units_needed = 7, quantity_remaining = 7 WHERE id = '${OE1}'; SELECT total_units_needed FROM public.order_items WHERE id = '${OE1}';`))), 7);
  console.log('[case] C with app.admin_override on, moving a delivered order line to another product or order is refused (ORDER_ITEM_DELIVERY_LINEAGE_LOCKED); a line with no delivery still moves; a quantity change still saves');

  // D
  for (const [name, re] of [['notALine', STALE], ['missingLine', STALE], ['upperKey', STALE], ['nullValue', INVALID], ['stringValue', INVALID], ['array', INVALID], ['jsonNull', INVALID]]) {
    refusedProbe(complete(DE, payloads[name]), re);
  }
  assert.equal(refusedLeaves(DE, payloads.missingLine), 'in_progress/10/0/0/0');
  assert.equal(refusedLeaves(DC, J({ [id('f11')]: 1 })), 'in_progress/10/0/0/0', 'a stale partial on a delivery with no stock rows creates none');
  assert.equal(twoLines(payloads.allLines), '1/0/0');
  console.log('[case] D a partial completion naming a line that is not on the delivery, leaving a line out, or naming one in other letter case is refused (DELIVERY_QUANTITIES_STALE); a blank or text figure, an array or JSON null is refused (DELIVERY_QUANTITIES_INVALID); caught as the offline queue catches it, nothing has moved or been created; every line named with a number completes as today');

  // E
  assert.equal(twoLines(), '-2/2/1');
  assert.match(shortText(), /completed with 1 product\(s\) short on stock: \[PROVER\] Two Lines: need 12, only 10 on-hand\./);
  assert.equal(twoLines(null, 12), '0/0/0');
  assert.equal(twoLines(J({ [E1]: 6, [E2]: 4 })), '0/0/0');
  assert.equal(twoLines(J({ [E1]: 6, [E2]: 5 })), '-1/2/1');
  assert.equal(twoLines(J({ [E1]: 0, [E2]: 6 })), '4/0/0');
  console.log('[case] E two lines of 6 against 10 warn once ("need 12, only 10 on-hand") and flag both delivered rows (stock -2, completion goes ahead); exactly enough (12), a partial that fits (6 + 4), or one line at zero gives no warning; a partial one short (6 + 5) warns');
}

function rollbackCases() {
  psql('DROP TRIGGER zz_prover_slow_new_stock_row ON public.inventory; DROP FUNCTION public.zz_prover_slow_new_stock_row();', { user: 'supabase_admin' });
  stageText('reverse.sql', lf(REVERSE));
  raw(`UPDATE public.cycle_count_items SET expected_qty = 12.3456789, variance = 1e11 WHERE id = '${CCI}';`);
  const refused = apply('reverse.sql');
  assert.notEqual(refused.status, 0, 'a value too large for numeric(14,4) must stop the rollback');
  assert.match(refused.output, /ROLLBACK_REFUSED/, refused.output);
  assert.equal(scalar(`SELECT coalesce(numeric_scale::text, '-') FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cycle_count_items' AND column_name = 'variance';`), '-', 'the refused rollback changed nothing');
  raw(`UPDATE public.cycle_count_items SET variance = 0.0043211 WHERE id = '${CCI}';`);
  const r = apply('reverse.sql');
  assert.equal(r.status, 0, r.output);
  assert.equal(scalar(`SELECT string_agg(column_name || ':' || numeric_precision || ',' || numeric_scale, ' ' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cycle_count_items' AND column_name IN ('counted_qty', 'expected_qty', 'variance');`), 'counted_qty:14,4 expected_qty:14,4 variance:14,4');
  assert.equal(scalar(`SELECT expected_qty || '/' || variance FROM public.cycle_count_items WHERE id = '${CCI}';`), '12.3457/0.0043');
  assert.match(okProbe(moveLine(OE1, `product_id = '${P4}'`)), new RegExp(`^${P4}/`));
  assert.equal(twoLines(payloads.missingLine), '1/0/0');
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', 'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)', 'EXECUTE');`), 'f');
  console.log('[case] R rollback refuses, changing nothing, while a count value is too large for numeric(14,4); then restores the four previous bodies (md5-checked in the script), narrows the count columns back to numeric(14,4) rounding a 7-place value to 4, and the old behaviour returns (the override moves the line, a missing line ships in full); the wrapper stays private');
}

async function main() {
  if (!REUSE) buildContainer();
  if (process.env.CRX_PROVER_BUILD_ONLY === '1') {
    // pg_cron and pg_net hold connections to the source database; end them so it can be copied.
    docker([...psqlArgs('supabase_admin').map((a) => (a === DB ? 'template1' : a)), '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB}' AND pid <> pg_backend_pid();`, '-c', `CREATE DATABASE invedge_base TEMPLATE ${DB} OWNER postgres;`]);
    console.log(`[prover] built ${NAME}; replayed database copied to invedge_base`);
    return;
  }
  seed();
  await beforeCases();
  await afterCases();
  rollbackCases();
  console.log('INVENTORY_EDGE_CASES_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
