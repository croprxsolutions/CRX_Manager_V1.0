#!/usr/bin/env node
/**
 * Real-schema proof for 20270228150000_driver_farm_lookup_scope.sql (release #2388 Sol HIGH 1).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), applies the candidate (autocommit refused,
 * POSTFLIGHT_OK, re-apply refused), then as the signed-in user checks:
 *   1. a driver gets only farms on their own not-deleted deliveries that are open, scheduled from yesterday on, or
 *      completed since yesterday;
 *      never a farm on someone else's, an unassigned, a deleted or an old completed delivery;
 *   2. the same seven keys, nothing financial, addresses as before;
 *   3. a driver denied only Deliveries, or only My Route, still gets their farms; denied both is refused;
 *   4. admin, sales rep, applicator and anon are still refused.
 *
 * Run: node scripts/smoke/prove-driver-farm-lookup-scope-real-schema.mjs   (needs Docker; never touches live)
 * Prints DRIVER_FARM_LOOKUP_SCOPE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, id, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270228150000_driver_farm_lookup_scope.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
// A today, B overdue in progress, C old completed, D completed yesterday, E another driver's, F unassigned, G deleted,
// H overdue but completed just now.
const FARMS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const ID = Object.fromEntries(FARMS.map((f, i) => [f, id(`c${i + 1}`)]));
const OTHER = id('a9');
const ALL = `ARRAY['${FARMS.map((f) => ID[f]).join("','")}']::uuid[]`;
const NAMES = `${asUser(`r := public.get_driver_customers(${ALL});`)} v := (SELECT COALESCE(string_agg(e->>'farm_name', ',' ORDER BY e->>'farm_name'), '') FROM jsonb_array_elements(r->'rows') e);`;
const setDenied = (pages) => docker(PSQL, { input: `SET session_replication_role = replica; UPDATE public.profiles SET denied_pages = ARRAY[${pages.map((p) => `'${p}'`).join(',')}]::text[] WHERE id = '${USERS.driver}';` });

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  docker(PSQL, { input: `SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, billing_address, shipping_address) VALUES
      ${FARMS.map((f) => `('${ID[f]}', 'Farm ${f}', 'BILL ${f}', ${f === 'A' ? "'SHIP A'" : 'NULL'})`).join(', ')};
    UPDATE public.customers SET credit_limit_cents = 987654321, prepay_balance_cents = 123456789,
      payment_terms = 'ZZTERMS2388', notes = 'ZZNOTE2388' WHERE id = '${ID.A}';
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, scheduled_date, status, assigned_driver, deleted_at, completed_at) VALUES
      ('FS-A', gen_random_uuid(), '${ID.A}', '${USERS.admin}', CURRENT_DATE, 'scheduled', '${USERS.driver}', NULL, NULL),
      ('FS-B', gen_random_uuid(), '${ID.B}', '${USERS.admin}', CURRENT_DATE - 10, 'in_progress', '${USERS.driver}', NULL, NULL),
      ('FS-C', gen_random_uuid(), '${ID.C}', '${USERS.admin}', CURRENT_DATE - 30, 'completed', '${USERS.driver}', NULL, NULL),
      ('FS-D', gen_random_uuid(), '${ID.D}', '${USERS.admin}', CURRENT_DATE - 1, 'completed', '${USERS.driver}', NULL, NULL),
      ('FS-E', gen_random_uuid(), '${ID.E}', '${USERS.admin}', CURRENT_DATE, 'scheduled', '${OTHER}', NULL, NULL),
      ('FS-F', gen_random_uuid(), '${ID.F}', '${USERS.admin}', CURRENT_DATE, 'scheduled', NULL, NULL, NULL),
      ('FS-G', gen_random_uuid(), '${ID.G}', '${USERS.admin}', CURRENT_DATE, 'scheduled', '${USERS.driver}', now(), NULL),
      ('FS-H', gen_random_uuid(), '${ID.H}', '${USERS.admin}', CURRENT_DATE - 5, 'completed', '${USERS.driver}', NULL, now());` });

  // Before the fix: the same driver reads every farm, including other drivers' and unassigned ones.
  assert.equal(attempt(USERS.driver, NAMES), 'ok|Farm A,Farm B,Farm C,Farm D,Farm E,Farm F,Farm G,Farm H', 'baseline leaks every farm');

  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /DRIVER_FARM_SCOPE_BASELINE_DRIFT/, 're-apply must refuse');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');

  assert.equal(attempt(USERS.driver, NAMES), 'ok|Farm A,Farm B,Farm D,Farm H', 'only farms on the driver\'s own open or recent deliveries');
  console.log('[scope] driver gets A (today), B (overdue, in progress), D (yesterday), H (completed just now); not C (old), E (other driver), F (unassigned), G (deleted)');

  const lookupA = asUser(`r := public.get_driver_customers(ARRAY['${ID.A}']::uuid[]);`);
  assert.equal(attempt(USERS.driver, `${lookupA} v := (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r->'rows'->0) k);`),
    'ok|address,billing_address,email,farm_name,id,phone,shipping_address', 'only the seven safe keys');
  assert.equal(attempt(USERS.driver, `${lookupA} v := concat_ws('|', r->'rows'->0->>'address', r->'rows'->0->>'billing_address', r->'rows'->0->>'shipping_address');`),
    'ok|SHIP A|BILL A|SHIP A', 'addresses unchanged');
  const text = attempt(USERS.driver, `${lookupA} v := r::text;`);
  for (const secret of ['987654321', '123456789', 'ZZTERMS2388', 'ZZNOTE2388']) assert.ok(!text.includes(secret), `the lookup must not return ${secret}`);
  assert.equal(attempt(USERS.driver, `${asUser(`r := public.get_driver_customers(ARRAY['${ID.E}', '${ID.F}']::uuid[]);`)} v := r::text;`), 'ok|{"rows": []}', 'unassigned farms: nothing');
  console.log('[keys] seven keys, same addresses, nothing financial; unassigned farms return an empty list');

  setDenied(['deliveries']);
  assert.equal(attempt(USERS.driver, NAMES), 'ok|Farm A,Farm B,Farm D,Farm H', 'My Route alone still reads');
  setDenied(['my-route']);
  assert.equal(attempt(USERS.driver, NAMES), 'ok|Farm A,Farm B,Farm D,Farm H', 'Deliveries alone still reads');
  setDenied(['deliveries', 'my-route']);
  assert.equal(attempt(USERS.driver, `${refuse(`r := public.get_driver_customers(${ALL});`)} v := t;`), 'ok|Not authorized to view farm contacts', 'both pages denied: refused');
  setDenied([]);
  console.log('[pages] denied one page still reads; denied Deliveries and My Route is refused');

  for (const [uid, who] of [[USERS.admin, 'admin'], [USERS.rep, 'sales rep'], [USERS.applicator, 'applicator']]) {
    assert.equal(attempt(uid, `${refuse(`r := public.get_driver_customers(ARRAY['${ID.A}']::uuid[]);`)} v := t;`), 'ok|Not authorized to view farm contacts', `${who} must be refused`);
  }
  assert.match(attempt(USERS.driver, `SET LOCAL ROLE anon; BEGIN r := public.get_driver_customers(ARRAY['${ID.A}']::uuid[]); v := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN v := SQLERRM; END; RESET ROLE;`),
    /permission denied/, 'anon cannot run the lookup');
  console.log('[refuse] admin, sales rep, applicator and anon still refused');

  console.log('\nDRIVER_FARM_LOOKUP_SCOPE_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
