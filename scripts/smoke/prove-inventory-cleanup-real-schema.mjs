#!/usr/bin/env node
/**
 * Real-schema proof for 20270122100000_inventory_cleanup_ki161_163_150.sql (KI-161, KI-163, KI-150; contract
 * docs/plans/2026-11-17-inventory-cleanup-ki161-163-150-CONTRACT.md).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (harness from prove-units-batch-real-schema.mjs),
 * applies the candidate, seeds invented rows, then checks every proof case: rolled-back probes as postgres or as the
 * signed-in admin through the real RPCs, and real concurrent sessions for the lock-order cases.
 *
 * Run: node scripts/smoke/prove-inventory-cleanup-real-schema.mjs   (needs Docker)
 * Prints INVENTORY_CLEANUP_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
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
const NAME = REUSE || `crx-invclean-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270122100000_inventory_cleanup_ki161_163_150.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'inventory-cleanup-ki161-163-150-reverse.sql');
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
  // Need live's storage.objects policies, which this database does not have; neither touches units or stock.
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate or its follow-up creates or relies on.
const TOUCHED = /(_complete_delivery_authorized_impl|_cancel_delivery_replay_impl_20261015|update_cycle_count_item|_delivery_line_matches_order_line|_lock_job_stock_rows_in_order|delivery_items_one_line_per_order_line|cycle_count_items)/i;
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

const id = (s) => `a8000000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), CUST = id('c1');
const P1 = id('b1'), P2 = id('b2'), P3 = id('b3');
const INV1 = id('d01'), INV2 = id('d02'), INV3 = id('d03');   // INV1 < INV2: id order locks P1 first
const OA = id('e1'), OB = id('e2'), OQ = id('e3');
const OA1 = id('e11'), OA2 = id('e12'), OB1 = id('e21'), OB2 = id('e22'), OQ1 = id('e31');
const DA = id('f1'), DLB = id('f2'), DE = id('f3'), DQ = id('f4');
const JOB = id('ab1'), CC = id('cc1'), CCI = id('cc2');

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'invclean-admin@example.invalid', '{"full_name":"[PROVER] Inv Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Inv Farm', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ('${P1}', '[PROVER] Herbicide One', 'IC-P1', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${P2}', '[PROVER] Herbicide Two', 'IC-P2', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${P3}', '[PROVER] Herbicide Three', 'IC-P3', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 16, 24, 30, 30, 30, 1, true);
    INSERT INTO public.inventory (id, product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order) VALUES
      ('${INV1}', '${P1}', 'Main Warehouse', 'Gal', 100, 20, 0),
      ('${INV2}', '${P2}', 'Main Warehouse', 'Gal', 100, 20, 0),
      ('${INV3}', '${P3}', 'Main Warehouse', 'Gal', 12.3456, 0, 0);
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES
      ('${OA}', 'IC-OA', '${CUST}', 'confirmed'), ('${OB}', 'IC-OB', '${CUST}', 'confirmed'), ('${OQ}', 'IC-OQ', '${CUST}', 'confirmed');
    INSERT INTO public.order_items (id, order_id, product_id, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit) VALUES
      ('${OA1}', '${OA}', '${P1}', 'Gal', 10, 0, 10, 30), ('${OA2}', '${OA}', '${P2}', 'Gal', 10, 0, 10, 30),
      ('${OB1}', '${OB}', '${P1}', 'Gal', 5, 0, 5, 30), ('${OB2}', '${OB}', '${P2}', 'Gal', 5, 0, 5, 30),
      ('${OQ1}', '${OQ}', '${P1}', 'Gal', 10, 0, 10, 30);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, is_quick_delivery) VALUES
      ('${DA}', 'IC-DA', '${OA}', '${CUST}', '${ADMIN}', 'in_progress', false),
      ('${DLB}', 'IC-DB', '${OB}', '${CUST}', '${ADMIN}', 'in_progress', false),
      ('${DE}', 'IC-DE', '${OA}', '${CUST}', '${ADMIN}', 'scheduled', false),
      ('${DQ}', 'IC-DQ', '${OQ}', '${CUST}', '${ADMIN}', 'scheduled', true);
    -- Opposite line order: DA touches P2 then P1, DB touches P1 then P2 (by line id and by insert order).
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size) VALUES
      ('${id('a11')}', '${DA}', '${OA2}', '${P2}', 5, 'Gal'), ('${id('a12')}', '${DA}', '${OA1}', '${P1}', 5, 'Gal'),
      ('${id('a21')}', '${DLB}', '${OB1}', '${P1}', 5, 'Gal'), ('${id('a22')}', '${DLB}', '${OB2}', '${P2}', 5, 'Gal'),
      ('${id('a41')}', '${DQ}', '${OQ1}', '${P1}', 10, 'Gal');
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status) VALUES ('${JOB}', 'IC-J1', '${CUST}', current_date, 'in_progress');
    INSERT INTO public.job_chemicals (id, job_id, product_id, quantity, customer_supplied) VALUES
      ('${id('ac1')}', '${JOB}', '${P2}', 1, false), ('${id('ac2')}', '${JOB}', '${P1}', 1, false);
    INSERT INTO public.cycle_counts (id, count_number, status, initiated_by) VALUES ('${CC}', 'IC-CC1', 'in_progress', '${ADMIN}');
    INSERT INTO public.cycle_count_items (id, cycle_count_id, product_id, inventory_id, expected_qty) VALUES ('${CCI}', '${CC}', '${P3}', '${INV3}', 12.35);`);
  console.log('[prover] seeded two Gal products on two orders with deliveries in opposite line order, a job, a quick delivery and a 4-decimal stock row');
}

// The completion step behind complete_delivery's role, receipt and evidence checks (its evidence marker set as it does),
// run as postgres with the admin's identity.
const complete = (d) => `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true), set_config('crx.delivery_completion_evidence', '${d}', true); SELECT public._complete_delivery_authorized_impl('${d}', 'Prover', '${ADMIN}');`;
const holdP2 = `BEGIN; SELECT 1 FROM public.inventory WHERE id = '${INV2}' FOR UPDATE; SELECT pg_sleep(4); ROLLBACK;`;
// Two completions sharing P1 and P2 in opposite line order, while a third session holds P2's stock row.
async function completionRace() {
  const [blocker, t1, t2] = await Promise.all([
    session(holdP2),
    session(`BEGIN; ${complete(DA)} SELECT 'T1 done'; ROLLBACK;`, 1000),
    session(`BEGIN; ${complete(DLB)} SELECT 'T2 done'; ROLLBACK;`, 2000),
  ]);
  assert.equal(blocker.code, 0, blocker.out);
  return { t1, t2, deadlocked: /deadlock detected/.test(t1.out + t2.out) };
}
// A job completing with chemicals P2 then P1, while a third session holds P2: does it hold P1 while it waits?
async function jobHoldsP1First() {
  const [, job, probeP1] = await Promise.all([
    session(holdP2),
    session(`BEGIN; UPDATE public.jobs SET status = 'completed' WHERE id = '${JOB}'; SELECT 'job done'; ROLLBACK;`, 1000),
    session(`BEGIN; SELECT 1 FROM public.inventory WHERE id = '${INV1}' FOR UPDATE NOWAIT; SELECT 'P1 free'; ROLLBACK;`, 2500),
  ]);
  assert.equal(job.code, 0, job.out);
  assert.match(job.out, /job done/);
  return /could not obtain lock/.test(probeP1.out);
}
const releasedAfterCancel = `SELECT public.cancel_delivery('${DQ}', 'prover', '${ADMIN}', 'ic-qc-1');
  SELECT coalesce((SELECT string_agg(quantity::text, ',') FROM public.inventory_transactions WHERE delivery_id = '${DQ}' AND transaction_type = 'released'), 'none')
    || '/' || (SELECT quantity_prebooked FROM public.inventory WHERE id = '${INV1}');`;
const countAndComplete = `SELECT public.update_cycle_count_item('${CCI}', 12.35, NULL, '${ADMIN}', 'ic-cc-1');
  SELECT public.complete_cycle_count('${CC}', '${ADMIN}', 'ic-cc-2', (SELECT item_revision FROM public.cycle_counts WHERE id = '${CC}'));
  SELECT quantity_available FROM public.inventory WHERE id = '${INV3}';`;
const prebooked = (q) => `SET session_replication_role = replica; UPDATE public.inventory SET quantity_prebooked = ${q} WHERE id = '${INV1}'; SET session_replication_role = origin;`;
const asAdmin = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true); SET LOCAL ROLE authenticated;`;
// Set prebooked as postgres, then cancel as the signed-in admin, in one rolled-back transaction.
const cancelWith = (q) => okProbe(`${prebooked(q)}\n${asAdmin}\n${releasedAfterCancel}`);

async function beforeCases() {
  const race = await completionRace();
  assert.ok(race.deadlocked, `today the two completions should deadlock:\n${race.t1.out}\n${race.t2.out}`);
  assert.equal(await jobHoldsP1First(), false, 'today a completing job does not hold P1 while it waits for P2');
  assert.equal(cancelWith(4), '10/0', 'today a cancel logs 10 released when 4 were held');
  assert.equal(Number(okProbe(countAndComplete, ADMIN)), 12.3456, 'today a count of 12.35 on 12.3456 leaves 12.3456');
  console.log('[case] B before: two completions sharing two products deadlock; a completing job locks stock in chemical order; a quick-delivery cancel logs 10 released when 4 were held; a 12.35 count leaves 12.3456 on hand');
}

const edit = (items, key) => `SELECT public.edit_delivery(p_delivery_id => '${DE}', p_items => ${J(items)}, p_performed_by => '${ADMIN}', p_idempotency_key => '${key}');`;
const line = (oi, product, qty = 1, unit = 'Gal') => ({ order_item_id: oi, product_id: product, quantity: qty, unit_size: unit });
const ins = (d, oi, product, unit = 'Gal') => `INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, unit_size)
    VALUES ('${d}', '${oi}', ${product ? `'${product}'` : 'NULL'}, 1, '${unit}');`;

async function afterCases() {
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);

  // KI-161 through the edit screen's RPC.
  refusedProbe(edit([line(OA1, P2)], 'ic-e1'), /DELIVERY_LINE_PRODUCT_MISMATCH/, ADMIN);
  refusedProbe(edit([line(OA1, P1), line(OA1, P1)], 'ic-e2'), /DELIVERY_LINE_DUPLICATE/, ADMIN);
  refusedProbe(edit([line(OB1, P1)], 'ic-e3'), /DELIVERY_LINE_NOT_ON_ORDER|not .*order|belong/i, ADMIN);
  assert.equal(okProbe(`${edit([line(OA1, P1, 2), line(OA2, P2, 3)], 'ic-e4')}
    SELECT string_agg(order_item_id::text || ':' || quantity, ',' ORDER BY order_item_id) FROM public.delivery_items WHERE delivery_id = '${DE}';`, ADMIN),
  `${OA1}:2,${OA2}:3`);
  console.log("[case] 1 edit_delivery refuses a line whose product differs from its order line, the same order line twice, and another order's line; a normal edit saves");

  // Every writer, not just the screen.
  refusedProbe(ins(DE, OB1, P1), /DELIVERY_LINE_NOT_ON_ORDER/);
  refusedProbe(ins(DE, OA1, null), /DELIVERY_LINE_PRODUCT_MISMATCH/);
  refusedProbe(ins(DA, OA1, P1), /DELIVERY_LINE_DUPLICATE/);
  refusedProbe(`UPDATE public.delivery_items SET order_item_id = '${OB1}' WHERE id = '${id('a11')}';`, /DELIVERY_LINE_NOT_ON_ORDER/);
  refusedProbe(`SET session_replication_role = replica; ${ins(DA, OA1, P1)}`, /delivery_items_one_line_per_order_line/);
  refusedProbe(`UPDATE public.deliveries SET order_id = '${OB}' WHERE id = '${DA}';`, /DELIVERY_ORDER_LOCKED/);
  const LEG = id('e19');
  raw(`INSERT INTO public.order_items (id, order_id, product_id, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit)
    VALUES ('${LEG}', '${OA}', '${P1}', 'Qt', 4, 0, 4, 7.5);`);
  refusedProbe(ins(DE, LEG, P1), /DELIVERY_LINE_UNIT_MISMATCH: this delivery line is in "Gal" but its order line is in "Qt"/);
  raw(`DELETE FROM public.order_items WHERE id = '${LEG}';`);
  assert.equal(okProbe(`UPDATE public.delivery_items SET quantity = 4 WHERE id = '${id('a41')}'; SELECT quantity FROM public.delivery_items WHERE id = '${id('a41')}';`), '4');
  console.log('[case] 2 a direct write is refused for another order\'s line, a missing product, a duplicate (the unique index catches one written with triggers off), and a unit that differs from a legacy order line; a delivery with lines cannot move to another order; a quantity change saves');

  // Signed-in users cannot write delivery lines directly; they still read them.
  refusedProbe(ins(DE, OA1, P1), /permission denied/, ADMIN);
  refusedProbe(`UPDATE public.delivery_items SET quantity = 2 WHERE id = '${id('a11')}';`, /permission denied/, ADMIN);
  refusedProbe(`DELETE FROM public.delivery_items WHERE id = '${id('a11')}';`, /permission denied/, ADMIN);
  assert.equal(okProbe(`SELECT count(*) FROM public.delivery_items WHERE delivery_id = '${DA}';`, ADMIN), '2');
  console.log("[case] 3 a signed-in admin's direct insert, update and delete of a delivery line are denied; reading works");

  // KI-150 / C-12.
  const race = await completionRace();
  assert.ok(!race.deadlocked, `no deadlock expected:\n${race.t1.out}\n${race.t2.out}`);
  assert.match(race.t1.out, /T1 done/, race.t1.out); assert.match(race.t2.out, /T2 done/, race.t2.out);
  assert.equal(await jobHoldsP1First(), true, 'a completing job takes P1 (lower id) before it waits for P2');
  assert.equal(okProbe(`${complete(DA)} SELECT status || '/' || (SELECT quantity_available FROM public.inventory WHERE id = '${INV1}') FROM public.deliveries WHERE id = '${DA}';`).replace(/\.0+$/, ''), 'completed/95');
  console.log('[case] 4 two completions sharing two products in opposite line order both finish (one waits, no deadlock); a completing job locks its stock rows in id order; a single completion still completes and deducts');

  // KI-163 (1) and (2).
  assert.equal(cancelWith(4), '4/0');
  assert.equal(cancelWith(20), '10/10');
  assert.equal(cancelWith(0), 'none/0');
  console.log('[case] 5 a quick-delivery cancel logs what it really released: 4 when 4 were held, 10 when 20 were held, no row when none were held');
  assert.equal(Number(okProbe(countAndComplete, ADMIN)), 12.35);
  console.log('[case] 6 a count of 12.35 on a 12.3456 stock row completes to exactly 12.35');
}

function rollbackCases() {
  stageText('reverse.sql', lf(REVERSE));
  const r = apply('reverse.sql');
  assert.equal(r.status, 0, r.output);
  assert.equal(n(`SELECT count(*) FROM pg_trigger WHERE tgname IN ('a2_delivery_line_matches_order_line', 'trg_zz_lock_job_stock_rows');`), 0);
  assert.equal(n(`SELECT count(*) FROM pg_class WHERE relname = 'delivery_items_one_line_per_order_line';`), 0);
  assert.equal(scalar(`SELECT has_table_privilege('authenticated', 'public.delivery_items', 'INSERT');`), 't');
  console.log('[case] R rollback restores the three original function bodies (md5-checked in the script), drops the trigger, index and job lock, and gives back the direct write grant');
}

async function main() {
  if (!REUSE) buildContainer();
  if (process.env.CRX_PROVER_BUILD_ONLY === '1') {
    // pg_cron and pg_net hold connections to the source database; end them so it can be copied.
    docker([...psqlArgs("supabase_admin").map((a) => (a === DB ? "template1" : a)), "-c", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB}' AND pid <> pg_backend_pid();`, "-c", `CREATE DATABASE invclean_base TEMPLATE ${DB} OWNER postgres;`]);
    console.log(`[prover] built ${NAME}; replayed database copied to invclean_base`);
    return;
  }
  seed();
  await beforeCases();
  await afterCases();
  rollbackCases();
  console.log('INVENTORY_CLEANUP_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
