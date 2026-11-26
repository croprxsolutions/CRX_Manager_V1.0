import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const lanePath = process.platform === 'win32' ? root.toLowerCase() : root;
process.env.CRX_LOCAL_APP_PROFILE = 'screen-walk';
process.env.CRX_LOCAL_APP_LANE = createHash('sha256').update(lanePath).digest('hex').slice(0, 8);
const target = await import('../local-app/target.mjs');
const { localSql } = await import('../local-app/e2e/local-db.ts');
target.assertCleanEnvironment();
const stateFile = resolve(root, 'scripts/local-app', target.STATE_FOLDER, 'local.env');
const raw = readFileSync(stateFile, 'utf8');
const state = Object.fromEntries(raw.split(/\r?\n/).filter(line => line.includes('=') && !line.startsWith('#')).map(line => {
  const equals = line.indexOf('=');
  return [line.slice(0, equals), line.slice(equals + 1)];
}));
target.assertLocalState(state);

const sql = readFileSync(new URL('./smoke-cancel-order-with-notice.sql', import.meta.url), 'utf8');
assert.equal(localSql(sql), 'SMOKE_PASS_ROLLBACK');

const [first, second, farm, distinct, same, eligibility] = Array.from({ length: 6 }, randomUUID);
const tag = farm.slice(0, 8);
try {
  localSql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id,email) VALUES ('${first}','${first}@fixture.example.test'), ('${second}','${second}@fixture.example.test');
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
      ('${first}','${first}@fixture.example.test','Invented Cancel Race Admin One ${tag}','admin',true),
      ('${second}','${second}@fixture.example.test','Invented Cancel Race Admin Two ${tag}','admin',true);
    INSERT INTO public.customers (id,farm_name) VALUES ('${farm}','Invented Cancellation Race ${tag}');
    INSERT INTO public.orders (id,order_number,customer_id,status) VALUES
      ('${distinct}','INVENTED-CANCEL-RACE-A-${tag}','${farm}','confirmed'),
      ('${same}','INVENTED-CANCEL-RACE-B-${tag}','${farm}','confirmed'),
      ('${eligibility}','INVENTED-CANCEL-RACE-C-${tag}','${farm}','confirmed');
    COMMIT;`);

  // Keep both database clients inside one local Docker invocation.
  const host = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
  target.assertLocalDockerEndpoint(host);
  const composePath = resolve(root, 'scripts/local-app/compose.yaml');
  const labels = JSON.parse(execFileSync('docker', ['-H', host, 'inspect', '--format', '{{json .Config.Labels}}', target.PROJECT + '-db-1'], { encoding: 'utf8' }));
  assert.equal(labels['com.docker.compose.project'], target.PROJECT);
  assert(target.sameComposePath(labels['com.docker.compose.project.config_files'], composePath));
  const race = readFileSync(new URL('./cancel-order-with-notice-race.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const output = execFileSync('docker', [
    '-H', host, 'compose', '-p', target.PROJECT, '-f', composePath, '--env-file', stateFile,
    'exec', '-T', 'db', 'sh', '-s', '--', first, second, distinct, same, eligibility, tag,
  ], { input: race, encoding: 'utf8', timeout: 60_000 }).trim();
  assert.equal(output, 'LOCAL_CANCEL_RACE_distinct_PASS\nLOCAL_CANCEL_RACE_same_PASS\nLOCAL_CANCEL_RACE_eligibility_PASS');
  console.log(output);
} finally {
  localSql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.activity_feed WHERE customer_id = '${farm}' OR related_entity_id = '${second}';
    DELETE FROM public.idempotency_keys WHERE result->'request'->>'order_id' IN ('${distinct}', '${same}', '${eligibility}')
      OR (operation = 'admin_update_profile' AND idempotency_key = '${tag}-deactivate');
    DELETE FROM public.notifications WHERE related_entity_id IN ('${distinct}', '${same}', '${eligibility}');
    DELETE FROM public.orders WHERE id IN ('${distinct}', '${same}', '${eligibility}');
    DELETE FROM public.customers WHERE id = '${farm}';
    DELETE FROM public.profiles WHERE id IN ('${first}', '${second}');
    DELETE FROM auth.users WHERE id IN ('${first}', '${second}');
    COMMIT;`);
}
process.stdout.write('SMOKE_PASS_ROLLBACK\n');
