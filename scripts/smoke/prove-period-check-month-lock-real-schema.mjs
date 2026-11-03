#!/usr/bin/env node
// KI-19 + KI-95 (payment half) proof for 20261103170000_period_check_takes_month_lock on a disposable,
// network-disabled PostgreSQL 17 built from the checked-in production baseline plus every migration
// before the candidate. No live URLs or writes. Two real psql sessions race a real month close
// (close_accounting_period) against a real payment (allocate_payment). Proves, fail-first:
//   BEFORE: a payment recorded while a close is in flight lands in the closed month, and a close does
//           not wait for an in-flight payment; a payment dated tomorrow is accepted.
//   AFTER:  (1) close first: the payment waits, then is refused; (2) payment first: the close waits
//           for it; (3) a close of another month does not hold up a payment today; (4) today's and
//           undated payments work, tomorrow's is refused; (5) a closed month refuses; anon has no EXECUTE.
// Run: node scripts/smoke/prove-period-check-month-lock-real-schema.mjs   (needs Docker)
// Prints PERIOD_LOCK_PROOF_PASS on success.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const name = `crx-period-lock-${process.pid}`;
let created = false;
const candidate = '20261103170000_period_check_takes_month_lock.sql';
const baseline = path.join(root, 'supabase/baselines');
const skippedStorage = new Set(['20260914100700_customer_document_bytes_server_only.sql', '20261015230000_staff_photo_storage_access.sql', '20261016030000_staff_photo_buckets_private.sql']);
const ledgerOnly = new Set(['20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql', '20261007150200_release_reservations_of_deleted_spring_orders.sql']);
const ADMIN = '7a5a0000-0000-4000-8000-000000000001';
const TODAY = "(now() AT TIME ZONE 'America/Chicago')::date";

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
    // The schema-only baseline has no seed rows; KI-85's postflight requires live's Main Warehouse.
    if (base === '20261102220000_receive_po_items_active_warehouse_only.sql') sql(`INSERT INTO public.warehouses (name, code, is_active, is_default) VALUES ('Main Warehouse', 'MW', true, true) ON CONFLICT (name) DO NOTHING;`);
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
const userSql = (user, query) => `SET request.jwt.claims = '{"sub":"${user}","role":"authenticated"}';\n${query}`;
// Runs each statement as `user` in one background psql session; resolves to {status, stdout, stderr}.
// Statements go in as -c arguments, not stdin: the foreground spawnSync blocks the event loop, so a
// stdin write could stall before COMMIT and deadlock the race.
function background(user, statements) {
  const args = ['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  for (const s of [userSql(user, ''), ...statements]) args.push('-c', s);
  const child = spawn('docker', args, { cwd: root });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  return new Promise(resolve => child.on('close', status => resolve({ status, stdout, stderr })));
}
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const HOLD_SECONDS = 4;
let keyNo = 0;
const key = (tag) => `[PROVER]-ki19-${tag}-${process.pid}-${++keyNo}`;
const pay = (date, tag) => `SELECT public.allocate_payment('${CUST}', 1000, 'check', '${key(tag)}', NULL, ${date}, NULL, '[]'::jsonb, NULL, '${key(tag)}');`;
const closeSql = (periodEnd, tag) => `SELECT public.close_accounting_period(${periodEnd}, NULL, '${key(tag)}');`;
const paymentsOn = (date) => Number(sql(`SELECT count(*) FROM public.allocation_sets WHERE customer_id = '${CUST}' AND payment_date = ${date};`).stdout.trim());
const reopenAll = () => sql(`UPDATE public.accounting_periods SET status = 'open' WHERE status = 'closed';`);

// A month close is held open for HOLD_SECONDS while a payment dated in that month is recorded.
async function raceCloseFirst(periodEnd, payDate, tag) {
  const held = background(ADMIN, ['BEGIN', closeSql(periodEnd, tag), `SELECT pg_sleep(${HOLD_SECONDS})`, 'COMMIT']);
  pause(1000);
  const t0 = Date.now();
  const writer = asUser(ADMIN, pay(payDate, tag), true);
  const waitedMs = Date.now() - t0;
  const close = await held;
  assert.equal(close.status, 0, `close: ${close.stderr}`);
  return { writer, waitedMs };
}
// A payment is held open for HOLD_SECONDS while the month is closed.
async function raceWriterFirst(periodEnd, payDate, tag) {
  const held = background(ADMIN, ['BEGIN', pay(payDate, tag), `SELECT pg_sleep(${HOLD_SECONDS})`, 'COMMIT']);
  pause(1000);
  const t0 = Date.now();
  const close = asUser(ADMIN, closeSql(periodEnd, tag), true);
  const waitedMs = Date.now() - t0;
  const writer = await held;
  assert.equal(close.status, 0, `close: ${close.stderr}`);
  return { writer, waitedMs };
}

const CUST = '7a5a0000-0000-4000-8000-0000000000c1';
// Last day of the previous Chicago month (closable), a day inside it, and the month before that.
const LAST_END = `(${TODAY} - extract(day FROM ${TODAY})::integer)`;
const LAST_DAY = `(${LAST_END} - 1)`;
const PRIOR_END = `(date_trunc('month', ${LAST_END})::date - 1)`;

try {
  console.log(`Building own isolated container ${name}`);
  build();
  sql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${ADMIN}', 'ki19-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb);`);
  sql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    SET session_replication_role = origin;`, 'supabase_admin');
  sql(`INSERT INTO public.customers (id, farm_name, account_number, is_active) VALUES ('${CUST}', '[PROVER] ki19', '[PROVER]-ki19', true);`);
  sql(`DELETE FROM public.accounting_periods;`);

  // BEFORE (old bodies): both races let a payment land in a month that ends up closed.
  let r = await raceCloseFirst(LAST_END, LAST_DAY, 'old-close-first');
  assert.equal(r.writer.status, 0, `old writer should slip in: ${r.writer.stderr}`);
  assert.ok(r.waitedMs < 2500, `old writer should not wait (${r.waitedMs} ms)`);
  assert.equal(paymentsOn(LAST_DAY), 1);
  console.log(`BEFORE close-first: the payment did not wait (${r.waitedMs} ms) and was recorded inside the month being closed.`);
  reopenAll();
  r = await raceWriterFirst(LAST_END, LAST_DAY, 'old-writer-first');
  assert.equal(r.writer.status, 0, r.writer.stderr);
  assert.ok(r.waitedMs < 2500, `old close should not wait (${r.waitedMs} ms)`);
  console.log(`BEFORE writer-first: the close did not wait for the in-flight payment (${r.waitedMs} ms).`);
  reopenAll();
  const oldFuture = asUser(ADMIN, pay(`(${TODAY} + 1)`, 'old-future'), true);
  assert.equal(oldFuture.status, 0, `old body should accept a future date: ${oldFuture.stderr}`);
  console.log('BEFORE: a payment dated tomorrow (Central) was accepted.');
  sql(`DELETE FROM public.accounting_periods;`);

  sql(`BEGIN;\n${read(`supabase/migrations/${candidate}`)}\nCOMMIT;`);
  const reapply = sql(`BEGIN;\n${read(`supabase/migrations/${candidate}`)}\nCOMMIT;`, 'postgres', true);
  assert.match(reapply.stderr, /PERIOD_LOCK_PREFLIGHT/, `re-apply must be refused by the preflight pin: ${reapply.stderr}`);
  console.log('APPLY: postflight passed (bodies = pinned live bodies + one block each; owner, grants, security unchanged); re-apply refused.');

  // (1) Close first: the payment waits for the close, then is refused.
  const before = paymentsOn(LAST_DAY);
  r = await raceCloseFirst(LAST_END, LAST_DAY, 'new-close-first');
  assert.notEqual(r.writer.status, 0, 'payment slipped into the closed month');
  assert.match(r.writer.stderr, /falls in closed accounting period/, r.writer.stderr);
  assert.ok(r.waitedMs >= (HOLD_SECONDS - 1) * 1000, `payment should have waited for the close (${r.waitedMs} ms)`);
  assert.equal(paymentsOn(LAST_DAY), before);
  console.log(`(1) CLOSE FIRST: the payment waited ${r.waitedMs} ms for the close, then was refused ("falls in closed accounting period"); nothing written.`);
  reopenAll();

  // (2) Payment first: the close waits until the payment commits, so the payment is in before the close.
  r = await raceWriterFirst(LAST_END, LAST_DAY, 'new-writer-first');
  assert.equal(r.writer.status, 0, r.writer.stderr);
  assert.ok(r.waitedMs >= (HOLD_SECONDS - 1) * 1000, `close should have waited for the payment (${r.waitedMs} ms)`);
  console.log(`(2) PAYMENT FIRST: the close waited ${r.waitedMs} ms for the in-flight payment to commit before closing.`);
  reopenAll();
  sql(`DELETE FROM public.accounting_periods;`);

  // (3) A close of a different month does not hold up a payment in an open month.
  r = await raceCloseFirst(PRIOR_END, TODAY, 'new-other-month');
  assert.equal(r.writer.status, 0, r.writer.stderr);
  assert.ok(r.waitedMs < 2500, `payment in an open month waited on another month's close (${r.waitedMs} ms)`);
  console.log(`(3) OTHER MONTH: a payment dated today went through in ${r.waitedMs} ms while an older month was being closed.`);

  // (4) Normal payments in an open month still work; a future date is refused.
  assert.equal(asUser(ADMIN, pay('NULL', 'new-omitted')).status, 0);
  assert.equal(asUser(ADMIN, pay(TODAY, 'new-today')).status, 0);
  const future = asUser(ADMIN, pay(`(${TODAY} + 1)`, 'new-future'), true);
  assert.match(future.stderr, /PAYMENT_DATE_IN_FUTURE/, future.stderr);
  assert.equal(paymentsOn(`(${TODAY} + 1)`), 1, 'only the BEFORE payment may be dated tomorrow');
  console.log('(4) TODAY / NO DATE: recorded. TOMORROW: refused with PAYMENT_DATE_IN_FUTURE.');

  // (5) A closed month still refuses with no race at all.
  const closedDirect = asUser(ADMIN, pay(PRIOR_END, 'new-closed'), true);
  assert.match(closedDirect.stderr, /falls in closed accounting period/, closedDirect.stderr);
  console.log('(5) CLOSED MONTH: a payment dated in it is refused.');

  // Grants unchanged; anon still cannot call either function.
  for (const fn of ['check_period_open(current_date)', `allocate_payment('${CUST}', 1, 'check')`]) {
    const anon = sql(`SET ROLE anon; SELECT public.${fn};`, 'postgres', true);
    assert.match(anon.stderr, /permission denied for function/, anon.stderr);
  }
  console.log('ACCESS: anon has no EXECUTE on check_period_open or allocate_payment.');
  console.log('PERIOD_LOCK_PROOF_PASS');
} finally {
  if (process.argv.includes('--keep-container')) console.log(`Kept own isolated container ${name}`);
  else if (created) docker(['rm','-f',name],undefined,true);
}
