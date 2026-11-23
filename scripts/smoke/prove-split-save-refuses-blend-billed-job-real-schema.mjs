#!/usr/bin/env node
/**
 * Real-schema proof for 20270224130000_split_save_refuses_blend_billed_job (#2063).
 * Contract: docs/plans/2026-11-22-job-double-bill-blend-CONTRACT.md (proof cases 1-10).
 * Container setup, replay and seed copied from probe-job-double-bill-blend-real-schema.mjs. Blend-ticket invoices
 * are made by create_invoice_from_blend_ticket with triggers on; only the legacy deleted-ticket case is inserted
 * with triggers off (that state is unreachable through the app).
 *   1. BEFORE: a split save for a job a live blend invoice already billed is accepted (the bug).
 *   2. The candidate applies; a second apply is refused by its preflight.
 *   3. AFTER: refused (admin and a second rep), nothing left behind; void releases it; negative controls; legacy
 *      deleted ticket; re-save rollback byte-identical; two-connection races both ways and a rollback;
 *      REPEATABLE READ / SERIALIZABLE refused; reverse with a live sibling; existing chains before and after.
 *
 * Run: node scripts/smoke/prove-split-save-refuses-blend-billed-job-real-schema.mjs   (needs Docker)
 * Prints SPLIT_SAVE_REFUSES_BLEND_BILLED_JOB_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a fresh, network-less container this run builds (no reuse: seed() rewrites reference data).
const NAME = `crx-a2p-${process.pid}-${Date.now().toString(36)}`;
const DB = 'postgres';
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20270224130000_split_save_refuses_blend_billed_job.sql');
// A later or parked file that (re)defines what the candidate changes or this proof relies on.
const TOUCHED = /(_save_field_app_split_invoice_impl|save_field_app_split_invoice|create_invoice_from_blend_ticket|enforce_linked_blend_ticket_header_lock|FUNCTION (public\.)?void_invoice\()/i;
// M9 re-emits the void_invoice wrapper with one refusal that fires only for an invoice a returned check paid
// (money_reversal_lines); this proof's voids have none.
// Pinned to the reviewed bytes: an edited M9 trips this proof's guard again.
const LATER_READ_ONLY = new Map([['20270226213000_m9_refunds_and_returned_checks.sql', '375fd2ef3dff0d9777039a12a6eb62bd4e756c6ca8bfcd0525966717b702992c']]);
const laterReadOnly = (file) => LATER_READ_ONLY.get(path.basename(file)) === createHash('sha256').update(readFileSync(file)).digest('hex');
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
  for (const file of all.slice(at + 1).filter((f) => !laterReadOnly(f))) {
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
const claimsFor = (uid) => `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSET LOCAL ROLE authenticated;`;
// One transaction as a signed-in user: rolled back by default, or committed; iso picks the isolation level.
function run(sql, uid, { commit = false, iso = 'READ COMMITTED' } = {}) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true,
    input: `BEGIN ISOLATION LEVEL ${iso};\n${claimsFor(uid)}\n${sql}\n${commit ? 'COMMIT' : 'ROLLBACK'};\n` });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, last: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '' };
}
function ok(sql, uid, opts) { const r = run(sql, uid, opts); assert.equal(r.status, 0, r.output); return r.last; }
function refused(sql, pattern, uid, opts) {
  const r = run(sql, uid, opts);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}\n${r.output}`);
  assert.match(r.output, pattern);
  return r.output;
}
// A psql session left open (stdin kept), so another connection can be made to wait on its locks.
function openSession(app, sql) {
  const p = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${app}`, NAME, 'psql', '-U', 'postgres', '-d', DB, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t'], { cwd: ROOT });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => p.on('close', (code) => resolve({ code, out })));
  p.stdin.write(sql);
  return { p, done, end(tail) { p.stdin.end(tail); } };
}
async function until(sql, what) {
  for (let i = 0; i < 120; i += 1) {
    if (scalar(sql) === 't') return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}
// Idle in its transaction AFTER the billing call itself (not between setup statements): the last query names the RPC.
const idleInTxn = (app, rpc) => until(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${app}' AND state = 'idle in transaction' AND position('${rpc}' IN query) > 0);`, `${app} to hold its transaction after ${rpc}`);
const waitingOnLock = (app) => until(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${app}' AND wait_event_type = 'Lock');`, `${app} to wait on a lock`);

const ADMIN = 'e1100000-0000-4000-8000-0000000000a1';
const REP = 'e1100000-0000-4000-8000-0000000000b2';
const REP2 = 'e1100000-0000-4000-8000-0000000000c3';
const APPL = 'e1100000-0000-4000-8000-0000000000d4';
function seed() {
  // Live auth has these; deactivating a profile (probe P5) bans the user and ends their sessions.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;`, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ejob-admin@example.invalid', '{"full_name":"[PROVER] EJ Admin","role":"admin"}'::jsonb),
    ('${REP}', 'ejob-rep@example.invalid', '{"full_name":"[PROVER] EJ Rep","role":"sales_rep"}'::jsonb),
    ('${REP2}', 'ejob-rep2@example.invalid', '{"full_name":"[PROVER] EJ Rep 2","role":"sales_rep"}'::jsonb),
    ('${APPL}', 'ejob-appl@example.invalid', '{"full_name":"[PROVER] EJ Applicator","role":"applicator"}'::jsonb),
    ('e1100000-0000-4000-8000-0000000000a5', 'ejob-admin2@example.invalid', '{"full_name":"[PROVER] EJ Admin 2","role":"admin"}'::jsonb),
    ('e1100000-0000-4000-8000-0000000000d6', 'ejob-appl2@example.invalid', '{"full_name":"[PROVER] EJ Applicator 2","role":"applicator"}'::jsonb),
    -- the invented profiles smoke-ops-replay-binding-batch4e expects
    ('4c4d0000-0000-4000-8000-0000000000a1', 'ejob-inv-a1@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('4c4d0000-0000-4000-8000-0000000000a2', 'ejob-inv-a2@example.invalid', '{"full_name":"[PROVER] Admin B","role":"admin"}'::jsonb),
    ('4c4d0000-0000-4000-8000-0000000000b1', 'ejob-inv-b1@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
    ('4c4d0000-0000-4000-8000-0000000000c1', 'ejob-inv-c1@example.invalid', '{"full_name":"[PROVER] Applicator","role":"applicator"}'::jsonb);`);
  raw(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id IN ('${REP}', '${REP2}');
    UPDATE public.profiles SET role = 'applicator', is_active = true WHERE id = '${APPL}';
    UPDATE public.profiles SET role = 'admin', is_active = true
     WHERE id IN ('e1100000-0000-4000-8000-0000000000a5', '4c4d0000-0000-4000-8000-0000000000a1', '4c4d0000-0000-4000-8000-0000000000a2');
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '4c4d0000-0000-4000-8000-0000000000b1';
    UPDATE public.profiles SET role = 'applicator', is_active = true
     WHERE id IN ('e1100000-0000-4000-8000-0000000000d6', '4c4d0000-0000-4000-8000-0000000000c1');
    DELETE FROM public.unit_conversions;
    INSERT INTO public.unit_conversions (id, unit, factor_oz, unit_type, notes) VALUES ${LIVE_UNIT_ROWS};`);
}
function chainOutcome(file) {
  stageText(file, lf(path.join(ROOT, 'scripts', 'smoke', file)));
  const r = apply(file);
  const line = r.output.split(/\r?\n/).find((l) => /ERROR:/.test(l)) ?? `(no error, status ${r.status})`;
  return { outcome: line.replace(/^.*?ERROR:\s*/, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>').replace(/\b[0-9a-f]{8}\b/g, '<sfx>'), output: r.output };
}
const REGRESSION = ('smoke-per-line-split-billing smoke-field-invoice-loop smoke-backfill-refuse-split-billing '
  + 'smoke-split-invoice-cross-customer-lineage smoke-order-invoice-refuses-field-split smoke-transfer-invoice-to-job '
  + 'smoke-transfer_job_invoice_column_fixes').split(' ').map((f) => `${f}.sql`);
