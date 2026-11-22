#!/usr/bin/env node
/**
 * Real-schema proof for 20270207120000_driver_farm_billing_address.sql (#2018).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), applies the candidate (autocommit refused,
 * POSTFLIGHT_OK, re-apply refused), then as the signed-in user checks:
 *   1. a driver's lookup returns billing_address and shipping_address separately (trimmed, blank as null), and
 *      `address` is still shipping, else billing;
 *   2. only the seven safe keys; never the seeded credit limit, prepay balance, payment terms or notes;
 *   3. admin, sales rep, applicator and anon are still refused.
 *
 * Run: node scripts/smoke/prove-driver-farm-billing-address-real-schema.mjs   (needs Docker; never touches live)
 * Prints DRIVER_FARM_BILLING_ADDRESS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, id, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270207120000_driver_farm_billing_address.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
const [A, B, D] = ['c1', 'c2', 'c4'].map(id);
const SECRETS = ['987654321', '123456789', 'ZZTERMS2018', 'ZZNOTE2018'];
const LOOKUP = `r := public.get_driver_customers(ARRAY['${A}', '${B}', '${D}']::uuid[]);`;

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  docker(PSQL, { input: `SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, billing_address, shipping_address) VALUES
      ('${A}', 'Alpha Farms', '  A Billing St ', '  '), ('${B}', 'Bravo Farms', NULL, NULL), ('${D}', 'Delta Farms', 'BILL 1 Rd', 'SHIP 9 Ln');
    UPDATE public.customers SET credit_limit_cents = 987654321, prepay_balance_cents = 123456789,
      payment_terms = 'ZZTERMS2018', notes = 'ZZNOTE2018' WHERE id = '${D}';` });

  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /DRIVER_FARM_BILLING_BASELINE_DRIFT/, 're-apply must refuse');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');

  assert.equal(attempt(USERS.driver, `${asUser(LOOKUP)} v := (SELECT string_agg(concat_ws('|', e->>'farm_name', COALESCE(e->>'billing_address', '-'), COALESCE(e->>'shipping_address', '-'), COALESCE(e->>'address', '-')), ',' ORDER BY e->>'id') FROM jsonb_array_elements(r->'rows') e);`),
    'ok|Alpha Farms|A Billing St|-|A Billing St,Bravo Farms|-|-|-,Delta Farms|BILL 1 Rd|SHIP 9 Ln|SHIP 9 Ln', 'billing and shipping separately; address unchanged');
  assert.equal(attempt(USERS.driver, `${asUser(LOOKUP)} v := (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r->'rows'->2) k);`),
    'ok|address,billing_address,email,farm_name,id,phone,shipping_address', 'only the seven safe keys');
  const text = attempt(USERS.driver, `${asUser(LOOKUP)} v := r::text;`);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `the lookup must not return ${secret}`);
  console.log('[lookup] a driver gets billing and shipping addresses separately, nothing financial');

  for (const [uid, who] of [[USERS.admin, 'admin'], [USERS.rep, 'sales rep'], [USERS.applicator, 'applicator']]) {
    assert.equal(attempt(uid, `${refuse(`r := public.get_driver_customers(ARRAY['${D}']::uuid[]);`)} v := t;`), 'ok|Not authorized to view farm contacts', `${who} must be refused`);
  }
  assert.match(attempt(USERS.driver, `SET LOCAL ROLE anon; BEGIN r := public.get_driver_customers(ARRAY['${D}']::uuid[]); v := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN v := SQLERRM; END; RESET ROLE;`),
    /permission denied/, 'anon cannot run the lookup');
  console.log('[refuse] admin, sales rep, applicator and anon still refused');

  console.log('\nDRIVER_FARM_BILLING_ADDRESS_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
