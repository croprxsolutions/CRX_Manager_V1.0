#!/usr/bin/env node
// KI-95 proof for 20261103150000_ar_aging_flags_unrebuildable_customers on a disposable,
// network-disabled PostgreSQL 17 built from the checked-in production baseline plus every migration
// before the candidate. No live URLs or writes. Proves:
//   (a) a past-date report with one customer whose balance cannot be rebuilt (a prepay entered after
//       the date) failed for everyone BEFORE; AFTER it returns every good customer exactly as before
//       and the bad one flagged, with no amounts (nothing invented);
//   (b) a current-date report is unchanged: every old column of every row is identical, and the new
//       unavailable_reason column is NULL on every row;
//   plus the registered rollback chain smoke-historical-ar-report-cutoffs.sql fails first and passes
//   after, access stays admin-only, and a mutation that shows today's balance instead of a flag is caught.
// Run: node scripts/smoke/prove-ar-aging-flags-unrebuildable-real-schema.mjs   (needs Docker)
// Prints AR_AGING_FLAGS_PROOF_PASS on success.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const name = `crx-ar-aging-flags-${process.pid}`;
let created = false;
const candidate = '20261103150000_ar_aging_flags_unrebuildable_customers.sql';
const baseline = path.join(root, 'supabase/baselines');
const skippedStorage = new Set(['20260914100700_customer_document_bytes_server_only.sql', '20261015230000_staff_photo_storage_access.sql', '20261016030000_staff_photo_buckets_private.sql']);
const ledgerOnly = new Set(['20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql', '20261007150200_release_reservations_of_deleted_spring_orders.sql']);
const ADMIN = '7a5a0000-0000-4000-8000-000000000001';
const REP = '7a5a0000-0000-4000-8000-000000000002';
const OLD_COLS = 'customer_id, farm_name, current_amount, days_30, days_60, days_90, over_90, total_outstanding, prepay_balance_cents, open_credit_cents';
const TODAY = "(now() AT TIME ZONE 'America/Chicago')::date";
const PAST = `(${TODAY} - 50)`;

