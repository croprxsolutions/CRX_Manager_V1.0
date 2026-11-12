#!/usr/bin/env node
/**
 * Real-schema proof for 20270105110000_epa_chemistry_proposals (DM-4, EPA auto-fill; build sheet
 * docs/plans/2026-11-08-product-DM4-BUILD-SHEET.md sections 6 and 13).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, seeds invented parents, sizes, brands and EPA
 * registrations, applies the candidate (and a second run, which refuses), then runs cases H1-H25 (H11 is a
 * build check, not a container case) through the real RPCs as a signed-in admin, a second admin, a sales rep,
 * anon and the service role (the epa-lookup Edge Function's role).
 *
 * Run: node scripts/smoke/prove-epa-chemistry-proposals-real-schema.mjs   (needs Docker)
 * Prints EPA_CHEMISTRY_PROPOSALS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-dm4-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270105110000_epa_chemistry_proposals.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// Data migrations that rewrite live rows this disposable database does not have, or need live's storage
// policies; recorded in the ledger (as live has them) instead of replayed. Same list as the DM-1b proof.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
  '20261217100000_job_access_ends_with_the_job.sql',
  '20261220100000_applicator_keeps_own_record_fields.sql',
]);
const ONE_SHOT = new Set(Object.keys(JSON.parse(readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8')).one_shot));
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(epa_lookup|epa_chemistry|_parent_chemistry_epa_refusal|_apply_parent_chemistry|_lock_parent_chemistry|_epa_registration|epa_registrations|product_parent_ingredients|_product_parent_replay|_product_parent_require_admin)/i;
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
// Live unit_conversions, read-only 2026-11-10 (RT-1's preflight pins them).
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
  const validate = bodyFrom('20260211000000_unit_tracking_pricing_overhaul.sql',
    /CREATE OR REPLACE FUNCTION validate_product_units\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)
    .replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
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
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
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
    if (ONE_SHOT.has(base.slice(0, -4))) { ledger(base.slice(0, -4)); continue; }
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    if (base === FORMS_SEED_EACH) restoreLiveBodies();
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
    }
    if (base === '20261229110000_product_rates_draft.sql') {
      raw(`DELETE FROM public.unit_conversions;
        INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};`);
    }
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') {
      psql(`UPDATE public.warehouses SET is_active = true WHERE name = 'Main Warehouse';
        INSERT INTO public.warehouses (name, is_active) SELECT 'Main Warehouse', true
        WHERE NOT EXISTS (SELECT 1 FROM public.warehouses WHERE name = 'Main Warehouse');`);
    }
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate`);
}

const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
const id = (n) => `d4000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = id('a1'), REP = id('a2'), ADMIN2 = id('a3');
const SERVICE = 'service';
const J = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);

function txIn(uid, sql) {
  if (uid === SERVICE) return `BEGIN;\nSET LOCAL ROLE service_role;\n${sql}\nCOMMIT;\n`;
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  return `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n`;
}
function as(uid, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: txIn(uid, sql) });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
// The same, in the background: for the two-session cases.
function asAsync(uid, sql) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ status: code, output: out, ms: Date.now() - t0, rows: out.trim().split(/\r?\n/).filter(Boolean) }));
    p.stdin.end(txIn(uid, sql));
  });
}
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
const js = (uid, sql) => JSON.parse(ok(uid, sql));
function refused(uid, sql, pattern) {
  const r = as(uid, sql);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}\n${r.output}`);
  assert.match(r.output, pattern);
  return r.output;
}
const n = (sql) => Number(scalar(sql));
const row = (sql) => JSON.parse(scalar(`SELECT COALESCE((${sql}), 'null'::jsonb);`));

// ---------------------------------------------------------------------------------------------
// Seed: one parent per case group, each with its own EPA number(s), so cases never share state.
// ---------------------------------------------------------------------------------------------
const PA = id('b01'), SA = id('c01'), BA = id('e01'), LBA = id('f01');  // H1 H2 H4 H7: number on parent, size, parent brand, legacy brand
const P3 = id('b03'), P5 = id('b05'), S5 = id('c05'), P5B = id('b55'), P6 = id('b06'), P8 = id('b08'), P9 = id('b09'), S9 = id('c09');
const P10 = id('b10'), P13 = id('b13'), P16 = id('b16'), P20 = id('b20'), S20 = id('c20'), P21 = id('b21'), P22 = id('b22');
const P24 = id('b24'), P25 = id('b25'), P26 = id('b26'), P27 = id('b27'), P28 = id('b28');
const ATRAZINE = id('aa1'), DICAMBA = id('aa2');
const CUST = id('d01'), ORD = id('d02'), INV = id('d03'), LINE = id('d04');
const PARENTS = [[PA, 'Alpha', '101-1'], [P3, 'Failures', '103-1'], [P5, 'Crop oil', '105-1'], [P5B, 'Crop oil B', '105-3'],
  [P6, 'Typed atrazine', '106-1'], [P8, 'Relookup', '108-1'], [P9, 'Two sessions', '109-1'], [P10, 'Gate', '110-1'],
  [P13, 'Rules', '113-1'], [P16, 'Cancelled', '116-1'], [P20, 'Restricted', null], [P21, 'Unregistered', '121-1'],
  [P22, 'Workbook', '122-1'], [P24, 'Mixed', '124-1'], [P25, 'Too much', '125-1'], [P26, 'Restricted upgrade', '126-1'],
  [P27, 'Shared A', '127-1'], [P28, 'Shared B', '127-1']];
// Registrations (121-1 deliberately has none). 116-1 is cancelled; 120-1 is still restricted-use unknown.
const REGS = ['101-1', '101-2', '101-3', '101-4', '103-1', '105-1', '105-2', '105-3', '106-1', '108-1', '109-1', '109-2',
  '110-1', '113-1', '116-1', '120-1', '122-1', '124-1', '125-1', '126-1', '126-2', '127-1'];

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'dm4-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'dm4-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ('${ADMIN2}', 'dm4-admin2@example.invalid', '{"full_name":"[PROVER] Admin Two","role":"admin"}'::jsonb);`);
  const parent = ([pid, name, epa]) => `('${pid}', '[PROVER] ${name}', 'liquid', 'SL', 'Herbicide', ${q(epa)}, true, '${ADMIN}', '${ADMIN}')`;
  const size = (pid, sku, epa) => `('${pid}', '[PROVER] ${sku}', '${sku}', 'liquid', 'Gal', 'Herbicide', ${q(epa)}, NULL, NULL, false, 10.00, 15.00, true)`;
  const reg = (num) => `('${num}', ${num === '116-1' ? "'cancelled', DATE '2024-01-01'" : "'unknown', NULL"}, 'unknown', '${ADMIN}', '${ADMIN}')`;
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id IN ('${ADMIN}', '${ADMIN2}');
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.product_parents (id, name, product_form, formulation_type, category, generic_epa_registration, is_active, created_by, updated_by) VALUES
      ${PARENTS.map(parent).join(', ')};
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, signal_word, rei_hours, is_rup, current_cost, tier1_price, is_active) VALUES
      ${size(SA, 'DM4-A', '101-2')}, ${size(S5, 'DM4-5', '105-2')}, ${size(S9, 'DM4-9', '109-2')}, ${size(S20, 'DM4-20', '120-1')};
    INSERT INTO public.product_parent_members (product_id, parent_id, added_by) VALUES
      ('${SA}', '${PA}', '${ADMIN}'), ('${S5}', '${P5}', '${ADMIN}'), ('${S9}', '${P9}', '${ADMIN}'), ('${S20}', '${P20}', '${ADMIN}');
    INSERT INTO public.product_parent_brands (id, parent_id, brand_name, epa_registration, created_by, updated_by)
      VALUES ('${BA}', '${PA}', '[PROVER] Alpha brand', '101-3', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_brands (id, product_id, brand_name, epa_registration, signal_word, is_rup, created_by, updated_by)
      VALUES ('${LBA}', '${SA}', '[PROVER] Alpha legacy brand', '101-4', NULL, false, '${ADMIN}', '${ADMIN}');
    INSERT INTO public.epa_registrations (epa_registration, registration_status, cancelled_on, rup_status, created_by, updated_by) VALUES
      ${REGS.map(reg).join(', ')};
    UPDATE public.epa_registrations SET rup_status = CASE epa_registration WHEN '126-2' THEN 'yes' ELSE 'no' END WHERE epa_registration IN ('126-1', '126-2');
    UPDATE public.epa_registrations SET signal_word = 'Caution', rup_status = 'no' WHERE epa_registration = '127-1';
    INSERT INTO public.epa_registration_seed_run (seeded_by, rup_default, fingerprint) VALUES ('${ADMIN}', 'unknown', 'prover');
    -- Typed chemistry (source label) on two numbered parents, as DM-1 had before the gate.
    INSERT INTO public.active_ingredients (id, name, cas, created_by, updated_by) VALUES
      ('${ATRAZINE}', 'Atrazine', '1912-24-9', '${ADMIN}', '${ADMIN}'), ('${DICAMBA}', 'Dicamba', '1918-00-9', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_ingredients (parent_id, ingredient_id, strength_value, strength_unit, strength_basis, source, source_note, created_by, updated_by) VALUES
      ('${P6}', '${ATRAZINE}', 40, 'pct_ww', 'active_ingredient', 'label', 'typed from the label', '${ADMIN}', '${ADMIN}'),
      ('${P24}', '${DICAMBA}', 30, 'pct_ww', 'active_ingredient', 'label', 'typed from the label', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_chemistry_state (parent_id, chemistry_version, updated_by) VALUES
      ('${P6}', 1, '${ADMIN}'), ('${P24}', 1, '${ADMIN}');
    -- One posted sale of the 120-1 size, with no restricted-use record.
    INSERT INTO public.customers (id, farm_name) VALUES ('${CUST}', '[PROVER] Farm');
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES ('${ORD}', 'DM4-O1', '${CUST}', 'confirmed');
    INSERT INTO public.invoices (id, customer_id, order_id, invoice_number, status, invoice_date, posted_at, created_by) VALUES
      ('${INV}', '${CUST}', '${ORD}', 'DM4-I1', 'posted', current_date, now(), '${ADMIN}');
    INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents, epa_registration)
      VALUES ('${LINE}', '${INV}', '${S20}', '[PROVER] line', 2, 'Gal', 1500, 3000, '120-1');`);
  console.log(`[prover] seeded: ${PARENTS.length} parents, 4 sizes, a parent brand, a legacy brand, ${REGS.length} registrations (one cancelled), two typed rows, one posted sale`);
}

// ---------------------------------------------------------------------------------------------
// EPA results (the epa-lookup Edge Function's shape) and RPC calls
// ---------------------------------------------------------------------------------------------
const CAS = { Glyphosate: '1071-83-6', Atrazine: '1912-24-9', Dicamba: '1918-00-9', '2,4-D': '94-75-7', Mesotrione: '104206-82-8' };
const found = (num, ings, extra = {}) => ({
  found: true, regType: 'section3', eparegno: num, productname: `[PROVER] ${num}`, manufacturer: 'Prover Co', productStatus: 'Registered',
  latestLabelPdfUrl: null, signalWordCanonical: 'Caution', needsManual: false, isCancelled: false, rupYn: 'No',
  activeIngredients: ings.map(([name, percent, cas = CAS[name] ?? null]) => ({ name, percent, pcCode: null, casNumber: cas })),
  labelPdfs: [], ...extra,
});
const notFound = (extra = {}) => ({
  found: false, regType: 'section3', eparegno: null, productname: null, manufacturer: null, productStatus: null,
  latestLabelPdfUrl: null, signalWordCanonical: null, needsManual: false, isCancelled: false, rupYn: null,
  activeIngredients: [], labelPdfs: [], ...extra,
});
let seq = 0;
const key = (tag) => `dm4-${tag}-${++seq}`;
const START = (pid, num, k = key('s')) => `SELECT public.start_epa_lookup('${pid}', ${q(num)}, ${q(k)});`;
const RECORD = (lid, result, k = key('r')) => `SELECT public.record_epa_lookup('${lid}', ${J(result)}, ${q(k)});`;
const COMMIT = (pid, ver, decisions = [], k = key('c')) => `SELECT public.commit_epa_proposal('${pid}', ${ver}, ${J(decisions)}, ${q(k)});`;
const REJECT = (pid, ver, reason = 'not this one', k = key('j')) => `SELECT public.reject_epa_proposal('${pid}', ${ver}, ${q(reason)}, ${q(k)});`;
const SETREG = (num, ver, changes, k = key('g')) => `SELECT public.set_epa_registration('${num}', ${ver ?? 'NULL'}, ${J(changes)}, 'label checked', NULL, ${q(k)});`;
const start = (pid, num) => js(ADMIN, START(pid, num));
const record = (lid, result) => js(SERVICE, RECORD(lid, result));
// Start and record in one go; returns the record result.
const lookup = (pid, num, result) => record(start(pid, num).lookup_id, result);
const proposal = (pid) => row(`SELECT to_jsonb(p) FROM public.epa_chemistry_proposals p WHERE id = '${pid}'`);
const item = (p, itemId) => p.items.find((i) => i.item_id === itemId);
const reg = (num) => row(`SELECT to_jsonb(r) FROM public.epa_registrations r WHERE epa_registration = '${num}'`);
const chemVer = (pid) => n(`SELECT COALESCE((SELECT chemistry_version FROM public.product_parent_chemistry_state WHERE parent_id = '${pid}'), 0);`);
const ingRows = (pid) => JSON.parse(scalar(`SELECT COALESCE(jsonb_agg(jsonb_build_object('name', a.name, 'strength', ppi.strength_value, 'source', ppi.source, 'note', ppi.source_note) ORDER BY a.name), '[]')
  FROM public.product_parent_ingredients ppi JOIN public.active_ingredients a ON a.id = ppi.ingredient_id WHERE ppi.parent_id = '${pid}' AND ppi.status = 'active';`));
const gate = (pid) => scalar(`SELECT public._parent_chemistry_epa_refusal('${pid}');`);
const openCount = (pid) => n(`SELECT count(*) FROM public.epa_chemistry_proposals WHERE parent_id = '${pid}' AND status IN ('proposed', 'held');`);
const chemEvents = (pid) => n(`SELECT count(*) FROM public.product_chemistry_events WHERE parent_id = '${pid}';`);
const typedAdd = (name, value = 5) => [{ kind: 'ingredient', name, strength_value: value, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'label', source_note: `${name} label` }];

function caseH1H2() {
  const l = start(PA, '101-1');
  assert.equal(l.link_kind, 'parent'); assert.equal(l.registration_version, 1); assert.equal(l.chemistry_version, 0);
  assert.equal(n('SELECT count(*) FROM public.epa_chemistry_proposals;'), 0, 'a start writes no proposal');
  const r = record(l.lookup_id, found('101-1', [['Glyphosate', 41]]));
  assert.equal(r.outcome, 'proposal');
  const p = proposal(r.proposal_id);
  assert.equal(p.status, 'proposed'); assert.equal(p.proposal_version, 1); assert.equal(p.link_kind, 'parent');
  assert.deepEqual(p.items.map((i) => `${i.item_id}=${i.class}`),
    ['ing:cas:1071-83-6=add', 'label:signal_word=fill', 'label:rup_status=fill', 'label:registration_status=differs']);
  assert.equal(item(p, 'ing:cas:1071-83-6').change.source, 'epa_lookup');
  assert.equal(chemVer(PA), 0); assert.deepEqual(ingRows(PA), []);
  assert.equal(reg('101-1').registration_version, 1); assert.equal(reg('101-1').signal_word, null);
  assert.equal(scalar(`SELECT status FROM public.epa_lookups WHERE id = '${l.lookup_id}';`), 'recorded');
  console.log('[case] H1 a usable number: start, then a found result makes one proposal; nothing is written to chemistry or the registration');

  const kinds = {};
  for (const [num, kind] of [['101-2', 'size'], ['101-3', 'parent_brand'], ['101-4', 'legacy_brand']]) {
    const s = start(PA, num);
    assert.equal(s.link_kind, kind, num);
    const rr = record(s.lookup_id, found(num, [['Glyphosate', 41]]));
    kinds[num] = proposal(rr.proposal_id);
    assert.equal(kinds[num].link_kind, kind); assert.equal(kinds[num].epa_registration, num);
  }
  assert.equal(openCount(PA), 4, 'each number on the parent has its own open proposal');
  console.log('[case] H2 the size, parent-brand and legacy-brand numbers each get their own lookup and proposal, bound to their link');
  return { main: p, ...kinds };
}

function caseH4H7(ps) {
  const before = reg('101-1');
  const c = js(ADMIN, COMMIT(ps.main.id, 1));
  assert.equal(c.status, 'committed'); assert.equal(c.chemistry_version, 1); assert.equal(c.registration_version, 2);
  assert.deepEqual(c.counts, { written: 3, kept_difference: 1 }); assert.deepEqual(c.posted_sales_to_record, []);
  assert.deepEqual(ingRows(PA), [{ name: 'Glyphosate', strength: 41, source: 'epa_lookup', note: 'EPA lookup of 101-1' }]);
  assert.equal(scalar(`SELECT event_type || '|' || (after_values->>'source_path') || '|' || changed_by FROM public.product_chemistry_events WHERE parent_id = '${PA}';`), `set|epa|${ADMIN}`);
  const after = reg('101-1');
  assert.equal(after.signal_word, 'Caution'); assert.equal(after.rup_status, 'no'); assert.equal(after.source, 'epa_lookup');
  assert.ok(after.checked_at); assert.equal(after.updated_by, ADMIN); assert.equal(after.registration_status, before.registration_status);
  assert.equal(scalar(`SELECT event_type || '|' || changed_by || '|' || (before_values->>'registration_version') || '>' || (after_values->>'registration_version') FROM public.epa_registration_events WHERE epa_registration = '101-1';`), `updated|${ADMIN}|1>2`);
  assert.equal(scalar(`SELECT COALESCE(signal_word, 'none') FROM public.products WHERE id = '${SA}';`), 'none', 'nothing is copied to sizes (REG-1 simplified)');
  const p = proposal(ps.main.id);
  assert.equal(p.status, 'committed'); assert.equal(p.proposal_version, 2); assert.equal(p.decided_by, ADMIN);
  console.log('[case] H4 a commit writes the accepted ingredient (source epa_lookup, one "set" event) and label facts through the registration writer (version 2, its event by the admin); sizes are not touched');

  // Holds, in the order the commit checks them; nothing is written and the hold stays.
  raw(`UPDATE public.product_parent_brands SET epa_registration = '199-9' WHERE id = '${BA}';`);
  js(ADMIN, SETREG('101-4', 1, { signal_word: 'Danger' }));
  for (const [num, reason] of [['101-3', 'relinked'], ['101-4', 'registration_changed'], ['101-2', 'chemistry_changed']]) {
    const regV = reg(num).registration_version;
    const h = js(ADMIN, COMMIT(ps[num].id, 1));
    assert.equal(h.status, 'held', num); assert.equal(h.hold_reason, reason, num); assert.equal(h.proposal_version, 2);
    const hp = proposal(ps[num].id);
    assert.equal(hp.status, 'held'); assert.equal(hp.hold_reason, reason);
    assert.equal(reg(num).registration_version, regV, `${num}: nothing written to the registration`);
    refused(ADMIN, COMMIT(ps[num].id, 2), /EPA_PROPOSAL_NOT_OPEN: this proposal is held/);
  }
  assert.equal(chemVer(PA), 1, 'no hold wrote chemistry');
  assert.equal(js(ADMIN, REJECT(ps['101-2'].id, 2)).status, 'rejected', 'a held proposal can be rejected');
  console.log('[case] H7 a relinked number, a changed registration and changed chemistry each hold the commit by name; nothing is written; the hold stays; a held proposal can be rejected');
}

function caseH3() {
  const reasons = [];
  const cases = [
    ['not_found', notFound()],
    ['upstream_error', { error: 'EPA PPLS timed out' }],
    ['transferred', notFound({ transferredTo: '999-1' })],
    ['invalid_result', { ...found('103-1', [['Glyphosate', 41]]), found: 'yes' }],
    ['invalid_result', found('103-9', [['Glyphosate', 41]])],  // EPA answered for another number
    ['invalid_result', found('103-1', [['Glyphosate', 141]])],
  ];
  for (const [reason, result] of cases) {
    const s = start(P3, '103-1');
    const r = record(s.lookup_id, result);
    assert.equal(r.outcome, 'failure'); assert.equal(r.reason, reason);
    const f = row(`SELECT to_jsonb(f) FROM public.epa_lookup_failures f WHERE id = '${r.failure_id}'`);
    assert.equal(f.lookup_id, s.lookup_id); assert.equal(f.epa_registration, '103-1'); assert.equal(f.registration_version, 1);
    assert.equal(f.link_kind, 'parent'); assert.equal(f.link_id, P3); assert.equal(f.created_by, ADMIN);
    if (reason === 'transferred') assert.equal(f.transferred_to, '999-1');
    reasons.push(f.reason);
  }
  assert.equal(n(`SELECT count(*) FROM public.epa_chemistry_proposals WHERE parent_id = '${P3}';`), 0);
  assert.equal(chemVer(P3), 0); assert.equal(reg('103-1').registration_version, 1);
  refused(ADMIN, `UPDATE public.epa_lookup_failures SET detail = 'x';`, /permission denied for table/);
  console.log(`[case] H3 not found, an EPA error, a transfer and three malformed results each leave one failure row (${reasons.join(', ')}), listed by number with its lookup, version and link; no proposal; nothing else changes`);
}

function caseH5() {
  const oil = (num) => found(num, [['Prover  Crop Oil', 10, null]]);
  const r1 = lookup(P5, '105-1', oil('105-1'));
  const p1 = proposal(r1.proposal_id);
  const it = item(p1, 'ing:name:prover crop oil');
  assert.equal(it.class, 'add_name_only'); assert.equal(it.accept_default, false, 'a name-only ingredient waits for a tick');
  const c1 = js(ADMIN, COMMIT(p1.id, 1, [{ item_id: it.item_id, accept: true }]));
  assert.equal(c1.commit_result[it.item_id], 'written');
  const r2 = lookup(P5, '105-2', oil('105-2'));
  const p2 = proposal(r2.proposal_id);
  assert.equal(item(p2, 'ing:name:prover crop oil').class, 'confirm', 'the second lookup matches the first row');
  const c2 = js(ADMIN, COMMIT(p2.id, 1));
  assert.equal(c2.commit_result['ing:name:prover crop oil'], 'confirmed'); assert.equal(c2.chemistry_version, 1, 'a confirm changes no chemistry');
  const r3 = lookup(P5B, '105-3', oil('105-3'));
  js(ADMIN, COMMIT(r3.proposal_id, 1, [{ item_id: 'ing:name:prover crop oil', accept: true }]));
  // DM-1 (D-AA) never joins name-only ingredients across parents: the other parent gets its own provisional row.
  assert.equal(n(`SELECT count(DISTINCT ingredient_id) FROM public.product_parent_ingredients WHERE parent_id = '${P5}';`), 1, 'one provisional ingredient on the parent, not two');
  assert.equal(n("SELECT count(*) FROM public.active_ingredients WHERE name_key = 'prover crop oil' AND cas IS NULL;"), 2);
  // Sol 2026-11-11: a name-only entry and a same-name entry with a CAS number are one ingredient, not two.
  const merged = JSON.parse(scalar(`SELECT public._epa_lookup_input(${J(found('105-1', [['glyphosate', 41, null], ['Glyphosate', 41]]))}::jsonb)->'ingredients';`));
  assert.equal(merged.length, 1, 'one ingredient'); assert.equal(merged[0].key, `cas:${CAS.Glyphosate}`); assert.equal(merged[0].cas, CAS.Glyphosate);
  // Luna 2026-11-11: the name under two CAS numbers plus once with none: the CAS-less entry joins neither and is one
  // unticked conflict with no row.
  const amb = found('105-1', [['Glyphosate', 41, CAS.Glyphosate], ['Glyphosate', 20, CAS.Atrazine], ['Glyphosate', 10, null]]);
  const ambIn = JSON.parse(scalar(`SELECT public._epa_lookup_input(${J(amb)}::jsonb)->'ingredients';`));
  assert.equal(ambIn.length, 3); assert.deepEqual(ambIn.map((i) => i.ambiguous), [false, false, true]);
  const ambItem = JSON.parse(scalar(`SELECT public._epa_proposal_items('${P5}', '105-1', public._epa_lookup_input(${J(amb)}::jsonb));`))
    .find((i) => i.item_id === 'ing:name:glyphosate');
  assert.equal(ambItem.class, 'epa_conflict'); assert.equal(ambItem.accept_default, false); assert.equal(ambItem.current, null);
  console.log('[case] H5 a name-only ingredient needs a tick; a second lookup of the parent confirms the same row (no duplicate); another parent gets its own provisional row, as DM-1 rules; a name under several CAS numbers is one unticked conflict');
}

function caseH6H23() {
  const r = lookup(P6, '106-1', found('106-1', [['Atrazine', 42.5]]));
  const p = proposal(r.proposal_id);
  const it = item(p, 'ing:cas:1912-24-9');
  assert.equal(it.class, 'differs_typed'); assert.equal(Number(it.current.strength_value), 40); assert.equal(it.change ?? null, null);
  refused(ADMIN, COMMIT(p.id, 1, [{ item_id: it.item_id, accept: true }]), /EPA_DECISION_NOT_WRITABLE/);
  const c = js(ADMIN, COMMIT(p.id, 1));
  assert.equal(c.status, 'committed'); assert.equal(c.commit_result[it.item_id], 'kept_difference');
  assert.deepEqual(ingRows(P6), [{ name: 'Atrazine', strength: 40, source: 'label', note: 'typed from the label' }]);
  assert.equal(chemVer(P6), 1);
  console.log('[case] H6 typed chemistry that disagrees is a difference: accepting it is refused, the commit keeps the typed 40% and says kept_difference');

  // H23: the repair is a DM-1 correction retiring the typed row, then a new lookup proposes the EPA row.
  const rowId = scalar(`SELECT id FROM public.product_parent_ingredients WHERE parent_id = '${P6}' AND status = 'active';`);
  const changes = [{ kind: 'ingredient', action: 'retire', row_id: rowId }];
  const pv = js(ADMIN, `SELECT public.preview_parent_chemistry_correction('${P6}', ${J(changes)});`);
  js(ADMIN, `SELECT public.correct_parent_chemistry('${P6}', 1, ${q(pv.preview_fingerprint)}, ${J(changes)}, 'typed value was wrong', 'EPA label 106-1', ${q(key('x'))});`);
  const r2 = lookup(P6, '106-1', found('106-1', [['Atrazine', 42.5]]));
  assert.equal(item(proposal(r2.proposal_id), 'ing:cas:1912-24-9').class, 'add');
  js(ADMIN, COMMIT(r2.proposal_id, 1));
  assert.deepEqual(ingRows(P6), [{ name: 'Atrazine', strength: 42.5, source: 'epa_lookup', note: 'EPA lookup of 106-1' }]);
  console.log('[case] H23 retiring the typed row by correction, then looking up again, proposes and writes the EPA value');
}

function caseH8H19() {
  const a = lookup(P8, '108-1', found('108-1', [['Glyphosate', 41]]));
  const sB = start(P8, '108-1');
  const b = record(sB.lookup_id, found('108-1', [['Glyphosate', 48.7]]));
  const pa = proposal(a.proposal_id);
  assert.equal(pa.status, 'superseded'); assert.equal(pa.superseded_by_lookup_id, sB.lookup_id); assert.equal(pa.proposal_version, 2);
  assert.equal(openCount(P8), 1);
  const f = lookup(P8, '108-1', notFound());
  assert.equal(f.outcome, 'failure');
  assert.equal(proposal(b.proposal_id).status, 'proposed', 'a failure never removes an open proposal');
  // Sol 2026-11-11: a transfer does supersede it, so the old number's facts can never be committed.
  const sT = start(P8, '108-1');
  assert.equal(record(sT.lookup_id, notFound({ transferredTo: '999-1' })).outcome, 'failure');
  const pb = proposal(b.proposal_id);
  assert.equal(pb.status, 'superseded'); assert.equal(pb.superseded_by_lookup_id, sT.lookup_id); assert.equal(openCount(P8), 0);
  refused(ADMIN, COMMIT(b.proposal_id, pb.proposal_version), /EPA_PROPOSAL_NOT_OPEN: this proposal is superseded/);
  console.log('[case] H8 a new lookup supersedes the open proposal (one open per number and parent); a later error or not-found leaves the open one alone; a transfer supersedes it and it cannot be committed');

  const s = start(P8, '108-1');
  const k = key('r19');
  const first = js(SERVICE, RECORD(s.lookup_id, found('108-1', [['Glyphosate', 30]]), k));
  const total = n('SELECT count(*) FROM public.epa_chemistry_proposals;');
  assert.deepEqual(js(SERVICE, RECORD(s.lookup_id, found('108-1', [['Glyphosate', 99]]), k)), first, 'the first answer wins');
  assert.equal(n('SELECT count(*) FROM public.epa_chemistry_proposals;'), total);
  refused(SERVICE, RECORD(s.lookup_id, found('108-1', [['Glyphosate', 99]])), /EPA_LOOKUP_NOT_PENDING: this lookup is recorded/);
  console.log('[case] H19 a record retry with a different EPA answer replays the first result and writes nothing; a new key on a recorded lookup is refused');
}

function caseH10() {
  const write = (ver, name) => `SELECT public.set_parent_chemistry('${P10}', ${ver}, ${J(typedAdd(name))}, ${q(key('t'))});`;
  assert.match(gate(P10), /CHEMISTRY_FROM_EPA_ONLY: .*110-1/);
  refused(ADMIN, write(0, 'Prover Typed A'), /CHEMISTRY_FROM_EPA_ONLY/);
  lookup(P10, '110-1', notFound());
  assert.equal(gate(P10), '', 'a current not-found answer excuses the number');
  assert.equal(js(ADMIN, write(0, 'Prover Typed A')).chemistry_version, 1, 'typed chemistry is accepted');
  lookup(P10, '110-1', { error: 'EPA PPLS timed out' });
  assert.match(gate(P10), /110-1/, 'a newer EPA error ends the excuse');
  refused(ADMIN, write(1, 'Prover Typed B'), /CHEMISTRY_FROM_EPA_ONLY/);
  lookup(P10, '110-1', notFound());
  assert.equal(gate(P10), '');
  js(ADMIN, SETREG('110-1', 1, { signal_word: 'Caution' }));
  assert.match(gate(P10), /110-1/, 'a registration change ends the excuse');
  lookup(P10, '110-1', notFound());
  assert.equal(gate(P10), '');
  raw(`UPDATE public.product_parents SET generic_epa_registration = NULL WHERE id = '${P10}';
       UPDATE public.product_parents SET generic_epa_registration = '110-1' WHERE id = '${P10}';`);
  assert.equal(gate(P10), '', 'the same link carrying the same number keeps the excuse');
  const sx = start(P10, '110-1');
  assert.match(gate(P10), /110-1/, 'a pending lookup ends the excuse while it can still be recorded');
  raw(`UPDATE public.epa_lookups SET requested_at = requested_at - interval '2 hours' WHERE parent_id = '${P10}' AND id <> '${sx.lookup_id}';
       UPDATE public.epa_lookups SET requested_at = now() - interval '31 minutes' WHERE id = '${sx.lookup_id}';`);
  assert.equal(gate(P10), '', 'an expired pending lookup is ignored: the not-found answer is current again');
  const s = start(P10, '110-1');
  assert.match(gate(P10), /110-1/, 'a newer pending lookup ends the excuse');
  const r = record(s.lookup_id, found('110-1', [['Glyphosate', 41]]));
  assert.match(gate(P10), /110-1/);
  js(ADMIN, REJECT(r.proposal_id, 1));
  assert.match(gate(P10), /110-1/, 'the newest answer is a find, so the number stays gated');
  lookup(P10, '110-1', notFound());
  assert.match(gate(P10), /110-1/, 'once EPA has found the number (even a rejected proposal), a later empty answer never excuses it');
  console.log('[case] H10 the gate: a current not-found excuses the number and typed chemistry saves; a newer error, a registration change, a newer lookup or any proposal (even rejected) gates it again; an expired lookup is ignored');
}

function caseH12H13H14H17H18() {
  // H18: an older lookup recorded after a newer start.
  const s1 = start(P13, '113-1');
  const s2 = start(P13, '113-1');
  assert.equal(scalar(`SELECT status FROM public.epa_lookups WHERE id = '${s1.lookup_id}';`), 'abandoned');
  refused(SERVICE, RECORD(s1.lookup_id, found('113-1', [['Glyphosate', 41]])), /EPA_LOOKUP_SUPERSEDED/);
  assert.equal(n(`SELECT count(*) FROM public.epa_chemistry_proposals WHERE lookup_id = '${s1.lookup_id}';`), 0);
  console.log('[case] H18 an older lookup recorded after a newer start is refused EPA_LOOKUP_SUPERSEDED; it stays abandoned with no proposal');

  // H14: provenance.
  refused(ADMIN, RECORD(s2.lookup_id, found('113-1', [['Glyphosate', 41]])), /permission denied for function record_epa_lookup/);
  raw(`UPDATE public.profiles SET is_active = false WHERE id = '${ADMIN}';`);
  refused(SERVICE, RECORD(s2.lookup_id, found('113-1', [['Glyphosate', 41]])), /EPA_LOOKUP_ACTOR/);
  raw(`UPDATE public.profiles SET is_active = true WHERE id = '${ADMIN}';`);
  console.log('[case] H14 an admin cannot record a result; the service role records it as the admin who started the lookup, who must still be active');

  // H13: expired, stale and closed.
  const s3 = start(P13, '113-1');
  // Back-date every lookup of the number, keeping s3 the newest, so only its age is wrong.
  raw(`UPDATE public.epa_lookups SET requested_at = now() - interval '2 hours' WHERE parent_id = '${P13}' AND id <> '${s3.lookup_id}';
       UPDATE public.epa_lookups SET requested_at = now() - interval '31 minutes' WHERE id = '${s3.lookup_id}';`);
  refused(SERVICE, RECORD(s3.lookup_id, found('113-1', [['Glyphosate', 41]])), /EPA_LOOKUP_EXPIRED/);
  refused(SERVICE, RECORD(start(P13, '113-1').lookup_id, { pad: 'x'.repeat(270000) }), /EPA_RESULT_TOO_LARGE/);
  const r = lookup(P13, '113-1', found('113-1', [['Glyphosate', 41]]));
  refused(ADMIN, COMMIT(r.proposal_id, 2), /EPA_PROPOSAL_STALE/);
  refused(ADMIN, REJECT(r.proposal_id, 1, '  '), /EPA_REJECT_REASON_REQUIRED/);
  refused(ADMIN, COMMIT(r.proposal_id, 1, [{ item_id: 'ing:cas:0000-00-0', accept: true }]), /EPA_DECISION_UNKNOWN_ITEM/);
  refused(ADMIN, COMMIT(r.proposal_id, 1, [{ item_id: 'label:signal_word', accept: 'yes' }]), /EPA_DECISION_INVALID/);
  refused(ADMIN, COMMIT(r.proposal_id, 1, [{ item_id: 'label:signal_word', accept: true }, { item_id: 'label:signal_word', accept: false }]), /decided twice/);
  refused(ADMIN, COMMIT(r.proposal_id, 1, [{ item_id: 'label:registration_status', accept: true }]), /EPA_DECISION_NOT_WRITABLE/);
  js(ADMIN, REJECT(r.proposal_id, 1, 'wrong product'));
  refused(ADMIN, COMMIT(r.proposal_id, 2), /EPA_PROPOSAL_NOT_OPEN: this proposal is rejected/);
  refused(ADMIN, `UPDATE public.epa_chemistry_proposals SET status = 'proposed';`, /permission denied for table/);
  refused(ADMIN, `DELETE FROM public.epa_chemistry_proposals;`, /permission denied for table/);
  console.log('[case] H13 an expired lookup, an oversized result, a wrong version, a blank reason, unknown, malformed, doubled or unwritable decisions, and a commit after reject are refused by name');

  // H12: who may call what, and replays.
  const props = scalar('SELECT id FROM public.epa_chemistry_proposals LIMIT 1;');
  for (const sql of [START(P13, '113-1'), COMMIT(props, 1), REJECT(props, 1)]) {
    refused(REP, sql, /ADMIN_REQUIRED/);
    refused(null, sql, /permission denied for function/);
  }
  refused(REP, RECORD(s2.lookup_id, notFound()), /permission denied for function record_epa_lookup/);
  refused(null, RECORD(s2.lookup_id, notFound()), /permission denied for function record_epa_lookup/);
  refused(ADMIN, START(P13, '113-1', null), /IDEMPOTENCY_KEY_REQUIRED/);
  refused(SERVICE, RECORD(s2.lookup_id, notFound(), ''), /IDEMPOTENCY_KEY_REQUIRED/);
  const k = key('s12');
  const once = js(ADMIN, START(P13, '113-1', k));
  assert.deepEqual(js(ADMIN, START(P13, '113-1', k)), once, 'the same key replays the same start');
  assert.equal(n(`SELECT count(*) FROM public.epa_lookups WHERE parent_id = '${P13}' AND status = 'pending';`), 1);
  refused(ADMIN, START(P8, '108-1', k), /IDEMPOTENCY/);
  refused(ADMIN2, START(P13, '113-1', k), /IDEMPOTENCY/);
  refused(ADMIN, START(P13, '9999999-1'), /EPA_NUMBER_INVALID/);
  refused(ADMIN, START(P13, '101-1'), /EPA_NUMBER_NOT_ON_PARENT/);
  for (const fn of ['_epa_link_carries(uuid,text,text,uuid)', '_epa_find_link(uuid,text)', '_epa_proposal_items(uuid,text,jsonb)', '_epa_lookup_input(jsonb)', '_parent_chemistry_epa_refusal(uuid)']) {
    assert.equal(ok(ADMIN, `SELECT has_function_privilege('public.${fn}', 'EXECUTE');`), 'f', `${fn} is private`);
  }
  console.log('[case] H12 a sales rep and anon are refused by all four functions; the same key replays, another body or caller under it is refused; the helpers are private');

  // H17: read access.
  for (const t of ['epa_lookups', 'epa_lookup_failures', 'epa_chemistry_proposals']) {
    assert.equal(ok(REP, `SELECT count(*) FROM public.${t};`), '0', `a sales rep reads no ${t}`);
    assert.ok(Number(ok(ADMIN, `SELECT count(*) FROM public.${t};`)) > 0, `an admin reads ${t}`);
    refused(null, `SELECT count(*) FROM public.${t};`, /permission denied for table/);
  }
  console.log('[case] H17 a sales rep reads 0 rows from the three tables; an admin reads them; anon is refused');
}

function caseH16() {
  const r = lookup(P16, '116-1', found('116-1', [['Glyphosate', 41]], { labelPdfs: [
    { fileName: 'bad.pdf', acceptedDate: '2026-02-30', url: 'https://www3.epa.gov/bad.pdf' },
    { fileName: 'good.pdf', acceptedDate: '05/01/2025', url: 'https://www3.epa.gov/good.pdf' },
  ] }));
  const p = proposal(r.proposal_id);
  const doc = item(p, 'label:label_document');
  assert.equal(doc.class, 'fill'); assert.match(doc.note, /1 label date\(s\) from EPA could not be read/);
  const st = item(p, 'label:registration_status');
  assert.equal(st.class, 'differs'); assert.match(st.note, /EPA lists this registration as active/);
  const c = js(ADMIN, COMMIT(p.id, 1));
  assert.equal(c.status, 'committed'); assert.equal(c.commit_result['label:registration_status'], 'kept_difference');
  const after = reg('116-1');
  assert.equal(after.label_accepted_on, '2025-05-01'); assert.equal(after.label_url, 'https://www3.epa.gov/good.pdf');
  assert.equal(after.registration_status, 'cancelled', 'the status is never written');
  // Luna 2026-11-11: an undated EPA link is not filled beside an existing date; it is shown as a difference.
  raw(`UPDATE public.epa_registrations SET label_url = NULL WHERE epa_registration = '116-1';`);
  const undated = JSON.parse(scalar(`SELECT public._epa_proposal_items('${P16}', '116-1', public._epa_lookup_input(${J(found('116-1', [], { latestLabelPdfUrl: 'https://www3.epa.gov/undated.pdf' }))}));`))
    .find((i) => i.item_id === 'label:label_document');
  assert.equal(undated.class, 'differs'); assert.equal(undated.change ?? null, null);
  raw(`UPDATE public.epa_registrations SET label_url = 'https://www3.epa.gov/good.pdf' WHERE epa_registration = '116-1';`);
  // Luna 2026-11-11: "transferred to" the number being looked up is not a move.
  assert.match(scalar(`SELECT public._epa_lookup_shape_error(${J(notFound({ transferredTo: '116-1' }))}, '116-1');`), /transferredTo is the number being looked up/);
  console.log('[case] H16 an unreadable label date is ignored with a note and the commit succeeds with the good one; "active" against a cancelled registration is shown as a difference, never written; an undated link beside a date is a difference; a transfer to itself is unreadable');
}

function caseH20H21() {
  const r = lookup(P20, '120-1', found('120-1', [['Glyphosate', 41]], { rupYn: 'Yes' }));
  const p = proposal(r.proposal_id);
  assert.equal(p.link_kind, 'size');
  assert.equal(item(p, 'label:rup_status').class, 'fill');
  const k = key('c20');
  const c = js(ADMIN, COMMIT(p.id, 1, [], k));
  assert.equal(reg('120-1').rup_status, 'yes');
  assert.deepEqual(c.posted_sales_to_record.map((x) => x.invoice_item_id), [LINE], 'the posted sale that now needs a record is listed');
  assert.deepEqual(js(ADMIN, COMMIT(p.id, 1, [], k)), c, 'the replay carries the same list');
  console.log('[case] H20 a commit that turns restricted-use to yes lists the posted sales that now need records, and its replay returns the same list');

  refused(ADMIN, START(P21, '121-1'), /EPA_REGISTRATION_MISSING: .*121-1/);
  js(ADMIN, SETREG('121-1', null, { rup_status: 'unknown' }));
  assert.equal(start(P21, '121-1').link_kind, 'parent');
  console.log('[case] H21 a number with no registration is refused at start by name; after the registration is created, the lookup starts');
}

function caseH26() {
  // Mason 2026-11-11 ("Yes, tickable"): EPA restricted-use over our "no" is tickable, unticked by default.
  const r = lookup(P26, '126-1', found('126-1', [], { rupYn: 'Yes' }));
  let it = item(proposal(r.proposal_id), 'label:rup_status');
  assert.equal(it.class, 'rup_upgrade'); assert.equal(it.accept_default, false); assert.match(it.note, /restricted use/);
  const c = js(ADMIN, COMMIT(r.proposal_id, 1));
  assert.equal(c.commit_result['label:rup_status'], 'skipped'); assert.equal(reg('126-1').rup_status, 'no', 'unticked: nothing changes');
  const r2 = lookup(P26, '126-1', found('126-1', [], { rupYn: 'Yes' }));
  const c2 = js(ADMIN, COMMIT(r2.proposal_id, 1, [{ item_id: 'label:rup_status', accept: true }]));
  assert.equal(c2.commit_result['label:rup_status'], 'written'); assert.equal(reg('126-1').rup_status, 'yes');
  assert.ok(Array.isArray(c2.posted_sales_to_record));
  // The other way (our "yes", EPA "no") stays a difference that cannot be ticked.
  raw(`UPDATE public.product_parents SET generic_epa_registration = '126-2' WHERE id = '${P26}';`);
  const r3 = lookup(P26, '126-2', found('126-2', [], { rupYn: 'No' }));
  it = item(proposal(r3.proposal_id), 'label:rup_status');
  assert.equal(it.class, 'differs');
  refused(ADMIN, COMMIT(r3.proposal_id, 1, [{ item_id: 'label:rup_status', accept: true }]), /EPA_DECISION_NOT_WRITABLE/);
  console.log('[case] H26 EPA restricted-use over our "no" is a tick box, unticked by default: left alone nothing changes, ticked it records yes; EPA "no" over our "yes" cannot be ticked');
}

function caseH22() {
  lookup(P22, '122-1', notFound());
  assert.equal(gate(P22), '');
  const up = [{ parent_id: P22, expected_chemistry_version: 0, row_id: null, name: 'Prover Safener', cas: null, strength_value: null,
    strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'label', source_note: 'label page 1' }];
  const wp = js(ADMIN, `SELECT public.commit_ingredients_tab(${J(up)}, ${q(key('w'))});`).proposals[0];
  lookup(P22, '122-1', found('122-1', [['Glyphosate', 41]]));
  refused(ADMIN, `SELECT public.promote_chemistry_proposal('${wp.proposal_id}', 1, 'apply', ${q(key('w'))});`, /CHEMISTRY_FROM_EPA_ONLY/);
  assert.deepEqual(ingRows(P22), []);
  console.log('[case] H22 a workbook upload made while the number was excused is refused at apply once EPA has found the number');
}

function caseH24() {
  const before = reg('124-1');
  const r = lookup(P24, '124-1', found('124-1', [['Dicamba', 35]]));
  const p = proposal(r.proposal_id);
  assert.deepEqual(p.items.map((i) => `${i.item_id}=${i.class}`),
    ['ing:cas:1918-00-9=differs_typed', 'label:signal_word=fill', 'label:rup_status=fill', 'label:registration_status=differs']);
  const c = js(ADMIN, COMMIT(p.id, 1, [{ item_id: 'label:signal_word', accept: true }, { item_id: 'label:rup_status', accept: false }]));
  assert.deepEqual(c.commit_result, { 'ing:cas:1918-00-9': 'kept_difference', 'label:signal_word': 'written', 'label:rup_status': 'skipped', 'label:registration_status': 'kept_difference' });
  const after = reg('124-1');
  const moved = ['signal_word', 'checked_at', 'source', 'registration_version', 'updated_by', 'updated_at'];
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k2]) => !moved.includes(k2)));
  assert.deepEqual(strip(after), strip(before), 'only the accepted key (and its stamp) changes');
  assert.equal(after.signal_word, 'Caution'); assert.equal(after.rup_status, 'unknown'); assert.equal(after.label_url, null);
  assert.deepEqual(ingRows(P24), [{ name: 'Dicamba', strength: 30, source: 'label', note: 'typed from the label' }]);
  console.log('[case] H24 a mixed proposal (one fill ticked, one unticked, one difference, no EPA link) changes only the ticked signal word');
}

function caseH25() {
  const r = lookup(P25, '125-1', found('125-1', [['2,4-D', 60], ['Mesotrione', 50]]));
  const pid = r.proposal_id;
  const counts = () => [n('SELECT count(*) FROM public.active_ingredients;'), chemVer(P25), chemEvents(P25), reg('125-1').registration_version,
    n("SELECT count(*) FROM public.epa_registration_events WHERE epa_registration = '125-1';"), proposal(pid).status, proposal(pid).proposal_version];
  const was = counts();
  const bad = key('c25');
  refused(ADMIN, COMMIT(pid, 1, [], bad), /CHEMISTRY_TOTAL_IMPOSSIBLE/);
  assert.deepEqual(counts(), was, 'a refused commit leaves nothing');
  assert.equal(n(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = '${bad}';`), 0, 'and no receipt');
  const good = key('c25');
  const decisions = [{ item_id: 'ing:cas:104206-82-8', accept: false }];
  const c = js(ADMIN, COMMIT(pid, 1, decisions, good));
  assert.equal(c.status, 'committed'); assert.equal(c.chemistry_version, 1); assert.equal(c.registration_version, 2);
  assert.deepEqual(js(ADMIN, COMMIT(pid, 1, decisions, good)), c, 'the replay returns the same result');
  assert.deepEqual(ingRows(P25), [{ name: '2,4-D', strength: 60, source: 'epa_lookup', note: 'EPA lookup of 125-1' }]);
  const ev = row(`SELECT jsonb_build_object('before', before_values::text, 'after', after_values::text, 'by', changed_by, 'evidence', evidence) FROM public.product_chemistry_events WHERE parent_id = '${P25}'`);
  assert.equal(ev.by, ADMIN); assert.doesNotMatch(ev.before, /2,4-D/); assert.match(ev.after, /2,4-D/); assert.doesNotMatch(ev.after, /Mesotrione/);
  assert.match(ev.evidence, new RegExp(pid));
  console.log('[case] H25 a commit DM-1 refuses (over 100%) leaves no ingredient, version, event, decision or receipt; the corrected retry commits, replays, and its event names the admin with before and after');
}

function caseH27() {
  // Taha 2026-11-11: two parents share 127-1, whose registration already holds EPA's facts. Committing A confirms
  // them (the registration version still moves); B must commit, not hold, because no fact changed.
  const a = lookup(P27, '127-1', found('127-1', [['Glyphosate', 41]]));
  const b = lookup(P28, '127-1', found('127-1', [['Glyphosate', 41]]));
  assert.equal(item(proposal(b.proposal_id), 'label:signal_word').class, 'confirm');
  const v0 = reg('127-1').registration_version;
  assert.equal(js(ADMIN, COMMIT(a.proposal_id, 1)).status, 'committed');
  assert.ok(reg('127-1').registration_version > v0, 'the first commit moved the registration version');
  const cb = js(ADMIN, COMMIT(b.proposal_id, 1));
  assert.equal(cb.status, 'committed', 'a version bump with no fact change does not hold');
  assert.equal(cb.commit_result['label:signal_word'], 'confirmed');
  // Luna 2026-11-11: a status that matches EPA is receipted as confirmed, not as a kept difference.
  const st = item(proposal(b.proposal_id), 'label:registration_status').class;
  assert.equal(cb.commit_result['label:registration_status'], st === 'matches' ? 'confirmed' : 'kept_difference');
  if (st !== 'matches') {
    raw(`UPDATE public.epa_registrations SET registration_status = 'active' WHERE epa_registration = '127-1';`);
    const m = lookup(P28, '127-1', found('127-1', [['Glyphosate', 41]]));
    assert.equal(item(proposal(m.proposal_id), 'label:registration_status').class, 'matches');
    assert.equal(js(ADMIN, COMMIT(m.proposal_id, 1)).commit_result['label:registration_status'], 'confirmed');
  }
  assert.deepEqual(ingRows(P28), [{ name: 'Glyphosate', strength: 41, source: 'epa_lookup', note: 'EPA lookup of 127-1' }]);
  // Codex App 2026-11-11: a CAS entry under another name and a name-only entry both land on P24's Dicamba row:
  // both are conflicts, neither is ticked, nothing is written for that row.
  const both = JSON.parse(scalar(`SELECT public._epa_proposal_items('${P24}', '124-1', public._epa_lookup_input(${J(found('124-1', [['Dicamba acid', 30, CAS.Dicamba], ['Dicamba', 35, null]]))}));`))
    .filter((i) => i.kind === 'ingredient' && i.current);
  assert.equal(both.length, 2);
  for (const i of both) { assert.equal(i.class, 'epa_conflict', i.item_id); assert.equal(i.accept_default, false); assert.equal(i.change, null); }
  // Codex App 2026-11-11: two of P24's rows share a name (distinct CAS, EPA-sourced, no strength) and EPA gives that
  // name with no CAS: one unticked conflict, no row chosen, neither row reported missing. Rows removed afterwards.
  const T1 = id('c91'), T2 = id('c92');
  raw(`INSERT INTO public.active_ingredients (id, name, cas, created_by, updated_by) VALUES
      ('${T1}', 'Twin', '50-00-0', '${ADMIN}', '${ADMIN}'), ('${T2}', 'Twin', '64-17-5', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_ingredients (parent_id, ingredient_id, strength_value, strength_unknown, strength_unit, strength_basis, source, source_note, created_by, updated_by) VALUES
      ('${P24}', '${T1}', NULL, true, 'pct_ww', 'active_ingredient', 'epa_lookup', 'EPA lookup of 124-1', '${ADMIN}', '${ADMIN}'),
      ('${P24}', '${T2}', NULL, true, 'pct_ww', 'active_ingredient', 'epa_lookup', 'EPA lookup of 124-1', '${ADMIN}', '${ADMIN}');`);
  const twin = JSON.parse(scalar(`SELECT public._epa_proposal_items('${P24}', '124-1', public._epa_lookup_input(${J(found('124-1', [['Dicamba', 30, CAS.Dicamba], ['Twin', 20, null]]))}));`))
    .filter((i) => i.kind === 'ingredient');
  const tw = twin.filter((i) => i.epa?.name === 'Twin' || [T1, T2].includes(i.current?.ingredient_id));
  assert.equal(tw.length, 1, JSON.stringify(twin));
  assert.equal(tw[0].class, 'epa_conflict'); assert.equal(tw[0].accept_default, false); assert.equal(tw[0].current, null);
  raw(`DELETE FROM public.product_parent_ingredients WHERE ingredient_id IN ('${T1}', '${T2}'); DELETE FROM public.active_ingredients WHERE id IN ('${T1}', '${T2}');`);
  // Sol 2026-11-11: EPA's month-name dates are read; a registration edited after the proposal holds the commit even
  // when the item still sorts as the same fill.
  assert.equal(scalar(`SELECT public._epa_label_date('December 12, 2025');`), '2025-12-12');
  assert.equal(scalar(`SELECT public._epa_label_date('February 30, 2025') IS NULL;`), 't');
  raw(`UPDATE public.epa_registrations SET label_accepted_on = '2020-01-01', label_url = 'https://www3.epa.gov/old.pdf' WHERE epa_registration = '127-1';`);
  const lp = lookup(P27, '127-1', found('127-1', [['Glyphosate', 41]], { labelPdfs: [
    { fileName: 'new.pdf', acceptedDate: 'December 12, 2025', url: 'https://www3.epa.gov/new.pdf' }] }));
  assert.equal(item(proposal(lp.proposal_id), 'label:label_document').class, 'fill');
  raw(`UPDATE public.epa_registrations SET label_accepted_on = '2024-01-01', label_url = 'https://www3.epa.gov/mid.pdf' WHERE epa_registration = '127-1';`);
  const lh = js(ADMIN, COMMIT(lp.proposal_id, 1));
  assert.equal(lh.status, 'held'); assert.equal(lh.hold_reason, 'registration_changed');
  assert.equal(reg('127-1').label_url, 'https://www3.epa.gov/mid.pdf', "the other admin's link is kept");
  // Sol 2026-11-11: a 250-character name passes the shape check and is shown, not written; a percent too small to
  // store is a conflict with no strength.
  const longName = 'X'.repeat(250);
  assert.equal(scalar(`SELECT public._epa_lookup_shape_error(${J(found('127-1', [[longName, 5, null]]))}, '127-1') IS NULL;`), 't');
  const li = JSON.parse(scalar(`SELECT public._epa_proposal_items('${P27}', '127-1', public._epa_lookup_input(${J(found('127-1', [[longName, 5, null]]))}));`))
    .find((i) => i.epa?.name === longName);
  assert.equal(li.class, 'epa_conflict'); assert.equal(li.accept_default, false);
  const tiny = JSON.parse(scalar(`SELECT public._epa_lookup_input(${J(found('127-1', [['Glyphosate', 0.00000000001]]))})->'ingredients';`));
  assert.equal(tiny[0].strength, null); assert.equal(tiny[0].conflict, true);
  console.log('[case] H27 two products share a number: committing one only confirms the registration, so the other commits instead of being held; two EPA entries on one row are both conflicts; a name shared by two rows is one unticked conflict; month-name label dates read; a registration edit after the proposal holds; an over-long name or unstorable percent is a conflict');
}

async function caseH9H15() {
  // H9: a commit against a REG-1 writer, both orders.
  const p1 = lookup(P9, '109-1', found('109-1', [['Glyphosate', 41]])).proposal_id;
  const writer = asAsync(ADMIN, `${SETREG('109-1', 1, { signal_word: 'Warning' })} SELECT pg_sleep(2);`);
  await pause(500);
  const commit = await asAsync(ADMIN, COMMIT(p1, 1));
  const w = await writer;
  assert.equal(w.status, 0, w.output); assert.equal(commit.status, 0, commit.output);
  assert.ok(commit.ms >= 1200, `the commit waited for the writer (${commit.ms} ms)`);
  assert.equal(JSON.parse(commit.rows.at(-1)).hold_reason, 'registration_changed');
  const p2 = lookup(P9, '109-1', found('109-1', [['Glyphosate', 41]])).proposal_id;
  const v = reg('109-1').registration_version;
  const committing = asAsync(ADMIN, `${COMMIT(p2, 1)} SELECT pg_sleep(2);`);
  await pause(500);
  const w2 = await asAsync(ADMIN2, SETREG('109-1', v, { signal_word: 'Danger' }));
  const c2 = await committing;
  assert.equal(c2.status, 0, c2.output);
  assert.doesNotMatch(w2.output, /deadlock/i);
  assert.ok(w2.ms >= 1200, `the writer waited for the commit (${w2.ms} ms)`);
  assert.match(w2.output, /EPA_REGISTRATION_STALE/, 'the writer then sees the commit\'s new version');
  console.log('[case] H9 a commit and a registration writer in two sessions wait for each other in either order; no deadlock');

  // H15: two results for one parent at once.
  const la = start(P9, '109-1').lookup_id;
  const lb = start(P9, '109-2').lookup_id;
  const first = asAsync(SERVICE, `${RECORD(la, found('109-1', [['Glyphosate', 41]]))} SELECT pg_sleep(2);`);
  await pause(500);
  const second = await asAsync(SERVICE, RECORD(lb, found('109-2', [['Glyphosate', 41]])));
  const f = await first;
  assert.equal(f.status, 0, f.output); assert.equal(second.status, 0, second.output);
  assert.ok(second.ms >= 1200, `the second record waited on the parent (${second.ms} ms)`);
  const lc = start(P9, '109-1').lookup_id;
  const holding = asAsync(SERVICE, `${RECORD(lc, found('109-1', [['Glyphosate', 41]]))} SELECT pg_sleep(2);`);
  await pause(500);
  const restart = await asAsync(ADMIN, START(P9, '109-1'));
  const h = await holding;
  assert.equal(h.status, 0, h.output); assert.equal(restart.status, 0, restart.output);
  assert.ok(restart.ms >= 1200, `the new start waited on the parent (${restart.ms} ms)`);
  const ld = JSON.parse(restart.rows.at(-1)).lookup_id;
  const last = record(ld, found('109-1', [['Glyphosate', 41]]));
  const held = JSON.parse(h.rows.find((x) => x.startsWith('{')));
  assert.equal(proposal(held.proposal_id).status, 'superseded', 'the newer lookup superseded the one recorded while it waited');
  assert.equal(proposal(last.proposal_id).status, 'proposed');
  assert.equal(n(`SELECT count(*) FROM public.epa_chemistry_proposals WHERE parent_id = '${P9}' AND epa_registration = '109-1' AND status IN ('proposed', 'held');`), 1);
  assert.equal(n(`SELECT count(*) FROM public.epa_chemistry_proposals WHERE parent_id = '${P9}' AND epa_registration = '109-2' AND status = 'proposed';`), 1);
  console.log('[case] H15 two results for one parent at once: the second waits on the parent, both land; a new start waits, then its result supersedes; one open proposal per number, no unique-index error');
}

async function main() {
  buildContainer();
  seed();
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /EPA_CHEMISTRY_PROPOSALS_PREFLIGHT: this file was already applied/);
  for (const t of ['epa_lookups', 'epa_lookup_failures', 'epa_chemistry_proposals']) {
    const tr = psql(`TRUNCATE public.${t} CASCADE;`, { allowFailure: true });
    assert.notEqual(tr.status, 0, `${t} must refuse TRUNCATE`); assert.match(tr.stderr, /EPA_/);
  }
  console.log('[case] M1 the candidate applies (its postflight checks every grant), a second run refuses, and the three tables refuse TRUNCATE');
  const ps = caseH1H2();
  caseH4H7(ps);
  caseH3();
  caseH5();
  caseH27();
  caseH6H23();
  caseH8H19();
  caseH10();
  caseH12H13H14H17H18();
  caseH16();
  caseH20H21();
  caseH22();
  caseH26();
  caseH24();
  caseH25();
  await caseH9H15();
  console.log('EPA_CHEMISTRY_PROPOSALS_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
