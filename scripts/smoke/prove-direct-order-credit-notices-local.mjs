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

const sql = readFileSync(new URL('./smoke-direct-order-credit-notices.sql', import.meta.url), 'utf8');
assert.equal(localSql(sql), 'SMOKE_PASS_ROLLBACK');
console.log('SMOKE_PASS_ROLLBACK');


const [actor, admin, farm, product] = Array.from({ length: 4 }, randomUUID);
const tag = 'local-credit-race-' + farm;
try {
  localSql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id,email) VALUES
      ('${actor}','${actor}@fixture.example.test'), ('${admin}','${admin}@fixture.example.test');
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
      ('${actor}','${actor}@fixture.example.test','Invented Credit Race Rep','sales_rep',true),
      ('${admin}','${admin}@fixture.example.test','Invented Credit Race Admin','admin',true);
    INSERT INTO public.customers (id,farm_name,credit_limit_cents,assigned_tier,assigned_sales_rep)
      VALUES ('${farm}','Invented Credit Race Farm',100000,1,'${actor}');
    INSERT INTO public.invoices (invoice_number,customer_id,invoice_type,status,invoice_date,due_date,total_amount_cents,created_by,salesman_id)
      VALUES ('${tag}','${farm}','chemical_sale','unposted',current_date,current_date+30,100001,'${actor}','${actor}');
    INSERT INTO public.products (id,product_name,product_form,inventory_unit,unit_size,rate_unit,container_unit,current_cost,is_active)
      VALUES ('${product}','Invented Race Product','liquid','Gal','Gal','Gal','Gal',10,true);
    COMMIT;`);

  const host = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
  target.assertLocalDockerEndpoint(host);
  const composePath = resolve(root, 'scripts/local-app/compose.yaml');
  const labels = JSON.parse(execFileSync('docker', ['-H', host, 'inspect', '--format', '{{json .Config.Labels}}', target.PROJECT + '-db-1'], { encoding: 'utf8' }));
  assert.equal(labels['com.docker.compose.project'], target.PROJECT);
  assert(target.sameComposePath(labels['com.docker.compose.project.config_files'], composePath));
  const race = readFileSync(new URL('./direct-order-credit-notices-race.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const output = execFileSync('docker', [
    '-H', host, 'compose', '-p', target.PROJECT, '-f', composePath, '--env-file', stateFile,
    'exec', '-T', 'db', 'sh', '-s', '--', actor, farm, product, tag,
  ], { input: race, encoding: 'utf8', timeout: 85_000 }).trim();
  assert.equal(output, 'LOCAL_CREDIT_RACE_SAVE_PASS\nLOCAL_CREDIT_RACE_LEGACY_PASS\nLOCAL_CREDIT_RACE_NOTICE_PASS');
  console.log(output);
} finally {
  localSql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.notifications WHERE notification_type='credit_limit_exceeded' AND related_entity_id='${farm}';
    DELETE FROM public.activity_feed WHERE customer_id='${farm}';
    DELETE FROM public.idempotency_keys WHERE operation='create_direct_order' AND idempotency_key IN ('${tag}-old','${tag}-new');
    DELETE FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE customer_id='${farm}');
    DELETE FROM public.orders WHERE customer_id='${farm}';
    DELETE FROM public.invoices WHERE customer_id='${farm}';
    DELETE FROM public.products WHERE id='${product}';
    DELETE FROM public.customers WHERE id='${farm}';
    DELETE FROM public.profiles WHERE id IN ('${actor}','${admin}');
    DELETE FROM auth.users WHERE id IN ('${actor}','${admin}');
    COMMIT;`);
}
const cleared = localSql(`SELECT
  NOT EXISTS (SELECT 1 FROM public.orders WHERE customer_id='${farm}')
  AND NOT EXISTS (SELECT 1 FROM public.invoices WHERE customer_id='${farm}')
  AND NOT EXISTS (SELECT 1 FROM public.notifications WHERE related_entity_id='${farm}')
  AND NOT EXISTS (SELECT 1 FROM public.products WHERE id='${product}')
  AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id='${farm}')
  AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id IN ('${actor}','${admin}'));`);
assert.equal(cleared, 't');
console.log('LOCAL_CREDIT_RACE_FIXTURES_CLEANUP_PASS');
