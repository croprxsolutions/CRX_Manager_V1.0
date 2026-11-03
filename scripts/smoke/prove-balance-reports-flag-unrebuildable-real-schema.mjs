#!/usr/bin/env node
// KI-95 proof for 20261104120000_balance_reports_flag_unrebuildable_customers on a disposable,
// network-disabled PostgreSQL 17 built from the checked-in production baseline plus every migration
// before the candidate. No live URLs or writes. Proves, for BOTH get_ar_aging and
// get_customer_balance_listing:
//   (a) a past-date report with one customer whose posting history has two events at the same audit
//       timestamp (HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE) and one with a prepay entered after
//       the date failed for everyone BEFORE; AFTER it returns every good customer exactly as before
//       and each bad one flagged with its reason code and no amounts (nothing invented);
//   (b) a current-date report is unchanged: every old column of every row is identical, and
//       unavailable_reason is NULL on every row (a sales rep's own-scope listing too);
//   plus the rollback chain smoke-historical-ar-report-cutoffs.sql fails first and passes after,
//   access is unchanged, any other error still fails the report, and two mutations are caught
//   (no CASE guard in the money query; a flagged customer shown with today's balance).
// Run: node scripts/smoke/prove-balance-reports-flag-unrebuildable-real-schema.mjs   (needs Docker)
// Prints BALANCE_REPORT_FLAGS_PROOF_PASS on success.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const name = `crx-balance-flags-${process.pid}`;
let created = false;
const candidate = '20261104120000_balance_reports_flag_unrebuildable_customers.sql';
const baseline = path.join(root, 'supabase/baselines');
const skippedStorage = new Set(['20260914100700_customer_document_bytes_server_only.sql', '20261015230000_staff_photo_storage_access.sql', '20261016030000_staff_photo_buckets_private.sql']);
const ledgerOnly = new Set(['20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql', '20261007150200_release_reservations_of_deleted_spring_orders.sql']);
const ADMIN = '7a5a0000-0000-4000-8000-000000000001';
const REP = '7a5a0000-0000-4000-8000-000000000002';
const AGING_OLD_COLS = 'customer_id, farm_name, current_amount, days_30, days_60, days_90, over_90, total_outstanding, prepay_balance_cents, open_credit_cents';
const LISTING_OLD_COLS = 'customer_id, farm_name, total_invoiced, total_paid, prepay_applied, outstanding_balance, open_credit, invoice_count, oldest_unpaid_date';
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
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 64*1024*1024 });
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
    // Its postcondition needs live's Main Warehouse row, which the schema-only baseline lacks.
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') sql("INSERT INTO public.warehouses (name, is_active, is_default) VALUES ('Main Warehouse', true, true) ON CONFLICT (name) DO NOTHING;");
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
// A report's rows as JSON sorted by customer.
const rows = (user, fn, date, cols) =>
  asUser(user, `SELECT COALESCE(json_agg(r ORDER BY r.customer_id), '[]') FROM (SELECT ${cols} FROM public.${fn}(${date})) r;`).stdout.trim();
const aging = (date, cols = AGING_OLD_COLS) => rows(ADMIN, 'get_ar_aging', date, cols);
const listing = (date, cols = LISTING_OLD_COLS, user = ADMIN) => rows(user, 'get_customer_balance_listing', date, cols);
function invoice(customer, number, type, day, dueDay, cents, salesman = ADMIN) {
  // Two statements: an UPDATE cannot see a row inserted by the same statement's CTE.
  return `INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id)
      VALUES ('[PROVER]-${number}', '${customer}', '${type}', 'draft', ${TODAY} - ${day}, ${dueDay === null ? 'NULL' : `${TODAY} - ${dueDay}`}, ${cents}, '${ADMIN}', '${salesman}');
    UPDATE public.invoices SET status = 'posted', posted_at = (${TODAY} - ${day})::timestamp AT TIME ZONE 'America/Chicago' WHERE invoice_number = '[PROVER]-${number}';`;
}
function fails(r, re, what) {
  assert.notEqual(r.status, 0, `${what} should fail`);
  assert.match(r.stderr, re, `${what}: ${r.stderr}`);
}
const BLANK_AGING = { current_amount: null, days_30: null, days_60: null, days_90: null, over_90: null, total_outstanding: null, prepay_balance_cents: null, open_credit_cents: null };
const BLANK_LISTING = { total_invoiced: null, total_paid: null, prepay_applied: null, outstanding_balance: null, open_credit: null, invoice_count: null, oldest_unpaid_date: null };

