#!/usr/bin/env node
// Disposable real-schema numbering proof. Never reads a database URL or contacts production.
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-document-numbers-${process.pid}-${Date.now().toString(36)}`;
assert.ok(process.argv.slice(2).every(arg => arg === '--keep'), 'only --keep is supported; reuse is deliberately refused');
const KEEP = process.argv.includes('--keep');
let createdContainerId = null;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261029160300_document_numbers_chicago_year.sql');
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
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const COVERED = /generate_quote_number|generate_order_number|create_rebate_claim/i;


// ------------------------------------------------------------------------------------------------

const SPECS = [
  ['generate_quote_number()', '43128e5f575b0a23a1941619ee878c93', '997d2761e4ccad424ec37b2eacf9bb60'],
  ['generate_order_number()', 'b05ec25cf0acc3788c1d07436876874e', '12ea44c2fab96aa4f3b84becd99aa8cf'],
  ['create_rebate_claim(uuid,numeric,bigint,uuid,uuid,uuid,text,text)', '99e94daf650cffb362a482e532e28694', 'b10a817e3ed45f227c5a471a837b3a4c'],
];
const ADMIN = 'ab120000-0000-4000-8000-000000000001';
const MANAGER = 'ab120000-0000-4000-8000-000000000003';
const PROGRAM = 'ab120000-0000-4000-8000-000000000002';
const claim = key => `public.create_rebate_claim('${PROGRAM}',1,100,p_idempotency_key=>'number-proof-${process.pid}-${key}')`;
const claims = `SET request.jwt.claim.sub='${ADMIN}'; SET request.jwt.claims='{"sub":"${ADMIN}"}';`;
const managerClaims = `SET request.jwt.claim.sub='${MANAGER}'; SET request.jwt.claims='{"sub":"${MANAGER}"}';`;
function contract() {
  return scalar(`SELECT jsonb_agg(jsonb_build_array(oid::text,proargtypes::text,proargnames,pronargdefaults,proacl::text,proconfig,prosecdef,proowner))::text
    FROM (SELECT * FROM pg_proc WHERE oid IN (${SPECS.map(([s]) => `'public.${s}'::regprocedure`).join(',')}) ORDER BY oid) p;`);
}
function definitions() {
  return SPECS.map(([s]) => JSON.parse(scalar(`SELECT to_json(pg_get_functiondef('public.${s}'::regprocedure))::text;`)));
}
// This clock substitution is LOCAL ONLY: the full installed function runs with
// only now()/current_date replaced by a literal. No production clock hook is added.
function freeze(defs, instant) {
  for (const def of defs) psql(def.replaceAll('now()', `TIMESTAMPTZ '${instant}'`).replaceAll('current_date', `(TIMESTAMPTZ '${instant}' AT TIME ZONE 'UTC')::date`));
}
function call(sql) { return scalar(`${claims} ${sql}`); }
function asyncSql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out.trim().split(/\r?\n/).at(-1)) : reject(new Error(err)));
    child.stdin.end(`${claims} ${sql}`);
  });
}
async function main() {
  buildContainer();
  for (const [sig, old] of SPECS) assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid='public.${sig}'::regprocedure;`), old, `live fidelity: ${sig}`);
  const before = contract();
  const oldDefs = definitions();
  stageText('candidate.sql', lf(CANDIDATE));
  const installed = apply('candidate.sql');
  assert.equal(installed.status, 0, `migration applies: ${installed.output}`);
  assert.equal(contract(), before, 'signature, owner, grants and search path preserved');
  for (const [sig,,hash] of SPECS) assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid='public.${sig}'::regprocedure;`),hash);
  assert.equal(apply('candidate.sql').status,0,'replay safe');
  const fixedDefs = definitions();
  psql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${ADMIN}','number-proof@example.invalid','{"role":"admin","full_name":"Number Proof"}'),
    ('${MANAGER}','number-manager@example.invalid','{"role":"admin","full_name":"Number Manager"}') ON CONFLICT (id) DO NOTHING;
    INSERT INTO rebate_programs(id,program_name,manufacturer,season,start_date,end_date) VALUES ('${PROGRAM}','Number Proof','Synthetic',2026,'2026-01-01','2027-12-31') ON CONFLICT (id) DO NOTHING;
    ${managerClaims} UPDATE profiles SET role='admin' WHERE id='${ADMIN}';`);
  for (const [instant, year] of [
    ['2026-12-31 23:59:59+00','2026'],
    ['2027-01-01 00:00:00+00','2026'],
    ['2027-01-01 05:59:59+00','2026'],
    ['2027-01-01 06:00:00+00','2027'],
    ['2027-01-01 06:00:01+00','2027'],
    ['2026-07-15 05:00:00+00','2026'],
    ['2026-01-15 06:00:00+00','2026'],
  ]) {
    freeze(fixedDefs, instant);
    for (const timezone of ['UTC','America/Chicago','Asia/Tokyo']) {
      const values = call(`SET timezone='${timezone}'; SELECT generate_quote_number()||'|'||generate_order_number()||'|'||(${claim('boundary-'+instant+timezone)}->>'claim_number');`).split('|');
      for (const [i,prefix] of ['Q','ORD','RC'].entries()) assert.match(values[i],new RegExp(`^${prefix}-${year}-[0-9]{4}$`));
    }
    console.log('PASS Chicago year',instant,year,'in UTC, Chicago and Tokyo sessions');
  }
  freeze(oldDefs,'2027-01-01 02:00:00+00');
  assert.match(call('SELECT generate_quote_number();'),/^Q-2027-/,'original reproduces early rollover');
  freeze(fixedDefs,'2027-01-01 02:00:00+00');
  assert.match(call('SELECT generate_quote_number();'),/^Q-2026-/,'fixed result differs from original');
  const first = call(`SELECT ${claim('replay-year')}::text;`);
  freeze(fixedDefs,'2027-01-01 06:00:01+00');
  assert.equal(call(`SELECT ${claim('replay-year')}::text;`),first,'retry after midnight retains original claim and year');
  const count = scalar('SELECT count(*) FROM rebate_claims;');
  const jobs = Array.from({length:12},(_,i)=>asyncSql(`SELECT generate_quote_number()||'|'||generate_order_number()||'|'||(${claim('parallel-'+i)}->>'claim_number');`));
  const results = await Promise.all(jobs);
  for (let i=0;i<3;i++) assert.equal(new Set(results.map(x=>x.split('|')[i])).size,12,'parallel numbers unique');
  assert.equal(Number(scalar('SELECT count(*) FROM rebate_claims;')),Number(count)+12);
  console.log('PASS 12 independent concurrent transactions: unique quote/order/claim numbers');
  for (const role of ['admin','sales_rep']) {
    psql(`${managerClaims} UPDATE profiles SET role='${role}' WHERE id='${ADMIN}';`);
    psql(`BEGIN; ${claims} SET LOCAL ROLE authenticated; SELECT generate_quote_number(),generate_order_number(),${claim('allowed-'+role)}; ROLLBACK;`);
  }
  for (const role of ['driver','applicator']) {
    psql(`${managerClaims} UPDATE profiles SET role='${role}' WHERE id='${ADMIN}';`);
    for (const expression of ['generate_quote_number()','generate_order_number()',claim('forbidden-'+role)]) {
      const r=psql(`BEGIN; ${claims} SET LOCAL ROLE authenticated; SELECT ${expression}; ROLLBACK;`,{allowFailure:true});
      assert.notEqual(r.status,0,role+' refused');
    }
  }
  psql(`${managerClaims} UPDATE profiles SET role='admin' WHERE id='${ADMIN}';`);
  assert.notEqual(psql(`${claims} SELECT public.create_rebate_claim('${PROGRAM}',0,100);`,{allowFailure:true}).status,0,'bad quantity refused');
  for (const def of fixedDefs) psql(def);
  const drift = fixedDefs[0].replace("RETURN 'Q-'", "RETURN 'DRIFT-Q-'");
  psql(drift);
  assert.notEqual(apply('candidate.sql').status,0,'unexpected body drift refused');
  for (const def of fixedDefs) psql(def);
  assert.equal(contract(),before,'all contracts still preserved');
  for (const change of [
    'ALTER FUNCTION public.create_rebate_claim(uuid,numeric,bigint,uuid,uuid,uuid,text,text) SECURITY INVOKER;',
    'ALTER FUNCTION public.generate_quote_number() SET search_path = public, pg_temp;',
    'CREATE ROLE number_proof_owner; GRANT number_proof_owner TO postgres WITH SET TRUE; GRANT CREATE ON SCHEMA public TO number_proof_owner; ALTER FUNCTION public.generate_order_number() OWNER TO number_proof_owner;',
    'REVOKE EXECUTE ON FUNCTION public.generate_quote_number() FROM authenticated;',
  ]) {
    const refused = psql(`BEGIN; ${change}\n${lf(CANDIDATE)}`, { allowFailure: true });
    assert.notEqual(refused.status, 0, 'preflight refuses changed function contract');
    assert.match(refused.stderr, /CONTRACT_FAIL/);
    assert.equal(contract(), before, 'failed preflight rolls back the local mutation');
  }
  const badReplacement = lf(CANDIDATE).replace('RETURNS text\nLANGUAGE plpgsql\nSET search_path = public',
    'RETURNS text\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public');
  assert.notEqual(badReplacement, lf(CANDIDATE));
  // The migration carries no transaction control; the apply wrapper (and this proof) supplies it.
  const postflightRefusal = psql(`BEGIN;\n${badReplacement}\nCOMMIT;`, { allowFailure: true });
  assert.notEqual(postflightRefusal.status, 0, 'postflight refuses an incorrect emitted contract');
  assert.match(postflightRefusal.stderr, /CONTRACT_FAIL/);
  assert.equal(contract(), before, 'postflight refusal rolls back the whole migration');
  console.log('PASS preflight/postflight refuse owner, grants, search-path and security drift');
  console.log('DOCUMENT_NUMBERS_CHICAGO_PROOF_PASS');
}
try { await main(); }
finally { if (createdContainerId && !KEEP) docker(['rm','--force',createdContainerId],{allowFailure:true}); }
// Container plumbing (the shared real-schema harness).
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
  // Replay only what sorts before the candidate. Later migrations (#1057 lands after this one) are
  // not part of this proof; any that redefines these functions must carry its own proof.
  const before = all.slice(0, at);
  for (const later of all.slice(at + 1)) {
    if (COVERED.test(lf(later))) console.log(`[prover] NOTE: ${path.basename(later)} sorts after the candidate and touches what this proves; it is not replayed here`);
  }
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!COVERED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return before;
}
function installLiveAuthUid() {
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
}
function buildContainer() {
  const startedContainerId = docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]).stdout.trim();
  assert.match(startedContainerId, /^[0-9a-f]{64}$/, 'Docker must identify the container this run created');
  createdContainerId = startedContainerId;
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    -- As live, and as 20261022075000 (delivery completion evidence) requires: metadata jsonb, and
    -- postgres, which owns complete_delivery, may read storage.objects.
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
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
    if (replayed % 25 === 0) console.log(`[prover] replayed ${replayed} migrations; latest ${base}`);
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}


// ------------------------------------------------------------------------------------------------