// shortcut: these chains already fail during their own setup on today's schema (fixture drift: pricing source, rate units,
// product form, missing fixtures), before any split or blend-invoice step; the prover only checks the candidate leaves
// their outcome unchanged. Move them to REGRESSION once their fixtures are refreshed. machine_fee joined after #2240
// (20270224110000) forbade the per-acre price override its case D inserts.
const STALE = ('smoke-save-invoice-field-app smoke-field-app-split-penny-exact smoke-blend-ticket-pricing-guards '
  + 'smoke-gauntlet-core-blend-guards smoke-blend-invoice-approval-binding smoke-blend-invoice-binding-lows '
  + 'smoke-blend_invoice_app_service_guard smoke-transfer_job_invoice_machine_fee').split(' ').map((f) => `${f}.sql`);
const JOBS = ['B1', 'U2', 'M3', 'L4', 'R5', 'X6', 'X7', 'X8', 'S9', 'I10'];
const jobId = (n) => `(SELECT id FROM jobs WHERE job_number = 'J-PRV-A2-${n}')`;
const ticketId = (t) => `(SELECT id FROM blend_tickets WHERE ticket_number = 'BT-PRV-A2-${t}')`;
const fieldsOf = (n) => `(SELECT jsonb_agg(jsonb_build_object('field_id', field_id, 'applied_acres', acres_to_treat) ORDER BY sort_order) FROM job_fields WHERE job_id = ${jobId(n)})`;
const LINES = `jsonb_build_array(
    jsonb_build_object('line_kind', 'service', 'application_service_id', (SELECT id FROM application_services WHERE name = '[PROVER] A2 Svc'),
      'description', '[PROVER] A2 Svc', 'source_acres', 100, 'manual_override', true, 'source_unit_price_cents', 100),
    jsonb_build_object('line_kind', 'chemical', 'product_id', (SELECT id FROM products WHERE product_name = '[PROVER] A2 Chem'),
      'description', '[PROVER] A2 Chem', 'source_quantity', 100, 'rate_unit', 'gal', 'manual_override', true, 'source_unit_price_cents', 1500))`;
