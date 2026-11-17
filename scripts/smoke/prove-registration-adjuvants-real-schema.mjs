#!/usr/bin/env node
/**
 * Real-schema proof for 20270114130000_registration_adjuvants (USE-2 part 1; build sheet
 * docs/plans/2026-11-15-product-USE2-BUILD-SHEET.md section 4.0).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate, seeds invented users and products, checks the
 * preflight refuses an old-shape list, applies the candidate (and a second run, which refuses), then runs
 * cases 1-6 through the real RPCs as admins, a sales rep, a driver, an inactive rep and anon, and finally the
 * rollback SQL from docs/reference/migrations.d/20270114130000_registration_adjuvants.md.
 *
 * Run: node scripts/smoke/prove-registration-adjuvants-real-schema.mjs   (needs Docker)
 * Prints REGISTRATION_ADJUVANTS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-use2-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270114130000_registration_adjuvants.sql');
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
const TOUCHED = /(epa_registration|_epa_label_adjuvants_valid|_product_parent_replay|save_idempotency|set_registration_adjuvants|_invoice_brand_rup_facts|get_epa_sales_to_check)/i;
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
        SELECT '00000000-0000-4000-8000-000000000000', 'unknown', 'use2-proof' WHERE NOT EXISTS (SELECT 1 FROM public.epa_registration_seed_run);`);
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
// Seed: invented users, two products with EPA numbers. The seed run row exists (replayed above).
// ---------------------------------------------------------------------------------------------
const DRIVER = id('a5');
const EPA1 = '100-9001', EPA2 = '100-9002', EPA3 = '100-9003';
const P1 = id('b01'), P2 = id('b02');

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'use2-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'use2-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ('${ADMIN2}', 'use2-admin2@example.invalid', '{"full_name":"[PROVER] Admin Two","role":"admin"}'::jsonb),
    ('${INACTIVE}', 'use2-gone@example.invalid', '{"full_name":"[PROVER] Gone","role":"sales_rep"}'::jsonb),
    ('${DRIVER}', 'use2-driver@example.invalid', '{"full_name":"[PROVER] Driver","role":"driver"}'::jsonb);`);
  const size = (pid, sku, epa) => `('${pid}', '[PROVER] ${sku}', '${sku}', 'liquid', 'Gal', 'Herbicide', '${epa}', NULL, NULL, false, 10.00, 15.00, true)`;
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id IN ('${ADMIN}', '${ADMIN2}');
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = false WHERE id = '${INACTIVE}';
    UPDATE public.profiles SET role = 'driver', is_active = true WHERE id = '${DRIVER}';
    INSERT INTO public.product_categories (name, sort_order) VALUES ('Herbicide', 60) ON CONFLICT DO NOTHING;
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, category, epa_registration, signal_word, rei_hours, is_rup, current_cost, tier1_price, is_active) VALUES
      ${size(P1, 'USE2-A', EPA1)}, ${size(P2, 'USE2-B', EPA2)};`);
  assert.equal(scalar('SELECT public._epa_registrations_seeded();'), 't', 'the seed run row exists');
  console.log('[prover] seeded: two admins, a rep, an inactive rep, a driver, two products with EPA numbers');
}

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------
let seq = 0;
const key = (tag = 'k') => `use2-${tag}-${++seq}`;
const SAVE = (num, expected, list, reason = 'read the label', k = key()) =>
  `SELECT public.set_registration_adjuvants(${q(num)}, ${expected === null ? 'NULL' : expected}, ${list === null ? 'NULL' : J(list)}, ${q(reason)}, ${q(k)});`;
const save = (num, expected, list, uid = REP) => js(uid, SAVE(num, expected, list));
const reg = (num) => row(`SELECT to_jsonb(r) FROM public.epa_registrations r WHERE epa_registration = '${num}'`);
const version = (num) => reg(num).registration_version;
const events = (num) => n(`SELECT count(*) FROM public.epa_registration_events WHERE epa_registration = '${num}';`);
const totals = () => scalar("SELECT (SELECT count(*) FROM public.idempotency_keys) || '|' || (SELECT count(*) FROM public.epa_registration_events) || '|' || (SELECT count(*) FROM public.epa_registrations);");
const facts = (r) => { const { label_adjuvants, registration_version, updated_by, updated_at, ...rest } = r; return rest; };
const PINNED = ['_epa_registration_event', '_epa_registration_facts', '_epa_registration_insert', '_epa_registration_lock',
  '_epa_registration_seed_plan', '_epa_registration_target_table', '_epa_registration_unrecorded_posted_lines',
  '_epa_registration_update', '_epa_registrations_seeded', '_product_parent_replay', 'commit_epa_proposal',
  'get_epa_registrations', 'save_idempotency', 'set_epa_registration', '_invoice_brand_rup_facts', 'get_epa_sales_to_check'];
const fingerprint = () => scalar(`SELECT md5(string_agg(p.oid::regprocedure::text || p.prosrc || COALESCE(p.proconfig::text, '')
  || p.proowner::text || p.prosecdef::text || COALESCE(p.proacl::text, ''), '#' ORDER BY p.oid::regprocedure::text))
  || ':' || count(DISTINCT p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${PINNED.map(q).join(', ')});`);
const LABEL = [
  { kind: 'required', adjuvant_types: ['HS-MSO', 'MSO', 'COC'], preferred: 'HS-MSO', note: '1% v/v' },
  { kind: 'required', when: 'tank mixed with atrazine', adjuvant_types: ['COC'] },
  { kind: 'required', adjuvant_types: ['AMS'], note: '8.5-17 lb / 100 gal' },
  { kind: 'do_not_use', when: 'corn after V8', adjuvant_types: ['UAN', 'COC'] },
];
// What posting and the compliance screen read for a number (a missing row and an 'unknown' row must match).
const postingView = () => scalar(`SELECT to_jsonb(f) FROM public._invoice_brand_rup_facts('${P2}', NULL, NULL) f;`);

const OLD = [{ kind: 'required', adjuvant_type: 'NIS', note: null }];
function caseM0() {
  // A list stored in REG-1's one-type shape before the file applies.
  raw(`INSERT INTO public.epa_registrations (epa_registration, label_adjuvants, created_by, updated_by)
    VALUES ('${EPA3}', '${JSON.stringify(OLD)}', '${ADMIN}', '${ADMIN}');`);
}
// After the file: that list is kept and valid, and the admin tool still saves the old shape (its write contract).
function caseM0After() {
  assert.deepEqual(js(DRIVER, `SELECT public.get_epa_registrations(ARRAY['${EPA3}']);`)[0].label_adjuvants, OLD);
  const v = version(EPA3);
  const older = [{ kind: 'recommended', adjuvant_type: 'COC', note: '1%' }, { kind: 'required', adjuvant_type: 'AMS' }];
  js(ADMIN, `SELECT public.set_epa_registration('${EPA3}', ${v}, ${J({ label_adjuvants: older })}, 'old shape', NULL, ${q(key())});`);
  assert.deepEqual(js(DRIVER, `SELECT public.get_epa_registrations(ARRAY['${EPA3}']);`)[0].label_adjuvants, older);
  for (const list of [[{ kind: 'do_not_use', adjuvant_type: 'NIS' }], [{ kind: 'required', adjuvant_type: ' ' }],
    [{ kind: 'required', adjuvant_type: 'NIS', preferred: 'NIS' }], [{ kind: 'required', adjuvant_type: 'x'.repeat(101) }]]) {
    refused(ADMIN, `SELECT public.set_epa_registration('${EPA3}', ${version(EPA3)}, ${J({ label_adjuvants: list })}, 'x', NULL, ${q(key())});`, /label_adjuvants_check/);
  }
  raw(`DELETE FROM public.epa_registration_events WHERE epa_registration = '${EPA3}'; DELETE FROM public.epa_registrations WHERE epa_registration = '${EPA3}';`);
  console.log('[case] M0 a list stored in REG-1 one-type shape before the file is kept and valid; the admin tool still saves that shape exactly as REG-1 checked it (a do-not-use, blank, preferred or over-long old entry is still refused)');
}

function case1() {
  for (const [sig, grant] of [['public.set_registration_adjuvants(text,bigint,jsonb,text,text)', 'authenticated'],
    ['public._epa_label_adjuvants_valid(jsonb)', '']]) {
    const r = scalar(`SELECT p.prosecdef || '|' || array_to_string(p.proconfig, ',') || '|' || pg_get_userbyid(p.proowner) || '|' ||
        COALESCE((SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, ',')
          FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner), '')
      FROM pg_proc p WHERE p.oid = '${sig}'::regprocedure;`);
    assert.equal(r, `${sig.includes('set_') ? 'true' : 'false'}|search_path=public, pg_temp|postgres|${grant}`, sig);
  }
  refused(REP, "SELECT public._epa_label_adjuvants_valid('[]');", /permission denied/);
  console.log('[case] 1 the save is SECURITY DEFINER, pins search_path, is owned by postgres and executable only by authenticated; the validator has no grants');
}

function case2() {
  // An admin records the registration's other facts (REG-1's tool); a rep then records only its adjuvants.
  js(ADMIN, `SELECT public.set_epa_registration('${EPA1}', NULL, ${J({ rup_status: 'no', signal_word: 'Caution', rei_hours: 12,
    label_url: 'https://example.invalid/label.pdf' })}, 'label', NULL, ${q(key())});`);
  const before = reg(EPA1);
  const res = save(EPA1, before.registration_version, LABEL);
  const after = reg(EPA1);
  assert.deepEqual(res, { epa_registration: EPA1, registration_version: before.registration_version + 1,
    event_id: res.event_id, event_type: 'updated' });
  assert.deepEqual(after.label_adjuvants, LABEL);
  assert.deepEqual(facts(after), facts(before), 'nothing but the list (and version, updated_by, updated_at) changes');
  assert.equal(after.updated_by, REP);
  const ev = row(`SELECT to_jsonb(e) FROM public.epa_registration_events e WHERE id = ${res.event_id}`);
  assert.equal(ev.event_type, 'updated'); assert.equal(ev.reason, 'read the label'); assert.equal(ev.changed_by, REP);
  assert.equal(ev.before_values.label_adjuvants, null); assert.deepEqual(ev.after_values.label_adjuvants, LABEL);
  // Read back through the read RPC every active user has: do-not-use with two types, condition, preferred.
  const read = js(DRIVER, `SELECT public.get_epa_registrations(ARRAY['${EPA1}']);`)[0];
  assert.deepEqual(read.label_adjuvants, LABEL);
  // An admin may save too; [] means "none on the label"; a preferred of JSON null is accepted.
  save(EPA1, after.registration_version, [], ADMIN);
  assert.deepEqual(reg(EPA1).label_adjuvants, []);
  save(EPA1, after.registration_version + 1, [{ kind: 'recommended', adjuvant_types: ['NIS'], preferred: null, when: null, note: null }], ADMIN2);
  console.log('[case] 2 a rep saves a list (only the list changes, one event with before/after and the reason); everyone reads it back, do-not-use and conditions intact; admins save too; [] is none on the label');
}

function case3() {
  // A number with no registration: the save creates one holding only the list; posting reads it as before.
  const postingBefore = postingView();
  const sales = js(ADMIN, 'SELECT public.get_epa_sales_to_check();');
  assert.equal(reg(EPA2), null);
  refused(REP, SAVE(EPA2, 1, LABEL), /EPA_REGISTRATION_STALE: EPA registration 100-9002 does not exist/);
  const res = save(` ${EPA2} `, null, LABEL);
  assert.equal(res.event_type, 'created'); assert.equal(res.epa_registration, EPA2); assert.equal(res.registration_version, 1);
  const r = reg(EPA2);
  assert.equal(r.rup_status, 'unknown'); assert.equal(r.registration_status, 'unknown');
  for (const col of ['label_url', 'signal_word', 'rei_hours', 'phi_days', 'max_label_rate', 'max_label_rate_unit', 'cancelled_on', 'label_accepted_on', 'source', 'checked_at']) {
    assert.equal(r[col], null, `${col} stays empty`);
  }
  assert.equal(postingView(), postingBefore, 'posting reads a created unknown registration exactly as a missing one');
  assert.deepEqual(js(ADMIN, 'SELECT public.get_epa_sales_to_check();'), sales, 'the compliance list is unchanged');
  // A second create for the same number (another screen still thinks it is missing) is stale, not a silent overwrite.
  refused(REP, SAVE(EPA2, null, []), /EPA_REGISTRATION_STALE: EPA registration 100-9002 already exists/);
  console.log('[case] 3 a rep creates a registration for a new number holding only the list (RUP unknown, every other fact empty); posting and the compliance list read it exactly as before; a second create is stale');
}

function case4() {
  const t = totals();
  const v = version(EPA1);
  const cur = reg(EPA1).label_adjuvants;
  refused(null, SAVE(EPA1, v, LABEL), /permission denied/);
  refused(INACTIVE, SAVE(EPA1, v, LABEL), /ADMIN_OR_SALES_REP_REQUIRED/);
  refused(DRIVER, SAVE(EPA1, v, LABEL), /ADMIN_OR_SALES_REP_REQUIRED/);
  refused(REP, SAVE(EPA1, v, LABEL, 'x', null), /IDEMPOTENCY_KEY_REQUIRED/);
  refused(REP, SAVE(EPA1, v, LABEL, 'x', ' '), /IDEMPOTENCY_KEY_REQUIRED/);
  refused(REP, SAVE(EPA1, v, LABEL, ' '), /EPA_REGISTRATION_REASON_REQUIRED/);
  refused(REP, SAVE(EPA1, v, LABEL, null), /EPA_REGISTRATION_REASON_REQUIRED/);
  refused(REP, SAVE(EPA1, v, LABEL, '\t\n'), /EPA_REGISTRATION_REASON_REQUIRED/);
  refused(REP, SAVE(EPA1, v, LABEL, 'x'.repeat(1001)), /EPA_REGISTRATION_REASON_TOO_LONG/);
  refused(REP, SAVE('abc', null, LABEL), /EPA_REGISTRATION_NUMBER_INVALID/);
  refused(REP, SAVE(EPA1, v - 1, LABEL), /EPA_REGISTRATION_STALE: EPA registration 100-9001 changed since you opened it/);
  refused(REP, SAVE(EPA1, null, LABEL), /EPA_REGISTRATION_STALE: EPA registration 100-9001 already exists/);
  refused(REP, SAVE(EPA1, v, cur), /EPA_REGISTRATION_NO_CHANGES/);
  const bad = [
    null, {}, 'x', [1],
    [{ kind: 'maybe', adjuvant_types: ['NIS'] }],
    [{ kind: 'required', adjuvant_types: [] }],
    [{ kind: 'required', adjuvant_types: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] }],
    [{ kind: 'required', adjuvant_types: 'NIS' }],
    [{ kind: 'required', adjuvant_types: ['NIS', 'nis'] }],
    [{ kind: 'required', adjuvant_types: [' NIS'] }],
    [{ kind: 'required', adjuvant_types: ['NIS\t'] }],
    [{ kind: 'required', adjuvant_types: ['\n'] }],
    [{ kind: 'required', adjuvant_types: ['MSO'], when: '\t' }],
    [{ kind: 5, adjuvant_types: ['MSO'] }],
    [{ kind: 'required', adjuvant_types: [''] }],
    [{ kind: 'required', adjuvant_types: [5] }],
    [{ kind: 'required', adjuvant_types: ['x'.repeat(101)] }],
    [{ kind: 'required', adjuvant_types: ['MSO', 'COC'], preferred: 'NIS' }],
    [{ kind: 'required', adjuvant_types: ['MSO'], preferred: 'mso' }],
    [{ kind: 'do_not_use', adjuvant_types: ['MSO', 'COC'], preferred: 'MSO' }],
    [{ kind: 'required', adjuvant_types: ['MSO'], when: ' ' }],
    [{ kind: 'required', adjuvant_types: ['MSO'], when: 'x'.repeat(201) }],
    [{ kind: 'required', adjuvant_types: ['MSO'], when: 3 }],
    [{ kind: 'required', adjuvant_types: ['MSO'], note: 'x'.repeat(501) }],
    [{ kind: 'required', adjuvant_types: ['MSO'], note: 1 }],
    [{ kind: 'required', adjuvant_type: 'MSO', adjuvant_types: ['MSO'] }],
    [{ kind: 'required', adjuvant_types: ['MSO'], rate: '1%' }],
    Array.from({ length: 51 }, () => ({ kind: 'required', adjuvant_types: ['MSO'] })),
  ];
  for (const list of bad) refused(REP, SAVE(EPA1, v, list), /EPA_LABEL_ADJUVANTS_INVALID/);
  // The table's CHECK uses the same rule, so the admin tool cannot store a bad list either.
  refused(ADMIN, `SELECT public.set_epa_registration('${EPA1}', ${v}, ${J({ label_adjuvants: [{ kind: 'maybe', adjuvant_types: ['NIS'] }] })}, 'x', NULL, ${q(key())});`, /label_adjuvants_check/);
  // A rep cannot reach any other fact: the general tool stays admin-only.
  refused(REP, `SELECT public.set_epa_registration('${EPA1}', ${v}, ${J({ rup_status: 'yes' })}, 'x', NULL, ${q(key())});`, /ADMIN_REQUIRED/);
  assert.equal(totals(), t, 'no refusal writes anything');
  assert.equal(version(EPA1), v);
  console.log(`[case] 4 anon, an inactive rep and a driver are refused; so are a missing key, a blank or over-long reason, a bad number, a stale or missing version, no change, and ${bad.length} malformed lists (repeats, a preferred outside its types or on do-not-use, blank or long conditions, an entry mixing both shapes); the admin tool's CHECK refuses a bad list; a rep cannot change other facts; nothing written`);
}

function case5() {
  const v = version(EPA1);
  const k = key('retry');
  const list = [{ kind: 'recommended', adjuvant_types: ['MSO'], note: 'retry' }];
  const first = js(REP, SAVE(EPA1, v, list, 'retry', k));
  const ev = events(EPA1);
  assert.deepEqual(js(REP, SAVE(EPA1, v, list, 'retry', k)), first, 'a retry returns the first answer');
  assert.equal(events(EPA1), ev); assert.equal(version(EPA1), v + 1);
  refused(REP, SAVE(EPA1, v, [{ kind: 'required', adjuvant_types: ['NIS'] }], 'retry', k), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  refused(ADMIN, SAVE(EPA1, v, list, 'retry', k), /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  console.log('[case] 5 the same key twice writes once and returns the same receipt; the key reused for another list or by another person is refused');
}

async function case6() {
  // Two identical requests at once: the second waits, then returns the first one's receipt (never "stale").
  const v = version(EPA1);
  const sql = SAVE(EPA1, v, [{ kind: 'required', adjuvant_types: ['COC'] }], 'race', key('race'));
  const ev = events(EPA1);
  const first = asAsync(REP, `${sql} SELECT pg_sleep(2);`);
  await pause(500);
  const second = await asAsync(REP, sql);
  const f = await first;
  assert.equal(f.status, 0, f.output); assert.equal(second.status, 0, second.output);
  assert.ok(second.ms >= 1200, `the repeat waited (${second.ms} ms)`);
  assert.equal(f.rows.find((x) => x.includes('"epa_registration"')), second.rows.at(-1));
  assert.equal(events(EPA1), ev + 1);
  // Two people saving the same version at once: the second is refused as stale, by name, without a deadlock.
  const cur = version(EPA1);
  const a = asAsync(REP, `${SAVE(EPA1, cur, [{ kind: 'required', adjuvant_types: ['NIS'] }])} SELECT pg_sleep(2);`);
  await pause(500);
  const b = await asAsync(ADMIN, SAVE(EPA1, cur, [{ kind: 'required', adjuvant_types: ['AMS'] }]));
  const ar = await a;
  assert.equal(ar.status, 0, ar.output);
  assert.notEqual(b.status, 0); assert.match(b.output, /EPA_REGISTRATION_STALE/); assert.doesNotMatch(b.output, /deadlock/i);
  assert.deepEqual(reg(EPA1).label_adjuvants, [{ kind: 'required', adjuvant_types: ['NIS'] }]);
  console.log('[case] 6 identical requests at once write once (the second waits and returns the first receipt); two people at once: the second is refused as stale');
}

async function main() {
  buildContainer();
  seed();
  const fpBefore = fingerprint();
  assert.match(fpBefore, new RegExp(`:${PINNED.length}$`), 'every pinned function exists before the candidate');
  stageText('candidate.sql', lf(CANDIDATE));
  const notTx = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(notTx.status, 0); assert.match(`${notTx.stdout}${notTx.stderr}`, /REGISTRATION_ADJUVANTS_NOT_IN_TRANSACTION/);
  assert.equal(scalar("SELECT to_regprocedure('public.set_registration_adjuvants(text,bigint,jsonb,text,text)') IS NULL;"), 't');
  caseM0();
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0); assert.match(again.output, /REGISTRATION_ADJUVANTS_PREFLIGHT: this file was already applied/);
  assert.equal(fingerprint(), fpBefore);
  caseM0After();
  console.log('[case] M1 the candidate refuses outside one transaction, applies (its postflight checks grants, pinned bodies, rows and counts), a second run refuses, and every pinned function is unchanged');
  case1();
  case2();
  case3();
  case4();
  case5();
  await case6();
  assert.equal(fingerprint(), fpBefore);
  // Rollback: the SQL block in the migrations.d record.
  const record = lf(path.join(ROOT, 'docs', 'reference', 'migrations.d', '20270114130000_registration_adjuvants.md'));
  const rb = /```sql\n([\s\S]*?)```/.exec(record);
  assert.ok(rb, 'the record carries its rollback SQL');
  stageText('rollback.sql', rb[1]);
  const rolled = apply('rollback.sql');
  assert.equal(rolled.status, 0, rolled.output);
  assert.equal(scalar("SELECT to_regprocedure('public.set_registration_adjuvants(text,bigint,jsonb,text,text)') IS NULL;"), 't');
  assert.equal(n('SELECT count(*) FROM public.epa_registrations WHERE label_adjuvants IS NOT NULL;'), 2, 'every list is kept');
  assert.deepEqual(js(DRIVER, `SELECT public.get_epa_registrations(ARRAY['${EPA2}']);`)[0].label_adjuvants, LABEL, 'and still readable');
  assert.equal(fingerprint(), fpBefore);
  console.log('[case] R the rollback drops the save, keeps every list readable and valid, and leaves the pinned functions unchanged');
  console.log('REGISTRATION_ADJUVANTS_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
