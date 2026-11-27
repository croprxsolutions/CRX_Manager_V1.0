import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const lane = process.platform === 'win32' ? root.toLowerCase() : root;
process.env.CRX_LOCAL_APP_PROFILE = 'screen-walk';
process.env.CRX_LOCAL_APP_LANE = createHash('sha256').update(lane).digest('hex').slice(0, 8);
const target = await import('../local-app/target.mjs');
target.assertCleanEnvironment();
const env = readFileSync(new URL('../local-app/' + target.STATE_FOLDER + '/local.env', import.meta.url), 'utf8');
const state = Object.fromEntries(env.split(/\r?\n/).filter(line => line.includes('=') && !line.startsWith('#')).map(line => {
  const equals = line.indexOf('=');
  return [line.slice(0, equals), line.slice(equals + 1)];
}));
target.assertLocalState(state);
const { localSql } = await import('../local-app/e2e/local-db.ts');

const rollbackSignal = 'LOCAL_DELIVERY_COMPLETION_MIGRATION_FIRST_CASES_PASS';
assert.equal(localSql(readFileSync(new URL('./smoke-delivery-completion-notice.sql', import.meta.url), 'utf8')), rollbackSignal);
console.log(rollbackSignal);

function localSqlInWorker(sql) {
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(
      "const { parentPort, workerData } = require('node:worker_threads');\n"
      + "import(workerData.moduleUrl).then(({ localSql }) => parentPort.postMessage(localSql(workerData.sql)))\n"
      + ".catch(error => { throw error; });",
      { eval: true, workerData: { sql, moduleUrl: new URL('../local-app/e2e/local-db.ts', import.meta.url).href } },
    );
    worker.once('message', resolveResult);
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error('Local SQL worker exited ' + code));
    });
  });
}

async function proveRace(useSameKey) {
  const [actor, customer, order, delivery, receipt, firstKey, differentKey] = Array.from({ length: 7 }, randomUUID);
  const tag = delivery.slice(0, 8);
  const savedKey = 'invented-completion-' + tag;
  const secondKey = useSameKey ? firstKey : differentKey;
  const holder = 'dc-alert-holder-' + tag;
  const ready = 'dc-alert-ready-' + tag;
  const waiter = 'dc-alert-waiter-' + tag;
  const workers = [];
  try {
    // The separate rollback smoke proves a real save. This private local fixture gives both
    // database sessions the same committed event without leaving any invoice or stock changes.
    localSql(`
      BEGIN;
      INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
        ('${actor}','${actor}@fixture.example.test',jsonb_build_object('full_name','Invented Notice Race Rep ${tag}','role','sales_rep'));
      INSERT INTO public.customers(id,farm_name) VALUES ('${customer}','Invented Notice Race Farm ${tag}');
      INSERT INTO public.orders(id,order_number,customer_id,status)
        VALUES ('${order}','INVENTED-NOTICE-RACE-${tag}','${customer}','confirmed');
      SET LOCAL session_replication_role = replica;
      INSERT INTO public.deliveries(id,delivery_number,order_id,customer_id,created_by,status,scheduled_date)
        VALUES ('${delivery}','INVENTED-NOTICE-RACE-${tag}','${order}','${customer}','${actor}','completed',current_date);
      SET LOCAL session_replication_role = origin;
      INSERT INTO public.idempotency_keys(id,idempotency_key,operation,result,request_actor_id,request_fingerprint)
        VALUES ('${receipt}','${savedKey}','complete_delivery',jsonb_build_object('status','completed','delivery_id','${delivery}'),
          '${actor}',public._replay_fingerprint_20261015(jsonb_build_object('delivery_id','${delivery}')));
      WITH event AS (
        INSERT INTO public.delivery_brand_events(delivery_id,event_type,actor)
          VALUES ('${delivery}','completed','${actor}') RETURNING seq
      )
      INSERT INTO public.delivery_completion_notice_events(completion_seq,receipt_id,receipt_operation,sender_role,show_partial)
        SELECT seq,'${receipt}','complete_delivery','sales_rep',false FROM event;
      COMMIT;`);

    const send = request => `
      DO $actor$
      BEGIN
        PERFORM set_config('request.jwt.claim.sub','${actor}',true);
        PERFORM set_config('request.jwt.claims',jsonb_build_object('sub','${actor}','role','authenticated')::text,true);
      END;
      $actor$;
      SET LOCAL ROLE authenticated;
      SELECT public.notify_saved_delivery_completion('${delivery}','${savedKey}','${request}') ->> 'status';
      RESET ROLE;`;
    const first = localSqlInWorker(`
      SET application_name = '${holder}';
      BEGIN;
      ${send(firstKey)}
      SET LOCAL application_name = '${ready}';
      DO $wait$
      DECLARE deadline timestamptz := clock_timestamp() + interval '45 seconds';
      BEGIN
        LOOP
          PERFORM pg_stat_clear_snapshot();
          EXIT WHEN EXISTS (SELECT FROM pg_stat_activity WHERE application_name = '${waiter}'
            AND pg_backend_pid() = ANY (pg_blocking_pids(pid)));
          IF clock_timestamp() >= deadline THEN RAISE EXCEPTION 'Concurrent notice request never waited'; END IF;
          PERFORM pg_sleep(0.05);
        END LOOP;
      END;
      $wait$;
      COMMIT;`);
    workers.push(first);
    first.catch(() => {});
    const readyDeadline = Date.now() + 30_000;
    while (localSql("SELECT EXISTS (SELECT FROM pg_stat_activity WHERE application_name = '" + ready + "');") !== 't') {
      assert(Date.now() < readyDeadline, 'First notice request did not finish its send');
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }

    const second = localSqlInWorker(`
      SET application_name = '${waiter}';
      BEGIN;
      ${send(secondKey)}
      COMMIT;`);
    workers.push(second);
    assert.deepEqual(await Promise.all(workers), ['sent', 'sent']);
    assert.equal(localSql(`
      SELECT NOT EXISTS (
        SELECT id FROM public.profiles WHERE role = 'admin' AND is_active
        EXCEPT ALL
        SELECT user_id FROM public.notifications WHERE related_entity_id = '${delivery}'
          AND notification_type = 'delivery_completed' AND created_by = '${actor}'
      ) AND NOT EXISTS (
        SELECT user_id FROM public.notifications WHERE related_entity_id = '${delivery}'
          AND notification_type = 'delivery_completed' AND created_by = '${actor}'
        EXCEPT ALL
        SELECT id FROM public.profiles WHERE role = 'admin' AND is_active
      );`), 't', 'The concurrent requests must leave exactly one notice per eligible admin');
  } finally {
    await Promise.allSettled(workers);
    localSql(`
      BEGIN;
      DELETE FROM public.notifications WHERE related_entity_id = '${delivery}';
      DELETE FROM public.delivery_completion_notice_claims WHERE completion_seq IN (
        SELECT seq FROM public.delivery_brand_events WHERE delivery_id = '${delivery}');
      DELETE FROM public.delivery_completion_notice_events WHERE receipt_id = '${receipt}';
      DELETE FROM public.idempotency_keys WHERE idempotency_key IN ('${savedKey}','${firstKey}','${differentKey}');
      SET LOCAL session_replication_role = replica;
      DELETE FROM public.delivery_brand_events WHERE delivery_id = '${delivery}';
      DELETE FROM public.deliveries WHERE id = '${delivery}';
      DELETE FROM public.orders WHERE id = '${order}';
      SET LOCAL session_replication_role = origin;
      DELETE FROM public.customers WHERE id = '${customer}';
      DELETE FROM public.profiles WHERE id = '${actor}';
      DELETE FROM auth.users WHERE id = '${actor}';
      COMMIT;`);
  }
  console.log(useSameKey ? 'LOCAL_DELIVERY_NOTICE_SAME_KEY_RACE_PASS' : 'LOCAL_DELIVERY_NOTICE_DISTINCT_KEY_RACE_PASS');
}

await proveRace(true);
await proveRace(false);