// The public split save, as the screen calls it: source job (or NULL), every field of the job, two lines.
const split = (job, fieldsJob, key, uid, set = 'NULL') => `SELECT public.save_field_app_split_invoice(${set}, ${job === null ? 'NULL' : jobId(job)},
    jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[PROVER] A2 split'),
    ${fieldsOf(fieldsJob)}, ${LINES}, '${uid}', NULL, '${key}')::text;`;
const blendInvoice = (t, key) => `SELECT public.create_invoice_from_blend_ticket(${ticketId(t)}, '${ADMIN}', '${key}')->'invoice_ids'->>0;`;
const voidInv = (idExpr, key) => `SELECT public.void_invoice(${idExpr}, '[PROVER] A2 release', '${key}');\nSELECT 'voided';`;
const BLEND_REFUSAL = (_ticket, shown = '[^)]*') => new RegExp(`BLEND_TICKET_ALREADY_BILLED: a blend ticket for this job is already billed \\(${shown}\\); billing the job here too would double-bill the customer`);
const blendInvoiceNumber = (t) => scalar(`SELECT string_agg(invoice_number, ', ' ORDER BY invoice_number) FROM invoices WHERE blend_ticket_id = ${ticketId(t)};`);
// Everything a split re-save writes for a job, as one fingerprint (rows, not counts).
const snapshot = (n) => scalar(`WITH s AS (SELECT * FROM field_app_billing_sets WHERE source_job_id = ${jobId(n)}),
    inv AS (SELECT * FROM invoices WHERE job_id = ${jobId(n)} OR field_app_billing_set_id IN (SELECT id FROM s))
  SELECT count(*) || ':' || md5(string_agg(t, '|' ORDER BY t)) FROM (
    SELECT 'inv' || row_to_json(i)::text t FROM inv i
    UNION ALL SELECT 'item' || row_to_json(ii)::text FROM invoice_items ii WHERE ii.invoice_id IN (SELECT id FROM inv)
    UNION ALL SELECT 'share' || row_to_json(sh)::text FROM invoice_shares sh WHERE sh.invoice_id IN (SELECT id FROM inv)
    UNION ALL SELECT 'line' || row_to_json(b)::text FROM field_app_billing_lines b WHERE b.billing_set_id IN (SELECT id FROM s)
    UNION ALL SELECT 'loc' || row_to_json(l)::text FROM field_app_locations l WHERE l.invoice_group_id IN (SELECT invoice_group_id FROM s)
    UNION ALL SELECT 'set' || row_to_json(s)::text FROM s
    UNION ALL SELECT 'job' || row_to_json(j)::text FROM jobs j WHERE j.id = ${jobId(n)}) x;`);

