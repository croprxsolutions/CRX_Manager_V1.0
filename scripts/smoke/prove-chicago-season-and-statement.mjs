/** Disposable PostgreSQL proof. Never connects to production. Requires Docker. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const name = `crx-season-statement-${process.pid}`;
const candidate = '20261102230000_chicago_season_and_statement_dates.sql';
const actor = 'ac680000-0000-4000-8000-000000000001';
const customer = 'ac680000-0000-4000-8000-000000000002';
const file = (relative) => readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n');
function docker(args, input, allowFailure = false) {
  const r = spawnSync('docker', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || (!allowFailure && r.status !== 0)) throw new Error(r.error?.message || r.stderr || r.stdout);
  return r;
}
const sql = (text, user = 'postgres') =>
  docker(['exec', '-i', name, 'psql', '-U', user, '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], text).stdout.trim();

const whole = file(`supabase/migrations/${candidate}`);
const CHI = "(now() AT TIME ZONE 'America/Chicago')::date";
const at = (marker) => whole.indexOf(marker);
const functions = whole.slice(at('CREATE OR REPLACE FUNCTION public.current_season()'), at('ALTER TABLE public.invoices'));
const returnCredit = whole.slice(at('CREATE OR REPLACE FUNCTION public._issue_return_credit_header_only_impl_20260825'));
// The live bodies before this migration: the candidate with its Chicago date
// reads reverted (the preflight digests prove it).
const live = functions
  .replace(CHI, 'CURRENT_DATE')
  .replace("(a.created_at AT TIME ZONE 'America/Chicago')::date", 'a.created_at::date')
  .replace("(pa.applied_at AT TIME ZONE 'America/Chicago')::date", 'pa.applied_at::date');
const liveReturnCredit = returnCredit.replaceAll(CHI, 'CURRENT_DATE');
// Only clock reads are swapped in disposable copies.
const proofNow = "current_setting('crx.proof_clock')::timestamptz";
const clocked = (source) => source
  .replace('CURRENT_DATE);', `(${proofNow} AT TIME ZONE current_setting('TimeZone'))::date);`)
  .replaceAll(CHI, `(${proofNow} AT TIME ZONE 'America/Chicago')::date`);
const clockedLiveReturn = liveReturnCredit.replaceAll('CURRENT_DATE', `(${proofNow} AT TIME ZONE current_setting('TimeZone'))::date`);
const season = (clock, timezone = 'UTC') => sql(`BEGIN; SET LOCAL TIME ZONE '${timezone}';
  SELECT set_config('crx.proof_clock','${clock}',true) \\g /dev/null
  SELECT public.current_season(); ROLLBACK;`);
const statement = (start, end) => sql(`BEGIN;
  SELECT set_config('request.jwt.claim.sub','${actor}',true) \\g /dev/null
  SET LOCAL ROLE authenticated;
  SELECT transaction_date || '|' || transaction_type || '|' || amount_cents
    FROM public.get_customer_statement('${customer}','${start}','${end}');
  ROLLBACK;`).split('\n').filter(Boolean);

try {
  docker(['run', '-d', '--name', name, '--network', 'none', '-e', 'POSTGRES_PASSWORD=postgres',
    'public.ecr.aws/supabase/postgres:17.6.1.143']);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const logs = docker(['logs', name], undefined, true);
    if (`${logs.stdout}\n${logs.stderr}`.includes('PostgreSQL init process complete')
      && docker(['exec', name, 'pg_isready', '-U', 'postgres'], undefined, true).status === 0) { ready = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  assert.ok(ready, 'local PostgreSQL readiness');
  sql(file('supabase/baselines/20260727174805_extensions.sql'));
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(schema.status, 0, schema.stderr);
  sql(schema.stdout);
  sql(file('supabase/baselines/20260727174805_acl_lockdown.sql'));
  sql('CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();', 'supabase_admin');
  sql(live);
  sql(liveReturnCredit);
  sql(`REVOKE ALL ON FUNCTION public._get_customer_statement_scoped_impl(uuid,date,date) FROM PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION public._issue_return_credit_header_only_impl_20260825(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;`);

  // Wrong-body guard, then the exact migration on the live-equivalent state.
  assert.throws(() => sql(`BEGIN; CREATE OR REPLACE FUNCTION public.current_season() RETURNS integer LANGUAGE sql STABLE SET search_path TO 'public' AS $f$ SELECT 1 $f$; ${whole} ROLLBACK;`), /PREFLIGHT_FAIL/);
  const acls = () => sql("SELECT string_agg(proname || proacl::text, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('current_season','_get_customer_statement_scoped_impl','_issue_return_credit_header_only_impl_20260825')");
  const before = acls();
  sql(whole);
  assert.equal(acls(), before, 'grants preserved');
  assert.equal(sql("SELECT public.current_season() = public.compute_season((now() AT TIME ZONE 'America/Chicago')::date)"), 't');
  assert.equal(sql("SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE d.adrelid='public.invoices'::regclass AND a.attname='invoice_date'"),
    "((now() AT TIME ZONE 'America/Chicago'::text))::date", 'invoice_date default is the Chicago date');
  console.log('PASS: exact migration applies on the live bodies, refuses drift, keeps grants');

  // Season: 2026-10-01 00:30 UTC is Sept 30 7:30pm Central (still season 2026).
  sql(clocked(live));
  assert.equal(season('2026-10-01 00:30+00'), '2027', 'old function flips early');
  console.log('PASS: regression reproduces: old season flips to 2027 at 7:30pm Central Sept 30');
  sql(clocked(functions));
  for (const [clock, want] of [
    ['2026-10-01 00:00+00', '2026'], ['2026-10-01 00:30+00', '2026'], ['2026-10-01 04:59:59+00', '2026'],
    ['2026-10-01 05:00+00', '2027'], ['2026-09-30 12:00+00', '2026'], ['2027-01-01 05:59:59+00', '2027'],
  ]) for (const tz of ['UTC', 'Asia/Tokyo']) assert.equal(season(clock, tz), want, `${clock} ${tz}`);
  console.log('PASS: season stays 2026 until midnight Central Sept 30, then 2027 (any session time zone)');

  // Statement: evening Central entries on Oct 31 belong to October.
  sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
      ('${actor}','season-proof@example.invalid','{"full_name":"[PROOF] Admin","role":"admin"}');
    UPDATE public.profiles SET role='admin',is_active=true WHERE id='${actor}';
    INSERT INTO public.customers(id,farm_name) VALUES ('${customer}','[PROOF] Chicago statement');
    SET session_replication_role = replica;
    INSERT INTO public.prepay_credits(id,customer_id,original_amount_cents,balance_cents,season)
      VALUES ('ac680000-0000-4000-8000-000000000003','${customer}',500,200,2026);
    INSERT INTO public.prepay_applications(id,prepay_credit_id,invoice_id,applied_amount_cents,applied_at)
      VALUES ('ac680000-0000-4000-8000-000000000004','ac680000-0000-4000-8000-000000000003',
              gen_random_uuid(),300,'2026-11-01 00:30+00');
    INSERT INTO public.allocation_sets(id,entity_type,entity_id,customer_id,is_active,total_allocated_cents,payment_date,created_at)
      VALUES ('ac680000-0000-4000-8000-000000000005','payment',gen_random_uuid(),'${customer}',true,700,NULL,'2026-11-01 04:59+00');`);
  const october = statement('2026-10-01', '2026-10-31');
  assert.deepEqual(october.sort(), ['2026-10-31|payment|-700', '2026-10-31|prepay|-300']);
  assert.deepEqual(statement('2026-11-01', '2026-11-30'), ['2026-11-01|opening_balance|-1000']);
  sql(live);
  assert.deepEqual(statement('2026-10-01', '2026-10-31'), [], 'old function moved them to November');
  console.log('PASS: 7:30pm/11:59pm Central Oct 31 prepay and payment land in October (old code put them in November)');

  // Return credit at 7:30pm Central Sept 30: date and season must agree.
  sql(`SET session_replication_role = replica;
    INSERT INTO public.returns(id,return_number,customer_id,status,requested_by)
      VALUES ('ac680000-0000-4000-8000-000000000006','RET-PROOF-1','${customer}','received','${actor}');
    INSERT INTO public.return_items(return_id,product_id,quantity,unit_price_cents,extended_cents)
      VALUES ('ac680000-0000-4000-8000-000000000006',gen_random_uuid(),1,1500,1500);`);
  sql(clocked(functions));
  const credit = (body) => {
    sql(body);
    return sql(`BEGIN;
      SELECT set_config('crx.proof_clock','2026-10-01 00:30+00',true) \\g /dev/null
      SELECT set_config('request.jwt.claim.sub','${actor}',true) \\g /dev/null
      SELECT set_config('crx.proof_credit',
        public._issue_return_credit_header_only_impl_20260825('ac680000-0000-4000-8000-000000000006', NULL)->>'credit_invoice_id', true) \\g /dev/null
      SELECT i.invoice_date || '|' || i.season || '|' || i.total_amount_cents FROM public.invoices i
       WHERE i.id = current_setting('crx.proof_credit')::uuid;
      ROLLBACK;`);
  };
  assert.equal(credit(clockedLiveReturn), '2026-10-01|2026|-1500', 'old body pairs a 1 Oct date with the 30 Sept season');
  assert.equal(credit(clocked(returnCredit)), '2026-09-30|2026|-1500');
  console.log('PASS: a return credit at 7:30pm Central Sept 30 is dated Sept 30 in season 2026 (old body: Oct 1 date, Sept 30 season)');
} finally {
  docker(['rm', '-f', name], undefined, true);
}
