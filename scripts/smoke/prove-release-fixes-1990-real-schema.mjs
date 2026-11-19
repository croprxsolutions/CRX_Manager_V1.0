#!/usr/bin/env node
/**
 * Real-schema proof for 20270129160000_release_fixes_1990 (release v0.1.0, #1990: Sol HIGHs and apply-review CHECK 4s).
 * Container setup and replay copied from prove-booking-guard-rep-and-delete-real-schema.mjs; the KI-81 fixtures from
 * prove-ki81-sent-quote-price-real-schema.mjs. Each fix is shown BEFORE (the gap is real) and AFTER:
 *   1. KI-81: a $60 sent quote on the grower's per-acre field priced the per-unit chemical on their other field
 *      (save and preview); after, the $10 list price, and a quote on the per-unit field itself still prices it.
 *      The split helper loses service_role EXECUTE.
 *   2. Stock unit: a REPEATABLE READ unit change slipped past a hold committed after its snapshot; after, refused
 *      PRODUCT_UNIT_CHANGE_NEEDS_READ_COMMITTED (READ COMMITTED behaves as before).
 *   3. Purchasing plan: an accepted booking whose only order is soft-deleted was missing; after, its 100 Gal shows.
 *   4. auto_expire_quotes: two overlapping sweeps alerted twice; after, once; a repeated idempotency key replays;
 *      grants stay postgres + service_role and the nightly cron line still runs.
 * Then a second apply stops at the preflight, the reverse restores every body and grant, and the candidate re-applies.
 *
 * Run: node scripts/smoke/prove-release-fixes-1990-real-schema.mjs   (needs Docker)
 * Prints RELEASE_FIXES_1990_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Iterating: CRX_PROVER_REUSE=<kept container> CRX_PROVER_DB=<a copy of its replayed database> skips the replay.
const REUSE = process.env.CRX_PROVER_REUSE;
const NAME = REUSE || `crx-rf90-${process.pid}-${Date.now().toString(36)}`;
const DB = process.env.CRX_PROVER_DB || 'postgres';
// Shell commands below name the database; only a bare name is accepted (Sol r1).
if (!/^[a-z0-9_]+$/.test(DB)) throw new Error('CRX_PROVER_DB must be a bare database name (a-z, 0-9, _)');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270129160000_release_fixes_1990.sql');
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
// A later or parked file that (re)defines anything the candidate changes or relies on.
// Also what the proof relies on: the field-app saves and preview, the stock-unit guard, the plan and the expiry sweep.
const TOUCHED = /(_save_field_app_invoice_impl_20260714|_preview_field_app_invoice_split_impl_20260908|_save_field_app_split_invoice_impl|_refuse_stock_unit_change_with_history|a2_product_unit_keeps_history|get_purchasing_plan|auto_expire_quotes|check_idempotency|save_idempotency)/i;
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


const REVERSE = path.join(ROOT, 'scripts', 'smoke', 'release-fixes-1990-reverse.sql');
const id = (s) => `a81a81a8-0000-4000-8000-${String(s).padStart(12, '0')}`;
const ADMIN = id('a1'), A = id('c1'), G = id('f1'), PA = id('f4'), P = id('d1'), SU = id('d5'), PP = id('d6');
const SPLIT = 'public._save_field_app_split_invoice_impl(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text,text)';
const FNS = ['_save_field_app_invoice_impl_20260714', '_preview_field_app_invoice_split_impl_20260908',
  '_refuse_stock_unit_change_with_history', 'get_purchasing_plan', 'auto_expire_quotes'];
const bodies = () => scalar(`SELECT string_agg(proname || ':' || md5(replace(prosrc, chr(13), '')), ',' ORDER BY proname)
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('${FNS.join("','")}');`);
const grants = (sig) => scalar(`SELECT COALESCE(string_agg(g, ',' ORDER BY g), '-') FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
  FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${sig}'::regprocedure AND a.privilege_type = 'EXECUTE') x;`);
const OLD_BODIES = '_preview_field_app_invoice_split_impl_20260908:97c05bf6abe6303d3d3c3b2720a5f104,'
  + '_refuse_stock_unit_change_with_history:edb18d7a09c0475bf1c6316c8d2d11e2,'
  + '_save_field_app_invoice_impl_20260714:14e32574403a249a9a138a2546f6809d,'
  + 'auto_expire_quotes:92a217ecd60983a8ee53271edc86d79d,get_purchasing_plan:25b0591e2df6d2c34d3aaaf9e5df5e71';
const NEW_BODIES = '_preview_field_app_invoice_split_impl_20260908:493f1256b3699729ccbfd5bfe67d9707,'
  + '_refuse_stock_unit_change_with_history:20f02f8606621be4bc042d7787c34cdb,'
  + '_save_field_app_invoice_impl_20260714:6cbd5936bdb6af9eed48dedcfa2cebc6,'
  + 'auto_expire_quotes:1f9f7ffad3513fdc8280a1e714bcc3a3,get_purchasing_plan:e196689d988d1da81ff9e2c3e9208762';

function seed() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'rf90-admin@example.invalid', '{"full_name":"[PROVER] RF90 Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};
    INSERT INTO public.customers (id, farm_name, assigned_tier, is_active) VALUES ('${A}', '[PROVER] RF90 Farm A', 1, true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, is_active) VALUES
      ('${P}', '[PROVER] RF90 Gallon chem', 'RF90-GAL', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 5, 10, 10, 10, true),
      ('${SU}', '[PROVER] RF90 Unit chem', 'RF90-UNIT', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 5, 10, 10, 10, true),
      ('${PP}', '[PROVER] RF90 Plan chem', 'RF90-PLAN', 'liquid', 'Gal', 'Gal', 'oz', 'Gal', 5, 10, 10, 10, true);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
      ('${G}', '${A}', '[PROVER] RF90 per-unit field', 100, true), ('${PA}', '${A}', '[PROVER] RF90 per-acre field', 100, true);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES
      ('${G}', '${A}', 100, true, NULL), ('${PA}', '${A}', 100, true, 5000);
    DELETE FROM public.app_settings WHERE setting_key = 'per_line_split_billing_enabled';
    INSERT INTO public.app_settings (setting_key, setting_value) VALUES ('per_line_split_billing_enabled', 'true');`);
  // Test-only helpers (prover database only): k81.quote is the KI-81 prover's sent-quote fixture.
  psql(`CREATE SCHEMA k81 AUTHORIZATION supabase_admin;
    CREATE FUNCTION k81.quote(p_customer uuid, p_field uuid, p_product uuid, p_price numeric, p_status text, p_expires date, p_sent boolean)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET session_replication_role = replica AS $f$
    DECLARE v_q uuid := gen_random_uuid(); v_s uuid := gen_random_uuid(); v_i uuid := gen_random_uuid();
    BEGIN
      INSERT INTO quotes (id, quote_number, customer_id, created_by, status, expires_at)
      VALUES (v_q, 'RF90-' || left(v_q::text, 8), p_customer, '${ADMIN}', p_status, p_expires);
      INSERT INTO quote_sections (id, quote_id, section_name, sort_order, field_id, needed_by_date)
      VALUES (v_s, v_q, 'RF90', 0, p_field, (now() AT TIME ZONE 'America/Chicago')::date + 30);
      INSERT INTO quote_items (id, quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit, unit_size)
      VALUES (v_i, v_q, v_s, p_product, 0, p_price, 20, 10, 2, 'gal/acre', 'Gal');
      IF p_sent THEN
        INSERT INTO quote_versions (quote_id, version_number, sent_by, snapshot_data, restore_trusted_at)
        VALUES (v_q, 1, '${ADMIN}', jsonb_build_object('quote', jsonb_build_object('customer_id', p_customer),
          'sections', jsonb_build_array(jsonb_build_object('items', jsonb_build_array(jsonb_build_object(
            'quote_item_id', v_i, 'product_id', p_product, 'price_per_unit', p_price, 'unit_size', 'Gal'))))), now());
      END IF;
      RETURN v_q;
    END $f$;
    GRANT USAGE, CREATE ON SCHEMA k81 TO postgres; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA k81 TO postgres;`, { user: 'supabase_admin' });
  psql(`CREATE FUNCTION k81.save_single_all(p_by uuid, p_fields uuid[], p_product uuid)
    RETURNS TABLE (customer_id uuid, unit_price_cents bigint, price_source text) LANGUAGE plpgsql SET search_path = public, pg_temp AS $f$
    DECLARE v_res jsonb;
    BEGIN
      v_res := public.save_field_app_invoice(NULL,
        jsonb_build_object('invoice_date', ((now() AT TIME ZONE 'America/Chicago')::date)::text, 'salesman_id', p_by),
        (SELECT jsonb_agg(jsonb_build_object('field_id', f, 'map_number', n, 'total_acres', 100, 'planted_acres', 100,
          'applied_acres', 10, 'sort_order', n - 1)) FROM unnest(p_fields) WITH ORDINALITY AS u(f, n)),
        jsonb_build_array(jsonb_build_object('description', 'RF90 chem', 'rate_per_acre', 16, 'rate_unit', 'oz', 'unit_size', 'Gal',
          'cost_cents', 500, 'sort_order', 0, 'manual_override', false, 'product_id', p_product)),
        p_by, NULL, 'rf90-single-' || gen_random_uuid());
      RETURN QUERY SELECT i.customer_id, ii.unit_price_cents::bigint, ii.price_source FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.invoice_id IN (SELECT (x #>> '{}')::uuid FROM jsonb_array_elements(v_res->'invoice_ids') x) AND ii.product_id = p_product;
    END $f$;
    CREATE FUNCTION k81.preview(p_fields uuid[], p_product uuid)
    RETURNS TABLE (customer_id uuid, unit_price_cents bigint) LANGUAGE plpgsql SET search_path = public, pg_temp AS $f$
    DECLARE v_res jsonb;
    BEGIN
      v_res := public.preview_field_app_invoice_split(
        (SELECT jsonb_agg(jsonb_build_object('field_id', f, 'applied_acres', 10)) FROM unnest(p_fields) f),
        jsonb_build_array(jsonb_build_object('description', 'RF90 chem', 'rate_per_acre', 16, 'rate_unit', 'oz', 'unit_size', 'Gal',
          'manual_override', false, 'product_id', p_product)),
        NULL, NULL, (now() AT TIME ZONE 'America/Chicago')::date);
      RETURN QUERY SELECT (c->>'customer_id')::uuid, (l->>'unit_price_cents')::bigint
        FROM jsonb_array_elements(v_res->'per_customer') c, jsonb_array_elements(c->'lines') l WHERE l->>'kind' = 'chemical';
    END $f$;`);
  // The setup guard refuses every stock-unit change on a saved product today; it is lifted here (prover database
  // only) so the history guard underneath, which this migration changes, is what decides.
  psql('ALTER TABLE public.products DISABLE TRIGGER trg_validate_product_setup_fields;');
  console.log('[prover] committed test rows: grower A with a per-unit field and a per-acre field ($50.00/acre), three $10.00 Gal chemicals');
}

// 1. KI-81: A's per-unit chemical on the per-unit field, while a $60 quote sits on A's per-acre field.
const SAVE = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
SELECT string_agg(unit_price_cents || ':' || price_source, ',' ORDER BY unit_price_cents) FROM k81.save_single_all('${ADMIN}', ARRAY['${G}', '${PA}']::uuid[], '${P}') WHERE customer_id = '${A}';`;
const PREVIEW = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
SELECT string_agg(unit_price_cents::text, ',' ORDER BY unit_price_cents) FROM k81.preview(ARRAY['${G}', '${PA}']::uuid[], '${P}') WHERE customer_id = '${A}';`;

// 2. A REPEATABLE READ stock-unit change that took its snapshot before a hold on the product committed.
function unitRace(tag) {
  raw(`DELETE FROM public.inventory_holds WHERE product_id = '${SU}'; UPDATE public.products SET inventory_unit = 'Gal', unit_size = 'Gal' WHERE id = '${SU}';`);
  docker(['exec', '-d', NAME, 'sh', '-c', `psql -U postgres -d ${DB} -X -q -A -t -v ON_ERROR_STOP=1 > /tmp/race-${tag}.out 2>&1 <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM public.products;
SELECT pg_sleep(4);
UPDATE public.products SET inventory_unit = 'Qt', unit_size = 'Qt' WHERE id = '${SU}';
COMMIT;
SQL`]);
  wait(1500);
  assert.equal(scalar("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND pid <> pg_backend_pid();"), '1', 'the unit-change session is not waiting');
  // A hold as create_inventory_hold leaves it: the product read FOR SHARE (a2_history_row_locks_product), then the row.
  // Its intent guard is skipped (replica mode; prover database only): what matters is a committed row the snapshot missed.
  psql(`BEGIN; SELECT 1 FROM public.products WHERE id = '${SU}' FOR SHARE; SET LOCAL session_replication_role = replica;
    INSERT INTO public.inventory_holds (product_id, created_by, quantity, hold_type, notes) VALUES ('${SU}', '${ADMIN}', 5, 'manual', '[PROVER] RF90 hold');
    COMMIT;`, { user: 'supabase_admin' });
  for (let i = 0; i < 60 && scalar("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND pid <> pg_backend_pid();") !== '0'; i += 1) wait(250);
  wait(500);
  return { out: docker(['exec', NAME, 'cat', `/tmp/race-${tag}.out`]).stdout,
    after: scalar(`SELECT inventory_unit || '/' || (SELECT count(*) FROM public.inventory_holds WHERE product_id = '${SU}' AND is_active) FROM public.products WHERE id = '${SU}';`) };
}

// 3. An accepted booking of 100 Gal whose only order was soft-deleted.
let planQuote;
function planFixture() {
  planQuote = scalar(`SELECT k81.quote('${A}', NULL, '${PP}', 20.00, 'accepted', NULL, false);`);
  raw(`UPDATE public.quote_items SET total_units_needed = 100 WHERE quote_id = '${planQuote}';
    INSERT INTO public.orders (order_number, customer_id, quote_id, status, deleted_at) VALUES ('[PROVER] RF90-DEL', '${A}', '${planQuote}', 'cancelled', now());`);
}
const PLAN = () => `SELECT COALESCE((SELECT sum((r->>'quantity')::numeric)::text FROM jsonb_array_elements(get_purchasing_plan(12)->'products') p,
  jsonb_array_elements(p->'rows') r WHERE r->>'quote_id' = '${planQuote}'), 'none');`;

// 4. Two overlapping expiry sweeps over one part-drawn booking past its date.
function expiryFixture() {
  const q = scalar(`SELECT k81.quote('${A}', NULL, '${P}', 20.00, 'sent', (now() AT TIME ZONE 'America/Chicago')::date - 30, false);`);
  raw(`UPDATE public.quotes SET is_planned = false WHERE id = '${q}';
    INSERT INTO public.quote_product_draws (quote_id, product_id, quantity_drawn) VALUES ('${q}', '${P}', 5);`);
  return q;
}
function expiryRace(q, tag) {
  docker(['exec', '-d', NAME, 'sh', '-c', `psql -U postgres -d ${DB} -X -q -A -t -v ON_ERROR_STOP=1 > /tmp/exp-${tag}.out 2>&1 <<'SQL'
BEGIN;
SELECT public.auto_expire_quotes();
SELECT pg_sleep(4);
COMMIT;
SQL`]);
  wait(1500);
  assert.equal(scalar("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND pid <> pg_backend_pid();"), '1', 'the first sweep is not holding');
  const t0 = Date.now();
  psql('SELECT public.auto_expire_quotes();');
  const waited = Date.now() - t0;
  for (let i = 0; i < 60 && scalar("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND pid <> pg_backend_pid();") !== '0'; i += 1) wait(250);
  return { waited, alerts: scalar(`SELECT count(*) FROM public.notifications WHERE related_entity_id = '${q}' AND notification_type = 'booking_past_expiry';`) };
}

async function main() {
  if (REUSE) {
    assert.match(REUSE, /^crx-[a-z0-9-]+$/, 'CRX_PROVER_REUSE must name a kept prover container (crx-...)');
    assert.equal(docker(['inspect', '-f', '{{.HostConfig.NetworkMode}}', REUSE]).stdout.trim(), 'none', 'CRX_PROVER_REUSE must be a network-less prover container');
    // Sol r1: only a fresh run copy (CREATE DATABASE rf90_run_<n> TEMPLATE <replayed db> OWNER postgres), checked
    // untouched before anything is written: the five replayed bodies, no seed rows and the setup guard still on.
    assert.match(DB, /^rf90_run_[a-z0-9_]+$/, 'CRX_PROVER_REUSE needs CRX_PROVER_DB naming a fresh copy called rf90_run_<n>');
  } else buildContainer();
  assert.equal(bodies(), OLD_BODIES, 'the replayed bodies are not the ones the candidate expects');
  assert.equal(scalar(`SELECT (SELECT count(*) FROM auth.users WHERE id = '${ADMIN}') + (SELECT count(*) FROM pg_namespace WHERE nspname = 'k81')
    + (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.products'::regclass AND tgname = 'trg_validate_product_setup_fields' AND tgenabled = 'D');`),
    '0', 'this database was already used by a proof run: make a fresh copy');
  seed();
  psql(`SELECT k81.quote('${A}', '${PA}', '${P}', 60.00, 'sent', (now() AT TIME ZONE 'America/Chicago')::date + 1, true);`);
  planFixture();

  // BEFORE
  const saveBefore = okProbe(SAVE), previewBefore = okProbe(PREVIEW);
  assert.equal(saveBefore, '0:manual,6000:quoted', `before: the per-acre field's $60 quote should price the per-unit line (got ${saveBefore})`);
  assert.equal(previewBefore, '6000', `before: the preview should show the per-acre field's $60 quote (got ${previewBefore})`);
  console.log(`[before] KI-81: a $60 quote on the per-acre field prices the per-unit chemical: save ${saveBefore}, preview ${previewBefore}`);
  assert.equal(grants(SPLIT), 'postgres,service_role');
  console.log(`[before] split helper EXECUTE: ${grants(SPLIT)}`);
  const raceBefore = unitRace('before');
  assert.equal(raceBefore.after, 'Qt/1', `before: the REPEATABLE READ unit change should slip past the new hold:\n${raceBefore.out}`);
  console.log(`[before] stock unit: a REPEATABLE READ change committed past a hold made after its snapshot (unit/holds now ${raceBefore.after})`);
  const planBefore = okProbe(PLAN(), ADMIN);
  assert.equal(planBefore, 'none', `before: the booking should be missing from the plan (got ${planBefore})`);
  console.log(`[before] purchasing plan: the accepted 100 Gal booking with only a deleted order shows ${planBefore}`);
  const expBefore = expiryRace(expiryFixture(), 'before');
  assert.equal(expBefore.alerts, '2', `before: two overlapping sweeps should alert twice (got ${expBefore.alerts})`);
  assert.ok(expBefore.waited < 1500, `before: the second sweep should not wait (${expBefore.waited} ms)`);
  console.log(`[before] auto_expire_quotes: two overlapping sweeps sent ${expBefore.alerts} past-date alerts for one booking (the second ran at once, ${expBefore.waited} ms)`);
  refusedProbe("SELECT public.auto_expire_quotes('rf90-k0');", /function public\.auto_expire_quotes\(unknown\) does not exist/);
  console.log('[before] auto_expire_quotes takes no idempotency key');

  // APPLY; a second apply stops at the preflight.
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  assert.equal(bodies(), NEW_BODIES);
  const second = apply('candidate.sql');
  assert.notEqual(second.status, 0);
  assert.match(second.output, /RELEASE_FIXES_PREFLIGHT: not the reviewed body/);
  console.log('[case] the candidate applies; a second apply stops at its preflight');

  // AFTER
  const saveAfter = okProbe(SAVE), previewAfter = okProbe(PREVIEW);
  assert.equal(saveAfter, '0:manual,1000:tier', `after: the per-unit line should take the $10 list price (got ${saveAfter})`);
  assert.equal(previewAfter, '1000', `after: the preview should show $10 (got ${previewAfter})`);
  console.log(`[after] KI-81: the per-acre field's quote no longer prices it: save ${saveAfter}, preview ${previewAfter}`);
  psql(`SELECT k81.quote('${A}', '${G}', '${P}', 8.00, 'sent', (now() AT TIME ZONE 'America/Chicago')::date + 1, true);`);
  const own = okProbe(SAVE), ownPreview = okProbe(PREVIEW);
  assert.equal(own, '0:manual,800:quoted'); assert.equal(ownPreview, '800');
  console.log(`[after] KI-81: a quote on the per-unit field itself still prices it: save ${own}, preview ${ownPreview}`);
  assert.equal(grants(SPLIT), 'postgres');
  for (const role of ['service_role', 'authenticated', 'anon']) {
    assert.equal(scalar(`SELECT has_function_privilege('${role}', '${SPLIT}', 'EXECUTE');`), 'f', `${role} can still run the split helper`);
  }
  console.log('[after] split helper: only its owner (postgres) may run it; service_role, authenticated and anon cannot');
  const raceAfter = unitRace('after');
  assert.equal(raceAfter.after, 'Gal/1', `after: the REPEATABLE READ change must be refused:\n${raceAfter.out}`);
  assert.match(raceAfter.out, /PRODUCT_UNIT_CHANGE_NEEDS_READ_COMMITTED: change a stock unit in a READ COMMITTED transaction \(this one is repeatable read\)/);
  refusedProbe(`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; UPDATE public.products SET inventory_unit = 'Qt', unit_size = 'Qt' WHERE id = '${PP}';`,
    /PRODUCT_UNIT_CHANGE_NEEDS_READ_COMMITTED/);
  refusedProbe(`UPDATE public.products SET inventory_unit = 'Qt', unit_size = 'Qt' WHERE id = '${SU}';`, /PRODUCT_UNIT_HAS_HISTORY/);
  const rc = okProbe(`UPDATE public.products SET inventory_unit = 'Qt', unit_size = 'Qt' WHERE id = '${PP}' RETURNING inventory_unit;`);
  assert.equal(rc, 'Qt');
  const rrSame = okProbe(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; UPDATE public.products SET product_name = product_name WHERE id = '${SU}' RETURNING inventory_unit;`);
  assert.equal(rrSame, 'Gal');
  console.log(`[after] stock unit: the REPEATABLE READ change is refused PRODUCT_UNIT_CHANGE_NEEDS_READ_COMMITTED (unit/holds stay ${raceAfter.after});`
    + ' SERIALIZABLE too; READ COMMITTED still refuses it with history and allows it without; other edits at REPEATABLE READ are untouched');
  const planAfter = okProbe(PLAN(), ADMIN);
  assert.equal(planAfter, '100', `after: the booking's 100 Gal should be in the plan (got ${planAfter})`);
  raw(`UPDATE public.orders SET deleted_at = NULL WHERE order_number = '[PROVER] RF90-DEL';`);
  assert.equal(okProbe(PLAN(), ADMIN), 'none', 'a live (cancelled) order still stands for the booking');
  raw(`UPDATE public.orders SET deleted_at = now() WHERE order_number = '[PROVER] RF90-DEL';`);
  console.log(`[after] purchasing plan: the booking shows ${planAfter} Gal; with its order not deleted it still shows none, as before`);
  const expAfter = expiryRace(expiryFixture(), 'after');
  assert.equal(expAfter.alerts, '1', `after: overlapping sweeps must alert once (got ${expAfter.alerts})`);
  assert.ok(expAfter.waited >= 1500, `after: the second sweep must wait for the first (${expAfter.waited} ms)`);
  console.log(`[after] auto_expire_quotes: two overlapping sweeps send ${expAfter.alerts} alert (the second waited ${expAfter.waited} ms, then saw the first)`);
  refusedProbe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; SELECT public.auto_expire_quotes();',
    /AUTO_EXPIRE_NEEDS_READ_COMMITTED: run the quote expiry sweep in a READ COMMITTED transaction \(this one is repeatable read\)/);
  console.log('[after] auto_expire_quotes at REPEATABLE READ is refused AUTO_EXPIRE_NEEDS_READ_COMMITTED');
  const k1 = scalar("SELECT public.auto_expire_quotes('rf90-k1');");
  // An undrawn quote past its date: a real run would now expire it; the repeated key must not.
  psql(`SELECT k81.quote('${A}', NULL, '${P}', 20.00, 'sent', (now() AT TIME ZONE 'America/Chicago')::date - 30, false);`);
  const k1again = scalar("SELECT public.auto_expire_quotes('rf90-k1');");
  assert.equal(k1again, k1, 'a repeated key must return the first result');
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'rf90-k1' AND operation = 'auto_expire_quotes';"), '1');
  const fresh = scalar("SELECT public.auto_expire_quotes();");
  assert.match(fresh, /"expired_count": 1/, `a keyless run should expire the undrawn quote: ${fresh}`);
  console.log(`[after] auto_expire_quotes('rf90-k1') twice returns ${k1} both times (replayed; a keyless run still sweeps: ${fresh})`);
  assert.equal(grants('public.auto_expire_quotes(text)'), 'postgres,service_role');
  assert.equal(okProbe('SET LOCAL ROLE service_role; SELECT public.auto_expire_quotes() IS NOT NULL;'), 't');
  refusedProbe('SELECT public.auto_expire_quotes();', /permission denied for function auto_expire_quotes/, ADMIN);
  const cron = scalar("SELECT command FROM cron.job WHERE jobname = 'auto-expire-quotes';");
  assert.match(cron, /auto_expire_quotes\(\)/);
  assert.equal(probe(`${cron};`).status, 0, `the nightly cron line no longer runs: ${cron}`);
  console.log(`[after] grants postgres + service_role (service_role runs it; a signed-in user cannot); the cron line "${cron}" still runs`);

  // ROLLBACK, then re-apply.
  stageText('reverse.sql', lf(REVERSE));
  const rev = apply('reverse.sql');
  assert.equal(rev.status, 0, rev.output);
  assert.equal(bodies(), OLD_BODIES, 'the reverse must restore every previous body');
  assert.equal(grants(SPLIT), 'postgres,service_role');
  assert.equal(grants('public.auto_expire_quotes()'), 'postgres,service_role');
  const again = apply('candidate.sql');
  assert.equal(again.status, 0, again.output);
  assert.equal(bodies(), NEW_BODIES);
  console.log('[case] the reverse restores all five bodies and both grants byte-identical; the candidate re-applies');
  console.log('RELEASE_FIXES_1990_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP && !REUSE) docker(['rm', '-f', NAME], { allowFailure: true }); }
