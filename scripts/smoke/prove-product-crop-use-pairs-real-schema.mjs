#!/usr/bin/env node
/**
 * Real-schema proof for 20261224100000 (Product Master USE-1, crop/use pairs). Builds the checked-in schema
 * baseline in a network-disabled PostgreSQL container, replays migrations up to the candidate, seeds invented
 * products holding each live use-timing code, applies the candidate (a second apply refuses), then, as real
 * signed-in roles: every product keeps its codes and joined text; 10 options and 8 crops; only an admin adds or
 * turns options on/off (retry-safe, one active option per crop+timing pair, labels checked); Burndown plus an
 * in-season timing on one product; pairs on ungrouped and grouped products; a turned-off option leaves the
 * pick list, holders keep it, every write path refuses it, sizes still inherit it from their parent; a row
 * never holds one pair twice.
 *
 * Run: node scripts/smoke/prove-product-crop-use-pairs-real-schema.mjs   (needs local Docker image)
 * Prints PRODUCT_CROP_USE_PAIRS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-crop-pairs-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
if (REUSE && !/^crx-crop-pairs-\d+-[0-9a-z]+$/.test(NAME)) {
  console.error(`CRX_PROVER_REUSE_CONTAINER must name a container this prover created (crx-crop-pairs-<pid>-<id>), not "${NAME}"`);
  process.exit(1);
}
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261224100000_product_crop_use_pairs.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// PR #889's data migrations rewrite live rows this disposable database does not have; they are
// recorded in the ledger (as live has them) instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
  // KI-01 part C (#1650) changes job and storage access only; its preflight needs live's storage.objects policies,
  // which this database does not have (the staff photo storage files are parked above). Its own proof is
  // prove-job-access-ends-with-the-job-real-schema.mjs; same approach as prove-close-delivery-receipt-real-schema.mjs.
  '20261217100000_job_access_ends_with_the_job.sql',
  // Its KI-73 follow-up (applicator spray-record fields) needs part C applied; same reason.
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(product_use_timing_options|product_crop_options|sync_product_use_timings|use_timing_option|guard_product_parent_retired_timings)/i;
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
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
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  for (const file of all.slice(at + 1)) {
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
  docker(['run', '-d', '--name', NAME, '--label', 'crx-prover=crop-pairs', '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
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
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') {
      psql(`UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
        INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
        WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');`);
    }
    // BLK-1a's preflight needs the count units live already has.
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql("INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Ea', 1, 'both'), ('Unit', 1, 'both') ON CONFLICT DO NOTHING;");
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const id = (n) => `05e10000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const REP = id('a2');
// Invented ungrouped products holding the live codes (one each, as live has them), seeded with triggers off.
const SEEDED = [
  ['b1', 'Herbicide', 'post_emergence', 'Post-Emergence'],
  ['b2', 'Herbicide', 'pre_emerge_soybean', 'Pre-Emerge Soybean'],
  ['b3', 'Herbicide', 'pre_emerge_corn', 'Pre-Emerge Corn'],
  ['b4', 'Foliar Fertilizer', 'foliar', 'Foliar'],
  ['b5', 'Herbicide', 'range_pasture_turf', 'Range/Pasture/Turf'],
  ['b6', 'Herbicide', 'volunteer_corn', 'Volunteer Corn'],
  ['b7', 'Herbicide', null, null],
  ['b8', 'Foliar Fertilizer', null, null],
  ['b9', 'Herbicide', null, null],
];
const P = (k) => id(k);

function asOwner(sql) { psql(`SET session_replication_role = replica;
${sql}
SET session_replication_role = origin;`, { user: 'supabase_admin' }); }
function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'u1-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'u1-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  const rows = SEEDED.map(([k, cat, code, label], i) => `('${P(k)}', '[PROVER] Use ${k}', 'U1-${k}', '${cat}', 'liquid', 'Gal', true, 20.00,
    ${code ? `ARRAY['${code}']` : "'{}'::text[]"}, ${label ? `'${label}'` : 'NULL'})`).join(',\n    ');
  asOwner(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) VALUES ('Gal', 128, 'liquid'), ('oz', 1, 'liquid'), ('Lb', 16, 'dry')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.products (id, product_name, sku, category, product_form, inventory_unit, is_active, tier1_price, use_timings, use_timing)
    VALUES ${rows};`);
  console.log('[prover] seeded an admin, a sales rep and nine invented ungrouped products (each live code once, three with none)');
}
function as(uid, sql) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true,
    input: `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
function refused(uid, sql, pattern) {
  const r = as(uid, sql);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`);
  assert.match(r.output, pattern);
}
const q = (v) => JSON.stringify(v).replaceAll("'", "''");
const J = (v) => `'${q(v)}'::jsonb`;
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
const call = (uid, sql) => JSON.parse(ok(uid, sql));
const prod = (pid, cols) => scalar(`SELECT concat_ws('|', ${cols}) FROM public.products WHERE id = '${pid}';`);
const timings = (pid) => prod(pid, "array_to_string(use_timings, ','), coalesce(use_timing, '-')");
const parentTimings = (pp) => scalar(`SELECT array_to_string(use_timings, ',') FROM public.product_parents WHERE id = '${pp}';`);
const version = (pp) => Number(scalar(`SELECT parent_version FROM public.product_parents WHERE id = '${pp}';`));
const optVersion = (code) => Number(scalar(`SELECT option_version FROM public.product_use_timing_options WHERE code = '${code}';`));
const addOpt = (cat, timing, crop, label, key, uid = ADMIN) => call(uid, `SELECT public.add_use_timing_option(${lit(cat)}, ${lit(timing)}, ${lit(crop)}, ${lit(label)}, ${lit(key)});`);
const addSql = (cat, timing, crop, label, key) => `SELECT public.add_use_timing_option(${lit(cat)}, ${lit(timing)}, ${lit(crop)}, ${lit(label)}, ${lit(key)});`;
const setSql = (code, on, v, key) => `SELECT public.set_use_timing_option_active(${lit(code)}, ${on === null ? 'NULL' : on}, ${v === null ? 'NULL' : v}, ${lit(key)});`;
const setOpt = (code, on, key) => call(ADMIN, setSql(code, on, optVersion(code), key));
const save = (rows, key) => `SELECT public.apply_product_setup('${q(rows)}'::jsonb, '${ADMIN}', '${key}');`;
const setupFp = (pid) => JSON.parse(ok(ADMIN, 'SELECT public.get_product_setup_workbook();')).rows.find((r) => r.product_id === pid).setup_fingerprint;
const setupSave = (pid, changes, key) => save([{ product_id: pid, setup_fingerprint: setupFp(pid), changes }], key);
const create = (parent, size, key) => `SELECT public.create_product_with_parent(${J(parent)}, ${J(size)}, '${key}');`;
const addSize = (pp, size, key) => `SELECT public.add_product_size('${pp}', ${version(pp)}, ${J(size)}, '${key}');`;
const editParent = (pp, changes, key, v = version(pp)) => `SELECT public.update_product_parent('${pp}', ${v}, ${J(changes)}, 'prover', '${key}');`;
const PRODUCTS_MD5 = "SELECT md5(string_agg(concat_ws('|', id, use_timings::text, use_timing, pricing_version), '#' ORDER BY id)) FROM public.products;";
const CODE_COUNTS = "SELECT coalesce(string_agg(c || '=' || n, ',' ORDER BY c), '-') FROM (SELECT unnest(use_timings) c, count(*) n FROM public.products GROUP BY 1) x;";
const OPTIONS = "SELECT count(*) FROM public.product_use_timing_options;";
const UNAVAILABLE = /Use timing "[^"]+" is unavailable/;

function main() {
  if (!REUSE) { buildContainer(); seed(); }  // a reused container stops before the candidate, already seeded
  const before = { md5: scalar(PRODUCTS_MD5), counts: scalar(CODE_COUNTS) };
  assert.equal(before.counts, 'foliar=1,post_emergence=1,pre_emerge_corn=1,pre_emerge_soybean=1,range_pasture_turf=1,volunteer_corn=1');
  const ledgerRows = scalar('SELECT count(*) FROM supabase_migrations.schema_migrations;');
  stageText('cand.sql', lf(CANDIDATE));
  const installed = apply('cand.sql');
  assert.equal(installed.status, 0, installed.output);
  assert.equal(scalar('SELECT count(*) FROM supabase_migrations.schema_migrations;'), ledgerRows);
  assert.equal(scalar(PRODUCTS_MD5), before.md5, 'the migration changed a product');
  assert.equal(scalar(CODE_COUNTS), before.counts);
  console.log('[prover] case 1: installs; every product keeps its codes, joined text and pricing version; per-code counts match');

  assert.equal(scalar(`SELECT string_agg(concat_ws('|', code, coalesce(crop, '-'), timing_code, sort_order), ' ' ORDER BY sort_order) FROM public.product_use_timing_options;`),
    'burndown_preplant|-|burndown|5 pre_emerge|-|pre_emergence|10 pre_emerge_corn|corn|pre_emergence|20 pre_emerge_soybean|soybeans|pre_emergence|30 '
    + 'post_emergence|-|post_emergence|40 post_emerge_corn|corn|post_emergence|50 post_emerge_soybeans|soybeans|post_emergence|60 '
    + 'volunteer_corn|-|volunteer_corn|70 range_pasture_turf|range_pasture_turf|range_pasture_turf|80 foliar|-|foliar|90');
  assert.equal(scalar("SELECT string_agg(label, ',' ORDER BY sort_order) FROM public.product_crop_options;"),
    'Corn,Soybeans,Wheat,Milo,Cotton,Alfalfa,Pasture/Hay,Range/Pasture/Turf');
  assert.equal(ok(REP, 'SELECT count(*) FROM public.product_crop_options;'), '8');
  refused(null, 'SELECT count(*) FROM public.product_crop_options;', /permission denied/);
  refused(ADMIN, "INSERT INTO public.product_crop_options (code, label, sort_order) VALUES ('barley', 'Barley', 90);", /permission denied/);
  console.log('[prover] 10 options (Burndown added; Volunteer Corn re-filed to any crop; Range/Pasture/Turf to its own crop); 8 crops, readable by staff, closed to visitors and writers');

  // Case 2: an admin adds a pair; others are refused and nothing is written.
  const n0 = scalar(OPTIONS);
  refused(REP, addSql('Herbicide', 'post_emergence', 'wheat', 'Post-Emerge Wheat', 'k-rep'), /ADMIN_REQUIRED/);
  refused(null, addSql('Herbicide', 'post_emergence', 'wheat', 'Post-Emerge Wheat', 'k-anon'), /permission denied/);
  refused(ADMIN, addSql('Herbicide', 'post_emergence', 'wheat', 'Post-Emerge Wheat', null), /IDEMPOTENCY_KEY_REQUIRED/);
  refused(ADMIN, `INSERT INTO public.product_use_timing_options (code, label, timing_code, crop, category, sort_order)
    VALUES ('x_wheat', 'X Wheat', 'post_emergence', 'wheat', 'Herbicide', 1);`, /permission denied/);
  refused(ADMIN, "UPDATE public.product_use_timing_options SET is_active = false WHERE code = 'foliar';", /permission denied/);
  assert.equal(scalar(OPTIONS), n0);
  const wheat = addOpt('Herbicide', 'post_emergence', 'wheat', ' Post-Emerge Wheat ', 'k-wheat');
  assert.deepEqual([wheat.code, wheat.label, wheat.crop, wheat.sort_order, wheat.option_version], ['post_emerge_wheat', 'Post-Emerge Wheat', 'wheat', 90, 1]);
  assert.equal(scalar(`SELECT created_by = '${ADMIN}' AND updated_by = '${ADMIN}' AND created_at IS NOT NULL FROM public.product_use_timing_options WHERE code = 'post_emerge_wheat';`), 't');
  assert.deepEqual(addOpt('Herbicide', 'post_emergence', 'wheat', 'Post-Emerge Wheat', 'k-wheat'), wheat, 'a retry returns the first receipt');
  assert.equal(Number(scalar(OPTIONS)), Number(n0) + 1, 'a retry writes once');
  refused(ADMIN, addSql('Herbicide', 'post_emergence', 'wheat', 'Wheat Post', 'k-wheat'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  console.log('[prover] case 2: an admin adds Post-Emerge Wheat once (retry-safe); a rep, a visitor, a keyless call and direct writes are refused and write nothing');

  // Case 3: one active option per pair; checks on every argument.
  refused(ADMIN, addSql('Herbicide', 'post_emergence', 'wheat', 'Wheat Post', 'k-dup'), /USE_TIMING_PAIR_EXISTS: "Post-Emerge Wheat"/);
  refused(ADMIN, addSql('Herbicide', 'post_emergence', 'barley', 'Post Barley', 'k-crop'), /USE_TIMING_CROP_UNKNOWN/);
  refused(ADMIN, addSql('Herbicide', 'post_emergence', 'wheat', 'Wheat; Post', 'k-semi'), /USE_TIMING_LABEL_INVALID/);
  refused(ADMIN, addSql('Herbicide', 'post_emergence', 'wheat', '2 Wheat Post', 'k-digit'), /USE_TIMING_LABEL_INVALID/);
  refused(ADMIN, addSql('Herbicide', 'post_emergence', 'wheat', 'Épandage', 'k-accent'), /USE_TIMING_LABEL_INVALID/);
  refused(ADMIN, addSql('Herbicide', 'post_emergence', 'wheat', 'Wheat​Post', 'k-zw'), /USE_TIMING_LABEL_INVALID/);
  refused(ADMIN, addSql('Herbicide', 'post_emergence', 'wheat', '', 'k-empty'), /USE_TIMING_LABEL_INVALID/);
  refused(ADMIN, addSql('Herbicide', 'post_emergence', 'wheat', 'x'.repeat(61), 'k-long'), /USE_TIMING_LABEL_INVALID/);
  refused(ADMIN, addSql('Herbicide', 'post_emergence', 'milo', 'pre-emerge CORN', 'k-taken'), /USE_TIMING_LABEL_TAKEN: "Pre-Emerge Corn"/);
  refused(ADMIN, addSql('Herbicide', 'post_emergence', 'milo', 'post_emergence', 'k-iscode'), /USE_TIMING_LABEL_IS_CODE/);
  refused(ADMIN, addSql('Fungicide', 'post_emergence', 'milo', 'Milo Fungus', 'k-cat'), /USE_TIMING_CATEGORY/);
  refused(ADMIN, addSql('Herbicide', 'Post Emergence', 'milo', 'Milo Post', 'k-code'), /USE_TIMING_CODE_INVALID/);
  refused(ADMIN, addSql('Herbicide', 'burndown', null, 'Burndown Any', 'k-burn'), /USE_TIMING_PAIR_EXISTS: "Burndown \(preplant\)"/);
  // The same pair in another category is a different pair.
  assert.equal(addOpt('Foliar Fertilizer', 'post_emergence', 'wheat', 'Foliar Wheat', 'k-fol').code, 'foliar_wheat');
  // A slug taken by another code gets _2.
  assert.equal(addOpt('Herbicide', 'burndown', 'wheat', 'Burndown Preplant!', 'k-slug').code, 'burndown_preplant_2');
  refused(ADMIN, setSql('post_emerge_wheat', false, 99, 'k-stale'), /USE_TIMING_STALE: "Post-Emerge Wheat"/);
  refused(ADMIN, setSql('post_emerge_wheat', true, 1, 'k-same'), /USE_TIMING_NO_CHANGE/);
  refused(ADMIN, setSql('post_emerge_wheat', null, 1, 'k-null'), /USE_TIMING_INVALID/);
  refused(ADMIN, setSql('post_emerge_wheat', false, null, 'k-null2'), /USE_TIMING_INVALID/);
  refused(ADMIN, setSql('nope', false, 1, 'k-nf'), /USE_TIMING_NOT_FOUND/);
  refused(REP, setSql('post_emerge_wheat', false, 1, 'k-rep2'), /ADMIN_REQUIRED/);
  const off = setOpt('post_emerge_wheat', false, 'k-off-wheat');
  assert.deepEqual([off.is_active, off.option_version, off.sizes_holding, off.parents_holding], [false, 2, 0, 0]);
  assert.deepEqual(call(ADMIN, setSql('post_emerge_wheat', false, 1, 'k-off-wheat')), off, 'a toggle retry returns the first receipt');
  refused(ADMIN, setSql('post_emerge_wheat', false, 2, 'k-off-wheat'), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  assert.equal(addOpt('Herbicide', 'post_emergence', 'wheat', 'Wheat Post', 'k-fixed').code, 'wheat_post');
  refused(ADMIN, setSql('post_emerge_wheat', true, 2, 'k-on-wheat'), /USE_TIMING_PAIR_EXISTS: "Wheat Post"/);
  console.log('[prover] case 3: a second label for an active pair, an unknown crop, bad labels/codes/categories, stale or empty toggles are refused; a retired pair can be re-added and not turned back on over it');

  // Case 10: Burndown and an in-season timing on one product.
  const [H1, H2, F1, H3] = [P('b7'), P('b9'), P('b8'), P('b1')];
  ok(ADMIN, `UPDATE public.products SET use_timings = ARRAY['post_emergence', 'burndown_preplant'] WHERE id = '${H1}';`);
  assert.equal(timings(H1), 'burndown_preplant,post_emergence|Burndown (preplant); Post-Emergence');
  refused(ADMIN, `UPDATE public.products SET use_timings = ARRAY['burndown_preplant'] WHERE id = '${F1}';`, /Use timing "Burndown \(preplant\)" is unavailable for category "Foliar Fertilizer"/);
  console.log('[prover] case 10: a Herbicide product holds Burndown (preplant) and Post-Emergence together; a Foliar Fertilizer product is refused Burndown');

  // Case 4 (ungrouped): two crop/timing pairs on one size survive a save and a re-read.
  ok(ADMIN, `UPDATE public.products SET use_timings = ARRAY['post_emerge_soybeans', 'pre_emerge_corn'] WHERE id = '${H2}';`);
  ok(ADMIN, `UPDATE public.products SET notes = 'resaved' WHERE id = '${H2}';`);
  assert.equal(timings(H2), 'pre_emerge_corn,post_emerge_soybeans|Pre-Emerge Corn; Post-Emerge Soybeans');

  // Case 4 (grouped), 5, 6: parents.
  const PA = call(ADMIN, create({ name: '[PROVER] Alpha', product_form: 'liquid', category: 'Herbicide', use_timings: ['pre_emerge_corn', 'post_emerge_soybeans'] },
    { product_name: '[PROVER] Alpha 2.5', sku: 'AL-25', inventory_unit: 'Gal' }, 'k-pa'));
  const A2 = call(ADMIN, addSize(PA.parent_id, { product_name: '[PROVER] Alpha 30', sku: 'AL-30', inventory_unit: 'Gal' }, 'k-pa2')).product_id;
  assert.equal(timings(PA.product_id), 'pre_emerge_corn,post_emerge_soybeans|Pre-Emerge Corn; Post-Emerge Soybeans');
  assert.equal(timings(A2), timings(PA.product_id));
  call(ADMIN, editParent(PA.parent_id, { use_timings: ['pre_emerge_corn', 'post_emerge_soybeans', 'burndown_preplant'] }, 'k-pa-edit'));
  assert.equal(timings(PA.product_id), 'burndown_preplant,pre_emerge_corn,post_emerge_soybeans|Burndown (preplant); Pre-Emerge Corn; Post-Emerge Soybeans');
  assert.equal(timings(A2), timings(PA.product_id));
  refused(ADMIN, `UPDATE public.products SET use_timings = ARRAY['pre_emerge'] WHERE id = '${A2}';`, /PRODUCT_PARENT_VALUE: use timing belongs to parent "\[PROVER\] Alpha"/);
  refused(ADMIN, editParent(PA.parent_id, { category: 'Fungicide' }, 'k-pa-cat'), /PRODUCT_PARENT_TIMINGS_MUST_CLEAR/);
  const cleared = call(ADMIN, editParent(PA.parent_id, { category: 'Fungicide', use_timings: [] }, 'k-pa-clear'));
  assert.equal(cleared.sizes.length, 2);
  assert.equal(timings(PA.product_id), '|-');
  assert.equal(timings(A2), '|-');
  assert.equal(scalar(`SELECT count(*) FROM public.product_parent_events WHERE id = ${cleared.event_id};`), '1');
  console.log('[prover] cases 4-6: two pairs survive save and reload (ungrouped and grouped); sizes share the parent\'s pairs; a size edit names the parent; a category change clears them after the confirm, in one event');

  // Case 7: a turned-off option.
  const held = setOpt('pre_emerge_corn', false, 'k-off-pec');
  assert.deepEqual([held.sizes_holding, held.parents_holding], [2, 0]);   // b3 and H2 (Alpha cleared it)
  assert.equal(ok(ADMIN, `SELECT count(*) FROM public.product_use_timing_options WHERE is_active AND code = 'pre_emerge_corn';`), '0');
  ok(ADMIN, `UPDATE public.products SET notes = 'kept' WHERE id = '${P('b3')}';`);
  assert.equal(timings(P('b3')), 'pre_emerge_corn|Pre-Emerge Corn');
  ok(ADMIN, `UPDATE public.products SET use_timings = ARRAY['pre_emerge_corn', 'post_emerge_soybeans', 'burndown_preplant'] WHERE id = '${H2}';`);
  refused(ADMIN, `UPDATE public.products SET use_timings = ARRAY['post_emergence', 'pre_emerge_corn'] WHERE id = '${H3}';`, UNAVAILABLE);
  refused(ADMIN, `UPDATE public.products SET use_timing = 'Post-Emergence; Pre-Emerge Corn' WHERE id = '${H3}';`, UNAVAILABLE);
  refused(ADMIN, setupSave(H3, { use_timings: ['post_emergence', 'pre_emerge_corn'] }, 'k-setup-pec'), UNAVAILABLE);
  refused(ADMIN, save([{ insert: { product_name: '[PROVER] Import PEC', sku: 'IM-PEC', category: 'Herbicide', product_form: 'liquid', inventory_unit: 'Gal', use_timing: 'Pre-Emerge Corn' } }], 'k-import-pec'), UNAVAILABLE);
  refused(ADMIN, create({ name: '[PROVER] Beta', product_form: 'liquid', category: 'Herbicide', use_timings: ['pre_emerge_corn'] },
    { product_name: '[PROVER] Beta 1', sku: 'BE-1', inventory_unit: 'Gal' }, 'k-pb-pec'), /PRODUCT_PARENT_TIMING_RETIRED: "Pre-Emerge Corn"/);
  call(ADMIN, editParent(PA.parent_id, { category: 'Herbicide' }, 'k-pa-herb'));
  refused(ADMIN, editParent(PA.parent_id, { use_timings: ['pre_emerge_corn'] }, 'k-pa-pec'), /PRODUCT_PARENT_TIMING_RETIRED: "Pre-Emerge Corn"/);
  assert.equal(timings(H3), 'post_emergence|Post-Emergence');
  assert.equal(scalar("SELECT count(*) FROM public.products WHERE sku = 'IM-PEC' OR sku = 'BE-1';"), '0');
  const back = setOpt('pre_emerge_corn', true, 'k-on-pec');
  assert.deepEqual([back.is_active, back.sizes_holding], [true, 2]);
  ok(ADMIN, `UPDATE public.products SET use_timings = ARRAY['post_emergence', 'pre_emerge_corn'] WHERE id = '${H3}';`);
  console.log('[prover] case 7: a turned-off option leaves the active list; holders keep it and still save; the product page, legacy text, setup workbook, bulk import, new parent and parent edit are refused it; turning it back on works and reports holders');

  // Case 9: a retired option a parent already holds.
  const RET = addOpt('Herbicide', 'post_emergence', 'milo', 'Post-Emerge Milo', 'k-milo').code;
  const PC = call(ADMIN, create({ name: '[PROVER] Gamma', product_form: 'liquid', category: 'Herbicide', use_timings: [RET, 'pre_emerge'] },
    { product_name: '[PROVER] Gamma 1', sku: 'GA-1', inventory_unit: 'Gal' }, 'k-pc'));
  const C2 = call(ADMIN, addSize(PC.parent_id, { product_name: '[PROVER] Gamma 2', sku: 'GA-2', inventory_unit: 'Gal' }, 'k-pc2')).product_id;
  const PD = call(ADMIN, create({ name: '[PROVER] Delta', product_form: 'liquid', category: 'Herbicide', use_timings: ['post_emergence'] },
    { product_name: '[PROVER] Delta 1', sku: 'DE-1', inventory_unit: 'Gal' }, 'k-pd'));
  const D2 = call(ADMIN, addSize(PD.parent_id, { product_name: '[PROVER] Delta 2', sku: 'DE-2', inventory_unit: 'Gal' }, 'k-pd2')).product_id;
  const retired = setOpt(RET, false, 'k-off-milo');
  assert.deepEqual([retired.sizes_holding, retired.parents_holding], [2, 1]);
  const C3 = call(ADMIN, addSize(PC.parent_id, { product_name: '[PROVER] Gamma 3', sku: 'GA-3', inventory_unit: 'Gal' }, 'k-pc3')).product_id;
  assert.equal(timings(C3), `pre_emerge,${RET}|Pre-Emerge; Post-Emerge Milo`);
  const mp = call(ADMIN, `SELECT public.preview_move_product_size('${D2}', '${PC.parent_id}');`);
  assert.equal(mp.refusal, null, JSON.stringify(mp));
  call(ADMIN, `SELECT public.move_product_size('${D2}', '${PC.parent_id}', ${mp.from_parent_version}, ${mp.to_parent_version}, ${lit(mp.size_fingerprint)}, 'wrong group', 'label photo', ${J(mp.prices)}, 'k-move');`);
  assert.equal(timings(D2), `pre_emerge,${RET}|Pre-Emerge; Post-Emerge Milo`);
  call(ADMIN, editParent(PC.parent_id, { name: '[PROVER] Gamma Renamed' }, 'k-pc-name'));
  call(ADMIN, editParent(PC.parent_id, { use_timings: [RET, 'pre_emerge', 'burndown_preplant'] }, 'k-pc-add'));
  assert.equal(parentTimings(PC.parent_id), `burndown_preplant,pre_emerge,${RET}`);
  for (const pid of [PC.product_id, C2, C3, D2]) assert.equal(timings(pid), `burndown_preplant,pre_emerge,${RET}|Burndown (preplant); Pre-Emerge; Post-Emerge Milo`);
  const vD = version(PD.parent_id);
  refused(ADMIN, editParent(PD.parent_id, { use_timings: ['post_emergence', RET] }, 'k-pd-ret'), /PRODUCT_PARENT_TIMING_RETIRED: "Post-Emerge Milo"/);
  assert.equal(version(PD.parent_id), vD);
  refused(ADMIN, create({ name: '[PROVER] Epsilon', product_form: 'liquid', category: 'Herbicide', use_timings: [RET] },
    { product_name: '[PROVER] Epsilon 1', sku: 'EP-1', inventory_unit: 'Gal' }, 'k-pe-ret'), /PRODUCT_PARENT_TIMING_RETIRED/);
  assert.equal(scalar("SELECT count(*) FROM public.product_parents WHERE name = '[PROVER] Epsilon';"), '0');
  refused(ADMIN, `UPDATE public.products SET use_timings = ARRAY['post_emergence', '${RET}'] WHERE id = '${H3}';`, UNAVAILABLE);
  refused(ADMIN, setupSave(P('b2'), { use_timings: ['pre_emerge_soybean', RET] }, 'k-setup-ret'), UNAVAILABLE);
  refused(ADMIN, save([{ insert: { product_name: '[PROVER] Import Milo', sku: 'IM-MILO', category: 'Herbicide', product_form: 'liquid', inventory_unit: 'Gal', use_timing: 'Post-Emerge Milo' } }], 'k-import-ret'), UNAVAILABLE);
  // Even the owner cannot fake an inheritance without a parent copy pass.
  const owner = psql(`UPDATE public.products SET use_timings = ARRAY['${RET}'] WHERE id = '${P('b9')}';`, { allowFailure: true });
  assert.notEqual(owner.status, 0); assert.match(`${owner.stdout}${owner.stderr}`, UNAVAILABLE);
  console.log('[prover] case 9: with a held option retired, Add a size and a move into the parent succeed and inherit it; renames and additions keep it; a new or other parent and every ungrouped write path are refused it');

  // One pair once per row, on sizes and parents.
  setOpt('wheat_post', false, 'k-off-wp');
  setOpt('post_emerge_wheat', true, 'k-on-pew');
  refused(ADMIN, editParent(PC.parent_id, { use_timings: [RET, 'pre_emerge', 'burndown_preplant', 'post_emerge_wheat', 'wheat_post'] }, 'k-pc-twice'), /PRODUCT_PARENT_TIMING_RETIRED: "Wheat Post"/);
  ok(ADMIN, `UPDATE public.products SET use_timings = ARRAY['post_emerge_wheat'] WHERE id = '${P('b9')}';`);
  const reMilo = setOpt(RET, true, 'k-on-milo');
  assert.equal(reMilo.is_active, true);
  setOpt('post_emerge_wheat', false, 'k-off-pew2');
  setOpt('wheat_post', true, 'k-on-wp2');
  refused(ADMIN, `UPDATE public.products SET use_timings = ARRAY['post_emerge_wheat', 'wheat_post'] WHERE id = '${P('b9')}';`, /USE_TIMING_PAIR_TWICE: "Post-Emerge Wheat" and "Wheat Post"/);
  ownerOkPair(PC.parent_id);
  console.log('[prover] one pair once per row: a size and a parent holding a retired option cannot also take its replacement');

  // Rerun refused; the parent trigger function is not callable.
  refused(ADMIN, 'SELECT public.guard_product_parent_retired_timings();', /permission denied|trigger functions can only be called as triggers/);
  stageText('again.sql', lf(CANDIDATE));
  const again = apply('again.sql');
  assert.notEqual(again.status, 0);
  assert.match(again.output, /PREFLIGHT_USE1_ALREADY_EXISTS/);
  console.log('[prover] a second apply is refused by the preflight');
  console.log('PRODUCT_CROP_USE_PAIRS_PROOF_PASS');
}
// A parent holding the retired post_emerge_wheat (written by the owner, as before it was retired) cannot add its active replacement.
function ownerOkPair(pp) {
  const holdAndAdd = (sql) => psql(sql, { allowFailure: true });
  let r = holdAndAdd(`UPDATE public.product_parents SET use_timings = use_timings || ARRAY['post_emerge_wheat'] WHERE id = '${pp}';`);
  assert.notEqual(r.status, 0); assert.match(`${r.stdout}${r.stderr}`, /PRODUCT_PARENT_TIMING_RETIRED: "Post-Emerge Wheat"/);
  setOpt('wheat_post', false, 'k-off-wp3');
  setOpt('post_emerge_wheat', true, 'k-on-pew3');
  r = holdAndAdd(`UPDATE public.product_parents SET use_timings = use_timings || ARRAY['post_emerge_wheat'] WHERE id = '${pp}';`);
  assert.equal(r.status, 0, r.stderr);
  setOpt('post_emerge_wheat', false, 'k-off-pew4');
  setOpt('wheat_post', true, 'k-on-wp4');
  r = holdAndAdd(`UPDATE public.product_parents SET use_timings = use_timings || ARRAY['wheat_post'] WHERE id = '${pp}';`);
  assert.notEqual(r.status, 0); assert.match(`${r.stdout}${r.stderr}`, /USE_TIMING_PAIR_TWICE: "Post-Emerge Wheat" and "Wheat Post"/);
}
try { main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
