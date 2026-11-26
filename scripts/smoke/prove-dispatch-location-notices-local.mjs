import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const lanePath = process.platform === 'win32' ? root.toLowerCase() : root;
process.env.CRX_LOCAL_APP_PROFILE = 'screen-walk';
process.env.CRX_LOCAL_APP_LANE = createHash('sha256').update(lanePath).digest('hex').slice(0, 8);
const target = await import('../local-app/target.mjs');
const { localSql } = await import('../local-app/e2e/local-db.ts');
target.assertCleanEnvironment();
const raw = readFileSync(new URL(`../local-app/${target.STATE_FOLDER}/local.env`, import.meta.url), 'utf8');
const state = Object.fromEntries(raw.split(/\r?\n/).filter(line => line.includes('=') && !line.startsWith('#')).map(line => {
  const equals = line.indexOf('=');
  return [line.slice(0, equals), line.slice(equals + 1)];
}));
target.assertLocalState(state);

const signal = 'DISPATCH_LOCATION_NOTICES_PROOF_PASS';
const result = localSql(readFileSync(new URL('./smoke-dispatch-location-notices.sql', import.meta.url), 'utf8'));
assert.equal(result, signal);

function localSqlInWorker(sql) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.moduleUrl)
        .then(({localSql}) => parentPort.postMessage(localSql(workerData.sql)))
        .catch(error => { throw error; });
    `, { eval: true, workerData: { moduleUrl: new URL('../local-app/e2e/local-db.ts', import.meta.url).href, sql } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error('Local SQL worker exited ' + code)); });
  });
}

async function proveDispatchAndDeactivationOrder(deactivateFirst) {
  const [rep, applicator, farm, field, job, location] = Array.from({ length: 6 }, randomUUID);
  const tag = job.slice(0, 8);
  const fixtureAdmin = localSql("SELECT id FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1;");
  assert.match(fixtureAdmin, /^[0-9a-f-]{36}$/);
  localSql(`
    SET ROLE postgres;
    BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id,email) VALUES ('${rep}','${rep}@fixture.example.test'), ('${applicator}','${applicator}@fixture.example.test');
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
      ('${rep}','${rep}@fixture.example.test','Invented concurrent dispatcher ${tag}','sales_rep',true),
      ('${applicator}','${applicator}@fixture.example.test','Invented concurrent applicator ${tag}','applicator',true);
    INSERT INTO public.customers(id,farm_name) VALUES ('${farm}','Invented concurrency farm ${tag}');
    INSERT INTO public.jobs(id,job_number,customer_id,job_date,status,total_acres)
      VALUES ('${job}','INVENTED-DISPATCH-${tag}','${farm}',CURRENT_DATE,'scheduled',10);
    INSERT INTO public.fields(id,customer_id,field_name,total_acres)
      VALUES ('${field}','${farm}','Invented concurrency field ${tag}',10);
    INSERT INTO public.job_fields(id,job_id,field_id,acres_to_treat)
      VALUES ('${location}','${job}','${field}',10);
    COMMIT;
  `);

  const asRole = (id, sql) => `
    SELECT set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);
    SELECT set_config('request.jwt.claim.sub', '${id}', true);
    SET LOCAL ROLE authenticated;
    ${sql}
    RESET ROLE;`;
  const deactivate = asRole(fixtureAdmin, `
    SELECT public.admin_update_profile('${applicator}', new_is_active => false, p_idempotency_key => '${randomUUID()}');`);
  const dispatch = `PERFORM public.dispatch_location_with_notices('wizard', jsonb_build_array(jsonb_build_object(
    'job_field_id','${location}','applicator_id','${applicator}')), p_idempotency_key => '${randomUUID()}');`;
  const assign = asRole(rep, deactivateFirst ? `
    DO $assign$ BEGIN
      ${dispatch}
      RAISE EXCEPTION 'Concurrent deactivation did not prevent dispatch';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'INVALID_APPLICATOR:%' THEN RAISE; END IF;
    END $assign$;` : `DO $assign$ BEGIN ${dispatch} END $assign$;`);

  const firstClient = `dispatch-proof-holder-${tag}`;
  const readyClient = `${firstClient}-ready`;
  const secondClient = `dispatch-proof-waiter-${tag}`;
  const first = localSqlInWorker(`
    SET ROLE postgres;
    SET application_name = '${firstClient}';
    BEGIN;
    ${deactivateFirst ? deactivate : assign}
    SET LOCAL application_name = '${readyClient}';
    DO $wait$
    DECLARE deadline timestamptz := clock_timestamp() + interval '45 seconds';
    BEGIN
      LOOP
        PERFORM pg_stat_clear_snapshot();
        EXIT WHEN EXISTS (SELECT FROM pg_stat_activity a WHERE a.application_name = '${secondClient}'
          AND pg_backend_pid() = ANY(pg_blocking_pids(a.pid)));
        IF clock_timestamp() >= deadline THEN RAISE EXCEPTION 'Second operation never waited for the first'; END IF;
        PERFORM pg_sleep(0.05);
      END LOOP;
    END
    $wait$;
    COMMIT;`);
  // Attach the rejection handler before polling the barrier.
  first.catch(() => {});
  const startDeadline = Date.now() + 30_000;
  let ready = false;
  while (!ready && Date.now() < startDeadline) {
    ready = localSql(`SELECT EXISTS (SELECT FROM pg_stat_activity WHERE application_name = '${readyClient}');`) === 't';
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'First local operation did not reach its lock');
  await Promise.all([first, localSqlInWorker(`
    SET ROLE postgres;
    SET application_name = '${secondClient}';
    BEGIN;
    ${deactivateFirst ? assign : deactivate}
    COMMIT;`)]);
  const expected = deactivateFirst ? '0|0|f' : '1|1|f';
  assert.equal(localSql(`
    SELECT (SELECT count(*) FROM public.job_location_dispatches WHERE job_field_id = '${location}')::text
      || '|' || (SELECT count(*) FROM public.notifications WHERE related_entity_id = '${job}' AND user_id = '${applicator}' AND created_by = '${rep}')::text
      || '|' || (SELECT CASE WHEN is_active THEN 't' ELSE 'f' END FROM public.profiles WHERE id = '${applicator}');
  `), expected);
}

await proveDispatchAndDeactivationOrder(true);
await proveDispatchAndDeactivationOrder(false);
console.log(signal);
