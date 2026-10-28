/** Disposable PostgreSQL proof. Never connects to production. Requires Docker. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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
const expectSeason = (key, date, season, explicitDate) => `DO $$ DECLARE r jsonb; BEGIN
  r := ${call(key, explicitDate)};
  IF NOT EXISTS (SELECT 1 FROM public.allocation_sets
    WHERE id=(r->>'allocation_set_id')::uuid AND payment_date='${date}'::date AND season=${season})
    THEN RAISE EXCEPTION 'wrong payment date or season, expected ${date}/${season}'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.prepay_credits
    WHERE allocation_set_id=(r->>'allocation_set_id')::uuid AND season=${season}
      AND original_amount_cents=100 AND balance_cents=100)
    THEN RAISE EXCEPTION 'wrong prepay season or amount, expected ${season}'; END IF;
END $$;`;

function session(input) {
  const child = spawn('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { cwd: root, stdio: 'pipe', windowsHide: true });
  const result = { child, stdout: '', stderr: '', closed: false, code: null };
  child.stdout.on('data', (data) => { result.stdout += data; });
  child.stderr.on('data', (data) => { result.stderr += data; });
  result.done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => { result.closed = true; result.code = code; resolve(); });
  });
  child.stdin.write(input);
  return result;
}
async function until(predicate, message) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function concurrentReplay() {
  const prefix = (application) => `BEGIN; SET LOCAL application_name='${application}';
    SELECT set_config('crx.proof_clock','2027-06-01 12:00+00',true);
    SELECT set_config('request.jwt.claim.sub','${actor}',true);
    SET LOCAL ROLE authenticated;`;
  let winner;
  let contender;
  try {
    winner = session(prefix('crx-date-winner') + `SELECT 'WINNER_RESULT|' || ${call('concurrent-new-key')}::text;\n`);
    await until(() => winner.stdout.includes('WINNER_RESULT|') || winner.closed, 'winner did not produce an uncommitted result');
    assert.ok(!winner.closed, winner.stderr);
    contender = session(prefix('crx-date-contender') + `SELECT 'CONTENDER_RESULT|' || ${call('concurrent-new-key')}::text; COMMIT;\n`);
    contender.child.stdin.end();
    await until(() => sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='crx-date-contender' AND wait_event_type='Lock'") === '1', 'contender never waited on the uncommitted claim');
    assert.ok(!contender.stdout.includes('CONTENDER_RESULT|'), 'contender returned before winner commit');
    winner.child.stdin.end('COMMIT;\n');
    await until(() => winner.closed && contender.closed, 'concurrent sessions did not complete after commit');
    await Promise.all([winner.done, contender.done]);
    assert.equal(winner.code, 0, winner.stderr);
    assert.equal(contender.code, 0, contender.stderr);
    const result = (output, label) => JSON.parse(output.split(/\r?\n/).find((line) => line.startsWith(label)).slice(label.length));
    const first = result(winner.stdout, 'WINNER_RESULT|');
    assert.deepEqual(result(contender.stdout, 'CONTENDER_RESULT|'), first, 'concurrent replay returned a different result');
    assert.equal(sql(`SELECT count(*) FROM allocation_sets WHERE customer_id='${customer}'`), '1');
    assert.equal(sql(`SELECT count(*) FROM prepay_credits WHERE allocation_set_id='${first.allocation_set_id}' AND original_amount_cents=100 AND balance_cents=100 AND season=2027`), '1');
    assert.equal(sql(`SELECT prepay_balance_cents FROM customers WHERE id='${customer}'`), '100');
    console.log('PASS: two synchronized sessions contend on one new marked key; both return one committed payment/prepay result');
  } finally {
    // These are only this proof's disposable sessions. Terminating either one
    // on failure rolls back an uncommitted transaction before container cleanup.
    sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name IN ('crx-date-winner','crx-date-contender')");
    for (const current of [winner, contender]) {
      if (current) { current.child.stdin.end(); await current.done; }
    }
  }
}

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

  // The existing insert trigger also expires replay keys. Its cleanup must
  // share the controlled clock, including past-date season-boundary retries.
  const replayGuard = sql("SELECT pg_get_functiondef('public._guard_idempotency_key_insert()'::regprocedure)");
  sql(clocked(replayGuard));
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

  const expectStrictDateIntent = `DO $$ DECLARE first_result jsonb; BEGIN
    first_result := ${call('strict-date', '2026-06-15')};
    IF ${call('strict-date', '2026-06-15')} IS DISTINCT FROM first_result THEN RAISE EXCEPTION 'same explicit date did not replay'; END IF;
    BEGIN PERFORM ${call('strict-date')}; RAISE EXCEPTION 'missed explicit-to-omitted mismatch';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN RAISE; END IF; END;
    BEGIN PERFORM ${call('strict-date', null)}; RAISE EXCEPTION 'missed explicit-to-null mismatch';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN RAISE; END IF; END;
    BEGIN PERFORM ${call('strict-date', '2026-06-16')}; RAISE EXCEPTION 'missed changed-date mismatch';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN RAISE; END IF; END;
    IF NOT EXISTS (SELECT 1 FROM allocation_sets WHERE id=(first_result->>'allocation_set_id')::uuid
      AND payment_date='2026-06-15'::date) THEN RAISE EXCEPTION 'mismatch changed original date'; END IF;
    IF (SELECT count(*) FROM allocation_sets WHERE customer_id='${customer}') <> 1 THEN RAISE EXCEPTION 'mismatch duplicated payment'; END IF;
  END $$;`;
  // Restore only the reported permissive comparison, proving this regression
  // would fail with the prior candidate while the rest of the fix stays intact.
  const legacyOnly = "AND NOT (v_idem_row.result ? '_date_intent_version')";
  assert.ok(fixed.includes(legacyOnly));
  sql(clocked(fixed.replace(legacyOnly, '')));
  assert.throws(() => run(expectStrictDateIntent), /missed explicit-to-omitted mismatch/);
  sql(clocked(fixed));
  run(expectStrictDateIntent + `RESET ROLE; DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE idempotency_key='strict-date'
      AND result->>'_contract'='allocate_payment_v1' AND result->>'_date_intent_version'='1'
      AND result->'response'->>'success'='true') THEN RAISE EXCEPTION 'new envelope marker or result missing'; END IF;
  END $$;`);
  run(`DO $$ DECLARE first_result jsonb; BEGIN
    first_result := ${call('automatic-date')};
    IF ${call('automatic-date', null)} IS DISTINCT FROM first_result THEN RAISE EXCEPTION 'NULL and omitted default diverged'; END IF;
    BEGIN PERFORM ${call('automatic-date', '2026-12-31')}; RAISE EXCEPTION 'missed omitted-to-explicit mismatch';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN RAISE; END IF; END;
  END $$;`);
  console.log('PASS: strict new-key date intent; prior comparison fails; same explicit and omitted/NULL retries replay');

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
  sql(`BEGIN; SELECT set_config('request.jwt.claim.sub','${actor}',true);
    SELECT set_config('crx.proof_clock','2026-12-31 23:00+00',true);
    ${clocked(old)}
    SELECT ${call('legacy-explicit', '2026-06-15')};
    ${clocked(fixed)}
    SET LOCAL ROLE authenticated;
    SELECT ${call('legacy-explicit', '2026-06-15')};
    SELECT ${call('legacy-explicit')};
    DO $$ BEGIN
      IF (SELECT count(*) FROM allocation_sets WHERE customer_id='${customer}') <> 1 THEN RAISE EXCEPTION 'legacy explicit duplicate'; END IF;
      IF (SELECT payment_date FROM allocation_sets WHERE customer_id='${customer}') <> '2026-06-15'::date THEN RAISE EXCEPTION 'legacy explicit date changed'; END IF;
      BEGIN PERFORM ${call('legacy-explicit').replace('p_total_cents => 100', 'p_total_cents => 101')}; RAISE EXCEPTION 'legacy missed amount mismatch';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN RAISE; END IF; END;
    END $$;
    ROLLBACK;`);
  sql(`BEGIN; SELECT set_config('crx.proof_clock','2027-01-01 01:00+00',true);
    INSERT INTO idempotency_keys(idempotency_key,operation,result)
    VALUES ('legacy-bare','allocate_payment','{"success":true,"legacy_receipt":"original"}'::jsonb);
    SELECT set_config('request.jwt.claim.sub','${actor}',true);
    SET LOCAL ROLE authenticated;
    DO $$ BEGIN IF ${call('legacy-bare')} IS DISTINCT FROM '{"success":true,"legacy_receipt":"original"}'::jsonb
      THEN RAISE EXCEPTION 'bare legacy result changed'; END IF;
      IF EXISTS (SELECT 1 FROM allocation_sets WHERE customer_id='${customer}') THEN RAISE EXCEPTION 'bare replay created payment'; END IF;
    END $$; ROLLBACK;`);
  console.log('PASS: older v1 explicit/default keys and bare cached results remain compatible; other arguments still bind');
  // Restore only the old season clock in a disposable mutant: the new season
  // assertion must fail even while the Chicago payment-date default works.
  const seasonBlock = /v_current_season := CASE[\s\S]*?END;/;
  assert.match(fixed, seasonBlock);
  const utcSeason = fixed.replace(seasonBlock, (block) => block.replaceAll('v_business_date', 'CURRENT_DATE'));
  sql(clocked(utcSeason));
  assert.throws(() => run(expectSeason('season-before', '2026-09-30', 2026), '2026-10-01 01:00+00'), /wrong payment date or season/);
  console.log('PASS: old UTC season rule fails the September 30 evening regression');
  sql(clocked(fixed));
  const seasonBoundaries = [
    ['2026-10-01 00:01+00', '2026-09-30', 2026],
    ['2026-10-01 04:59:59+00', '2026-09-30', 2026],
    ['2026-10-01 05:00+00', '2026-10-01', 2027],
    ['2027-01-01 05:59:59+00', '2026-12-31', 2027],
    ['2027-01-01 06:00+00', '2027-01-01', 2027],
  ];
  for (const [clock, date, season] of seasonBoundaries) {
    for (const timezone of ['UTC', 'Asia/Tokyo', 'America/Chicago']) {
      run(expectSeason('season-boundary', date, season), clock, actor, timezone);
    }
  }
  run(expectSeason('backdated', '2026-09-15', 2027, '2026-09-15'), '2026-10-01 05:00+00');
  run(`DO $$ DECLARE first_result jsonb; BEGIN
    first_result := ${call('season-retry')};
    PERFORM set_config('crx.proof_clock','2026-10-01 05:01+00',true);
    IF ${call('season-retry')} IS DISTINCT FROM first_result THEN RAISE EXCEPTION 'season retry changed result'; END IF;
    IF (SELECT count(*) FROM allocation_sets WHERE customer_id='${customer}') <> 1 THEN RAISE EXCEPTION 'season retry duplicated'; END IF;
    IF NOT EXISTS (SELECT 1 FROM allocation_sets WHERE id=(first_result->>'allocation_set_id')::uuid
      AND payment_date='2026-09-30'::date AND season=2026) THEN RAISE EXCEPTION 'season retry changed date or season'; END IF;
    IF NOT EXISTS (SELECT 1 FROM prepay_credits WHERE allocation_set_id=(first_result->>'allocation_set_id')::uuid
      AND season=2026 AND original_amount_cents=100 AND balance_cents=100) THEN RAISE EXCEPTION 'season retry changed prepay'; END IF;
  END $$;`, '2026-10-01 04:59+00');
  console.log('PASS: 15 Chicago season boundaries, allocation/prepay parity, explicit backdate and season-crossing replay');
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
  await concurrentReplay();
  console.log('CHICAGO_PAYMENT_DATE_PROOF_PASS');
} finally {
  docker(['rm', '-f', name], undefined, true);
}
