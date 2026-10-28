/** Disposable PostgreSQL proof. Never connects to production. Requires Docker. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const name = `crx-payment-date-${process.pid}`;
const candidate = '20261028175551_chicago_payment_business_date.sql';
const signature = 'public.allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text)';
const actor = 'ac670000-0000-4000-8000-000000000001';
const customer = 'ac670000-0000-4000-8000-000000000002';
const file = (relative) => readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n');
function docker(args, input, allowFailure = false) {
  const r = spawnSync('docker', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || (!allowFailure && r.status !== 0)) throw new Error(r.error?.message || r.stderr || r.stdout);
  return r;
}
function sql(text, user = 'postgres') {
  return docker(['exec', '-i', name, 'psql', '-U', user, '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], text).stdout.trim();
}
function functionOnly(source) {
  return source.slice(source.indexOf('CREATE OR REPLACE FUNCTION public.allocate_payment('));
}
const old = functionOnly(file('supabase/migrations/20260713060300_harden_allocate_payment_idempotency.sql'));
const fixed = functionOnly(file(`supabase/migrations/${candidate}`));
// Only clock reads are replaced in a disposable function copy. Date conversion,
// replay, period guards, and every financial write execute the migration's real SQL.
function clocked(source) {
  return source.replaceAll('CURRENT_DATE', "(current_setting('crx.proof_clock')::timestamptz AT TIME ZONE current_setting('TimeZone'))::date")
    .replaceAll('now()', "current_setting('crx.proof_clock')::timestamptz");
}
function call(key, date) {
  return `public.allocate_payment(p_customer_id => '${customer}', p_total_cents => 100,
    p_payment_method => 'check', p_idempotency_key => '${key}'${date === undefined ? '' : `, p_payment_date => ${date === null ? 'NULL' : `'${date}'::date`}`})`;
}
function run(body, clock = '2027-01-01 01:00:00+00', uid = actor, timezone = 'UTC') {
  return sql(`BEGIN; SET LOCAL TIME ZONE '${timezone}';
    SELECT set_config('crx.proof_clock','${clock}',true);
    SELECT set_config('request.jwt.claim.sub','${uid}',true);
    SELECT set_config('request.jwt.claims','{"sub":"${uid}","role":"authenticated"}',true);
    SET LOCAL ROLE authenticated;
    ${body}
    ROLLBACK;`);
}
const expectDate = (key, date) => `DO $$ DECLARE r jsonb; d date; BEGIN
  r := ${call(key)};
  SELECT payment_date INTO d FROM public.allocation_sets WHERE id=(r->>'allocation_set_id')::uuid;
  IF d IS DISTINCT FROM '${date}'::date THEN RAISE EXCEPTION 'wrong date: %, expected ${date}', d; END IF;
END $$;`;

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
  // The baseline's platform overlay registers this auth-to-profile trigger.
  // Storage policy restoration is unrelated to the payment path.
  sql('CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();', 'supabase_admin');
  // Expiry must use the same controlled clock as the function copy; otherwise
  // a future year-boundary probe would immediately expire its own real-time key.
  sql(`ALTER TABLE public.idempotency_keys ALTER COLUMN expires_at SET DEFAULT
    coalesce(nullif(current_setting('crx.proof_clock',true),'')::timestamptz,now()) + interval '24 hours';`);
  // auth.uid in this image reads request.jwt.claim.sub, set by run().
  assert.equal(sql(`SELECT md5(replace(prosrc,chr(13),'')) FROM pg_proc WHERE oid='${signature}'::regprocedure`),
    '6a945a2510d8e788d4e6f03c0c6d7563', 'baseline payment body equals current live body');
  assert.match(sql("SELECT pg_get_functiondef('public._guard_idempotency_key_insert()'::regprocedure)"), /allocate_payment_v1/);
  sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${actor}','chicago-payment@example.invalid','{"full_name":"[PROOF] Admin","role":"admin"}');
    UPDATE public.profiles SET role='admin',is_active=true WHERE id='${actor}';
    INSERT INTO public.customers(id,farm_name) VALUES ('${customer}','[PROOF] Chicago payment');`);

  const acl = sql(`SELECT proacl::text FROM pg_proc WHERE oid='${signature}'::regprocedure`);
  sql(file(`supabase/migrations/${candidate}`)); // whole migration, before clock-controlled copies
  assert.equal(sql(`SELECT proacl::text FROM pg_proc WHERE oid='${signature}'::regprocedure`), acl, 'ACL preserved');
  run(`DO $$ DECLARE r jsonb; d date; BEGIN r := ${call('real-clock')};
    SELECT payment_date INTO d FROM public.allocation_sets WHERE id=(r->>'allocation_set_id')::uuid;
    IF d IS DISTINCT FROM (now() AT TIME ZONE 'America/Chicago')::date THEN RAISE EXCEPTION 'real clock mismatch'; END IF;
  END $$;`);
  console.log('PASS: exact candidate runs with real database clock; ACL unchanged');

  sql(clocked(old));
  assert.throws(() => run(expectDate('before', '2026-12-31')), /wrong date: 2027-01-01/);
  console.log('PASS: regression fails before fix on December 31 evening');
  sql(clocked(fixed));
  const boundaries = [
    ['2026-07-02 00:01+00','2026-07-01'], ['2026-07-02 04:59:59+00','2026-07-01'],
    ['2026-07-02 05:00+00','2026-07-02'], ['2026-01-02 05:59:59+00','2026-01-01'],
    ['2026-01-02 06:00+00','2026-01-02'], ['2027-01-01 00:01+00','2026-12-31'],
    ['2027-01-01 05:59:59+00','2026-12-31'], ['2027-01-01 06:00+00','2027-01-01'],
    ['2026-03-08 07:59:59+00','2026-03-08'], ['2026-03-08 08:00+00','2026-03-08'],
    ['2026-11-01 06:59:59+00','2026-11-01'], ['2026-11-01 07:00+00','2026-11-01'],
  ];
  for (const [clock, date] of boundaries) {
    for (const timezone of ['UTC', 'Asia/Tokyo']) run(expectDate('boundary', date), clock, actor, timezone);
  }
  console.log(`PASS: ${boundaries.length * 2} summer/winter, DST, evening and year-boundary cases`);
  for (const date of ['2026-06-15', null]) {
    run(`DO $$ DECLARE r jsonb; d date; BEGIN r := ${call('explicit', date)};
      SELECT payment_date INTO d FROM public.allocation_sets WHERE id=(r->>'allocation_set_id')::uuid;
      IF d IS DISTINCT FROM '${date ?? '2026-12-31'}'::date THEN RAISE EXCEPTION 'explicit/null mismatch %',d; END IF;
    END $$;`);
  }
  run(`DO $$ DECLARE first_result jsonb; second_result jsonb; BEGIN
    first_result := ${call('retry')};
    PERFORM set_config('crx.proof_clock','2027-01-01 06:01+00',true);
    second_result := ${call('retry')};
    IF first_result IS DISTINCT FROM second_result THEN RAISE EXCEPTION 'retry changed result'; END IF;
    IF (SELECT count(*) FROM allocation_sets WHERE customer_id='${customer}') <> 1 THEN RAISE EXCEPTION 'duplicate payment'; END IF;
    IF (SELECT payment_date FROM allocation_sets WHERE id=(first_result->>'allocation_set_id')::uuid) <> '2026-12-31'::date THEN RAISE EXCEPTION 'retry changed date'; END IF;
    BEGIN PERFORM ${call('retry', '2027-01-02')}; RAISE EXCEPTION 'missed mismatch';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN RAISE; END IF; END;
    BEGIN PERFORM ${call('retry').replace('p_total_cents => 100', 'p_total_cents => 101')}; RAISE EXCEPTION 'missed amount mismatch';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN RAISE; END IF; END;
  END $$;`);
  console.log('PASS: explicit date, NULL default, midnight replay and changed-date refusal');

  // Seed an old v1 request using the original function, then replace it within
  // the same disposable transaction to exercise an in-flight deployment retry.
  sql(`BEGIN; SELECT set_config('request.jwt.claim.sub','${actor}',true);
    SELECT set_config('crx.proof_clock','2026-12-31 23:00+00',true);
    ${clocked(old)}
    SELECT ${call('legacy-retry')};
    ${clocked(fixed)}
    SELECT set_config('crx.proof_clock','2027-01-01 06:01+00',true);
    SET LOCAL ROLE authenticated;
    SELECT ${call('legacy-retry')};
    DO $$ BEGIN
      IF (SELECT count(*) FROM allocation_sets WHERE customer_id='${customer}') <> 1 THEN RAISE EXCEPTION 'legacy duplicate'; END IF;
      IF (SELECT payment_date FROM allocation_sets WHERE customer_id='${customer}') <> '2026-12-31'::date THEN RAISE EXCEPTION 'legacy date changed'; END IF;
    END $$;
    ROLLBACK;`);
  console.log('PASS: pre-migration v1 request replays after default change');
  // Preserve the pre-existing current-season behavior; changing prepay season
  // allocation is a separate business rule, outside this date-default fix.
  run(`DO $$ DECLARE r jsonb; BEGIN r := ${call('season-scope')};
    IF NOT EXISTS (SELECT 1 FROM allocation_sets WHERE id=(r->>'allocation_set_id')::uuid
      AND payment_date='2026-09-30'::date AND season=2027) THEN RAISE EXCEPTION 'season scope changed'; END IF;
  END $$;`, '2026-10-01 01:00+00');
  console.log('PASS: existing current-season rule preserved (separate deferred boundary issue)');
  for (const [index, role] of ['sales_rep', 'driver', 'applicator'].entries()) {
    const roleActor = `ac670000-0000-4000-8000-00000000000${index + 3}`;
    sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
      ('${roleActor}','${role}@example.invalid','{"full_name":"[PROOF] ${role}","role":"${role}"}');
      SELECT set_config('request.jwt.claim.sub','${actor}',false);
      UPDATE public.profiles SET role='${role}',is_active=true WHERE id='${roleActor}';`);
    if (role === 'sales_rep') run(expectDate('role', '2026-12-31'), undefined, roleActor);
    else assert.throws(() => run(`SELECT ${call('role')};`, undefined, roleActor), /Not authorized to allocate payments/);
  }
  console.log('PASS: admin/rep succeed; driver/applicator remain refused');
  sql(`INSERT INTO public.accounting_periods(period_start,period_end,status) VALUES ('2026-12-01','2026-12-31','closed');`);
  assert.throws(() => run(`SELECT ${call('closed')};`), /falls in closed accounting period/);
  assert.equal(sql(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='closed'`), '0');
  assert.equal(sql(`SELECT count(*) FROM public.allocation_sets WHERE customer_id='${customer}'`), '0');
  console.log('PASS: Chicago closed period rejects with no payment or replay-key side effects');
  console.log('CHICAGO_PAYMENT_DATE_PROOF_PASS');
} finally {
  docker(['rm', '-f', name], undefined, true);
}
