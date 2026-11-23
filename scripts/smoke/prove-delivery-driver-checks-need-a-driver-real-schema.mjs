#!/usr/bin/env node
/**
 * Real-schema proof for 20270226100000_delivery_driver_checks_need_a_driver.sql (a delivery with no driver: the
 * driver branch of each delivery permission check means "not this driver"; Mason approved 2026-11-23).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container, replays
 * every post-baseline migration before the candidate (harness from prove-edit-delivery-unassign-driver-real-schema.mjs),
 * applies it, checks each case through the real RPCs as signed-in users
 * (each probe rolled back), then applies the rollback script and the candidate again.
 *
 * Run: node scripts/smoke/prove-delivery-driver-checks-need-a-driver-real-schema.mjs   (needs Docker)
 * Prints DRIVER_CHECKS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a disposable container this run creates (no reuse of another container or database: Sol r1).
const NAME = `crx-driverchk-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
let created = false; // only remove a container this run started (Sol r1 LOW)
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270226100000_delivery_driver_checks_need_a_driver.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'delivery-driver-checks-need-a-driver-reverse.sql');
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
const TOUCHED = /(_complete_delivery_(evidence|replay|period_preflight|aggregate|authorized)_impl|_start_and_complete_delivery_impl|get_delivery_receipt_recipient|stage_offline_action)/i;
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
  created = true;
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
// A rolled-back probe as a signed-in user. Returns the last row.
function probe(sql, uid) {
  const claims = `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;`;
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${claims}\n${sql}\nROLLBACK;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '' };
}
function okProbe(sql, uid) { const r = probe(sql, uid); assert.equal(r.status, 0, r.output); return r.last; }
function refusedProbe(sql, pattern, uid) {
  const r = probe(sql, uid);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}\n${r.output}`);
  assert.match(r.output, pattern);
}

const id = (s) => `a0a56000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), REP = id('a2'), DRV1 = id('d1'), DRV2 = id('d2'), CUST = id('c1'), PROD = id('b1');
// NONE: started, no driver. MINE: started, Driver One. NONE_S: scheduled, no driver. MINE_S: scheduled, Driver One.
const NONE = id('f1'), MINE = id('f2'), NONE_S = id('f3'), MINE_S = id('f4');
const ORDER = (d) => id(`e${d.slice(-1)}`);
const OLINE = (d) => id(`1${d.slice(-1)}`);
const LINE = (d) => id(`2${d.slice(-1)}`);
const PHOTO = (d) => id(`3${d.slice(-1)}`);

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'drvchk-admin@example.invalid', '{"full_name":"[PROVER] Office","role":"admin"}'::jsonb),
    ('${REP}', 'drvchk-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ('${DRV1}', 'drvchk-d1@example.invalid', '{"full_name":"[PROVER] Driver One","role":"driver"}'::jsonb),
    ('${DRV2}', 'drvchk-d2@example.invalid', '{"full_name":"[PROVER] Driver Two","role":"driver"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    UPDATE public.profiles SET role = 'driver', is_active = true WHERE id IN ('${DRV1}', '${DRV2}');
    INSERT INTO public.customers (id, farm_name, is_active, email, contact_name) VALUES
      ('${CUST}', '[PROVER] Driver Check Farm', true, 'drvchk-farm@example.invalid', 'Pat Prover');
    INSERT INTO public.products (id, product_name, sku, unit_size, product_form, inventory_unit, is_active) VALUES
      ('${PROD}', '[PROVER] Product', 'DRVCHK-P', 'Gal', 'liquid', 'Gal', true);
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
      VALUES ('${PROD}', 'Main Warehouse', 1000, 0, 'Gal');`);
  for (const [d, st, drv] of [[NONE, 'in_progress', null], [MINE, 'in_progress', DRV1], [NONE_S, 'scheduled', null], [MINE_S, 'scheduled', DRV1]]) {
    const photo = `delivery-photos/${d}/drop.jpg`;
    raw(`INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
        VALUES ('${ORDER(d)}', 'DRVCHK-${d.slice(-2)}', '${CUST}', current_date, 'confirmed', false, '${ADMIN}');
      INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
          total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
        VALUES ('${OLINE(d)}', '${ORDER(d)}', '${PROD}', '[PROVER] Product', 10, 6, 5, 50, 20, 40, 0, 5);
      INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver)
        VALUES ('${d}', 'DRVCHK-D${d.slice(-2)}', '${ORDER(d)}', '${CUST}', '${ADMIN}', '${st}', current_date, ${drv ? `'${drv}'` : 'NULL'});
      INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
        VALUES ('${LINE(d)}', '${d}', '${OLINE(d)}', '${PROD}', 5, 'Gal');
      INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
        VALUES ('delivery-photos', '${photo}', '${ADMIN}', '{"mimetype":"image/jpeg","size":"5000"}'::jsonb);
      INSERT INTO public.delivery_photos (id, delivery_id, storage_path, image_url, caption, uploaded_by)
        VALUES ('${PHOTO(d)}', '${d}', '${photo}', '${photo}', 'Left at site — drop location', '${ADMIN}');`);
  }
  console.log('[prover] seeded an admin, a rep, two drivers, and four deliveries: started and scheduled, each with no driver and with Driver One');
}

// What the screens send: left at site with its photo (any role may use it).
const complete = (d, actor, key) => `SELECT public.complete_delivery(p_delivery_id => '${d}', p_signed_by => 'No one present — left at site',
  p_performed_by => '${actor}', p_quantities => ${J({ [LINE(d)]: 5 })}, p_idempotency_key => '${key}',
  p_evidence => 'left_at_site', p_evidence_ref => '${PHOTO(d)}')::text;`;
const startComplete = (d, actor, key) => `SELECT public.start_and_complete_delivery(p_delivery_id => '${d}', p_signed_by => 'No one present — left at site',
  p_delivered_on => (now() AT TIME ZONE 'America/Chicago')::date, p_performed_by => '${actor}', p_quantities => ${J({ [LINE(d)]: 5 })}, p_idempotency_key => '${key}',
  p_evidence => 'left_at_site', p_evidence_ref => '${PHOTO(d)}')::text;`;
// The result of a completion, read past row security: status, stock left, invoices for the delivery.
const outcome = (d) => `RESET ROLE; SELECT (SELECT status FROM public.deliveries WHERE id = '${d}')
  || '|' || (SELECT quantity_available FROM public.inventory WHERE product_id = '${PROD}')::numeric::int
  || '|' || (SELECT count(*) FROM public.invoices WHERE delivery_id = '${d}');`;
const recipient = (d) => `SELECT public.get_delivery_receipt_recipient('${d}') ->> 'farm_name';`;
const stage = (d, key) => `SELECT public.stage_offline_action('${key}'::uuid, 'complete_delivery', '${d}', 1, now(),
    ${J({ signed_by: 'Offline signer' })}, 'stage-${key}', '${scalar(`SELECT updated_at FROM public.deliveries WHERE id = '${d}';`)}'::timestamptz)::text;
  RESET ROLE; SELECT coalesce(failure_code, 'none') FROM public.offline_action_receipts WHERE client_action_id = '${key}';`;
const NOT_COMPLETE = /Not authorized to complete this delivery/;
const untouched = () => scalar(`SELECT status || '|' || (SELECT quantity_available FROM public.inventory WHERE product_id = '${PROD}')::numeric::int
  || '|' || (SELECT count(*) FROM public.invoices WHERE delivery_id = '${NONE}') FROM public.deliveries WHERE id = '${NONE}';`);

function afterCases() {
  // 1. A driver cannot complete, start-and-complete, read the receipt contact of, or queue a delivery with no driver.
  refusedProbe(complete(NONE, DRV2, 'a-1'), NOT_COMPLETE, DRV2);
  refusedProbe(startComplete(NONE_S, DRV2, 'a-1b'), NOT_COMPLETE, DRV2);
  refusedProbe(recipient(NONE_S), /Not authorized to view this delivery/, DRV2);
  assert.equal(okProbe(stage(NONE, id('a1c')), DRV2), 'NOT_AUTHORIZED');
  assert.equal(untouched(), 'in_progress|1000|0');
  console.log('[case 1] a driver is refused completing, starting-and-completing, or reading the receipt contact of a delivery with no driver; the offline queue sends it to office review; nothing changed');

  // 2. The office still can: admin and rep complete it and start-and-complete a scheduled one, and read the contact.
  assert.equal(okProbe(`${complete(NONE, ADMIN, 'a-2')} ${outcome(NONE)}`, ADMIN), 'completed|995|1');
  assert.equal(okProbe(`${complete(NONE, REP, 'a-2b')} ${outcome(NONE)}`, REP), 'completed|995|1');
  assert.equal(okProbe(`${startComplete(NONE_S, ADMIN, 'a-2c')} ${outcome(NONE_S)}`, ADMIN), 'completed|995|1');
  assert.equal(okProbe(`${startComplete(NONE_S, REP, 'a-2d')} ${outcome(NONE_S)}`, REP), 'completed|995|1');
  assert.equal(okProbe(recipient(NONE_S), ADMIN), '[PROVER] Driver Check Farm');
  assert.equal(okProbe(recipient(NONE_S), REP), '[PROVER] Driver Check Farm');
  console.log('[case 2] an admin and a rep still complete and start-and-complete a delivery with no driver, and read its receipt contact');

  // 3. The assigned driver still can; another driver still cannot.
  assert.equal(okProbe(`${complete(MINE, DRV1, 'a-3')} ${outcome(MINE)}`, DRV1), 'completed|995|1');
  assert.equal(okProbe(`${startComplete(MINE_S, DRV1, 'a-3b')} ${outcome(MINE_S)}`, DRV1), 'completed|995|1');
  assert.equal(okProbe(recipient(MINE_S), DRV1), '[PROVER] Driver Check Farm');
  assert.equal(okProbe(stage(MINE, id('a3c')), DRV1), 'none');
  refusedProbe(complete(MINE, DRV2, 'a-3d'), NOT_COMPLETE, DRV2);
  refusedProbe(recipient(MINE_S), /Not authorized to view this delivery/, DRV2);
  console.log('[case 3] the assigned driver still completes, starts-and-completes, reads the contact and queues offline; another driver is still refused');

  // 4. Grants unchanged (the postflight checks all eight; spot-check two here).
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', 'public._complete_delivery_evidence_impl_20270104(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text,boolean)', 'EXECUTE')::text
    || '|' || has_function_privilege('authenticated', 'public.get_delivery_receipt_recipient(uuid)', 'EXECUTE')::text
    || '|' || has_function_privilege('anon', 'public.get_delivery_receipt_recipient(uuid)', 'EXECUTE')::text;`), 'false|true|false');
  console.log('[case 4] grants unchanged');
}

function main() {
  buildContainer();
  seed();
  stageText('candidate.sql', lf(CANDIDATE));
  const r = apply('candidate.sql');
  assert.equal(r.status, 0, r.output);
  console.log('[prover] candidate applied (preflight and postflight passed)');
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.output, /DRIVER_CHECK_PREFLIGHT/);
  afterCases();
  // The rollback script restores the old behavior; the candidate then applies again.
  stageText('reverse.sql', lf(REVERSE));
  const back = docker([...psqlArgs(), '-f', '/tmp/reverse.sql'], { allowFailure: true });
  assert.equal(back.status, 0, `${back.stdout}\n${back.stderr}`);
  const reapply = apply('candidate.sql');
  assert.equal(reapply.status, 0, reapply.output);
  refusedProbe(complete(NONE, DRV2, 'r-2'), NOT_COMPLETE, DRV2);
  console.log('[prover] the rollback script restores the base bodies (the candidate preflight accepts them again), and the candidate applies again');
  console.log('DRIVER_CHECKS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP && created) docker(['rm', '-f', NAME], { allowFailure: true }); }
