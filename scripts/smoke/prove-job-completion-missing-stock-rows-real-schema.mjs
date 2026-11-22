#!/usr/bin/env node
/**
 * Real-schema proof for 20270220120000_job_completion_missing_stock_rows.sql.
 * Contract: docs/plans/2026-11-21-job-completion-missing-stock-rows-CONTRACT.md.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (harness from prove-inventory-edge-cases-1942-real-schema.mjs),
 * then checks two job completions that both need stock rows which do not exist yet.
 *
 * Run: node scripts/smoke/prove-job-completion-missing-stock-rows-real-schema.mjs   (needs Docker)
 * Prints JOB_STOCK_ROW_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a disposable container this run creates (no reuse of another container or database: Sol r1).
const NAME = `crx-jobstock-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270220120000_job_completion_missing_stock_rows.sql');
const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'job-completion-missing-stock-rows-reverse.sql');
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
const TOUCHED = /(_lock_job_stock_rows_in_order|trg_zz_lock_job_stock_rows)/i;
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
function scalar(sql) {
  const q = /^\s*select\b/i.test(sql) ? sql : `SELECT ${sql}`;
  return docker([...psqlArgs(), '-A', '-t'], { input: q }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}
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

const id = (s) => `a3480000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1');
const CUST = id('c1');
// PA < PB < PC < PD < PE < PF by id. None of these start with a stock row except PF.
const PA = id('b1'), PB = id('b2'), PC = id('b3'), PD = id('b4'), PE = id('b5'), PF = id('b6'), PG = id('b7');
const INV_F = id('d6');
const J_BEFORE_A = id('11'), J_BEFORE_B = id('12');
const J_AFTER_A = id('21'), J_AFTER_B = id('22');
const J_EXISTING = id('31'), J_RETRY = id('32'), J_NOT_STARTED = id('33');
const J_MIX = id('41');
const J_BLEND_BEFORE = id('61'), J_BLEND_AFTER = id('62');
const PX = id('ba');
const INV_X = id('da');
const PN = id('bc'), PNS = id('bd'); // never given a stock row by any case
const J_DIRECT = id('42'), J_ORDER = id('63');
const PM = id('b0'); // sorts before PF: a completion that created PM before locking PF would deadlock with the writer

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'jobstock-admin@example.invalid', '{"full_name":"[PROVER] Job Stock Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Job Stock Farm', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ('${PA}', '[PROVER] New A', 'JS-PA', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${PB}', '[PROVER] New B', 'JS-PB', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${PC}', '[PROVER] New C', 'JS-PC', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${PD}', '[PROVER] New D', 'JS-PD', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${PE}', '[PROVER] Retry', 'JS-PE', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${PF}', '[PROVER] On hand', 'JS-PF', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${PG}', '[PROVER] Grower supplied', 'JS-PG', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${PM}', '[PROVER] Mixed missing', 'JS-PM', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${PX}', '[PROVER] Blend race', 'JS-PX', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${PN}', '[PROVER] Direct update', 'JS-PN', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${PNS}', '[PROVER] Not started', 'JS-PNS', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true);
    INSERT INTO public.products (product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active)
      SELECT '[PROVER] Filler ' || g, 'JS-F' || g, 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, false
        FROM generate_series(1, 2000) g;
    INSERT INTO public.inventory (id, product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES ('${INV_F}', '${PF}', 'Main Warehouse', 'Gal', 10, 0, 0),
             ('${INV_X}', '${PX}', 'Main Warehouse', 'Gal', 20, 0, 0);`);
  const job = (jid, number, status) =>
    `INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, created_by) VALUES ('${jid}', '${number}', '${CUST}', current_date, '${status}', '${ADMIN}');`;
  const chem = (jid, pid, qty, sort, supplied = false) =>
    `INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, sort_order, customer_supplied) VALUES ('${jid}', '${pid}', ${qty}, 'Gal', ${sort}, ${supplied});`;
  raw(`
    ${job(J_BEFORE_A, 'JS-BA', 'in_progress')}
    ${job(J_BEFORE_B, 'JS-BB', 'in_progress')}
    ${chem(J_BEFORE_A, PB, 6, 1)}
    ${chem(J_BEFORE_A, PA, 4, 2)}
    ${chem(J_BEFORE_B, PA, 5, 1)}
    ${chem(J_BEFORE_B, PB, 7, 2)}
    ${job(J_AFTER_A, 'JS-CA', 'in_progress')}
    ${job(J_AFTER_B, 'JS-CB', 'in_progress')}
    ${chem(J_AFTER_A, PD, 3, 1)}
    ${chem(J_AFTER_A, PC, 2, 2)}
    ${chem(J_AFTER_B, PC, 2, 1)}
    ${chem(J_AFTER_B, PD, 3, 2)}
    ${job(J_EXISTING, 'JS-EX', 'in_progress')}
    ${chem(J_EXISTING, PF, 4, 1)}
    ${chem(J_EXISTING, PG, 9, 2, true)}
    ${job(J_RETRY, 'JS-RT', 'in_progress')}
    ${chem(J_RETRY, PE, 2, 1)}
    ${job(J_NOT_STARTED, 'JS-NS', 'scheduled')}
    ${chem(J_NOT_STARTED, PNS, 2, 1)}
    ${job(J_DIRECT, 'JS-DU', 'in_progress')}
    ${chem(J_DIRECT, PN, 2, 1)}
    ${job(J_ORDER, 'JS-OR', 'in_progress')}
    ${chem(J_ORDER, PX, 1, 1)}
    ${job(J_MIX, 'JS-MX', 'in_progress')}
    ${chem(J_MIX, PM, 1, 1)}
    ${chem(J_MIX, PF, 1, 2)}
    ${job(J_BLEND_BEFORE, 'JS-BBT', 'in_progress')}
    ${chem(J_BLEND_BEFORE, PX, 1, 1)}
    ${job(J_BLEND_AFTER, 'JS-BAT', 'in_progress')}
    ${chem(J_BLEND_AFTER, PX, 1, 1)}
  `);
  psql(`DROP INDEX IF EXISTS public.idx_job_chemicals_product_id;
    DROP INDEX IF EXISTS public.idx_job_chemicals_job;
    CREATE INDEX idx_job_chemicals_job_sort ON public.job_chemicals (job_id, sort_order);
    CREATE TABLE public.zz_insert_log (at timestamptz default clock_timestamp(), product_id uuid, xid text);
    CREATE FUNCTION public.zz_prover_slow_new_stock_row() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO public.zz_insert_log (product_id, xid) VALUES (NEW.product_id, txid_current()::text);
      IF NEW.location = 'Main Warehouse' THEN PERFORM pg_sleep(1.5); END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER zz_prover_slow_new_stock_row BEFORE INSERT ON public.inventory
      FOR EACH ROW EXECUTE FUNCTION public.zz_prover_slow_new_stock_row();`, { user: 'supabase_admin' });
  console.log('[prover] seeded two pairs of in-progress jobs whose chemicals have no stock row, in opposite line order');
}

const claims = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', false);`;
// The chemical loop has no ORDER BY. Left to itself the planner walks products in product order, so both
// jobs create rows in the same order and both finish. The index below is (job, chemical order). With a
// sequential scan unavailable, each job creates rows in its own chemical order, and these two jobs are
// opposite. That is the collision.
const LIVE_PLAN = `SET join_collapse_limit = 1; SET from_collapse_limit = 1;
  SET enable_seqscan = off; SET enable_bitmapscan = off; SET enable_hashjoin = off; SET enable_mergejoin = off;`;
const STAMP = (k) => `SELECT '${k} ' || extract(epoch FROM clock_timestamp());`;
const complete = (job) => `${claims} SELECT public.complete_job('${job}', '{}'::jsonb, '${ADMIN}', 'job-stock-${job}');`;
const onHand = (p) => `(SELECT quantity_available FROM public.inventory WHERE product_id = '${p}' AND location = 'Main Warehouse')`;
const rowCount = (p) => `(SELECT count(*) FROM public.inventory WHERE product_id = '${p}' AND location = 'Main Warehouse')`;

function at(out, k) {
  return Number((out.match(new RegExp(`^${k} ([0-9.]+)$`, 'm')) ?? [])[1]);
}
function failed(out) {
  return /deadlock detected|duplicate key value violates unique constraint/i.test(out);
}

async function race(jobA, jobB) {
  const [t1, t2] = await Promise.all([
    session(`${LIVE_PLAN} BEGIN; ${STAMP('S')} ${complete(jobA)} SELECT 'T1 ' || (SELECT status FROM public.jobs WHERE id = '${jobA}'); ${STAMP('E')} COMMIT;`),
    session(`${LIVE_PLAN} BEGIN; ${STAMP('S')} ${complete(jobB)} SELECT 'T2 ' || (SELECT status FROM public.jobs WHERE id = '${jobB}'); ${STAMP('E')} COMMIT;`, 400),
  ]);
  const overlapped = at(t2.out, 'S') < at(t1.out, 'E') && at(t1.out, 'S') < at(t2.out, 'E');
  return { t1, t2, overlapped, failed: failed(t1.out) || failed(t2.out) };
}

const insertPair = (first, second, qty1, qty2) => `BEGIN; ${STAMP('S')}
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
    VALUES ('${first}', 'Main Warehouse', ${qty1}, 0, 0);
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
    VALUES ('${second}', 'Main Warehouse', ${qty2}, 0, 0);
  SELECT 'ok'; ${STAMP('E')} ROLLBACK;`;

async function oppositeInserts(firstA, secondA, firstB, secondB) {
  const [t1, t2] = await Promise.all([
    session(insertPair(firstA, secondA, -6, -4)),
    session(insertPair(firstB, secondB, -5, -7), 400),
  ]);
  return { t1, t2, failed: failed(t1.out) || failed(t2.out), overlapped: at(t2.out, 'S') < at(t1.out, 'E') && at(t1.out, 'S') < at(t2.out, 'E') };
}

async function beforeCases() {
  // The completion's own insert has no conflict handling and follows chemical order. Two of those inserts,
  // in opposite order, deadlock. Two complete_job calls do not hit it today: the application-record number
  // lock is taken before that insert, so the second job waits and then updates the rows the first committed.
  const rawRace = await oppositeInserts(PB, PA, PA, PB);
  assert.ok(rawRace.failed, `opposite inserts must collide:\n${rawRace.t1.out}\n${rawRace.t2.out}`);
  assert.ok(Number.isFinite(at(rawRace.t1.out, 'S')) && Number.isFinite(at(rawRace.t2.out, 'S')), `both inserts must start:\n${rawRace.t1.out}\n${rawRace.t2.out}`);
  assert.equal(scalar(`${rowCount(PA)} || '/' || ${rowCount(PB)}`), '0/0');
  const jobs = await race(J_BEFORE_A, J_BEFORE_B);
  assert.ok(!jobs.failed, `two jobs must both finish today:\n${jobs.t1.out}\n${jobs.t2.out}`);
  assert.equal(jobs.t1.code, 0, jobs.t1.out);
  assert.equal(jobs.t2.code, 0, jobs.t2.out);
  assert.equal(scalar(`${onHand(PA)}`), '-9');
  assert.equal(scalar(`${onHand(PB)}`), '-13');
  const blend = await blendVersusJob(J_BLEND_BEFORE);
  assert.ok(/deadlock detected/i.test(blend.blend.out + blend.job.out), `a blend ticket and a job must deadlock before the number lock moves:\n${blend.blend.out}\n${blend.job.out}`);
  assert.ok(Number.isFinite(at(blend.blend.out, 'S')) && Number.isFinite(at(blend.job.out, 'S')), `both must start:\n${blend.blend.out}\n${blend.job.out}`);
  assert.equal(await numberLockWhileWaiting(), 'Lock/false', 'today a job waits on a stock row without the number lock');
  console.log('[case] before: the plain stock insert collides in opposite order; two jobs still both finish because the record-number lock runs first; a blend ticket that holds that lock and then the stock row deadlocks with a job');
}

// Another session holds PX's stock row; complete_job(J_ORDER) must wait on it. Reports whether, while
// waiting, the job already holds the application-record number lock (key hashtext, objsubid 1). Rolled back.
async function numberLockWhileWaiting() {
  const holder = session(`BEGIN; SELECT 1 FROM public.inventory WHERE id = '${INV_X}' FOR UPDATE; SELECT pg_sleep(3); ROLLBACK;`);
  const job = session(`SET application_name = 'jsorder'; BEGIN; ${complete(J_ORDER)} SELECT 'order done'; ROLLBACK;`, 400);
  await new Promise((r) => setTimeout(r, 1800));
  const seen = scalar(`SELECT coalesce((SELECT wait_event_type FROM pg_stat_activity WHERE application_name = 'jsorder'), 'none') || '/' ||
    coalesce((SELECT bool_or(l.granted) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE a.application_name = 'jsorder' AND l.locktype = 'advisory' AND l.objsubid = 1
         AND l.objid::bigint = (hashtext('next_application_record_number')::bigint & 4294967295)), false);`);
  const [h, j] = await Promise.all([holder, job]);
  assert.equal(h.code, 0, h.out);
  assert.equal(j.code, 0, j.out);
  return seen;
}

// Same order as create_application_record_from_blend_ticket: the application-record number lock, then the stock row.
async function blendVersusJob(job) {
  const [blend, jobRun] = await Promise.all([
    session(`BEGIN; ${STAMP('S')}
      SELECT pg_advisory_xact_lock(hashtext('next_application_record_number'));
      SELECT pg_sleep(2.5);
      SELECT 1 FROM public.inventory WHERE product_id = '${PX}' AND location = 'Main Warehouse' FOR UPDATE;
      SELECT 'blend done'; ${STAMP('E')} ROLLBACK;`),
    session(`BEGIN; ${STAMP('S')} ${complete(job)} SELECT 'job ' || (SELECT status FROM public.jobs WHERE id = '${job}'); ${STAMP('E')} COMMIT;`, 400),
  ]);
  return { blend, job: jobRun };
}

async function afterCases() {
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /JOB_STOCK_ROW_PREFLIGHT/, again.output);
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._lock_job_stock_rows_in_order()'::regprocedure;`),
    'e3344479412462cc3bdecee378f4d495');
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) || ',' || prosecdef::text || ',' || array_to_string(proconfig, ';') || ',' || has_function_privilege('authenticated', oid, 'EXECUTE') || ',' || has_function_privilege('service_role', oid, 'EXECUTE') || ',' || has_function_privilege('anon', oid, 'EXECUTE') FROM pg_proc WHERE oid = 'public.complete_job(uuid, jsonb, uuid, text)'::regprocedure;`),
    'cb32addd7999eae75282813e94962bba,true,search_path=public, pg_temp,true,true,false');
  assert.equal(scalar(`SELECT prosecdef::text || ',' || array_to_string(proconfig, ';') || ',' || has_function_privilege('authenticated', oid, 'EXECUTE') || ',' || has_function_privilege('anon', oid, 'EXECUTE') FROM pg_proc WHERE oid = 'public._lock_job_stock_rows_in_order()'::regprocedure;`),
    'true,search_path=public, pg_temp,false,false');
  console.log('[case] the migration applies once, a second apply refuses, the lock function stays private and complete_job keeps its grants');

  // Sol r1 #1: a completion that is not complete_job (a direct table update, or a mark naming another job) creates no row.
  assert.equal(okProbe(`UPDATE public.jobs SET status = 'completed' WHERE id = '${J_DIRECT}'; SELECT (SELECT status FROM public.jobs WHERE id = '${J_DIRECT}') || '/' || ${rowCount(PN)};`), 'completed/0');
  assert.equal(okProbe(`SELECT set_config('crx.complete_job_rpc', '${J_ORDER}', true); UPDATE public.jobs SET status = 'completed' WHERE id = '${J_DIRECT}'; SELECT ${rowCount(PN)};`), '0');
  console.log('[case] a direct status update, or one marked for another job, completes the job and creates no stock row');

  // Sol r1 #2/#6: the number lock is held before any stock row is waited on (the hold sync, quote-linked or not,
  // and the stock-row trigger all run inside the body's status update, after the wrapper takes it).
  assert.equal(await numberLockWhileWaiting(), 'Lock/true', 'complete_job must hold the number lock while it waits on a stock row');
  console.log('[case] complete_job holds the application-record number lock while it waits on a stock row');

  const raced = await race(J_AFTER_A, J_AFTER_B);
  assert.ok(!raced.failed, `no collision expected:\n${raced.t1.out}\n${raced.t2.out}`);
  assert.ok(raced.overlapped, `the two completions must run at the same time:\n${raced.t1.out}\n${raced.t2.out}`);
  assert.equal(raced.t1.code, 0, raced.t1.out);
  assert.equal(raced.t2.code, 0, raced.t2.out);
  assert.equal(scalar(`SELECT count(*) FROM public.jobs WHERE id IN ('${J_AFTER_A}', '${J_AFTER_B}') AND status = 'completed';`), '2');
  assert.equal(scalar(`${rowCount(PC)}`), '1');
  assert.equal(scalar(`${rowCount(PD)}`), '1');
  assert.equal(scalar(`${onHand(PC)}`), '-4');
  assert.equal(scalar(`${onHand(PD)}`), '-6');
  assert.equal(scalar(`SELECT coalesce(bool_or(manufactured_at_delivery), false) FROM public.inventory WHERE product_id IN ('${PC}', '${PD}');`), 'f');
  assert.equal(scalar(`SELECT count(*) FROM public.inventory_transactions WHERE product_id = '${PC}' AND transaction_type = 'job_applied';`), '2');
  assert.equal(scalar(`SELECT count(*) FROM public.inventory_transactions WHERE product_id = '${PD}' AND transaction_type = 'job_applied';`), '2');
  assert.equal(scalar(`SELECT count(*) FROM public.invoices WHERE job_id IN ('${J_AFTER_A}', '${J_AFTER_B}');`), '0');
  console.log('[case] after: both jobs finish, each new product has one row, and on-hand is minus both jobs');

  const [writer, job] = await Promise.all([
    session(`BEGIN; ${STAMP('S')} SELECT 1 FROM public.inventory WHERE id = '${INV_F}' FOR UPDATE; SELECT pg_sleep(2.5);
      INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES ('${PM}', 'Main Warehouse', 0, 0, 0) ON CONFLICT DO NOTHING;
      SELECT 'W done'; ${STAMP('E')} ROLLBACK;`),
    session(`${LIVE_PLAN} BEGIN; ${STAMP('S')} ${complete(J_MIX)} SELECT 'C ' || ${onHand(PM)} || ' ' || ${onHand(PF)}; ${STAMP('E')} ROLLBACK;`, 300),
  ]);
  const mixedOut = writer.out + job.out;
  assert.ok(!/deadlock detected/i.test(mixedOut), `no deadlock expected:\n${mixedOut}`);
  assert.ok(at(job.out, 'S') < at(writer.out, 'E') && at(writer.out, 'S') < at(job.out, 'E'), `they must overlap:\n${mixedOut}`);
  assert.equal(writer.code, 0, writer.out);
  assert.equal(job.code, 0, job.out);
  assert.match(job.out, /C -1 9/, job.out);
  console.log('[case] a job waits, with no deadlock, for a writer that holds an existing row and then creates a missing one');

  psql(`${complete(J_EXISTING)}\nSELECT ${onHand(PF)} || '/' || ${rowCount(PF)} || '/' || ${rowCount(PG)};`);
  assert.equal(scalar(`${onHand(PF)} || '/' || ${rowCount(PF)} || '/' || ${rowCount(PG)}`), '6/1/0');
  psql(`${complete(J_RETRY)}`);
  assert.equal(scalar(`${onHand(PE)}`), '-2');
  psql(`${complete(J_RETRY)}`);
  assert.equal(scalar(`${onHand(PE)} || '/' || (SELECT count(*) FROM public.inventory_transactions WHERE product_id = '${PE}' AND transaction_type = 'job_applied')`), '-2/1');
  const refused = probe(`${complete(J_NOT_STARTED)} SELECT 'should-not';`);
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, /in_progress/);
  assert.equal(scalar(`SELECT status FROM public.jobs WHERE id = '${J_NOT_STARTED}';`), 'scheduled');
  assert.equal(scalar(`${rowCount(PNS)}`), '0');
  console.log('[case] one job still deducts an existing row, skips a customer-supplied chemical, replays a saved key, and refuses a job that has not been started');

  const retook = psql(`BEGIN;
    SELECT pg_advisory_xact_lock(hashtext('next_application_record_number'));
    SELECT pg_advisory_xact_lock(hashtext('next_application_record_number'));
    SELECT 'retook';
  ROLLBACK;`);
  assert.match(retook.stdout, /retook/, 'taking the number lock twice in one transaction must not wait');
  const beforeHand = scalar(`${onHand(PX)}`);
  const blend = await blendVersusJob(J_BLEND_AFTER);
  const blendOut = blend.blend.out + blend.job.out;
  assert.ok(!/deadlock detected/i.test(blendOut), `no deadlock expected:\n${blendOut}`);
  assert.equal(blend.blend.code, 0, blend.blend.out);
  assert.equal(blend.job.code, 0, blend.job.out);
  assert.match(blend.job.out, /job completed/, blend.job.out);
  assert.equal(scalar(`${onHand(PX)}`), String(Number(beforeHand) - 1));
  console.log('[case] a job and a blend ticket both finish: the job takes the number lock before the stock row, and takes that lock again without waiting');
}

async function rollbackCases() {
  stageText('reverse.sql', lf(REVERSE));
  psql(`CREATE TABLE public.zz_defs AS SELECT 'lock' AS k, pg_get_functiondef('public._lock_job_stock_rows_in_order()'::regprocedure) AS d
    UNION ALL SELECT 'job', pg_get_functiondef('public.complete_job(uuid, jsonb, uuid, text)'::regprocedure);`);
  const putBack = (k) => psql(`SELECT d FROM public.zz_defs WHERE k = '${k}' \\gexec`);
  psql(`CREATE OR REPLACE FUNCTION public._lock_job_stock_rows_in_order() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$ BEGIN RETURN NULL; END $fn$;`);
  const refused = apply('reverse.sql');
  assert.notEqual(refused.status, 0, 'rollback must refuse a lock body it did not install');
  assert.match(refused.output, /ROLLBACK_REFUSED/, refused.output);
  putBack('lock');
  psql(`SELECT replace(d, 'v_result jsonb;', 'v_result jsonb; v_changed int;') FROM public.zz_defs WHERE k = 'job' \\gexec`);
  const refusedJob = apply('reverse.sql');
  assert.notEqual(refusedJob.status, 0, 'rollback must refuse a complete_job it did not install');
  assert.match(refusedJob.output, /ROLLBACK_REFUSED: complete_job/, refusedJob.output);
  putBack('job');
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.complete_job(uuid, jsonb, uuid, text)'::regprocedure;`), 'cb32addd7999eae75282813e94962bba');
  psql('DROP TABLE public.zz_defs;');
  const rolled = apply('reverse.sql');
  assert.equal(rolled.status, 0, rolled.output);
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public._lock_job_stock_rows_in_order()'::regprocedure;`),
    '1db82a3124369cd6009643a3e6e4596f');
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) || ',' || has_function_privilege('authenticated', oid, 'EXECUTE') || ',' || has_function_privilege('service_role', oid, 'EXECUTE') || ',' || has_function_privilege('anon', oid, 'EXECUTE') FROM pg_proc WHERE oid = 'public.complete_job(uuid, jsonb, uuid, text)'::regprocedure;`),
    '6ec962c198bf326b4ef773fa8d8d5edc,true,true,false');
  assert.equal(await numberLockWhileWaiting(), 'Lock/false', 'after rollback complete_job no longer takes the number lock first');
  const againReverse = apply('reverse.sql');
  assert.notEqual(againReverse.status, 0);
  assert.match(againReverse.output, /ROLLBACK_REFUSED/);
  const PH = id('b8'), PI = id('b9'), JA = id('51'), JB = id('52');
  raw(`INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active) VALUES
      ('${PH}', '[PROVER] Roll A', 'JS-PH', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true),
      ('${PI}', '[PROVER] Roll B', 'JS-PI', 'liquid', 'Gal', 'Gal', 'Gal', 'Gal', 16, 24, 30, 30, 30, 1, true);
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, created_by) VALUES
      ('${JA}', 'JS-RA', '${CUST}', current_date, 'in_progress', '${ADMIN}'),
      ('${JB}', 'JS-RB', '${CUST}', current_date, 'in_progress', '${ADMIN}');
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, sort_order, customer_supplied) VALUES
      ('${JA}', '${PI}', 2, 'Gal', 1, false),
      ('${JA}', '${PH}', 2, 'Gal', 2, false),
      ('${JB}', '${PH}', 2, 'Gal', 1, false),
      ('${JB}', '${PI}', 2, 'Gal', 2, false);`);
  const rawRace = await oppositeInserts(PI, PH, PH, PI);
  assert.ok(rawRace.failed, `after rollback the plain insert must collide again:\n${rawRace.t1.out}\n${rawRace.t2.out}`);
  psql(complete(JA));
  assert.equal(scalar(`(SELECT status FROM public.jobs WHERE id = '${JA}') || '/' || ${rowCount(PH)} || '/' || ${onHand(PH)} || '/' || ${onHand(PI)}`), 'completed/1/-2/-2');
  console.log('[case] rollback refuses a changed lock body or complete_job, restores both, refuses a second run, the restored complete_job still completes a job, and opposite inserts collide again');
}

async function main() {
  buildContainer();
  seed();
  await beforeCases();
  await afterCases();
  await rollbackCases();
  console.log('JOB_STOCK_ROW_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }

