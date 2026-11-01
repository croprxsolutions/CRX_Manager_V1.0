#!/usr/bin/env node
/**
 * Full-chain proof for 20261101120000_allocate_payment_error_shows_dollars.
 *
 * Builds the checked-in production baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every ordered post-baseline migration up to the candidate (whose preflight pins the live
 * body, owner, grants and defaults), seeds an admin, a rep, a customer and a $1,000.00 posted invoice,
 * then runs one rolled-back matrix BEFORE and AFTER the candidate:
 *   - the over-balance refusal changes from cents to dollars and nothing else about it;
 *   - the forged-actor refusal gains only the ACTOR_MISMATCH token;
 *   - a normal payment, a same-key replay, an edited-retry refusal, a too-large total and another
 *     operation's key answer exactly as before;
 *   - grants, security settings and defaults are unchanged, and a second apply is refused by the
 *     preflight (the pinned body has gone), so nothing can be applied twice.
 *
 * Run: node scripts/smoke/prove-allocate-payment-error-shows-dollars-real-schema.mjs   (needs Docker)
 * Prints ALLOCATE_PAYMENT_ERROR_SHOWS_DOLLARS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-pay-dollars-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261101120000_allocate_payment_error_shows_dollars.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
const SIG = 'public.allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text)';
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';

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
  try { docker(['cp', staged, `${NAME}:/tmp/${name}`]); } finally { unlinkSync(staged); }
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
  for (const file of all.slice(at + 1)) assert.ok(!/allocate_payment/.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches allocate_payment; re-think this proof`);
  return all.slice(0, at);
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres;
    GRANT ALL ON storage.objects, storage.buckets TO postgres;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  let replayed = 0;
  for (const [i, file] of plan().entries()) {
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
  console.log(`[prover] replayed ${replayed} post-baseline migrations`);
}

const id = (n) => `7c720000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1'); const REP = id('b1'); const CUST = id('c1'); const INV = id('101');
function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function seed() {
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${ADMIN}', 'pay-dollars-a@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
      ('${REP}', 'pay-dollars-r@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);
    ${claims(ADMIN)}
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Dollars Farm', true);
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by)
      VALUES ('${INV}', 'PROVER-DOLLARS-1', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, CURRENT_DATE + 30, 100000, '${ADMIN}');
    UPDATE public.invoices SET status = 'posted', posted_by = '${ADMIN}', posted_at = now() WHERE id = '${INV}';
    COMMIT;`);
  assert.equal(scalar(`SELECT status || ':' || balance_cents FROM public.invoices WHERE id = '${INV}';`), 'posted:100000');
}

/** One rolled-back signed-in call; returns ok|<v> or <sqlstate>|<message>. */
function attempt(uid, stmt, fixture = '') {
  const sql = `BEGIN;
${fixture}
RESET ROLE;
${claims(uid)}
SET LOCAL ROLE authenticated;
DO $probe$
DECLARE v text; r jsonb; r2 jsonb;
BEGIN
  ${stmt}
  RAISE NOTICE 'RESULT|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|%|%', SQLSTATE, SQLERRM;
END
$probe$;
ROLLBACK;
`;
  const res = docker([...psqlArgs(), '-A', '-t'], { input: sql, allowFailure: true });
  assert.equal(res.status, 0, `probe failed to run:\n${res.stderr}\n--- SQL ---\n${sql}`);
  const m = /RESULT\|([^\n]*)/.exec(res.stderr);
  assert.ok(m, `probe printed no RESULT:\n${res.stderr}`);
  return m[1].trimEnd();
}
const pay = (uid, cents, key, ref = 'PROVER-REF') => `public.allocate_payment('${CUST}', ${cents}, 'check', '${ref}', NULL, CURRENT_DATE, 'prover',
    jsonb_build_array(jsonb_build_object('invoice_id', '${INV}', 'amount_cents', ${cents})), '${uid}', ${key ? `'${key}'` : 'NULL'})`;
const CASES = {
  'over by $500': [ADMIN, `r := ${pay(ADMIN, 150000, 'k-over')};`],
  'over by one cent': [ADMIN, `r := ${pay(ADMIN, 100001, 'k-cent')};`],
  'absurd amount': [ADMIN, `r := ${pay(ADMIN, 2000000000000, 'k-huge')};`],
  'allocations above the total': [ADMIN, `r := public.allocate_payment('${CUST}', 30000, 'check', 'PROVER-REF', NULL, CURRENT_DATE, 'prover',
    jsonb_build_array(jsonb_build_object('invoice_id', '${INV}', 'amount_cents', 40000)), '${ADMIN}', 'k-total');`],
  'rep forges the admin': [REP, `r := ${pay(ADMIN, 30000, 'k-forged')};`],
  'normal payment': [ADMIN, `r := ${pay(ADMIN, 30000, 'k-pay')}; v := (r->>'total_allocated_cents') || ':' || (r->>'invoices_paid') || ':' || (SELECT count(*) FROM public.allocation_sets WHERE id = (r->>'allocation_set_id')::uuid AND is_active);`],
  'rep payment': [REP, `r := ${pay(REP, 30000, 'k-rep')}; v := (r->>'total_allocated_cents') || ':' || (r->>'invoices_paid');`],
  'exact balance': [ADMIN, `r := ${pay(ADMIN, 100000, 'k-all')}; v := (r->>'total_allocated_cents');`],
  'same-key replay saves once': [ADMIN, `r := ${pay(ADMIN, 30000, 'k-replay')}; r2 := ${pay(ADMIN, 30000, 'k-replay')};
    v := ((r->>'allocation_set_id') = (r2->>'allocation_set_id'))::text || ':' || (SELECT count(*) FROM public.allocation_sets WHERE customer_id = '${CUST}' AND entity_type = 'payment');`],
  'edited retry refused': [ADMIN, `r := ${pay(ADMIN, 30000, 'k-edit')}; r2 := ${pay(ADMIN, 40000, 'k-edit')};`],
  'edited reference refused': [ADMIN, `r := ${pay(ADMIN, 30000, 'k-edit2')}; r2 := ${pay(ADMIN, 30000, 'k-edit2', 'OTHER')};`],
  'another operation owns the key': [ADMIN, `r := ${pay(ADMIN, 30000, 'k-other')};`, "INSERT INTO public.idempotency_keys (idempotency_key, operation, result) VALUES ('k-other', 'void_payment', '{}'::jsonb);"],
};
function matrix(phase) {
  const out = {};
  for (const [label, [uid, stmt, fixture]] of Object.entries(CASES)) out[label] = attempt(uid, stmt, fixture);
  console.log(`[prover] ${phase}:`);
  for (const [k, v] of Object.entries(out)) console.log(`  ${k}: ${v}`);
  return out;
}
const META = `SELECT pg_get_userbyid(proowner) || '|' || proacl::text || '|' || prosecdef || '|' || proconfig::text || '|' || provolatile::text || '|'
  || pg_get_function_arguments(oid) FROM pg_proc WHERE oid = '${SIG}'::regprocedure;`;

function main() {
  buildContainer();
  seed();
  const before = matrix('BEFORE');
  assert.equal(before['over by $500'], `P0001|Allocation ($150000) exceeds balance ($100000) on invoice PROVER-DOLLARS-1`);
  assert.equal(before['rep forges the admin'], 'P0001|p_performed_by does not match authenticated user');
  const metaBefore = scalar(META);

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  const after = matrix('AFTER');
  assert.equal(after['over by $500'], 'P0001|Allocation ($1500.00) exceeds balance ($1000.00) on invoice PROVER-DOLLARS-1');
  assert.equal(after['over by one cent'], 'P0001|Allocation ($1000.01) exceeds balance ($1000.00) on invoice PROVER-DOLLARS-1');
  assert.equal(after['absurd amount'], 'P0001|Allocation ($20000000000.00) exceeds balance ($1000.00) on invoice PROVER-DOLLARS-1');
  assert.equal(after['rep forges the admin'], 'P0001|ACTOR_MISMATCH: p_performed_by does not match authenticated user');
  assert.match(after['allocations above the total'], /^P0001\|OVER_ALLOCATED: allocations total \$400\.00 but payment is only \$300\.00/);
  assert.match(after['edited retry refused'], /^P0001\|IDEMPOTENCY_ARGUMENT_MISMATCH: /);
  assert.match(after['another operation owns the key'], /IDEMPOTENCY_CROSS_OP_KEY_REUSE/);
  const expected = ['over by $500', 'over by one cent', 'absurd amount', 'rep forges the admin'];
  for (const [label, got] of Object.entries(after)) {
    if (!expected.includes(label)) assert.equal(got, before[label], `${label} changed`);
  }
  assert.equal(scalar(META), metaBefore, 'owner, grants, security settings or defaults changed');
  console.log(`[prover] every other case and the function's grants, owner, settings and defaults are unchanged:\n  ${metaBefore}`);

  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply must be refused by the preflight');
  assert.match(again.output, /PREFLIGHT_FAIL/);
  console.log('[prover] a second apply is refused by the preflight');

  console.log('ALLOCATE_PAYMENT_ERROR_SHOWS_DOLLARS_PROOF_PASS');
}

try { main(); }
finally { docker(['rm', '-f', NAME], { allowFailure: true }); }
