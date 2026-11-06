/** Shared, container-only baseline and proof runner for KI-10 batches 4d and 4e. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let NAME;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
let CANDIDATE;
let OTHER;
let OTHER_IN_BASELINE = false;
// Live but not replayable here (storage.objects policies, storage.buckets settings); it must not touch what this proves.
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
  // Its preflight needs live unit and category rows this database lacks; it touches nothing proven here.
  '20261117130000_tote_fill_from_bulk.sql',
]);
// PR #889's data migrations rewrite live rows this disposable database does not have; they are
// recorded in the ledger (as live has them) instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const SMOKE = path.join(ROOT, 'scripts', 'smoke');
let CHAIN;
const SPECS = path.join(SMOKE, 'smoke-specs.json');
let WRAPPED;
let IMPLS;
let TAG;
let SPEC_KEY;
let PASS;
let FIRST;
const GUARD = 'require_bound_replay_receipt_20261015';

const id = (n) => `4c4d0000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN_B: id('a2'), REP: id('b1'), APPLICATOR: id('c1') };

// ------------------------------------------------------------------------------------------------
// Container plumbing (the shared real-schema harness).
function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
let DATABASE = 'postgres';
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', DATABASE, '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
function psql(sql, options = {}) { return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure }); }
function scalar(sql) { return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''; }
function lf(file) { return readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
function stageText(name, text) {
  const staged = path.join(ROOT, `${NAME}-${name}`);
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
// Record a migration in the ledger by NAME (later preflights look names up), versioned by its own
// stamp: an older file's high-water check compares versions, so only stamps are used.
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
function restorePinnedUnitValidator() {
  // The baseline has LF line endings; the later product-forms preflight pins the raw
  // CRLF body from 2026-02-11. Verify both byte forms before restoring the pinned one.
  const source = readFileSync(path.join(MIGRATIONS, '20260211000000_unit_tracking_pricing_overhaul.sql'), 'utf8');
  const start = source.indexOf('CREATE OR REPLACE FUNCTION validate_product_units()');
  assert.ok(start >= 0, 'unit validator source is missing');
  const a = source.indexOf('AS $$', start) + 'AS $$'.length;
  const body = source.slice(a, source.indexOf('$$;', a));
  assert.equal(createHash('md5').update(body).digest('hex'), '83a51c58c83cd83bea760bd117410a38',
    'the checked-in unit validator does not match the later raw body pin');
  assert.equal(createHash('md5').update(body.replaceAll('\r\n', '\n')).digest('hex'),
    'd05ee54d04d9ae78dfd6207e26d0dc0e', 'the normalized validator body drifted');
  psql(`CREATE OR REPLACE FUNCTION public.validate_product_units() RETURNS trigger LANGUAGE plpgsql
    SET search_path = public AS $unit_validator$${body}$unit_validator$;`);
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.validate_product_units()'::regprocedure;"),
    '83a51c58c83cd83bea760bd117410a38', 'unit validator restoration did not match');
}
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const fourc = '20261110160000_bind_money_inventory_replay_receipts_batch4c.sql';
  assert.ok(all.some((f) => path.basename(f) === fourc),
    'needs 20261110160000 from the batch 4c PR until it lands on main');
  // Replay only what is ordered before the candidate (a later file assumes the candidate is live).
  const before = all.filter((f) => f !== CANDIDATE && (OTHER_IN_BASELINE || f !== OTHER)
    && path.basename(f) < path.basename(CANDIDATE));
  if (OTHER_IN_BASELINE) assert.ok(before.includes(OTHER), `${path.basename(OTHER)} must be replayed before the candidate`);
  const touched = new RegExp([...WRAPPED, 'idempotency_keys'].join('|'));
  for (const name of PARKED) {
    if (name >= path.basename(CANDIDATE)) continue; // sorts after this candidate: never replayed for it
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!touched.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs', '--with-live-rows'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
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
    if (base === '20261104150000_product_forms_seed_each.sql') restorePinnedUnitValidator();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

function pinRows(file) {
  const sql = lf(file);
  const marker = `${path.basename(file).includes('batch4e') ? 'ops_replay_binding_batch4e' : 'records_replay_binding_batch4d'}_pins ON COMMIT DROP AS`;
  const block = sql.split(marker)[1]?.split(') AS pin(')[0];
  assert.ok(block, `pin table missing in ${file}`);
  const row = /\('([a-z_]+)', '(?:[^']|'')*', '(?:[^']|'')*', '(?:[^']|'')*', '(?:[^']|'')*', '([0-9a-f]{32})'\)/g;
  return [...block.matchAll(row)].map((m) => [m[1], m[2]]);
}
function guardArrays(file) {
  const block = lf(file).split('$guard$')[1];
  const arr = (name) => {
    const m = new RegExp(`${name} constant text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`).exec(block);
    assert.ok(m, `${file} has no ${name} guard array`);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  };
  return { prior: arr('v_prior'), other: arr('v_other'), self: arr('v_this') };
}
function guardOps() {
  const out = scalar(`SELECT 'GUARD_OPS=' || coalesce(string_agg(m[1], ',' ORDER BY ord), '')
      FROM pg_trigger t,
           regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)''::text', 'g') WITH ORDINALITY AS r(m, ord)
     WHERE t.tgrelid = 'public.idempotency_keys'::regclass AND t.tgname = '${GUARD}';`);
  const m = /GUARD_OPS=([a-z_,]*)/.exec(out);
  assert.ok(m, `could not read guard operations: ${out}`);
  return m[1] ? m[1].split(',') : [];
}
function fidelity() {
  const pins = pinRows(CANDIDATE);
  assert.deepEqual(pins.map(([n]) => n), WRAPPED, 'the candidate must pin exactly its wrappers in order');
  for (const [name, pin] of pins) {
    assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname='${name}' AND pronamespace='public'::regnamespace;`), '1', `${name} is overloaded`);
    const actual = scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE proname='${name}' AND pronamespace='public'::regnamespace;`);
    assert.equal(actual, pin, `${name} body does not match the pinned live md5`);
  }
  const helperBlock = lf(CANDIDATE).split('_helper_pins ON COMMIT DROP AS')[1]?.split(') AS h(')[0];
  assert.ok(helperBlock, 'helper pin table missing');
  const helpers = [...helperBlock.matchAll(/\('(public\.[a-z_0-9]+\([^']*\))', '([0-9a-f]{32})', (?:true|false), '[^']*'\)/g)];
  assert.ok(helpers.length >= 4, 'the candidate has fewer than four helper pins');
  for (const [, sig, pin] of helpers) assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`), pin, `${sig} helper body drifted`);
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, 'auth.uid() body drifted');
  console.log(`[prover] FIDELITY: ${pins.length} target bodies, ${helpers.length} helpers and auth.uid() match their pinned md5`);
}
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.ADMIN_B, 'admin', 'Admin B', 8], [U.REP, 'sales_rep', 'Rep', 7], [U.APPLICATOR, 'applicator', 'Applicator', 6]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'replay-batch4de-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '4c4d0000-%';`),
    'admin:true,admin:true,sales_rep:true,applicator:true', 'invented profiles are missing');
}
function chain(prefix = '', file = CHAIN) {
  stageText('chain.sql', lf(file));
  const r = docker(psqlArgs(), { input: `BEGIN;\n${prefix}\n\\i /tmp/chain.sql\nROLLBACK;\n`, allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const pass = /SMOKE_PASS_ROLLBACK/.test(out);
  const fail = /SMOKE_FAIL[^\n]*/.exec(out)?.[0] ?? (pass ? '' : (/ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-500)));
  return { pass, fail, output: out };
}
function recreateGuardSql(ops) {
  return `DROP TRIGGER ${GUARD} ON public.idempotency_keys;
CREATE CONSTRAINT TRIGGER ${GUARD} AFTER INSERT OR UPDATE ON public.idempotency_keys
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.operation IN (${ops.map((o) => `'${o}'`).join(', ')}))
  EXECUTE FUNCTION public._require_bound_replay_receipt_20261015();`;
}
function assertUntouched(label, prior) {
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname IN (${IMPLS.map((n) => `'${n}'`).join(', ')});`), '0', `${label}: renamed body leaked`);
  for (const [name, pin] of pinRows(CANDIDATE)) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE proname = '${name}' AND pronamespace = 'public'::regnamespace;`), pin, `${label}: ${name} changed`);
  }
  assert.deepEqual(guardOps(), prior, `${label}: guard changed`);
}
function refusedAfter(label, prefix, expected, prior) {
  const r = docker(psqlArgs(), { input: `BEGIN;\n${prefix}\n\\i /tmp/candidate.sql\nROLLBACK;`, allowFailure: true });
  assert.notEqual(r.status, 0, `${label}: candidate applied`);
  assert.match(r.stderr, expected, `${label}: wrong refusal:\n${r.stderr}`);
  assertUntouched(label, prior);
}
function unboundReceipt(op) {
  const r = docker(psqlArgs(), { input: `BEGIN; INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
    VALUES ('proof-unbound-' || gen_random_uuid(), '${op}', '{"success":true}'::jsonb);
    SET CONSTRAINTS ALL IMMEDIATE; SELECT 'UNBOUND_ACCEPTED'; ROLLBACK;`, allowFailure: true });
  return `${r.stdout}\n${r.stderr}`;
}
function candidateBody(fn) {
  const sql = lf(CANDIDATE);
  const start = sql.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${fn}\\(`));
  assert.ok(start >= 0, `${fn} wrapper missing`);
  const tag = /AS (\$[a-z_]*\$)/.exec(sql.slice(start))[1];
  const a = sql.indexOf(`AS ${tag}`, start) + `AS ${tag}`.length;
  const header = sql.slice(start, a).replace(/^CREATE (?:OR REPLACE )?FUNCTION/, 'CREATE OR REPLACE FUNCTION');
  return { header, body: sql.slice(a, sql.indexOf(`${tag};`, a)), tag };
}
function mutate(fn, find, replacement) {
  const { header, body, tag } = candidateBody(fn);
  assert.equal(body.split(find).length - 1, 1, 'mutation hunk not unique');
  return `${header}${body.replace(find, replacement)}${tag};`;
}

function applyAndCheck(file, expected) {
  const staged = file === CANDIDATE ? 'candidate.sql' : 'other.sql';
  const r = apply(staged);
  assert.equal(r.status, 0, `${path.basename(file)} failed to apply:\n${r.output}`);
  assert.match(r.output, /POSTFLIGHT_OK/, 'POSTFLIGHT_OK missing');
  assert.deepEqual(guardOps(), expected, 'guard operation list is wrong');
  console.log(`[prover] APPLY ${path.basename(file)}: POSTFLIGHT_OK; guard ${expected.length} operations`);
}
function cloneBaseline() {
  // The pg_net and pg_cron sessions run as supabase_admin, which is the image's superuser.
  const fromTemplate1 = (sql) => docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'template1', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql });
  // The image opens background sessions on postgres. Close that source for the few seconds
  // required by CREATE DATABASE TEMPLATE, then reopen it even if the clone fails.
  fromTemplate1('ALTER DATABASE postgres ALLOW_CONNECTIONS false;');
  try {
    fromTemplate1("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres' AND pid<>pg_backend_pid();");
    fromTemplate1(`CREATE DATABASE proof_${TAG}_other_first OWNER postgres TEMPLATE postgres;`);
  } finally {
    fromTemplate1('ALTER DATABASE postgres ALLOW_CONNECTIONS true;');
  }
}

export function proveReplayBinding(config) {
  TAG = config.tag;
  SPEC_KEY = config.specKey;
  PASS = config.pass;
  FIRST = config.first;
  NAME = `crx-replay-${TAG}-${process.pid}-${Date.now().toString(36)}`;
  CANDIDATE = path.join(MIGRATIONS, config.candidate);
  OTHER = config.other ? path.join(MIGRATIONS, config.other) : null;
  OTHER_IN_BASELINE = config.otherInBaseline === true;
  assert.ok(!OTHER_IN_BASELINE || OTHER, 'otherInBaseline needs the other file');
  CHAIN = path.join(SMOKE, config.chain);
  WRAPPED = guardArrays(CANDIDATE).self;
  IMPLS = WRAPPED.map((n) => `_${n}_replay_impl_20261015`);
  try { run(); }
  finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
}

function run() {
  buildContainer();
  fidelity();
  seed();
  const { prior: post4c, other, self } = guardArrays(CANDIDATE);
  assert.equal(post4c.length, 53, 'the post-4c guard must have 53 operations');
  assert.equal(other.length, TAG === '4d' ? 15 : 25, 'the other batch has the wrong operation count');
  assert.equal(self.length, TAG === '4d' ? 25 : 15, 'this batch has the wrong operation count');
  // `prior` is the guard the candidate starts from: post-4c, or post-4c plus the live other batch.
  const prior = OTHER_IN_BASELINE ? [...post4c, ...other] : post4c;
  assert.deepEqual(guardOps(), prior, 'baseline guard differs from the expected starting state');
  stageText('candidate.sql', lf(CANDIDATE));
  const hasOther = Boolean(OTHER) && !OTHER_IN_BASELINE && existsSync(OTHER);
  if (hasOther) stageText('other.sql', lf(OTHER));
  const before = chain();
  assert.ok(!before.pass, 'BEFORE: chain unexpectedly passed');
  assert.match(before.fail, new RegExp(`SMOKE_FAIL: ${FIRST} replayed a changed request`), `BEFORE wrong first failure: ${before.fail}`);
  console.log(`[prover] BEFORE: ${before.fail}`);

  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT candidate applied');
  assert.match(auto.stderr, /NOT_IN_TRANSACTION/, 'AUTOCOMMIT wrong refusal');
  assertUntouched('AUTOCOMMIT', prior);
  const firstPin = pinRows(CANDIDATE)[0][0];
  const firstArgs = scalar(`SELECT pg_get_function_arguments(oid) FROM pg_proc WHERE proname='${firstPin}' AND pronamespace='public'::regnamespace;`);
  const firstReturn = scalar(`SELECT pg_get_function_result(oid) FROM pg_proc WHERE proname='${firstPin}' AND pronamespace='public'::regnamespace;`);
  refusedAfter('drifted body', `CREATE OR REPLACE FUNCTION public.${firstPin}(${firstArgs}) RETURNS ${firstReturn}
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NULL; END; $$;`,
  new RegExp(`PREFLIGHT_${TAG.toUpperCase()}_BODY_DRIFT`), prior);
  refusedAfter('pending receipt', `INSERT INTO public.idempotency_keys (idempotency_key, operation, result) VALUES ('prover-pending-${TAG}', '${self[0]}', '{"success":true}'::jsonb);`, /PREFLIGHT_UNEXPIRED_RECEIPTS/, prior);
  refusedAfter('unreviewed caller', `CREATE FUNCTION public.prover_unreviewed_${TAG}() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM public.${self[0]}(NULL); END; $$;`, /PREFLIGHT_UNREVIEWED_INTERNAL_CALLER/, prior);
  refusedAfter('unknown guard list', recreateGuardSql([...prior, 'unknown_prover_operation']), /PREFLIGHT_RECEIPT_GUARD_DRIFT/, prior);
  refusedAfter('pre-4c guard', recreateGuardSql(post4c.slice(0, 41)), /PREFLIGHT_RECEIPT_GUARD_DRIFT/, prior);
  if (OTHER_IN_BASELINE) refusedAfter('post-4c guard without the live other batch', recreateGuardSql(post4c), /PREFLIGHT_RECEIPT_GUARD_DRIFT/, prior);
  console.log(`[prover] AUTOCOMMIT + PREFLIGHT: transaction, body, receipt, internal caller, unknown, pre-4c${OTHER_IN_BASELINE ? ' and post-4c-only' : ''} guard refusals leave no changes`);

  // Clone only when both independent migration files are present.
  if (hasOther) cloneBaseline();
  applyAndCheck(CANDIDATE, [...prior, ...self]);
  for (const api of ['anon', 'authenticated', 'service_role']) {
    for (const impl of IMPLS) assert.equal(scalar(`SELECT has_function_privilege('${api}', (SELECT oid FROM pg_proc WHERE proname='${impl}' AND pronamespace='public'::regnamespace), 'EXECUTE');`), 'f', `${api} can execute ${impl}`);
  }
  const spec = JSON.parse(readFileSync(SPECS, 'utf8')).specs[SPEC_KEY];
  assert.ok(spec && spec.chain === path.basename(CHAIN) && spec.container_only === true, 'container-only smoke spec missing');
  assert.deepEqual([...spec.covers].sort(), [...self].sort(), 'smoke-specs covers must list this batch exactly');
  const after = chain();
  assert.ok(after.pass, `AFTER target-first chain failed: ${after.fail}\n${after.output.slice(-1500)}`);
  console.log('[prover] AFTER target-first: SMOKE_PASS_ROLLBACK');
  for (const op of self) assert.match(unboundReceipt(op), /REPLAY_RECEIPT_UNBOUND/, `unbound ${op} receipt committed`);
  const autoUnbound = docker(psqlArgs(), { input: `INSERT INTO public.idempotency_keys (idempotency_key,operation,result)
    VALUES ('prover-autocommit-${TAG}', '${self[0]}', '{"success":true}'::jsonb);`, allowFailure: true });
  assert.match(autoUnbound.stderr, /REPLAY_RECEIPT_UNBOUND/, 'an autocommit unbound receipt was accepted');
  assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='prover-autocommit-${TAG}';`), '0', 'an unbound receipt persisted');
  console.log(`[prover] AFTER: all ${self.length} unbound receipts refused; autocommit leaves no row`);
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'candidate reapplied');
  assert.match(again.output, new RegExp(`PREFLIGHT_${TAG.toUpperCase()}_BODY_DRIFT`));
  assert.deepEqual(guardOps(), [...prior, ...self]);
  console.log('[prover] RE-APPLY: refused by body preflight');
  const arg = configFirstArg(FIRST);
  const m = chain(mutate(FIRST, `'${arg}', ${arg}`, `'${arg}', NULL`));
  assert.ok(!m.pass, 'MUTATION: chain passed with record argument removed');
  assert.match(m.fail, new RegExp(`SMOKE_FAIL: ${FIRST} replayed a changed request`), `MUTATION wrong failure: ${m.fail}`);
  console.log(`[prover] MUTATION: dropping ${FIRST}.${arg} fails at ${m.fail}`);
  const body = candidateBody(FIRST).body;
  const rolePattern = TAG === '4d'
    ? /IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN[\s\S]*?END IF;/
    : /IF v_role IS NULL OR v_role NOT IN \('admin', 'sales_rep'\) THEN[\s\S]*?END IF;/;
  const roleCheck = rolePattern.exec(body)?.[0];
  assert.ok(roleCheck, `${FIRST} copied role check missing`);
  const noRole = chain(mutate(FIRST, roleCheck, '-- role check removed by mutation'));
  assert.ok(!noRole.pass, 'MUTATION: chain passed without the copied role check');
  assert.match(noRole.fail, /SMOKE_FAIL: .* (?:checked receipt before role|role gave)/,
    `MUTATION role check failed at the wrong step: ${noRole.fail}`);
  console.log(`[prover] MUTATION: removing ${FIRST} role check fails at ${noRole.fail}`);
  if (hasOther) {
    applyAndCheck(OTHER, [...prior, ...self, ...other]);
    assert.ok(chain().pass, 'target chain failed after the other batch was applied');
    console.log('[prover] ORDER target -> other: both batches and chain pass');

    DATABASE = `proof_${TAG}_other_first`;
    assert.deepEqual(guardOps(), prior, 'second database is not the baseline');
    applyAndCheck(OTHER, [...prior, ...other]);
    applyAndCheck(CANDIDATE, [...prior, ...other, ...self]);
    const reversed = chain();
    assert.ok(reversed.pass, `AFTER other-first chain failed: ${reversed.fail}\n${reversed.output.slice(-1500)}`);
    console.log('[prover] ORDER other -> target: both batches and SMOKE_PASS_ROLLBACK');
  }
  console.log(PASS);
}
function configFirstArg(name) {
  const m = /'actor_id', v_actor, '([a-z_]+)'/.exec(candidateBody(name).body);
  assert.ok(m, `cannot find first fingerprint argument for ${name}`);
  return m[1];
}

// ------------------------------------------------------------------------------------------------
// FIDELITY: the md5 pins the candidate's preflight checks, read from the candidate file itself.
