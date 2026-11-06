#!/usr/bin/env node
/**
 * Real-schema proof for 20261111120000 (KI-27 leftovers: the refusal of a later save of a cleared request no
 * longer says "an admin cleared", and the postflight checks retire_uncertain_request's EXECUTE for service_role
 * and metabase_ro too). Builds the checked-in schema baseline in a network-disabled PostgreSQL container and
 * replays migrations up to the candidate. BEFORE: the guard is 20261107150000's body (md5 a9e47f3e...) and a
 * late save of a cleared request is refused with the old wording. AFTER (a second apply refuses at the
 * preflight): the same save is refused with the same SQLSTATE and error prefix in the neutral wording; the
 * guard body differs from the old one in that message only; both functions keep their settings, owner and
 * privileges; retire_uncertain_request is untouched; the postflight refuses an EXECUTE grant on
 * retire_uncertain_request to service_role, metabase_ro or anon; the permanent smoke chain passes.
 *
 * Run: node scripts/smoke/prove-uncertain-request-cleared-message-real-schema.mjs   (needs local Docker image)
 * Prints UNCERTAIN_REQUEST_CLEARED_MESSAGE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-cleared-message-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261111120000_uncertain_request_cleared_message_neutral.sql');
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-uncertain-request-clear-check.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// PR #889's data migrations and DATA-11 rewrite live rows this disposable database does not have
// (DATA-11 also needs a live admin approver); they are recorded in the ledger (as live has them)
// instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
  '20261105170000_data11_preferred_vendor_links.sql',
]);
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /FUNCTION public\.retire_uncertain_request\(|FUNCTION public\._guard_idempotency_key_insert\(/i;
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


const GUARD = 'public._guard_idempotency_key_insert()';
const RETIRE = 'public.retire_uncertain_request(text,text,text)';
const ADMIN = '16000000-0000-4000-8000-000000000001';
const md5 = (fn) => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${fn}'::regprocedure;`);
// The whole body: scalar() keeps only the last line, so read it hex-encoded on one line.
const source = (fn) => Buffer.from(scalar(`SELECT encode(convert_to(prosrc, 'UTF8'), 'hex') FROM pg_proc WHERE oid = '${fn}'::regprocedure;`), 'hex').toString('utf8');
const settings = (fn) => scalar(`SELECT prosecdef::text || ' ' || array_to_string(proconfig, ',') || ' '
  || pg_get_userbyid(proowner) || ' ' || coalesce(proacl::text, 'null') FROM pg_proc WHERE oid = '${fn}'::regprocedure;`);
function seed() {
  // An invented active admin (the smoke chain needs one); triggers are skipped so the role lock lets it be set.
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${ADMIN}', 'cleared-admin@example.invalid', '{"full_name":"[PROVER] admin"}'::jsonb) ON CONFLICT DO NOTHING;
    SET session_replication_role = replica;
    INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES ('${ADMIN}', 'cleared-admin@example.invalid', '[PROVER] admin', 'admin', true)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active;`);
}
// A late save of a cleared request, rolled back; returns "<SQLSTATE>|<message>".
function lateSave() {
  const key = `save_vendor:${ADMIN}:${randomUUID()}`;
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;
INSERT INTO public.retired_uncertain_requests (request_key, retired_by, reason) VALUES ('${key}', '${ADMIN}', 'not_recorded_after_wait');
DO $late$ BEGIN
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id, request_fingerprint)
  VALUES ('${key}', 'save_vendor', '{"late": true}', '${ADMIN}', 'late');
  RAISE NOTICE 'LATE=saved';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'LATE=%|%', SQLSTATE, SQLERRM;
END $late$;
ROLLBACK;` });
  const line = /LATE=(.*)/.exec(r.stderr)?.[1];
  assert.ok(line, `late save gave no answer:\n${r.stdout}\n${r.stderr}`);
  return line.replace(key, '<key>');
}
// The candidate's postflight, run after granting EXECUTE on retire_uncertain_request to a role; rolled back.
function postflightWith(role) {
  const block = /DO \$postflight\$[\s\S]*?\$postflight\$;/.exec(lf(CANDIDATE))[0];
  const grant = role ? `GRANT EXECUTE ON FUNCTION public.retire_uncertain_request(text, text, text) TO ${role};\n` : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;\n${grant}${block}\nROLLBACK;` });
  return `${r.stdout}\n${r.stderr}`;
}

function main() {
  buildContainer();  // always a fresh sealed container: no reuse of any existing database
  assert.equal(md5(GUARD), 'a9e47f3ea8b2b5b76b15ed1d745a8140', "before the candidate the guard must be 20261107150000's");
  assert.equal(md5(RETIRE), 'addf6df43b0e9d23c91e88dba315a1d0', "before the candidate retire must be 20261110120000's");
  seed();
  const guardBefore = settings(GUARD);
  const retireBefore = settings(RETIRE);
  const srcBefore = source(GUARD);
  const before = lateSave();
  assert.equal(before, 'P0001|IDEMPOTENCY_REQUEST_RETIRED: idempotency_key <key> belongs to a request an admin cleared; it cannot be saved');
  console.log(`[prover] BEFORE: ${before}`);

  stageText('candidate.sql', lf(CANDIDATE));
  const first = apply('candidate.sql');
  assert.equal(first.status, 0, first.output);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must refuse');
  assert.match(again.output, /PREFLIGHT_GUARD_IDEMPOTENCY_KEY_INSERT_DRIFT/);
  assert.equal(md5(GUARD), 'b6d31e7221291e5fb9c40aa146c93ef6');
  assert.equal(md5(RETIRE), 'addf6df43b0e9d23c91e88dba315a1d0', 'retire_uncertain_request untouched');
  assert.equal(settings(GUARD), guardBefore, 'guard SECURITY DEFINER, search_path, owner and privileges unchanged');
  assert.equal(settings(RETIRE), retireBefore, 'retire SECURITY DEFINER, search_path, owner and privileges unchanged');
  const srcAfter = source(GUARD);
  assert.notEqual(srcAfter, srcBefore);
  assert.equal(srcAfter.replace('that was cleared after it got stuck', 'an admin cleared'), srcBefore, 'the guard body changed beyond its message');
  console.log(`[prover] candidate applied once; a second apply refuses at the preflight; only the message changed; settings and privileges unchanged (guard: ${guardBefore}; retire: ${retireBefore})`);

  const after = lateSave();
  assert.equal(after, 'P0001|IDEMPOTENCY_REQUEST_RETIRED: idempotency_key <key> belongs to a request that was cleared after it got stuck; it cannot be saved');
  console.log(`[prover] AFTER: ${after}`);

  assert.doesNotMatch(postflightWith(null), /ERROR/, 'the postflight passes on the unchanged grants');
  for (const role of ['service_role', 'metabase_ro', 'anon']) {
    assert.match(postflightWith(role), /POSTFLIGHT_RETIRE_UNCERTAIN_REQUEST_GRANTS/, `the postflight must refuse EXECUTE for ${role}`);
  }
  console.log('[prover] the postflight refuses an EXECUTE grant on retire_uncertain_request to service_role, metabase_ro or anon');

  stageText('smoke.sql', lf(SMOKE));
  const smoke = apply('smoke.sql');
  assert.match(smoke.output, /SMOKE_PASS_ROLLBACK/, `smoke chain did not pass:\n${smoke.output}`);
  console.log('[prover] permanent smoke chain smoke-uncertain-request-clear-check.sql passed (SMOKE_PASS_ROLLBACK)');
  console.log('UNCERTAIN_REQUEST_CLEARED_MESSAGE_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
