#!/usr/bin/env node
/**
 * Real-schema proof for 20261215100000_dispatch_sync_on_applicator_qualify (KI-28): when a person BECOMES an
 * active applicator (re-activated, or given the applicator role), their open jobs' locations that have no
 * dispatch row get one, so the job reaches the Dispatch Board, whatever their license (Mason, 2026-11-08). The
 * apply backfills any such location already waiting. Locations that already have any dispatch row and finished
 * or soft-deleted jobs are left alone. Same-instant location adds and assignments are proved in both orders.
 * A job reassigned from an active applicator to an inactive one (Taha's #1652 review) stays on the old
 * applicator's board after the new one is re-activated, and both can see and start it (Mason, 2026-11-08).
 *
 * Builds the checked-in schema baseline in a network-disabled PostgreSQL container, replays every
 * migration before the candidate, seeds invented rows and checks each case.
 *
 * Run: node scripts/smoke/prove-dispatch-sync-on-applicator-qualify-real-schema.mjs   (needs local Docker image)
 * Prints DISPATCH_SYNC_QUALIFY_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-ki28-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261215100000_dispatch_sync_on_applicator_qualify.sql');
const FOLLOW_UPS = [];
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
  // DATA-11 rewrites live rows only (every product gets one preferred link); the proof seeds that state.
  '20261105170000_data11_preferred_vendor_links.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(_sync_job_location_dispatch_on_applicator_qualify|_lock_assigned_applicator_profile|_sync_job_location_dispatch_on_field_insert|_sync_job_location_dispatch_on_applicator_change|job_location_dispatches_job_field_id_key|TRIGGER\s+\w+\s+(BEFORE|AFTER)\s+[\w\s,]+?\s+ON\s+(public\.)?(profiles|jobs))\b/i;
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
  // Others' migrations may sort between the candidate and a follow-up (live applied them in between);
  // they are not replayed, so each must leave alone what this proof covers.
  let last = at;
  for (const file of FOLLOW_UPS) {
    const i = all.indexOf(file);
    assert.ok(i > last, `${path.basename(file)} must sort after the candidate and earlier follow-ups`);
    last = i;
  }
  for (const file of all.slice(at + 1).filter((f) => !FOLLOW_UPS.includes(f))) {
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
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
    // BLK-1a's preflight needs live's count units (live has Ea and Unit, factor 1, both).
    if (base === '20261117130000_tote_fill_from_bulk.sql') {
      psql(`INSERT INTO public.unit_conversions (unit, factor_oz, unit_type) SELECT u, 1, 'both' FROM (VALUES ('Ea'), ('Unit')) v(u)
        WHERE NOT EXISTS (SELECT 1 FROM public.unit_conversions WHERE unit = v.u);`);
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
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

const id = (n) => `7a7e2800-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const APP_A = id('b1');   // inactive applicator, re-activated
const APP_B = id('b2');   // active sales rep, given the applicator role
const APP_C = id('b3');   // inactive applicator whose only active license expired
const APP_D = id('b4');   // active applicator from the start: backfilled at apply; an unrelated edit must not fire
const APP_E = id('b5');   // inactive applicator: a no-user re-activation is refused, then the admin's works
const APP_G = id('b7');   // inactive applicator assigned a job at the same instant as the activation
const APP_I = id('b9');   // reverse order: activation in progress while a job is assigned to I
const APP_K = id('ba');   // reverse order: activation in progress while a location is added to K's job
const APP_S = id('bb');   // Taha's #1652 review: inactive applicator a dispatched job is reassigned to
const CUST = id('c1');
const F = (n) => id(`f${n}`);
const J = (n) => id(`d${n}`);
const JF = (n) => id(`e${n}`);
const SWEEP = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'dispatch-sync-nonqualifying-profile.sql');

function asOwner(sql) { psql(`SET session_replication_role = replica;
${sql}
SET session_replication_role = origin;`, { user: 'supabase_admin' }); }
function txIn(uid, sql) {
  const claims = uid ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);` : '';
  return `BEGIN;\n${claims}\nSET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};\n${sql}\nCOMMIT;\n`;
}
function as(uid, sql) {
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: txIn(uid, sql) });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, rows: r.stdout.trim().split(/\r?\n/).filter(Boolean) };
}
function ok(uid, sql) { const r = as(uid, sql); assert.equal(r.status, 0, r.output); return r.rows.at(-1); }
const short = (col) => `right(${col}::text, 2)`;
// One entry per location: location|assignee|status|dispatched_by ('-' / 'none' when it has no dispatch row).
function board() {
  return scalar(`SELECT string_agg(${short('jf.id')} || '|' || coalesce(${short('d.applicator_id')}, '-') || '|'
      || coalesce(d.dispatch_status, 'none') || '|' || coalesce(${short('d.dispatched_by')}, '-'), ' ' ORDER BY jf.id)
    FROM public.job_fields jf LEFT JOIN public.job_location_dispatches d ON d.job_field_id = jf.id;`);
}
function sweepRows() {
  const predicate = lf(SWEEP).replace(/^\s*--.*$/gm, '').replace(/;\s*$/, '');
  return scalar(`SELECT coalesce(string_agg(${short('job_field_id')}, ' ' ORDER BY job_field_id), '-') FROM (${predicate}) s;`);
}

// Session 1 runs holderSql as the admin and holds its transaction open for 4 s; session 2 then runs mainSql as
// the admin. Returns how long session 2 waited (it must wait on session 1's lock, then see its committed write).
async function race(name, holderSql, mainSql) {
  stageText(name, txIn(ADMIN, `${holderSql}\nSELECT pg_sleep(4);`));
  const holder = spawn('docker', [...psqlArgs(), '-f', `/tmp/${name}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  holder.stdout.on('data', (d) => { out += d; });
  holder.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => holder.on('close', resolve));
  wait(1500);
  const started = Date.now();
  ok(ADMIN, mainSql);
  const waited = Date.now() - started;
  assert.equal(await done, 0, out);
  assert.ok(waited >= 1000, `${name}: session 2 should have waited for session 1 (waited ${waited} ms)`);
  return waited;
}

function seed() {
  // The baseline auth.users is a stub; (de)activating a profile fires _sync_auth_access_on_profile_active,
  // which writes the real column set (same shim as prove-adjust-inventory-intent-binding-real-schema.mjs).
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;`, { user: 'supabase_admin' });
  const users = [[ADMIN, 'admin'], [APP_A, 'applicator'], [APP_B, 'sales_rep'], [APP_C, 'applicator'], [APP_D, 'applicator'], [APP_E, 'applicator']];
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ${users.map(([u, r], i) =>
    `('${u}', 'ki28-${i}@example.invalid', '{"full_name":"[PROVER] ${r} ${i}","role":"${r}"}'::jsonb)`).join(', ')};`);
  asOwner(`UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'applicator', is_active = false WHERE id IN ('${APP_A}', '${APP_C}', '${APP_E}');
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${APP_B}';
    UPDATE public.profiles SET role = 'applicator', is_active = true WHERE id = '${APP_D}';
    INSERT INTO public.applicator_licenses (profile_id, license_number, holder_name, expiry_date, is_active) VALUES
      ('${APP_C}', 'PROVER-C', '[PROVER] C', current_date - 30, true),
      ('${APP_A}', 'PROVER-A-OLD', '[PROVER] A', current_date - 400, false),
      ('${APP_A}', 'PROVER-A', '[PROVER] A', current_date + 300, true);
    INSERT INTO public.customers (id, farm_name) VALUES ('${CUST}', '[PROVER] KI-28 Farm');
    INSERT INTO public.fields (id, customer_id, field_name)
      SELECT ('7a7e2800-0000-4000-8000-0000000000f' || n)::uuid, '${CUST}', '[PROVER] Field ' || n FROM generate_series(1, 9) n;
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, applicator_id, created_by, updated_by, deleted_at) VALUES
      ('${J(1)}', 'PRV-KI28-1', '${CUST}', current_date, 'scheduled',   '${APP_A}', '${ADMIN}', NULL, NULL),
      ('${J(2)}', 'PRV-KI28-2', '${CUST}', current_date, 'in_progress', '${APP_B}', '${ADMIN}', NULL, NULL),
      ('${J(3)}', 'PRV-KI28-3', '${CUST}', current_date, 'completed',   '${APP_A}', '${ADMIN}', NULL, NULL),
      ('${J(4)}', 'PRV-KI28-4', '${CUST}', current_date, 'scheduled',   '${APP_A}', '${ADMIN}', NULL, now()),
      ('${J(5)}', 'PRV-KI28-5', '${CUST}', current_date, 'scheduled',   '${APP_C}', '${ADMIN}', NULL, NULL),
      ('${J(6)}', 'PRV-KI28-6', '${CUST}', current_date, 'scheduled',   '${APP_D}', '${ADMIN}', NULL, NULL),
      ('${J(7)}', 'PRV-KI28-7', '${CUST}', current_date, 'scheduled',   '${APP_E}', '${ADMIN}', NULL, NULL);
    INSERT INTO public.job_fields (id, job_id, field_id) VALUES
      ('${JF(1)}', '${J(1)}', '${F(1)}'), ('${JF(2)}', '${J(1)}', '${F(2)}'), ('${JF(3)}', '${J(1)}', '${F(3)}'),
      ('${JF(4)}', '${J(2)}', '${F(4)}'), ('${JF(5)}', '${J(3)}', '${F(5)}'), ('${JF(6)}', '${J(4)}', '${F(6)}'),
      ('${JF(7)}', '${J(5)}', '${F(7)}'), ('${JF(8)}', '${J(6)}', '${F(8)}'), ('${JF(9)}', '${J(7)}', '${F(9)}');
    INSERT INTO public.job_location_dispatches (job_field_id, job_id, applicator_id, dispatch_status, dispatched_by) VALUES
      ('${JF(2)}', '${J(1)}', '${APP_A}', 'cancelled', '${ADMIN}'),
      ('${JF(3)}', '${J(1)}', '${APP_D}', 'dispatched', '${ADMIN}');`);
  console.log('[prover] seeded an admin, five people, seven jobs (open, finished, soft-deleted) and nine locations;'
    + ' e2 was undispatched and e3 split to applicator D on the board');
}

// Taha's #1652 review (MED): a job already on D's board is reassigned to S while S is inactive, either straight
// (job 13: D's row stays 'dispatched') or after the applicator was cleared (job 14: D's row was 'cancelled').
// Mason, 2026-11-08: "any sprayer should be able to just pick up field and start spraying, not wait on someone
// from office", and two sprayers sometimes spray the same field. So re-activating S must not take the field off
// D's board; it is enough that S, now the job's applicator, sees both jobs and can start them, and D keeps job 13.
async function reassignedToInactive() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${APP_S}', 'ki28-11@example.invalid', '{"full_name":"[PROVER] applicator 11","role":"applicator"}'::jsonb);`);
  asOwner(`UPDATE public.profiles SET role = 'applicator', is_active = false WHERE id = '${APP_S}';
    INSERT INTO public.applicator_licenses (profile_id, license_number, holder_name, expiry_date, is_active)
      VALUES ('${APP_S}', 'PROVER-S', '[PROVER] S', current_date + 300, true);
    INSERT INTO public.fields (id, customer_id, field_name) VALUES
      ('${F(16)}', '${CUST}', '[PROVER] Field 16'), ('${F(17)}', '${CUST}', '[PROVER] Field 17');
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, applicator_id, created_by) VALUES
      ('${J(13)}', 'PRV-KI28-13', '${CUST}', current_date, 'scheduled', '${APP_D}', '${ADMIN}'),
      ('${J(14)}', 'PRV-KI28-14', '${CUST}', current_date, 'scheduled', '${APP_D}', '${ADMIN}');
    INSERT INTO public.job_fields (id, job_id, field_id) VALUES ('${JF(16)}', '${J(13)}', '${F(16)}'), ('${JF(17)}', '${J(14)}', '${F(17)}');
    INSERT INTO public.job_location_dispatches (job_field_id, job_id, applicator_id, dispatch_status, dispatched_by) VALUES
      ('${JF(16)}', '${J(13)}', '${APP_D}', 'dispatched', '${ADMIN}'),
      ('${JF(17)}', '${J(14)}', '${APP_D}', 'dispatched', '${ADMIN}');`);
  const row = (jf) => scalar(`SELECT ${short('applicator_id')} || '|' || dispatch_status FROM public.job_location_dispatches WHERE job_field_id = '${jf}';`);
  ok(ADMIN, `UPDATE public.jobs SET applicator_id = '${APP_S}' WHERE id = '${J(13)}';`);
  ok(ADMIN, `UPDATE public.jobs SET applicator_id = NULL WHERE id = '${J(14)}';`);
  ok(ADMIN, `UPDATE public.jobs SET applicator_id = '${APP_S}' WHERE id = '${J(14)}';`);
  assert.deepEqual([row(JF(16)), row(JF(17))], ['b4|dispatched', 'b4|cancelled']);
  ok(ADMIN, `UPDATE public.profiles SET is_active = true WHERE id = '${APP_S}';`);
  assert.deepEqual([row(JF(16)), row(JF(17))], ['b4|dispatched', 'b4|cancelled'], 're-activating S must not take a field off D');
  console.log("[prover] REASSIGNED TO INACTIVE (Taha #1652): S re-activated; job 13 stays on D's board (dispatched), job 14 keeps D's cancelled row");

  // What S's field app loads (FieldView): get_dispatched_list, then S's own open whole-job assignments for any job
  // that list did not cover. Job 13 comes through the list (S is the job's applicator), job 14 through the second read.
  const listed = ok(APP_S, "SELECT coalesce(string_agg(x::text, ' '), '') FROM public.get_dispatched_list() x;");
  assert.ok(listed.includes(J(13)), "S's dispatched list must include job 13");
  assert.ok(!listed.includes(J(14)), "job 14 has no active dispatch row, so it reaches S through the whole-job read");
  assert.equal(ok(APP_S, `SELECT string_agg(right(id::text, 2), ' ' ORDER BY id) FROM public.jobs
     WHERE applicator_id = '${APP_S}' AND deleted_at IS NULL AND status IN ('scheduled', 'in_progress');`), '13 14');
  const dList = ok(APP_D, "SELECT coalesce(string_agg(x::text, ' '), '') FROM public.get_dispatched_list() x;");
  assert.ok(dList.includes(J(13)) && !dList.includes(J(14)), "D still sees job 13, not job 14");
  console.log("[prover] S's field app lists both jobs (13 via the dispatched list, 14 as a whole-job card); D's still lists job 13");

  // Both sprayers can pick the work up themselves: S starts job 14, D starts job 13 (still on D's board).
  ok(APP_S, `SELECT public.start_job('${J(14)}', '${APP_S}', 'prover-ki28-s-14');`);
  ok(APP_D, `SELECT public.start_job('${J(13)}', '${APP_D}', 'prover-ki28-d-13');`);
  assert.equal(scalar(`SELECT string_agg(status, ' ' ORDER BY id) FROM public.jobs WHERE id IN ('${J(13)}', '${J(14)}');`), 'in_progress in_progress');
  console.log('[prover] S starts job 14 and D starts job 13 from the field app, with no office step');
}

async function main() {
  buildContainer();
  seed();
  const before = 'e1|-|none|- e2|b1|cancelled|a1 e3|b4|dispatched|a1 e4|-|none|- e5|-|none|- e6|-|none|- e7|-|none|- e8|-|none|- e9|-|none|-';
  assert.equal(board(), before);
  // The KI-28 state the sweep exists to find: e1 (A inactive), e4 (B a sales rep), e7 (C inactive), e9 (E inactive).
  // The sweep does not skip soft-deleted jobs, so it also lists e6; the trigger leaves a deleted job alone.
  assert.equal(sweepRows(), 'e1 e4 e6 e7 e9');
  console.log('[prover] before: the KI-28 sweep finds the four stuck locations (e1, e4, e7, e9), plus e6 on a soft-deleted job');

  const ledgerRows = scalar('SELECT count(*) FROM supabase_migrations.schema_migrations;');
  stageText('cand.sql', lf(CANDIDATE));
  const r = apply('cand.sql');
  assert.equal(r.status, 0, r.output);
  assert.equal(scalar('SELECT count(*) FROM supabase_migrations.schema_migrations;'), ledgerRows);
  // BACKFILL: D was already an active applicator with an undispatched location (e8); the apply dispatches it,
  // recorded as by the job's creator. Nothing else changes: the stuck people do not qualify yet.
  const applied = before.replace('e8|-|none|-', 'e8|b4|dispatched|a1');
  assert.equal(board(), applied, 'the apply must backfill only the active applicator D');
  assert.equal(sweepRows(), 'e1 e4 e6 e7 e9');
  for (const sig of ['_sync_job_location_dispatch_on_applicator_qualify()', '_lock_assigned_applicator_profile()']) {
    const fn = `'public.${sig}'`;
    assert.equal(scalar(`SELECT p.prosecdef::text || '|' || p.proowner::regrole::text || '|' || array_to_string(p.proconfig, ',') FROM pg_proc p WHERE p.oid = ${fn}::regprocedure;`),
      'true|postgres|search_path=public, pg_temp');
    assert.equal(scalar(`SELECT concat_ws('|', has_function_privilege('authenticated', ${fn}, 'EXECUTE'), has_function_privilege('anon', ${fn}, 'EXECUTE'), has_function_privilege('service_role', ${fn}, 'EXECUTE'));`), 'f|f|f');
  }
  console.log("[prover] the file applies; its backfill puts the already-active applicator D's waiting location e8 on the board and writes nothing else;"
    + ' both functions SECURITY DEFINER, owner postgres, search_path pinned; no client role can execute them');

  // An unrelated edit of an applicator who already qualified does not fire.
  ok(ADMIN, `UPDATE public.profiles SET full_name = '[PROVER] renamed', is_active = true, role = 'applicator' WHERE id = '${APP_D}';`);
  assert.equal(board(), applied);
  console.log('[prover] editing an applicator who already qualified changes nothing');

  // A is re-activated by the admin through an ordinary signed-in update (RLS and every profiles trigger on).
  ok(ADMIN, `UPDATE public.profiles SET is_active = true WHERE id = '${APP_A}';`);
  const afterA = applied.replace('e1|-|none|-', 'e1|b1|dispatched|a1');
  assert.equal(board(), afterA);
  console.log("[prover] RE-ACTIVATED: A's open job location e1 is now on the board, dispatched to A, recorded as dispatched by the admin;"
    + ' the undispatched e2, the board split e3, the completed job (e5) and the soft-deleted job (e6) are untouched');

  ok(ADMIN, `UPDATE public.profiles SET role = 'applicator' WHERE id = '${APP_B}';`);
  const afterB = afterA.replace('e4|-|none|-', 'e4|b2|dispatched|a1');
  assert.equal(board(), afterB);
  console.log("[prover] RE-ROLED: sales rep B made an applicator; B's in-progress job location e4 is now on the board");

  // Mason, 2026-11-08: the license is not re-checked here, exactly as when a location is added.
  ok(ADMIN, `UPDATE public.profiles SET is_active = true WHERE id = '${APP_C}';`);
  const afterC = afterB.replace('e7|-|none|-', 'e7|b3|dispatched|a1');
  assert.equal(board(), afterC);
  console.log("[prover] C (only license expired) is re-activated and e7 goes straight onto the board, as Mason decided");

  // With no signed-in user (a dashboard or service run) the role lock refuses the change outright, so the
  // trigger's no-user attribution fallback is never reached; E then is re-activated by the admin.
  const blocked = psql(`UPDATE public.profiles SET is_active = true WHERE id = '${APP_E}';`, { allowFailure: true });
  assert.notEqual(blocked.status, 0);
  assert.match(`${blocked.stdout}
${blocked.stderr}`, /PROFILE_ROLE_LOCK/);
  assert.equal(board(), afterC);
  ok(ADMIN, `UPDATE public.profiles SET is_active = true WHERE id = '${APP_E}';`);
  const afterE = afterC.replace('e9|-|none|-', 'e9|b5|dispatched|a1');
  assert.equal(board(), afterE);
  console.log('[prover] a re-activation with no signed-in user is refused by the role lock and writes nothing; the admin then re-activates E and e9 reaches the board');

  ok(ADMIN, `UPDATE public.profiles SET is_active = false WHERE id = '${APP_A}';`);
  ok(ADMIN, `UPDATE public.profiles SET is_active = true WHERE id = '${APP_A}';`);
  assert.equal(board(), afterE);
  assert.equal(scalar('SELECT count(*) FROM public.job_location_dispatches;'), '7');
  console.log('[prover] deactivating and re-activating A again adds no second row');

  // RACE (Luna MED): a location added to A's open job while A is inactive, committing only after A's
  // re-activation has started, must still reach the board. Session 1 adds it and holds its transaction open;
  // session 2 (the re-activation) must wait on the job lock and then see the committed location.
  ok(ADMIN, `UPDATE public.profiles SET is_active = false WHERE id = '${APP_A}';`);
  asOwner(`INSERT INTO public.fields (id, customer_id, field_name) VALUES ('${F(10)}', '${CUST}', '[PROVER] Field 10');`);
  const waited = await race('race.sql',
    `INSERT INTO public.job_fields (id, job_id, field_id) VALUES ('${JF(10)}', '${J(1)}', '${F(10)}');`,
    `UPDATE public.profiles SET is_active = true WHERE id = '${APP_A}';`);
  const afterRace = `${afterE} 10|b1|dispatched|a1`;
  assert.equal(board(), afterRace);
  assert.equal(scalar('SELECT count(*) FROM public.job_location_dispatches;'), '8');
  console.log(`[prover] RACE: a location added to A's job while A was inactive, committed during A's re-activation (which waited ${waited} ms), still reaches the board`);

  // More people for the remaining same-instant cases: G for job 9; I and K for the reverse order.
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${APP_G}', 'ki28-7@example.invalid', '{"full_name":"[PROVER] applicator 7","role":"applicator"}'::jsonb),
      ('${APP_I}', 'ki28-9@example.invalid', '{"full_name":"[PROVER] applicator 9","role":"applicator"}'::jsonb),
      ('${APP_K}', 'ki28-10@example.invalid', '{"full_name":"[PROVER] applicator 10","role":"applicator"}'::jsonb);`);
  asOwner(`UPDATE public.profiles SET role = 'applicator', is_active = false WHERE id IN ('${APP_G}', '${APP_I}', '${APP_K}');
    INSERT INTO public.fields (id, customer_id, field_name) VALUES
      ('${F(12)}', '${CUST}', '[PROVER] Field 12'), ('${F(14)}', '${CUST}', '[PROVER] Field 14'), ('${F(15)}', '${CUST}', '[PROVER] Field 15');
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, applicator_id, created_by) VALUES
      ('${J(9)}', 'PRV-KI28-9', '${CUST}', current_date, 'scheduled', NULL, '${ADMIN}'),
      ('${J(11)}', 'PRV-KI28-11', '${CUST}', current_date, 'scheduled', NULL, '${ADMIN}'),
      ('${J(12)}', 'PRV-KI28-12', '${CUST}', current_date, 'scheduled', '${APP_K}', '${ADMIN}');
    INSERT INTO public.job_fields (id, job_id, field_id) VALUES ('${JF(12)}', '${J(9)}', '${F(12)}'), ('${JF(14)}', '${J(11)}', '${F(14)}');`);
  const withNew = `${afterRace} 12|-|none|- 14|-|none|-`;
  assert.equal(board(), withNew);

  // ASSIGNMENT RACE (Luna/Sol MED): job 9 is assigned to inactive G by one session while another re-activates G.
  const waitedAssign = await race('race-assign.sql',
    `UPDATE public.jobs SET applicator_id = '${APP_G}' WHERE id = '${J(9)}';`,
    `UPDATE public.profiles SET is_active = true WHERE id = '${APP_G}';`);
  const afterAssign = withNew.replace('12|-|none|-', '12|b7|dispatched|a1');
  assert.equal(board(), afterAssign);
  assert.equal(scalar('SELECT count(*) FROM public.job_location_dispatches;'), '9');
  console.log(`[prover] ASSIGNMENT RACE: job 9 assigned to G in another session during G's re-activation (which waited ${waitedAssign} ms) reaches the board`);

  // REVERSE ORDER (Sol round 2): the activation runs first and holds its transaction open; the assignment or
  // location add arrives during it, must wait (no deadlock) and then end correctly.
  const wAssign = await race('rev-assign.sql',
    `UPDATE public.profiles SET is_active = true WHERE id = '${APP_I}';`,
    `UPDATE public.jobs SET applicator_id = '${APP_I}' WHERE id = '${J(11)}';`);
  const afterRevAssign = afterAssign.replace('14|-|none|-', '14|b9|dispatched|a1');
  assert.equal(board(), afterRevAssign);
  console.log(`[prover] REVERSE ASSIGNMENT: assigning job 11 to I during I's activation waited ${wAssign} ms (no deadlock) and e14 reached the board`);

  const wField = await race('rev-field.sql',
    `UPDATE public.profiles SET is_active = true WHERE id = '${APP_K}';`,
    `INSERT INTO public.job_fields (id, job_id, field_id) VALUES ('${JF(15)}', '${J(12)}', '${F(15)}');`);
  assert.equal(board(), `${afterRevAssign} 15|ba|dispatched|a1`);
  assert.equal(scalar('SELECT count(*) FROM public.job_location_dispatches;'), '11');
  console.log(`[prover] REVERSE LOCATION: a location added to K's job during K's activation waited ${wField} ms (no deadlock) and reached the board`);

  await reassignedToInactive();

  assert.equal(sweepRows(), '-');
  console.log('[prover] after: the KI-28 sweep finds nothing (the applicator A of e6 now qualifies; the soft-deleted job itself stays undispatched)');

  stageText('again.sql', lf(CANDIDATE));
  const again = apply('again.sql');
  assert.notEqual(again.status, 0);
  assert.match(again.output, /already exists/);
  console.log('[prover] a second apply is refused by the preflight');
  console.log('DISPATCH_SYNC_QUALIFY_PROOF_PASS');
}
try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