async function race(firstApp, firstSql, firstUid, secondApp, secondSql, secondUid, firstEnd) {
  const a = openSession(firstApp, `BEGIN;\n${claimsFor(firstUid)}\n${firstSql}\n`);
  await idleInTxn(firstApp, /create_invoice_from_blend_ticket|save_field_app_split_invoice/.exec(firstSql)[0]);
  const b = openSession(secondApp, `BEGIN;\n${claimsFor(secondUid)}\n${secondSql}\nCOMMIT;\n`);
  b.end();
  await waitingOnLock(secondApp);
  a.end(`${firstEnd};\n`);
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 0, ra.out);
  return rb;
}

async function main() {
  buildContainer();
  seed();
  // Fixtures, committed (disposable container). The product is priced through the governed path.
  psql(`DO $fx$
  DECLARE v_admin uuid := '${ADMIN}'; v_cust uuid; v_cust2 uuid; v_prod uuid; v_field uuid; v_pricing jsonb; v_job uuid; n text;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    INSERT INTO customers (farm_name, assigned_tier) VALUES ('[PROVER] A2 Farm', 1) RETURNING id INTO v_cust;
    INSERT INTO customers (farm_name, assigned_tier) VALUES ('[PROVER] A2 Farm Two', 1) RETURNING id INTO v_cust2;
    INSERT INTO products (product_name, unit_size, product_form, inventory_unit)
      VALUES ('[PROVER] A2 Chem', 'gal', 'liquid', 'Gal') RETURNING id INTO v_prod;
    v_pricing := public.preview_product_pricing_changes('product_page', NULL,
      jsonb_build_array(jsonb_build_object('product_id', v_prod, 'row_version', 1, 'pricing_mode', 'price_driven',
        'new_cost', '5.00', 'tier1_price', '15.00', 'tier2_price', '15.00', 'tier3_price', '15.00')),
      v_admin, 'a2-pricing-preview');
    PERFORM public.apply_product_pricing_change_set((v_pricing->>'change_set_id')::uuid,
      v_pricing->>'request_fingerprint', v_admin, 'a2-pricing-apply');
    INSERT INTO application_services (name, is_active) VALUES ('[PROVER] A2 Svc', true);
    FOREACH n IN ARRAY ARRAY[${JOBS.map((j) => `'${j}'`).join(', ')}] LOOP
      INSERT INTO fields (field_name, customer_id, total_acres) VALUES ('[PROVER] A2 Field ' || n, v_cust, 100) RETURNING id INTO v_field;
      IF n = 'S9' THEN  -- two payers share this field
        INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field, v_cust, 50, true), (v_field, v_cust2, 50, false);
      ELSE
        INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES (v_field, v_cust, 100, true);
      END IF;
      INSERT INTO jobs (job_number, customer_id, status, job_date, total_acres, total_price_cents, total_cost_cents, created_by)
        VALUES ('J-PRV-A2-' || n, v_cust, 'scheduled', CURRENT_DATE - 3, 100, 150000, 50000, v_admin) RETURNING id INTO v_job;
      INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job, v_field, 100, 1);
      INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
        VALUES (v_job, v_prod, 100, 'Gal', 1, 'GAL', 500, 1500, 1);
      UPDATE jobs SET status = 'in_progress' WHERE id = v_job;
      UPDATE jobs SET status = 'completed' WHERE id = v_job;
    END LOOP;
    INSERT INTO app_settings (setting_key, setting_value) VALUES ('per_line_split_billing_enabled', 'true')
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = 'true';
  END $fx$;`);
  // Approved, unbilled blend tickets on the jobs (M3 has two), inserted with triggers on, as the upload makes them.
  const tickets = [['B1', 'B1'], ['U2', 'U2'], ['M3a', 'M3'], ['M3b', 'M3'], ['R5', 'R5'], ['X6', 'X6'], ['X7', 'X7'], ['X8', 'X8'], ['S9', 'S9']];
  psql(tickets.map(([t, j]) => `WITH bt AS (
      INSERT INTO blend_tickets (ticket_number, uploaded_by, customer_id, status, review_status, payment_status, order_link_status, season, total_acres, source, job_id)
      VALUES ('BT-PRV-A2-${t}', '${ADMIN}', (SELECT id FROM customers WHERE farm_name = '[PROVER] A2 Farm'), 'completed', 'approved', 'unbilled', 'unlinked',
        public.current_season(), 100, 'manual', ${jobId(j)}) RETURNING id),
    f AS (INSERT INTO blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres)
      SELECT bt.id, jf.field_id, (SELECT id FROM customers WHERE farm_name = '[PROVER] A2 Farm'), 100 FROM bt, job_fields jf WHERE jf.job_id = ${jobId(j)})
    INSERT INTO blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
      SELECT bt.id, (SELECT id FROM products WHERE product_name = '[PROVER] A2 Chem'), '[PROVER] A2 Chem', 100, 'Gal', 1, 'gal/ac', 1 FROM bt;`).join('\n'));
  // Real blend-ticket invoices (create_invoice_from_blend_ticket, triggers on) for B1 and one of M3's two tickets.
  for (const t of ['B1', 'M3a']) assert.match(ok(blendInvoice(t, `a2-blend-${t}`), ADMIN, { commit: true }), /^[0-9a-f-]{36}$/);
  // Legacy state, unreachable through the app (the header-lock trigger refuses it): a live invoice on a soft-deleted ticket.
  raw(`INSERT INTO blend_tickets (ticket_number, uploaded_by, customer_id, status, review_status, payment_status, order_link_status, season, total_acres, source, job_id, deleted_at)
       VALUES ('BT-PRV-A2-L4', '${ADMIN}', (SELECT id FROM customers WHERE farm_name = '[PROVER] A2 Farm'), 'completed', 'approved', 'billed', 'unlinked',
         public.current_season(), 100, 'manual', ${jobId('L4')}, now());
       INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, created_by, total_amount_cents, total_cost_cents, blend_ticket_id, season)
       VALUES ('INV-PRV-A2-L4', (SELECT id FROM customers WHERE farm_name = '[PROVER] A2 Farm'), 'field_application', 'unposted', CURRENT_DATE, '${ADMIN}',
         150000, 50000, ${ticketId('L4')}, public.current_season());
       -- A second live invoice on M3a, made by REP2 (stands in for a two-payer blend bill: one ticket, two invoices).
       INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, created_by, total_amount_cents, total_cost_cents, blend_ticket_id, season)
       VALUES ('INV-PRV-A2-M3R', (SELECT id FROM customers WHERE farm_name = '[PROVER] A2 Farm Two'), 'field_application', 'unposted', CURRENT_DATE, '${REP2}',
         75000, 25000, ${ticketId('M3a')}, public.current_season());`);
  assert.equal(scalar(`SELECT count(*) FROM invoices i JOIN blend_tickets bt ON bt.id = i.blend_ticket_id
    WHERE bt.ticket_number LIKE 'BT-PRV-A2-%' AND i.deleted_at IS NULL AND i.status NOT IN ('voided', 'cancelled');`), '4', 'fixture: B1, M3a (two) and L4 carry live blend invoices');

  // 1. BEFORE: the double bill is accepted.
  assert.match(ok(split('B1', 'B1', 'a2-before', ADMIN), ADMIN), /invoice_ids/, 'before the candidate the split save bills B1 again');
  console.log('[case] BEFORE: a split save for a job a live blend invoice already billed is ACCEPTED (the bug)');
  const before = Object.fromEntries(REGRESSION.map((f) => [f, chainOutcome(f).outcome]));
  const notPassing = REGRESSION.filter((f) => !/^SMOKE_PASS_ROLLBACK/.test(before[f]));
  assert.deepEqual(notPassing.map((f) => `${f}: ${before[f]}`), [], 'regression chains must pass before the candidate');
  const staleOutcome = (f) => chainOutcome(f).outcome.replace(/\d{4}-\d\d-\d\dT[0-9:.+]+/g, '<ts>').replace(/\b[0-9a-f]{32}\b/g, '<md5>');
  const staleBefore = Object.fromEntries(STALE.map((f) => [f, staleOutcome(f)]));
  for (const f of STALE) assert.doesNotMatch(staleBefore[f], /^SMOKE_PASS_ROLLBACK/, `${f} passes again: move it to REGRESSION`);

  // 2. Apply, then a second apply stops at the preflight.
  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  ledger(path.basename(CANDIDATE, '.sql'));
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.output, /SPLIT_BLEND_BILLED_PREFLIGHT/);
  console.log('[case] the candidate applies; a second apply stops at its preflight');

  // 3. AFTER. A committed attempt, then a separate connection checks nothing was left behind.
  const b1Invoice = blendInvoiceNumber('B1');
  assert.ok(b1Invoice, 'fixture: B1 blend invoice number');
  const adminOut = refused(split('B1', 'B1', 'a2-after-admin', ADMIN), BLEND_REFUSAL('B1', `invoice ${b1Invoice}`), ADMIN, { commit: true });
  assert.ok(!adminOut.includes('BT-PRV-A2-B1'), 'the refusal carries no user-typed ticket number');
  // REP2 neither made nor is salesman on the admin's blend invoice, so invoices_select hides it: neither named nor counted.
  const rep2Out = refused(split('B1', 'B1', 'a2-after-rep2', REP2), BLEND_REFUSAL('B1', 'an invoice you cannot open'), REP2, { commit: true });
  assert.ok(!rep2Out.includes(b1Invoice), 'a rep never sees the number of an invoice they cannot read');
  assert.equal(scalar(`SELECT (SELECT count(*) FROM field_app_billing_sets WHERE source_job_id = ${jobId('B1')})
    + (SELECT count(*) FROM invoices WHERE job_id = ${jobId('B1')})
    + (SELECT count(*) FROM idempotency_keys WHERE idempotency_key IN ('a2-after-admin', 'a2-after-rep2'));`), '0', 'a refused save leaves no set, invoice or receipt');
  assert.equal(scalar(`SELECT status || ':' || (invoice_id IS NULL) FROM jobs WHERE id = ${jobId('B1')};`), 'completed:true', 'the job is untouched');
  console.log('[case] AFTER: refused BLEND_TICKET_ALREADY_BILLED (admin sees the invoice number; a rep who cannot read it sees neither its number nor a count); no set, invoice, receipt or job change');

  assert.match(ok(split('U2', 'U2', 'a2-u2', ADMIN), ADMIN), /invoice_ids/, 'a job whose ticket is unbilled stays billable');
  // Two live invoices on one ticket: the admin sees both numbers, REP2 its own plus 'an invoice you cannot open'.
  const m3Admin = blendInvoiceNumber('M3a');
  refused(split('M3', 'M3', 'a2-m3', ADMIN), BLEND_REFUSAL('M3a', `invoice ${m3Admin}`), ADMIN);
  refused(split('M3', 'M3', 'a2-m3-rep2', REP2), BLEND_REFUSAL('M3a', 'invoice INV-PRV-A2-M3R; an invoice you cannot open'), REP2);
  assert.match(ok(split(null, 'U2', 'a2-jobless', ADMIN), ADMIN), /invoice_ids/, 'a jobless split is unaffected');
  refused(split('L4', 'L4', 'a2-l4', ADMIN), BLEND_REFUSAL('L4'), ADMIN);
  console.log('[case] AFTER: unbilled ticket -> billable; one billed of two tickets (two live invoices, readable ones named) -> refused; jobless split -> unaffected; live invoice on a soft-deleted ticket -> refused');

  refused(split('I10', 'I10', 'a2-rr', ADMIN), /SPLIT_INVOICE_NEEDS_READ_COMMITTED/, ADMIN, { iso: 'REPEATABLE READ' });
  refused(split('I10', 'I10', 'a2-ser', ADMIN), /SPLIT_INVOICE_NEEDS_READ_COMMITTED/, ADMIN, { iso: 'SERIALIZABLE' });
  assert.match(ok(split(null, 'I10', 'a2-rr-jobless', ADMIN), ADMIN, { iso: 'REPEATABLE READ' }), /invoice_ids/);
  assert.match(ok(split('I10', 'I10', 'a2-rc', ADMIN), ADMIN), /invoice_ids/);
  console.log('[case] AFTER: a split for a job under REPEATABLE READ or SERIALIZABLE is refused; READ COMMITTED and a jobless split are not');

  // Re-save rollback: split R5, void its children, the blend ticket then bills R5, and a re-save is refused untouched.
  const r5 = JSON.parse(ok(split('R5', 'R5', 'a2-r5', ADMIN), ADMIN, { commit: true }));
  const setR5 = `(SELECT id FROM field_app_billing_sets WHERE source_job_id = ${jobId('R5')})`;
  for (const [i, id] of r5.invoice_ids.entries()) ok(voidInv(`'${id}'`, `a2-r5-void-${i}`), ADMIN, { commit: true });
  assert.match(ok(blendInvoice('R5', 'a2-blend-R5'), ADMIN, { commit: true }), /^[0-9a-f-]{36}$/);
  const pre = snapshot('R5');
  assert.ok(Number(pre.split(':')[0]) >= 6, `the R5 fixture holds rows to compare: ${pre}`);
  refused(split('R5', 'R5', 'a2-r5-resave', ADMIN, setR5), BLEND_REFUSAL('R5'), ADMIN, { commit: true });
  assert.equal(snapshot('R5'), pre, 'a refused re-save changes nothing');
  console.log(`[case] AFTER: a re-save of a voided split set for a now blend-billed job is refused and leaves ${pre.split(':')[0]} rows byte-identical`);

  // Release: voiding B1's blend invoice re-opens the job.
  ok(voidInv(`(SELECT id FROM invoices WHERE blend_ticket_id = ${ticketId('B1')})`, 'a2-b1-void'), ADMIN, { commit: true });
  assert.match(ok(split('B1', 'B1', 'a2-b1-rebill', ADMIN), ADMIN), /invoice_ids/, 'after the void the job bills again');
  console.log('[case] AFTER: voiding the blend invoice re-opens the job to the split save');

  // Reverse with a live sibling: a two-payer split on S9, its anchor child voided, the other live -> blend refused.
  const s9 = JSON.parse(ok(split('S9', 'S9', 'a2-s9', ADMIN), ADMIN, { commit: true }));
  assert.equal(s9.invoice_ids.length, 2, 'S9 splits to two payers');
  ok(voidInv(`(SELECT invoice_id FROM jobs WHERE id = ${jobId('S9')})`, 'a2-s9-void'), ADMIN, { commit: true });
  assert.equal(scalar(`SELECT count(*) FROM invoices WHERE job_id = ${jobId('S9')} AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL;`), '1');
  refused(blendInvoice('S9', 'a2-blend-S9'), /JOB_ALREADY_INVOICED/, ADMIN);
  console.log('[case] AFTER: a two-payer split with its anchor voided and one live child still blocks the blend invoice');

  // Races on two connections.
  let rb = await race('a2_x6_blend', blendInvoice('X6', 'a2-blend-X6'), ADMIN, 'a2_x6_split', split('X6', 'X6', 'a2-x6', ADMIN), ADMIN, 'COMMIT');
  assert.notEqual(rb.code, 0, rb.out); assert.match(rb.out, BLEND_REFUSAL('X6'));
  rb = await race('a2_x7_split', split('X7', 'X7', 'a2-x7', ADMIN), ADMIN, 'a2_x7_blend', blendInvoice('X7', 'a2-blend-X7'), ADMIN, 'COMMIT');
  assert.notEqual(rb.code, 0, rb.out); assert.match(rb.out, /JOB_ALREADY_INVOICED/);
  rb = await race('a2_x8_blend', blendInvoice('X8', 'a2-blend-X8'), ADMIN, 'a2_x8_split', split('X8', 'X8', 'a2-x8', ADMIN), ADMIN, 'ROLLBACK');
  assert.equal(rb.code, 0, rb.out);
  assert.equal(scalar(`SELECT (SELECT count(*) FROM invoices WHERE job_id = ${jobId('X8')} AND status NOT IN ('voided', 'cancelled'))
    || ':' || (SELECT count(*) FROM invoices i JOIN blend_tickets bt ON bt.id = i.blend_ticket_id WHERE bt.job_id = ${jobId('X8')});`), '1:0');
  for (const j of ['X6', 'X7']) {
    assert.equal(scalar(`SELECT (SELECT count(*) FROM invoices WHERE job_id = ${jobId(j)} AND status NOT IN ('voided', 'cancelled'))
      + (SELECT count(*) FROM invoices i JOIN blend_tickets bt ON bt.id = i.blend_ticket_id WHERE bt.job_id = ${jobId(j)} AND i.status NOT IN ('voided', 'cancelled'));`), '1', `${j}: one bill survives`);
  }
  console.log('[case] AFTER: races: blend first -> split waits then refused; split first -> blend waits then refused; blend rolled back -> split wins alone');

  for (const f of REGRESSION) {
    const now = chainOutcome(f).outcome;
    assert.match(now, /^SMOKE_PASS_ROLLBACK/, `${f} no longer passes after the candidate: ${now}`);
  }
  for (const f of STALE) assert.equal(staleOutcome(f), staleBefore[f], `${f} changed outcome after the candidate`);
  console.log(`[case] AFTER: ${STALE.length} chains already stale on today's schema end exactly as before`);
  console.log(`[case] AFTER: ${REGRESSION.length} existing split, field-invoice, blend and transfer chains pass before and after`);
  console.log('SPLIT_SAVE_REFUSES_BLEND_BILLED_JOB_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