try {
  console.log(`Building own isolated container ${name}`);
  build();
  sql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'balance-flags-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
    ('${REP}', 'balance-flags-rep@example.invalid', '{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb);`);
  sql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    UPDATE public.profiles SET role = 'sales_rep', is_active = true WHERE id = '${REP}';
    SET session_replication_role = origin;`, 'supabase_admin');
  const C = {
    g1: '7a5a0000-0000-4000-8000-0000000000a1', g2: '7a5a0000-0000-4000-8000-0000000000a2',
    bad: '7a5a0000-0000-4000-8000-0000000000b1', post: '7a5a0000-0000-4000-8000-0000000000b2',
  };
  sql(Object.entries(C).map(([k, id]) => `INSERT INTO public.customers (id, farm_name, account_number, is_active) VALUES ('${id}', '[PROVER] ${k}', '[PROVER]-${k}', true);`).join('\n'));
  sql([
    invoice(C.g1, 'G1-OLD', 'chemical_sale', 130, 125, 20000),
    invoice(C.g1, 'G1-NEW', 'chemical_sale', 10, null, 5000),
    invoice(C.g2, 'G2-A', 'chemical_sale', 70, 60, 10000, REP),
    invoice(C.g2, 'G2-CM', 'credit_memo', 60, null, -2000),
    invoice(C.bad, 'BAD-A', 'chemical_sale', 80, 75, 5000),
    invoice(C.post, 'POST-A', 'chemical_sale', 90, 85, 7000),
  ].join('\n'));

  // BEFORE (old functions), while every customer can still be rebuilt.
  const oldAgingPast = JSON.parse(aging(PAST));
  const oldListingPast = JSON.parse(listing(PAST));
  assert.deepEqual(oldAgingPast.map(r => r.customer_id).sort(), Object.values(C).sort(), `aging fixture: ${JSON.stringify(oldAgingPast)}`);
  assert.deepEqual(oldListingPast.map(r => r.customer_id).sort(), Object.values(C).sort(), `listing fixture: ${JSON.stringify(oldListingPast)}`);

  // The "post" customer's invoice: posted and unposted recorded at the same moment before the past
  // date (so that date's posting state is unknowable), then posted again after it (so today is fine).
  sql(`INSERT INTO public.financial_audit_log (operation_type, entity_type, entity_id, actor_user_id, actor_role, description, created_at)
       SELECT v.op, 'invoice', i.id, '${ADMIN}', 'admin', '[PROVER] posting history', v.at
         FROM public.invoices i
        CROSS JOIN (VALUES
          ('invoice_posted',   (${PAST} - 5)::timestamp AT TIME ZONE 'America/Chicago'),
          ('invoice_unposted', (${PAST} - 5)::timestamp AT TIME ZONE 'America/Chicago'),
          ('invoice_posted',   (${PAST} + 1)::timestamp AT TIME ZONE 'America/Chicago')) v(op, at)
        WHERE i.invoice_number = '[PROVER]-POST-A';`);
  // Gap 1: the old AR aging flags the three other codes, but this one still fails it for everyone.
  fails(asUser(ADMIN, `SELECT count(*) FROM public.get_ar_aging(${PAST});`, true), /HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE/, 'old aging, posting collision');
  fails(asUser(ADMIN, `SELECT count(*) FROM public.get_customer_balance_listing(${PAST});`, true), /HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE/, 'old listing, posting collision');
  // The bad customer pays by prepay today, after the past date.
  sql(`INSERT INTO public.prepay_credits (customer_id, original_amount_cents, balance_cents, payment_method, reference_number, created_by)
       VALUES ('${C.bad}', 1000, 1000, 'check', '[PROVER]-LATER', '${ADMIN}');`);
  fails(asUser(ADMIN, `SELECT count(*) FROM public.get_customer_balance_listing(${PAST});`, true), /HISTORICAL_(POSTING|BALANCE)_RECONSTRUCTION_UNAVAILABLE/, 'old listing, two bad customers');
  console.log('BEFORE: a posting-timestamp collision fails the whole past-date AR aging; one unrebuildable customer fails the whole listing.');
  const oldAgingToday = aging(TODAY);
  const oldListingToday = listing(TODAY);
  const oldRepListingToday = listing(TODAY, LISTING_OLD_COLS, REP);
  assert.equal(JSON.parse(oldAgingToday).length, 4, oldAgingToday);
  assert.equal(JSON.parse(oldListingToday).length, 4, oldListingToday);
  assert.deepEqual(JSON.parse(oldRepListingToday).map(r => r.customer_id), [C.g2], oldRepListingToday);
  const chain = read('scripts/smoke/smoke-historical-ar-report-cutoffs.sql');
  fails(sql(chain, 'postgres', true), /HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE/, 'chain on old listing');
  console.log('BEFORE: the updated rollback chain fails first on the old listing.');

  const migration = read(`supabase/migrations/${candidate}`);
  sql(`BEGIN;\n${migration}\nCOMMIT;`);
  fails(sql(`BEGIN;\n${migration}\nCOMMIT;`, 'postgres', true), /BALANCE_REPORT_FLAGS_PREFLIGHT/, 're-apply');
  console.log('APPLY: postflight passed (one version each, SECURITY DEFINER, search_path, grants, shape); re-apply refused by the preflight.');

  // (a) Past date: good rows exactly as before, each bad one flagged with its own code and no amounts.
  const strip = ({ unavailable_reason: _reason, ...rest }) => rest;
  const good = (r) => r.customer_id === C.g1 || r.customer_id === C.g2;
  const newAgingPast = JSON.parse(aging(PAST, `${AGING_OLD_COLS}, unavailable_reason`));
  assert.deepEqual(newAgingPast.filter(good).map(strip), oldAgingPast.filter(good), 'good aging rows changed');
  assert.ok(newAgingPast.filter(good).every(r => r.unavailable_reason === null), 'a good customer was flagged');
  assert.deepEqual(newAgingPast.filter(r => !good(r)), [
    { customer_id: C.bad, farm_name: '[PROVER] bad', ...BLANK_AGING, unavailable_reason: 'HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE' },
    { customer_id: C.post, farm_name: '[PROVER] post', ...BLANK_AGING, unavailable_reason: 'HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE' },
  ]);
  const newListingPast = JSON.parse(listing(PAST, `${LISTING_OLD_COLS}, unavailable_reason`));
  assert.deepEqual(newListingPast.filter(good).map(strip), oldListingPast.filter(good), 'good listing rows changed');
  assert.ok(newListingPast.filter(good).every(r => r.unavailable_reason === null), 'a good customer was flagged');
  assert.deepEqual(newListingPast.filter(r => !good(r)), [
    { customer_id: C.bad, farm_name: '[PROVER] bad', ...BLANK_LISTING, unavailable_reason: 'HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE' },
    { customer_id: C.post, farm_name: '[PROVER] post', ...BLANK_LISTING, unavailable_reason: 'HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE' },
  ]);
  console.log('(a) PAST DATE: both reports keep the 2 good customers identical to before and flag the posting-collision and later-prepay customers with every amount blank.');

  // (b) Current date: unchanged, nobody flagged.
  assert.equal(aging(TODAY), oldAgingToday, 'current-date aging changed');
  assert.equal(listing(TODAY), oldListingToday, 'current-date listing changed');
  assert.equal(listing(TODAY, LISTING_OLD_COLS, REP), oldRepListingToday, "a rep's current-date listing changed");
  for (const fn of ['get_ar_aging', 'get_customer_balance_listing']) {
    assert.equal(asUser(ADMIN, `SELECT count(*) FILTER (WHERE unavailable_reason IS NOT NULL) || '/' || count(*) FROM public.${fn}(${TODAY});`).stdout.trim(), '0/4', fn);
  }
  assert.equal(asUser(REP, `SELECT count(*) FILTER (WHERE unavailable_reason IS NOT NULL) || '/' || count(*) FROM public.get_customer_balance_listing(${TODAY});`).stdout.trim(), '0/1');
  console.log('(b) CURRENT DATE: every row and column identical to the old functions (admin and rep); no row flagged.');

  // Access unchanged.
  assert.notEqual(asUser(REP, `SET ROLE authenticated; SELECT count(*) FROM public.get_ar_aging(${PAST});`, true).status, 0, 'a sales rep read AR aging');
  fails(asUser(REP, `SET ROLE authenticated; SELECT count(*) FROM public.get_customer_balance_listing(${PAST});`, true), /Admin access required for historical customer balance report/, 'rep past listing');
  fails(sql(`SET ROLE anon; SELECT count(*) FROM public.get_ar_aging(${PAST});`, 'postgres', true), /permission denied for function get_ar_aging/, 'anon aging');
  fails(sql(`SET ROLE anon; SELECT count(*) FROM public.get_customer_balance_listing(${PAST});`, 'postgres', true), /permission denied for function get_customer_balance_listing/, 'anon listing');
  console.log('ACCESS: reps still cannot run AR aging or a past-date listing; anon has no EXECUTE on either.');

  fails(sql(chain, 'postgres', true), /SMOKE_PASS_ROLLBACK/, 'chain after');
  console.log('CHAIN: smoke-historical-ar-report-cutoffs.sql SMOKE_PASS_ROLLBACK (both reports flag; grants intact).');

  // Any other error from the per-customer check still fails each report (never becomes a flag).
  // One transaction that psql aborts on the error, so the stand-in helper is rolled back.
  for (const fn of ['get_ar_aging', 'get_customer_balance_listing']) {
    fails(asUser(ADMIN, `BEGIN;
      CREATE OR REPLACE FUNCTION public.assert_customer_balance_reconstructable_as_of(p_customer_id uuid, p_as_of_date date)
        RETURNS void LANGUAGE plpgsql AS $f$BEGIN RAISE EXCEPTION 'SOME_OTHER_FAILURE: not a reconstruction refusal'; END$f$;
      SELECT count(*) FROM public.${fn}(${PAST});`, true), /SOME_OTHER_FAILURE/, `${fn} re-raise`);
  }
  assert.match(sql("SELECT prosrc FROM pg_proc WHERE oid = 'public.assert_customer_balance_reconstructable_as_of(uuid,date)'::regprocedure;").stdout, /HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE/, 'stand-in helper was not rolled back');
  console.log('RE-RAISE: an error other than the four refusal codes still fails each report.');

  // MUTATIONS, each in a transaction psql aborts, so nothing sticks.
  const body = migration.split('DO $postflight$')[0].replace(/DO \$preflight\$[\s\S]*?\$preflight\$;/, '');
  // 1. The money query re-reads a flagged customer's invoices (no CASE guard): the collision fails the listing again.
  const unguarded = body.replace(/CASE WHEN (c?i)\.invoice_date > p_as_of_date[^]*?THEN false\s+ELSE (public\.statement_invoice_was_posted_as_of\(\1\.id, \1\.posted_at, p_as_of_date\)) END/g, '$2');
  assert.equal((body.match(/THEN false\s+ELSE public\.statement_invoice_was_posted_as_of/g) || []).length, 4, 'expected four CASE guards');
  assert.notEqual(unguarded, body, 'mutation 1 did not apply');
  fails(asUser(ADMIN, `BEGIN;\n${unguarded}\nSELECT count(*) FROM public.get_customer_balance_listing(${PAST});`, true), /HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE/, 'mutation 1');
  // 2. A flagged customer shown with a today-based balance instead of a flag: the chain catches it.
  const swallow = body
    .replace('WHERE c.id <> ALL (v_unavailable_ids)', '')
    .replace(/(NULL::bigint, NULL::date,\s+u\.code\s+FROM unnest\(v_unavailable_ids, v_unavailable_codes\) AS u\(id, code\)\s+JOIN public\.customers c ON c\.id = u\.id)/, '$1 AND false');
  assert.notEqual(swallow, body, 'mutation 2 did not apply');
  fails(sql(`BEGIN;\n${swallow}\n${chain}`, 'postgres', true), /SMOKE_FAIL: Customer Balance Listing did not flag/, 'mutation 2');
  console.log("MUTATION: removing the money query's guard, or showing a flagged customer's balance, is caught.");
  console.log('BALANCE_REPORT_FLAGS_PROOF_PASS');
} finally {
  if (process.argv.includes('--keep-container')) console.log(`Kept own isolated container ${name}`);
  else if (created) docker(['rm','-f',name],undefined,true);
}
