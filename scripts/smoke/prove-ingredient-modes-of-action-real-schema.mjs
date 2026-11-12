#!/usr/bin/env node
/**
 * Real-schema proof for 20270108100000_ingredient_modes_of_action (MOA-1 part 1; build sheet
 * docs/plans/2026-11-12-product-MOA1-BUILD-SHEET.md section 6).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, seeds invented parents, sizes and ingredients,
 * applies the candidate (and a second run, which refuses), then runs cases 1-11 through the real RPCs as a
 * signed-in admin, a second admin, a sales rep, an inactive user and anon, and finally the rollback SQL from
 * docs/reference/migrations.d/20270108100000_ingredient_modes_of_action.md.
 *
 * Run: node scripts/smoke/prove-ingredient-modes-of-action-real-schema.mjs   (needs Docker)
 * Prints INGREDIENT_MODES_OF_ACTION_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-moa1-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270108100000_ingredient_modes_of_action.sql');
// Taha 2026-11-12 (#1810): an over-long EPA name still matches by CAS. Applied right after the candidate.
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
const TOUCHED = /(active_ingredient|product_parent_modes_of_action|product_parent_ingredients|_product_parent_replay|_product_parent_require_admin|save_idempotency|_parent_mode_groups|ingredient_mode)/i;
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
    if (base === '20270106110000_invoice_brands_rup.sql') {
      // Live ran REG-1's one-time seed before this file; its preflight refuses without the seed row.
      raw(`INSERT INTO public.epa_registration_seed_run (seeded_by, rup_default, fingerprint)
        SELECT '00000000-0000-4000-8000-000000000000', 'unknown', 'moa1-proof' WHERE NOT EXISTS (SELECT 1 FROM public.epa_registration_seed_run);`);
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
const id = (n) => `d8000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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
const INACTIVE = id('a4');

// ---------------------------------------------------------------------------------------------
// Seed: invented ingredients, parents and sizes. No group data exists before the candidate (live has none).
// ---------------------------------------------------------------------------------------------
const GLY = id('aa1'), ATZ = id('aa2'), MESO = id('aa3'), ACID = id('aa4'), ESTER = id('aa5'), NOLIST = id('aa6');
const RET = id('aa7'), REM = id('aa8'), KEYS = id('aa9'), RACE = id('ab0');
const P1 = id('b01'), P2 = id('b02'), P3 = id('b03'), P4 = id('b04'), P5 = id('b05'), P6 = id('b06'), P7 = id('b07');
const S1A = id('c01'), S1B = id('c02'), S1X = id('c03');
// parent, name, EPA number on the parent, active, ingredients
const PARENTS = [[P1, 'Glyphosate solo', null, true, [GLY]], [P2, 'Premix', null, true, [ATZ, MESO]],
  [P3, 'Half recorded', null, true, [NOLIST, GLY]], [P4, 'Ester', null, true, [ESTER]], [P5, 'Typed differs', null, true, [MESO]],
  [P6, 'EPA gated', '106-1', true, [GLY]], [P7, 'Inactive', null, false, [GLY]]];

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'moa1-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'moa1-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ('${ADMIN2}', 'moa1-admin2@example.invalid', '{"full_name":"[PROVER] Admin Two","role":"admin"}'::jsonb),
    ('${INACTIVE}', 'moa1-gone@example.invalid', '{"full_name":"[PROVER] Gone","role":"sales_rep"}'::jsonb);`);
  const parent = ([pid, name, epa, active]) => `('${pid}', '[PROVER] ${name}', 'liquid', 'SL', 'Herbicide', ${q(epa)}, ${active}, '${ADMIN}', '${ADMIN}')`;
  const size = (pid, sku, active) => `('${pid}', '[PROVER] ${sku}', '${sku}', 'liquid', 'Gal', 'Herbicide', NULL, NULL, NULL, false, 10.00, 15.00, ${active})`;
  const ing = (iid, name, parentForm = false) => `('${iid}', '${name}', ${parentForm}, '${ADMIN}', '${ADMIN}')`;
  const rows = PARENTS.flatMap(([pid, , , , ings]) => ings.map((iid) =>
    `('${pid}', '${iid}', 10, 'pct_ww', 'active_ingredient', 'label', 'prover label', '${ADMIN}', '${ADMIN}')`));
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id IN ('${ADMIN}', '${ADMIN2}');
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = false WHERE id = '${INACTIVE}';
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.product_parents (id, name, product_form, formulation_type, category, generic_epa_registration, is_active, created_by, updated_by) VALUES
      ${PARENTS.map(parent).join(', ')};
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, signal_word, rei_hours, is_rup, current_cost, tier1_price, is_active) VALUES
      ${size(S1A, 'MOA1-A', true)}, ${size(S1B, 'MOA1-B', true)}, ${size(S1X, 'MOA1-X', false)};
    INSERT INTO public.product_parent_members (product_id, parent_id, added_by) VALUES
      ('${S1A}', '${P1}', '${ADMIN}'), ('${S1B}', '${P1}', '${ADMIN}'), ('${S1X}', '${P1}', '${ADMIN}');
    INSERT INTO public.active_ingredients (id, name, is_parent_form, created_by, updated_by) VALUES
      ${ing(GLY, 'Glyphosate')}, ${ing(ATZ, 'Atrazine')}, ${ing(MESO, 'Mesotrione')}, ${ing(ACID, '2,4-D', true)},
      ${ing(NOLIST, 'Nolist')}, ${ing(REM, 'Removable')}, ${ing(KEYS, 'Keys')}, ${ing(RACE, 'Race')}, ${ing(RET, 'Retired one')};
    INSERT INTO public.active_ingredients (id, name, canonical_ingredient_id, canonical_fraction, fraction_basis, created_by, updated_by) VALUES
      ('${ESTER}', '2,4-D ester', '${ACID}', 0.8, 'acid_equivalent', '${ADMIN}', '${ADMIN}');
    UPDATE public.active_ingredients SET status = 'retired', retire_reason = 'prover' WHERE id = '${RET}';
    INSERT INTO public.product_parent_ingredients (parent_id, ingredient_id, strength_value, strength_unit, strength_basis, source, source_note, created_by, updated_by) VALUES
      ${rows.join(', ')};
    -- Typed groups (DM-1): one that matches the ingredient list (P2 Atrazine HRAC 5), one that differs (P5 Mesotrione HRAC 5).
    INSERT INTO public.product_parent_modes_of_action (parent_id, ingredient_id, scheme, group_code, created_by, updated_by) VALUES
      ('${P2}', '${ATZ}', 'HRAC', '5', '${ADMIN}', '${ADMIN}'), ('${P5}', '${MESO}', 'HRAC', '5', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_chemistry_state (parent_id, chemistry_version, updated_by) VALUES
      ('${P2}', 3, '${ADMIN}'), ('${P5}', 2, '${ADMIN}');`);
  console.log(`[prover] seeded: ${PARENTS.length} parents, 3 sizes, 10 ingredients (one salt/ester form, one retired), two typed groups`);
}

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------
let seq = 0;
const key = (tag = 'k') => `moa1-${tag}-${++seq}`;
const m = (scheme, code, note = `${scheme} 2024 classification`) => ({ scheme, group_code: code, source_note: note });
const SET = (ing, expected, modes, reason = 'from the published list', k = key()) =>
  `SELECT public.set_active_ingredient_modes('${ing}', ${expected === null ? 'NULL' : J(expected)}, ${J(modes)}, ${q(reason)}, ${q(k)});`;
const set = (ing, expected, modes, uid = ADMIN) => js(uid, SET(ing, expected, modes));
const groups = (pid, uid = ADMIN) => js(uid, `SELECT public.get_parent_mode_groups('${pid}');`);
const listOf = (ing) => row(`SELECT public._ingredient_mode_list('${ing}')`);
const ingOf = (g, iid) => g.ingredients.find((i) => i.ingredient_id === iid);
const events = (ing) => n(`SELECT count(*) FROM public.active_ingredient_events WHERE ingredient_id = '${ing}';`);
const typedCount = () => n('SELECT count(*) FROM public.product_parent_modes_of_action;');
const summary = (g) => g.summary.map((s) => `${s.scheme} ${s.group_code}${s.differs ? ' differs' : ''}`).join(', ');
// The fifteen DM-1/DM-1b/DM-4 functions MOA-1 must not touch (sheet 4.A), fingerprinted independently of the file.
const UNTOUCHED = ['_apply_parent_chemistry', '_parent_chemistry_values', '_check_parent_chemistry', '_chemistry_kept_modes',
  '_parent_chemistry_epa_refusal', 'get_parent_chemistry', 'set_parent_chemistry', 'correct_parent_chemistry', '_ingredient_users',
  '_ingredient_usage_fingerprint', 'get_active_ingredient_worklist', 'retire_active_ingredient', 'reactivate_active_ingredient',
  'promote_chemistry_proposal', 'commit_epa_proposal'];
const fingerprint = () => scalar(`SELECT md5(string_agg(p.oid::regprocedure::text || p.prosrc || COALESCE(p.proconfig::text, '')
  || p.proowner::text || p.prosecdef::text || COALESCE(p.proacl::text, ''), '#' ORDER BY p.oid::regprocedure::text))
  || ':' || count(DISTINCT p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${UNTOUCHED.map(q).join(', ')});`);

function case1() {
  const before = typedCount();
  const ingVersion = n(`SELECT row_version FROM public.active_ingredients WHERE id = '${GLY}';`);
  const r = set(GLY, [], [m('HRAC', ' 9 ')]);
  assert.deepEqual(r.modes, [m('HRAC', '9')], 'the code is trimmed and upper-cased');
  assert.equal(r.unchanged, false);
  assert.equal(r.parents_affected, 3, 'P1, P3 and P6; the inactive P7 is not counted');
  assert.equal(r.products_affected, 2, 'the two active sizes of P1; the inactive size is not counted');
  const g = groups(P1);
  const gl = ingOf(g, GLY);
  assert.equal(gl.derived_from, 'from_ingredient'); assert.equal(gl.acid_name, null); assert.equal(gl.not_recorded, false);
  assert.deepEqual(gl.schemes, [{ scheme: 'HRAC', live: ['9'], derived: ['9'], typed: [], status: 'derived' }]);
  assert.equal(summary(g), 'HRAC 9'); assert.equal(g.not_recorded_count, 0); assert.equal(g.chemistry_version, 0);
  assert.equal(g.parent_id, P1);
  assert.equal(typedCount(), before, 'no typed product row is written');
  assert.equal(n(`SELECT row_version FROM public.active_ingredients WHERE id = '${GLY}';`), ingVersion, 'the ingredient row is not changed');
  const ev = row(`SELECT to_jsonb(e) FROM public.active_ingredient_events e WHERE ingredient_id = '${GLY}' ORDER BY id DESC LIMIT 1`);
  assert.equal(ev.event_type, 'updated'); assert.equal(ev.changed_by, ADMIN); assert.equal(ev.reason, 'from the published list');
  assert.deepEqual(ev.before_values, { modes_of_action: [] }); assert.deepEqual(ev.after_values, { modes_of_action: [m('HRAC', '9')] });
  console.log('[case] 1 an admin sets HRAC 9 on an ingredient; a parent containing it shows HRAC 9 "from ingredient list" with no typed row; one ingredient event; counts skip inactive parents and sizes');
}

function case2() {
  set(ATZ, [], [m('HRAC', '5')]);
  set(MESO, [], [m('HRAC', '27'), m('FRAC', 'm3')]);
  const g = groups(P2);
  assert.equal(summary(g), 'HRAC 5, HRAC 27, FRAC M3', 'scheme order HRAC, FRAC, IRAC; 5 sorts before 27');
  assert.equal(ingOf(g, ATZ).schemes[0].status, 'matches', 'a typed group equal to the list is shown once');
  assert.deepEqual(ingOf(g, ATZ).schemes[0].live, ['5']);
  assert.equal(ingOf(g, MESO).schemes.map((s) => `${s.scheme}:${s.status}`).join(','), 'HRAC:derived,FRAC:derived');
  assert.equal(g.chemistry_version, 3);
  console.log('[case] 2 a two-ingredient premix shows both ingredients\' groups and a summary with both, sorted naturally; a matching typed group shows once');
}

function case3() {
  const g = groups(P3);
  const none = ingOf(g, NOLIST);
  assert.equal(none.not_recorded, true); assert.equal(none.derived_from, null); assert.deepEqual(none.schemes, []);
  assert.equal(g.not_recorded_count, 1); assert.equal(summary(g), 'HRAC 9');
  console.log('[case] 3 an ingredient with no list (and no acid) shows "group not recorded"; the summary counts it');
}

function case4() {
  assert.equal(js(ADMIN, `SELECT public.get_ingredient_mode_users('${ACID}');`).parents_affected, 1, 'the ester\'s parent feeds from the acid');
  set(ACID, [], [m('HRAC', '4')]);
  let e = ingOf(groups(P4), ESTER);
  assert.equal(e.derived_from, 'from_acid'); assert.equal(e.acid_name, '2,4-D');
  assert.deepEqual(e.schemes, [{ scheme: 'HRAC', live: ['4'], derived: ['4'], typed: [], status: 'derived' }]);
  const r = set(ESTER, [], [m('HRAC', '41')]);
  assert.equal(r.parents_affected, 1);
  e = ingOf(groups(P4), ESTER);
  assert.equal(e.derived_from, 'from_ingredient'); assert.equal(e.acid_name, null);
  assert.deepEqual(e.schemes[0].live, ['41'], 'once the form has its own list, only its own shows');
  const users = js(ADMIN, `SELECT public.get_ingredient_mode_users('${ACID}');`);
  assert.equal(users.parents_affected, 0, 'a form with its own list no longer counts toward the acid');
  assert.deepEqual(users.modes, [m('HRAC', '4')]); assert.equal(users.name, '2,4-D');
  console.log('[case] 4 a salt/ester with no list shows its acid\'s groups, labelled from the acid; once it has its own list only its own shows, and the acid\'s count drops it');
}

function case5() {
  const g = groups(P5);
  const s = ingOf(g, MESO).schemes.find((x) => x.scheme === 'HRAC');
  assert.equal(s.status, 'differs'); assert.deepEqual(s.live, ['5'], 'the typed group stays live');
  assert.deepEqual(s.derived, ['27']); assert.equal(s.typed[0].group_code, '5'); assert.equal(s.typed[0].source, 'typed');
  assert.equal(summary(g), 'HRAC 5 differs, FRAC M3');
  console.log('[case] 5 a typed HRAC 5 where the ingredient list says HRAC 27 keeps HRAC 5 live, returns both, and is flagged as differing');
}

function case6() {
  assert.match(scalar(`SELECT public._parent_chemistry_epa_refusal('${P6}');`), /CHEMISTRY_FROM_EPA_ONLY/);
  assert.equal(summary(groups(P6)), 'HRAC 9');
  console.log('[case] 6 an EPA-gated parent shows derived groups; the gate is unchanged and not consulted');
}

function case7() {
  const cur = listOf(GLY);
  refused(REP, SET(GLY, cur, [m('HRAC', '9'), m('HRAC', '10')]), /ADMIN_REQUIRED/);
  refused(INACTIVE, SET(GLY, cur, [m('HRAC', '9')]), /ADMIN_REQUIRED/);
  refused(null, SET(GLY, cur, [m('HRAC', '9')]), /permission denied/);
  refused(ADMIN, SET(RET, [], [m('HRAC', '9')]), /INGREDIENT_RETIRED/);
  refused(ADMIN, SET(id('fff'), [], [m('HRAC', '9')]), /INGREDIENT_NOT_FOUND/);
  refused(ADMIN, SET(GLY, cur, [m('WSSA', '9')]), /CHEMISTRY_MOA_INVALID: scheme/);
  refused(ADMIN, SET(GLY, cur, [m('HRAC', '  ')]), /CHEMISTRY_MOA_INVALID: scheme/);
  refused(ADMIN, SET(GLY, cur, [m('HRAC', '12345678901')]), /CHEMISTRY_MOA_INVALID: scheme/);
  refused(ADMIN, SET(GLY, cur, [{ ...m('HRAC', '9'), extra: 1 }]), /CHEMISTRY_MOA_INVALID: each group/);
  refused(ADMIN, SET(GLY, cur, [{ scheme: 'HRAC', group_code: '9' }]), /CHEMISTRY_MOA_INVALID: each group/);
  refused(ADMIN, SET(GLY, cur, [{ scheme: 'HRAC', group_code: 9, source_note: 'x' }]), /CHEMISTRY_MOA_INVALID: each group/);
  refused(ADMIN, SET(GLY, cur, [m('HRAC', '9', '   ')]), /CHEMISTRY_MOA_INVALID: say where HRAC 9 came from/);
  refused(ADMIN, SET(GLY, cur, [m('HRAC', '9', 'x'.repeat(1001))]), /CHEMISTRY_MOA_INVALID: say where/);
  refused(ADMIN, SET(GLY, cur, [m('HRAC', '9'), m('HRAC', ' 9', 'other source')]), /CHEMISTRY_MOA_INVALID: HRAC 9 is listed twice/);
  refused(ADMIN, SET(GLY, cur, { scheme: 'HRAC' }), /CHEMISTRY_MOA_INVALID: the new list must be a list/);
  refused(ADMIN, SET(GLY, null, [m('HRAC', '9')]), /CHEMISTRY_MOA_INVALID: the list you opened must be a list/);
  refused(ADMIN, SET(GLY, cur, Array.from({ length: 11 }, (_, i) => m('HRAC', String(i + 1)))), /CHEMISTRY_MOA_INVALID: an ingredient has at most 10 groups/);
  for (const reason of [null, '', '  \n\t', 'x'.repeat(1001)]) refused(ADMIN, SET(GLY, cur, [m('HRAC', '10')], reason), /MOA_REASON_REQUIRED/);
  refused(ADMIN, SET(GLY, [], [m('HRAC', '10')]), /MOA_LIST_STALE: the groups of "Glyphosate" changed since you opened them; reload/);
  refused(ADMIN, SET(GLY, [m('HRAC', '9', 'a different note')], [m('HRAC', '10')]), /MOA_LIST_STALE/);
  refused(ADMIN, SET(GLY, cur, [m('HRAC', '10')], 'why', null), /IDEMPOTENCY_KEY_REQUIRED/);
  refused(ADMIN, SET(GLY, cur, [m('HRAC', '10')], 'why', ''), /IDEMPOTENCY_KEY_REQUIRED/);
  assert.deepEqual(listOf(GLY), cur, 'no refusal wrote anything');
  console.log('[case] 7 refused: non-admin, inactive user, anon, retired or unknown ingredient, bad scheme/code/shape/note, repeated pair, 11 groups, blank or long reason, stale list (codes or notes), missing retry key');
}

function case8() {
  const k = key('same');
  const sql = SET(KEYS, [], [m('IRAC', '3A')], 'first', k);
  const a = ok(ADMIN, sql), b = ok(ADMIN, sql);
  assert.equal(a, b, 'the repeat returns the saved answer');
  assert.equal(n(`SELECT count(*) FROM public.active_ingredient_modes_of_action WHERE ingredient_id = '${KEYS}';`), 1);
  assert.equal(events(KEYS), 1, 'the same key twice writes once');
  refused(ADMIN, SET(KEYS, [], [m('IRAC', '4A')], 'first', k), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  refused(ADMIN2, sql, /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  // A request that changes nothing still saves its receipt.
  const k2 = key('noop');
  const cur = listOf(KEYS);
  const noop = js(ADMIN, SET(KEYS, cur, cur, 'nothing', k2));
  assert.equal(noop.unchanged, true); assert.equal(events(KEYS), 1, 'no event for no change');
  refused(ADMIN, SET(KEYS, cur, [m('IRAC', '4A')], 'nothing', k2), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  // Changing only a kept group's note updates the note in place and logs an event.
  const rowId = scalar(`SELECT id FROM public.active_ingredient_modes_of_action WHERE ingredient_id = '${KEYS}' AND status = 'active';`);
  const r = set(KEYS, cur, [m('IRAC', '3A', 'IRAC 2025 edition')]);
  assert.equal(r.unchanged, false);
  const after = row(`SELECT to_jsonb(o) FROM public.active_ingredient_modes_of_action o WHERE ingredient_id = '${KEYS}' AND status = 'active'`);
  assert.equal(after.id, rowId); assert.equal(after.source_note, 'IRAC 2025 edition'); assert.equal(after.row_version, 2);
  assert.equal(events(KEYS), 2);
  console.log('[case] 8 the same retry key twice writes once; the same key with a different list (or another admin) is refused, also after a no-change request; a note-only change updates the note and logs an event');
}

function case9() {
  set(REM, [], [m('FRAC', '11'), m('FRAC', '3')]);
  assert.deepEqual(listOf(REM).map((x) => x.group_code), ['3', '11'], 'stored list sorted naturally');
  const before = listOf(REM);
  set(REM, before, [m('FRAC', '11')]);
  const gone = row(`SELECT to_jsonb(o) FROM public.active_ingredient_modes_of_action o WHERE ingredient_id = '${REM}' AND group_code = '3'`);
  assert.equal(gone.status, 'retired', 'retired, not deleted'); assert.equal(gone.row_version, 2); assert.equal(gone.updated_by, ADMIN);
  const ev = row(`SELECT to_jsonb(e) FROM public.active_ingredient_events e WHERE ingredient_id = '${REM}' ORDER BY id DESC LIMIT 1`);
  assert.deepEqual(ev.before_values.modes_of_action, before); assert.deepEqual(ev.after_values.modes_of_action, [m('FRAC', '11')]);
  assert.equal(events(REM), 2);
  // A removed group can come back as a new active row next to the retired one.
  set(REM, listOf(REM), [m('FRAC', '11'), m('FRAC', '3')]);
  assert.equal(n(`SELECT count(*) FROM public.active_ingredient_modes_of_action WHERE ingredient_id = '${REM}' AND group_code = '3';`), 2);
  console.log('[case] 9 a save that removes a group retires the row (not deleted) and writes one event with before and after; the group can be added back');
}

function case10() {
  assert.equal(summary(groups(P1, REP)), 'HRAC 9', 'a sales rep reads groups');
  refused(INACTIVE, `SELECT public.get_parent_mode_groups('${P1}');`, /ACTIVE_USER_REQUIRED/);
  refused(null, `SELECT public.get_parent_mode_groups('${P1}');`, /permission denied/);
  refused(ADMIN, `SELECT public.get_parent_mode_groups('${id('fff')}');`, /PRODUCT_PARENT_NOT_FOUND/);
  refused(REP, `SELECT public.get_ingredient_mode_users('${GLY}');`, /ADMIN_REQUIRED/);
  refused(ADMIN, `SELECT public.get_ingredient_mode_users('${id('fff')}');`, /INGREDIENT_NOT_FOUND/);
  const total = n('SELECT count(*) FROM public.active_ingredient_modes_of_action;');
  const active = n("SELECT count(*) FROM public.active_ingredient_modes_of_action WHERE status = 'active';");
  assert.ok(total > active, 'there are retired rows to hide');
  assert.equal(Number(ok(REP, 'SELECT count(*) FROM public.active_ingredient_modes_of_action;')), active, 'a non-admin sees active rows');
  assert.equal(Number(ok(ADMIN, 'SELECT count(*) FROM public.active_ingredient_modes_of_action;')), total, 'an admin sees retired rows too');
  assert.equal(Number(ok(INACTIVE, 'SELECT count(*) FROM public.active_ingredient_modes_of_action;')), 0, 'an inactive profile sees nothing');
  refused(null, 'SELECT count(*) FROM public.active_ingredient_modes_of_action;', /permission denied/);
  for (const uid of [ADMIN, REP, SERVICE]) {
    refused(uid, `INSERT INTO public.active_ingredient_modes_of_action (ingredient_id, scheme, group_code, source_note, created_by, updated_by)
      VALUES ('${GLY}', 'HRAC', '1', 'x', '${ADMIN}', '${ADMIN}');`, /permission denied/);
    refused(uid, "UPDATE public.active_ingredient_modes_of_action SET group_code = '1';", /permission denied/);
    refused(uid, 'DELETE FROM public.active_ingredient_modes_of_action;', /permission denied/);
  }
  refused(ADMIN, `SELECT public._parent_mode_groups('${P1}');`, /permission denied/);
  refused(ADMIN, `SELECT public._ingredient_mode_reach('${GLY}');`, /permission denied/);
  console.log('[case] 10 a non-admin active user reads groups (active rows only); an inactive profile and anon cannot; nobody writes the table directly; helpers are not callable');
}

async function case12() {
  // Two identical requests at once: the second waits on the lock, then returns the first one's saved answer.
  const k = key('race');
  const sql = SET(RACE, [], [m('HRAC', '15')], 'race', k);
  const first = asAsync(ADMIN, `${sql} SELECT pg_sleep(2);`);
  await pause(500);
  const second = await asAsync(ADMIN, sql);
  const f = await first;
  assert.equal(f.status, 0, f.output); assert.equal(second.status, 0, second.output);
  assert.ok(second.ms >= 1200, `the repeat waited (${second.ms} ms)`);
  assert.equal(f.rows.find((x) => x.includes('"ingredient_id"')), second.rows.at(-1));
  assert.equal(events(RACE), 1);
  // Two admins editing the same list at once: the second is refused as stale, by name.
  const cur = listOf(RACE);
  const a = asAsync(ADMIN, `${SET(RACE, cur, [m('HRAC', '15'), m('HRAC', '14')])} SELECT pg_sleep(2);`);
  await pause(500);
  const b = await asAsync(ADMIN2, SET(RACE, cur, [m('HRAC', '13')]));
  const ar = await a;
  assert.equal(ar.status, 0, ar.output);
  assert.notEqual(b.status, 0); assert.match(b.output, /MOA_LIST_STALE: the groups of "Race"/);
  assert.doesNotMatch(b.output, /deadlock/i);
  console.log('[case] 12 identical requests at once run once (the second waits and returns the saved answer); two admins at once: the second is refused as stale');
}

async function main() {
  buildContainer();
  seed();
  const fpBefore = fingerprint();
  assert.match(fpBefore, /:15$/, 'the fifteen untouched functions exist before the candidate');
  stageText('candidate.sql', lf(CANDIDATE));
  const notTx = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(notTx.status, 0); assert.match(`${notTx.stdout}${notTx.stderr}`, /INGREDIENT_MODES_NOT_IN_TRANSACTION/);
  assert.equal(scalar("SELECT to_regclass('public.active_ingredient_modes_of_action') IS NULL;"), 't', 'outside one transaction nothing is created');
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /INGREDIENT_MODES_PREFLIGHT: this file was already applied/);
  console.log('[case] M1 the candidate refuses outside one transaction, applies (its postflight checks every grant and the untouched functions), and a second run refuses');
  case1();
  case2();
  case3();
  case4();
  case5();
  case6();
  case7();
  case8();
  case9();
  case10();
  await case12();
  assert.equal(fingerprint(), fpBefore);
  console.log('[case] 11 the fifteen DM-1/DM-1b/DM-4 functions are byte-for-byte unchanged (checked by the file\'s postflight and again here)');
  // Rollback: the SQL block in the migrations.d record.
  const record = lf(path.join(ROOT, 'docs', 'reference', 'migrations.d', '20270108100000_ingredient_modes_of_action.md'));
  const rb = /```sql\n([\s\S]*?)```/.exec(record);
  assert.ok(rb, 'the record carries its rollback SQL');
  stageText('rollback.sql', rb[1]);
  const rolled = apply('rollback.sql');
  assert.equal(rolled.status, 0, rolled.output);
  assert.equal(n(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('_ingredient_mode_list',
    '_ingredient_modes_input', '_ingredient_mode_reach', '_parent_mode_groups', 'set_active_ingredient_modes', 'get_parent_mode_groups',
    'get_ingredient_mode_users');`), 0);
  assert.ok(n('SELECT count(*) FROM public.active_ingredient_modes_of_action;') > 0, 'the table is kept as history');
  refused(ADMIN, 'SELECT count(*) FROM public.active_ingredient_modes_of_action;', /permission denied/);
  assert.equal(fingerprint(), fpBefore);
  console.log('[case] R the rollback drops the seven functions, keeps the table unreadable, and leaves the fifteen untouched');
  console.log('INGREDIENT_MODES_OF_ACTION_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