function docker(args, input, allowFailure = false) {
  const r = spawnSync('docker', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.error || (!allowFailure && r.status !== 0)) throw new Error(r.error?.message || r.stderr || r.stdout);
  return r;
}
function sql(input, user = 'postgres', allowFailure = false) {
  return docker(['exec', '-i', name, 'psql', '-U', user, '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input, allowFailure);
}
const read = (file) => readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
function ledger(stem) {
  sql(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ('${stem.slice(0,14)}','${stem}',ARRAY[]::text[]) ON CONFLICT DO NOTHING;`);
}
function installAuthUid() {
  // The batch-2 preflight pins live's byte-exact body, including whitespace.
  const body = '\n  select \n  coalesce(\n' + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n" + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n" + '  )::uuid\n';
  sql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $uid$${body}$uid$;`, 'supabase_admin');
}
function build() {
  docker(['run','-d','--name',name,'--network','none','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m','-e','POSTGRES_PASSWORD=postgres','public.ecr.aws/supabase/postgres:17.6.1.143']);
  created = true;
  for (let i = 0; ; i++) {
    // The image first runs an init-only socket server; wait for the final TCP server.
    if (docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'], undefined, true).status === 0) break;
    if (i > 120) throw new Error('PostgreSQL not ready');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  sql(read('supabase/baselines/20260727174805_extensions.sql'));
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs', '--with-live-rows'], { cwd: root, encoding: 'utf8', maxBuffer: 64*1024*1024 });
  assert.equal(schema.status, 0, schema.stderr);
  sql(schema.stdout);
  sql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets(id text PRIMARY KEY,name text NOT NULL,public boolean NOT NULL DEFAULT false,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text NOT NULL,name text NOT NULL,owner_id text,metadata jsonb,UNIQUE(bucket_id,name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name,'/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name,'/',array_length(string_to_array(name,'/'),1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres; GRANT ALL ON storage.objects,storage.buckets TO postgres;`, 'supabase_admin');
  sql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY,name text NOT NULL,statements text[]);');
  for (const suffix of ['acl_lockdown','platform_overlay','cron_jobs','migration_history']) {
    sql(readFileSync(path.join(baseline, `20260727174805_${suffix}.sql`),'utf8'), suffix === 'platform_overlay' ? 'supabase_admin' : 'postgres');
  }
  const plan = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(plan.status, 0, plan.stderr);
  const files = plan.stdout.split(/\r?\n/).filter(f => f.startsWith('supabase/migrations/'));
  assert.equal(path.basename(files.at(-1)), candidate, 'candidate must be last');
  for (const [i,file] of files.slice(0,-1).entries()) {
    const base = path.basename(file);
    if (skippedStorage.has(base)) continue;
    for (const only of ledgerOnly) if (only < base) ledger(only.slice(0,-4));
    if (ledgerOnly.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') {
      const source = read('supabase/migrations/20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql');
      const start = source.indexOf('CREATE FUNCTION public._close_undelivered_order_remainder_20260718(');
      const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
      const bodyStart = start + tag.index + tag[0].length;
      const body = source.slice(bodyStart, source.indexOf(tag[0],bodyStart)).replaceAll('\n','\r\n');
      assert.equal(body.length,15910);
      sql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $body$${body}$body$;`);
    }
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installAuthUid();
    const result = sql(`BEGIN;\n${read(file)}\nCOMMIT;`, 'postgres', true);
    assert.equal(result.status, 0, `${base}: ${result.stderr}`);
    ledger(base.slice(0,-4));
    if (i % 25 === 0) console.log(`Replayed ${i+1}/${files.length-1}`);
  }
  installAuthUid();
  console.log('Restored baseline and current migration chain; storage-only and one-shot data skips match existing provers.');
}

function asUser(user, query, allowFailure = false) {
  return sql(`SET request.jwt.claims = '{"sub":"${user}","role":"authenticated"}';\n${query}`, 'postgres', allowFailure);
}
// The report's rows as JSON sorted by customer: the old columns, or the given ones.
const report = (date, cols = OLD_COLS) =>
  asUser(ADMIN, `SELECT COALESCE(json_agg(r ORDER BY r.customer_id), '[]') FROM (SELECT ${cols} FROM public.get_ar_aging(${date})) r;`).stdout.trim();
function invoice(customer, number, type, day, dueDay, cents) {
  // Two statements: an UPDATE cannot see a row inserted by the same statement's CTE.
  return `INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id)
      VALUES ('[PROVER]-${number}', '${customer}', '${type}', 'draft', ${TODAY} - ${day}, ${dueDay === null ? 'NULL' : `${TODAY} - ${dueDay}`}, ${cents}, '${ADMIN}', '${ADMIN}');
    UPDATE public.invoices SET status = 'posted', posted_at = (${TODAY} - ${day})::timestamp AT TIME ZONE 'America/Chicago' WHERE invoice_number = '[PROVER]-${number}';`;
}

try {
  console.log(`Building own isolated container ${name}`);
  build();
  sql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ar-aging-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'ar-aging-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  sql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    SET session_replication_role = origin;`, 'supabase_admin');
  const C = { g1: '7a5a0000-0000-4000-8000-0000000000a1', g2: '7a5a0000-0000-4000-8000-0000000000a2', bad: '7a5a0000-0000-4000-8000-0000000000b1' };
  sql(Object.entries(C).map(([k, id]) => `INSERT INTO public.customers (id, farm_name, account_number, is_active) VALUES ('${id}', '[PROVER] ${k}', '[PROVER]-${k}', true);`).join('\n'));
  sql([
    invoice(C.g1, 'G1-OLD', 'chemical_sale', 130, 125, 20000),
    invoice(C.g1, 'G1-NEW', 'chemical_sale', 10, null, 5000),
    invoice(C.g2, 'G2-A', 'chemical_sale', 70, 60, 10000),
    invoice(C.g2, 'G2-CM', 'credit_memo', 60, null, -2000),
    invoice(C.bad, 'BAD-A', 'chemical_sale', 80, 75, 5000),
  ].join('\n'));

  // BEFORE (old function). The past-date report while every customer can still be rebuilt.
  const oldPast = JSON.parse(report(PAST));
  assert.deepEqual(oldPast.map(r => r.customer_id).sort(), Object.values(C).sort(), `fixture: ${JSON.stringify(oldPast)}`);
  // The bad customer pays by prepay today, after the past date, so that date can no longer be rebuilt for them.
  sql(`INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, payment_method, reference_number, created_by)
       VALUES ('${C.bad}', 1000, 1000, 'check', '[PROVER]-LATER', '${ADMIN}');`);
  const failed = asUser(ADMIN, `SELECT count(*) FROM public.get_ar_aging(${PAST});`, true);
  assert.match(failed.stderr, /HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE/, `fail-first: ${failed.stderr}`);
  console.log('BEFORE: one unrebuildable customer makes the past-date report fail for everyone.');
  const oldToday = report(TODAY);
  assert.equal(JSON.parse(oldToday).length, 3, oldToday);
  const chain = read('scripts/smoke/smoke-historical-ar-report-cutoffs.sql');
  const chainBefore = sql(chain, 'postgres', true);
  assert.match(chainBefore.stderr, /HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE/, `chain fail-first: ${chainBefore.stderr}`);
  console.log('BEFORE: the updated rollback chain fails first on the old function.');

  sql(`BEGIN;\n${read(`supabase/migrations/${candidate}`)}\nCOMMIT;`);
  const reapply = sql(`BEGIN;\n${read(`supabase/migrations/${candidate}`)}\nCOMMIT;`, 'postgres', true);
  assert.match(reapply.stderr, /AR_AGING_FLAGS_PREFLIGHT/, `re-apply must be refused by the preflight pin: ${reapply.stderr}`);
  console.log('APPLY: postflight passed (one version, SECURITY DEFINER, search_path, grants); re-apply refused by the preflight.');

  // (a) Past date: good rows exactly as before, the bad one flagged with no amounts.
  const newPast = JSON.parse(report(PAST, `${OLD_COLS}, unavailable_reason`));
  const goodNew = newPast.filter(r => r.customer_id !== C.bad);
  assert.ok(goodNew.every(r => r.unavailable_reason === null), 'a good customer was flagged');
  const strip = ({ unavailable_reason: _reason, ...rest }) => rest;
  assert.deepEqual(goodNew.map(strip), oldPast.filter(r => r.customer_id !== C.bad), 'good customers changed');
  assert.deepEqual(newPast.filter(r => r.customer_id === C.bad), [{
    customer_id: C.bad, farm_name: '[PROVER] bad', current_amount: null, days_30: null, days_60: null, days_90: null,
    over_90: null, total_outstanding: null, prepay_balance_cents: null, open_credit_cents: null,
    unavailable_reason: 'HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE',
  }]);
  console.log(`(a) PAST DATE: ${goodNew.length} good customers identical to before; the unrebuildable one is flagged with every amount blank.`);

  // (b) Current date: unchanged.
  assert.equal(report(TODAY), oldToday, 'current-date report changed');
  assert.equal(asUser(ADMIN, `SELECT count(*) FILTER (WHERE unavailable_reason IS NOT NULL) || '/' || count(*) FROM public.get_ar_aging(${TODAY});`).stdout.trim(), '0/3');
  console.log('(b) CURRENT DATE: every row and column identical to the old function; no row flagged.');

  // Still admin-only, still closed to anon.
  const rep = asUser(REP, `SET ROLE authenticated; SELECT count(*) FROM public.get_ar_aging(${PAST});`, true);
  assert.notEqual(rep.status, 0, 'a sales rep read the report');
  const anon = sql(`SET ROLE anon; SELECT count(*) FROM public.get_ar_aging(${PAST});`, 'postgres', true);
  assert.match(anon.stderr, /permission denied for function get_ar_aging/, anon.stderr);
  console.log(`ACCESS: a sales rep is refused (${rep.stderr.trim().split('\n')[0]}); anon has no EXECUTE.`);

  const chainAfter = sql(chain, 'postgres', true);
  assert.match(chainAfter.stderr, /SMOKE_PASS_ROLLBACK/, chainAfter.stderr);
  console.log('CHAIN: smoke-historical-ar-report-cutoffs.sql SMOKE_PASS_ROLLBACK (listing still fails closed; grants intact).');

  // Any other error from the per-customer check still fails the whole report (never becomes a flag).
  // One transaction that psql aborts on the error, so the stand-in helper is rolled back.
  const other = asUser(ADMIN, `BEGIN;
    CREATE OR REPLACE FUNCTION public.assert_customer_balance_reconstructable_as_of(p_customer_id uuid, p_as_of_date date)
      RETURNS void LANGUAGE plpgsql AS $f$BEGIN RAISE EXCEPTION 'SOME_OTHER_FAILURE: not a reconstruction refusal'; END$f$;
    SELECT count(*) FROM public.get_ar_aging(${PAST});`, true);
  assert.match(other.stderr, /SOME_OTHER_FAILURE/, `unexpected error must still fail the report: ${other.stderr}`);
  assert.match(sql("SELECT prosrc FROM pg_proc WHERE oid = 'public.assert_customer_balance_reconstructable_as_of(uuid,date)'::regprocedure;").stdout, /HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE/, 'stand-in helper was not rolled back');
  console.log('RE-RAISE: an error other than the three refusal codes still fails the whole report.');

  // MUTATION: a version that drops the flag and shows the customer's today-based balance must be caught.
  const swallow = read(`supabase/migrations/${candidate}`).split('DO $postflight$')[0]
    .replace(/DO \$preflight\$[\s\S]*?\$preflight\$;/, '')
    .replace('AND i.customer_id <> ALL (v_unavailable_ids)', '')
    .replace('JOIN public.customers c ON c.id = u.id', 'JOIN public.customers c ON c.id = u.id AND false');
  sql(`BEGIN;\n${swallow}\nCOMMIT;`);
  const mutated = sql(chain, 'postgres', true);
  assert.match(mutated.stderr, /SMOKE_FAIL: AR Aging did not flag/, mutated.stderr);
  console.log("MUTATION: a report that shows the unrebuildable customer's balance instead of a flag is caught by the chain.");
  console.log('AR_AGING_FLAGS_PROOF_PASS');
} finally {
  if (process.argv.includes('--keep-container')) console.log(`Kept own isolated container ${name}`);
  else if (created) docker(['rm','-f',name],undefined,true);
}
