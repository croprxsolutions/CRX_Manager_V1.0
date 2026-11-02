#!/usr/bin/env node
/**
 * Full-chain proof for the 20261102180000 candidate (cycle-count freeze): while a cycle count is
 * open, the stock of every inventory row it counts cannot move; completion applies the counted
 * quantity exactly once; the freeze lifts on complete and cancel; a stale snapshot cannot complete;
 * and create_cycle_count starts a count and snapshots stock in one transaction.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate, checks
 * the candidate's md5 pin against the replayed complete_cycle_count, seeds one active admin, then:
 *   BEFORE the candidate the double count happens (a +5 receipt during an open count, counted as
 *   15, completes to 20) and the chain fails (create_cycle_count does not exist);
 *   AFTER it the same receipt is refused and scripts/smoke/smoke-cycle-count-freeze.sql ends in
 *   SMOKE_PASS_ROLLBACK.
 * Also: grants and definer settings, and the preflight refusing a second apply.
 *
 * Run: node scripts/smoke/prove-cycle-count-freeze-real-schema.mjs   (needs Docker)
 * Prints CYCLE_COUNT_FREEZE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a fresh, network-disabled container this run creates.
const NAME = `crx-cc-freeze-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261102180000_freeze_stock_during_cycle_count.sql');
const CHAIN = path.join(ROOT, 'scripts', 'smoke', 'smoke-cycle-count-freeze.sql');
// Live but not replayable here (storage.objects policies, storage.buckets settings); it must not touch what this proves.
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
]);
// A later or parked file that (re)defines anything the candidate changes.
const TOUCHED = /FUNCTION\s+(public\.)?"?(complete_cycle_count|create_cycle_count|_complete_cycle_count_impl|_freeze_inventory_during_cycle_count_20261102)\b|trg_freeze_inventory_during_cycle_count/i;
const PINS = {
  'public.complete_cycle_count(uuid,uuid,text,bigint)': 'ad7249f15027bd75084cb0cfbf8b6bab',
};
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const ADMIN = '7c730000-0000-4000-8000-0000000000a1';

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
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  const before = all.slice(0, at);
  for (const file of all.slice(at + 1)) {
    assert.ok(!TOUCHED.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches what it changes; re-think this proof`);
  }
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!TOUCHED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return before;
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate`);
}

// FIDELITY: the candidate pins each body it replaces, and the replayed bodies match those pins.
function fidelity() {
  const preflight = lf(CANDIDATE).split('$preflight$')[1];
  for (const [sig, pin] of Object.entries(PINS)) {
    assert.ok(preflight.includes(`'${pin}'`), `the candidate preflight must pin ${sig}`);
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`), pin,
      `${sig} replayed with a body that differs from the live pin of 2026-11-02`);
  }
  console.log('[prover] FIDELITY: the replayed complete_cycle_count matches the live md5 pin of 2026-11-02');
}

function seed() {
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('${ADMIN}', 'cc-freeze-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb);`);
  // The role is set directly too (past _guard_profile_role_lock), in case handle_new_user no longer
  // honours the metadata role.
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT string_agg(role || ':' || is_active, ',') FROM public.profiles WHERE role = 'admin' AND is_active;"),
    'admin:true', 'the proof needs exactly one active admin');
  console.log('[prover] seeded one active admin');
}

// Runs the smoke chain; returns the error text it ended with.
function runChain() {
  stageText('chain.sql', lf(CHAIN));
  const r = docker([...psqlArgs(), '-f', '/tmp/chain.sql'], { allowFailure: true });
  assert.notEqual(r.status, 0, 'the smoke chain must always end in an error');
  return r.stderr;
}

// One rolled-back probe as the admin; prints "RESULT|ok|<value>" or "RESULT|<sqlstate>|<message>".
function probe(body) {
  const r = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
DO $probe$
DECLARE v text; p uuid; i uuid; c uuid; it uuid; rev bigint;
BEGIN
  ${body}
  RAISE NOTICE 'RESULT|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|%|%', SQLSTATE, replace(SQLERRM, chr(10), ' ');
END
$probe$;
ROLLBACK;`, allowFailure: true });
  assert.equal(r.status, 0, `probe failed to run:\n${r.stderr}`);
  const m = /RESULT\|([^\n]*)/.exec(r.stderr);
  assert.ok(m, `probe printed no RESULT:\n${r.stderr}`);
  return m[1].trimEnd();
}

// The old three-step start, then a +5 receipt while the count is open, then the shelf counted as 15.
const DOUBLE_COUNT = `INSERT INTO public.products (product_name, is_active) VALUES ('[PROVER] double', true) RETURNING id INTO p;
  INSERT INTO public.inventory (product_id, location, quantity_available) VALUES (p, '[PROVER] Bay', 10) RETURNING id INTO i;
  INSERT INTO public.cycle_counts (count_number, warehouse, status, initiated_by) VALUES ('CC-PROVER-1', '[PROVER] Bay', 'in_progress', '${ADMIN}') RETURNING id INTO c;
  INSERT INTO public.cycle_count_items (cycle_count_id, product_id, inventory_id, expected_qty) VALUES (c, p, i, 10) RETURNING id INTO it;
  PERFORM public.adjust_inventory(i, 5, 'receipt during count', '${ADMIN}', 'prover-dc-adj');
  PERFORM public.update_cycle_count_item(it, 15, NULL, '${ADMIN}', 'prover-dc-item');
  SELECT item_revision INTO rev FROM public.cycle_counts WHERE id = c;
  PERFORM public.complete_cycle_count(c, '${ADMIN}', 'prover-dc-complete', rev);
  v := (SELECT quantity_available::text FROM public.inventory WHERE id = i);`;

function before() {
  const err = runChain();
  assert.match(err, /function public\.create_cycle_count\(.*\) does not exist/, `BEFORE: the chain should fail on the missing create_cycle_count, got:\n${err}`);
  assert.match(probe(DOUBLE_COUNT), /^ok\|20(\.0+)?$/, 'BEFORE: the receipt during the count should land twice (10 + 5, counted as 15 -> 20)');
  console.log('[prover] BEFORE: a +5 receipt during an open count lands twice (stock 20, shelf 15); create_cycle_count does not exist');
}

function after() {
  const err = runChain();
  assert.match(err, /SMOKE_PASS_ROLLBACK/, `AFTER: the chain should pass, got:\n${err}`);
  assert.doesNotMatch(err, /SMOKE_FAIL/);
  const r = probe(DOUBLE_COUNT);
  assert.match(r, /^P0001\|INVENTORY_FROZEN_FOR_CYCLE_COUNT: \[PROVER\] double at \[PROVER\] Bay is being counted in cycle count CC-PROVER-1\. /, r);
  console.log('[prover] AFTER: the chain passes (a)-(h) and ends in SMOKE_PASS_ROLLBACK; the receipt during the count is refused');
}

function security() {
  const rows = docker([...psqlArgs(), '-A', '-t', '-F', '|'], { input: `SELECT p.oid::regprocedure::text,
      has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      has_function_privilege('service_role', p.oid, 'EXECUTE'), p.prosecdef, array_to_string(p.proconfig, ';'), pg_get_userbyid(p.proowner)
    FROM pg_proc p WHERE p.oid IN ('public.complete_cycle_count(uuid,uuid,text,bigint)'::regprocedure,
      'public.create_cycle_count(text,text,text)'::regprocedure,
      'public._freeze_inventory_during_cycle_count_20261102()'::regprocedure) ORDER BY 1;` }).stdout.trim().split(/\r?\n/);
  assert.deepEqual(rows, [
    '_freeze_inventory_during_cycle_count_20261102()|f|f|f|t|search_path=public, pg_temp|postgres',
    'complete_cycle_count(uuid,uuid,text,bigint)|f|t|t|t|search_path=public, pg_temp|postgres',
    'create_cycle_count(text,text,text)|f|t|f|t|search_path=public, pg_temp|postgres',
  ]);
  assert.equal(scalar("SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_freeze_inventory_during_cycle_count' AND tgrelid = 'public.inventory'::regclass;"), 'O');
  console.log('[prover] SECURITY: owners, EXECUTE grants, SECURITY DEFINER, search_path and the trigger as intended');
}

function secondApplyRefused() {
  stageText('again.sql', lf(CANDIDATE));
  const r = apply('again.sql');
  assert.notEqual(r.status, 0, 'the candidate applied twice');
  assert.match(r.output, /CYCLE_COUNT_FREEZE_PREFLIGHT/);
  console.log('[prover] PREFLIGHT: a second apply is refused');
}

function main() {
  const started = Date.now();
  buildContainer();
  fidelity();
  seed();
  before();
  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');
  after();
  security();
  secondApplyRefused();
  console.log(`[prover] finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('CYCLE_COUNT_FREEZE_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
