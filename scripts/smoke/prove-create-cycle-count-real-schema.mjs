#!/usr/bin/env node
/**
 * Real-schema proof for 20270209160000_create_cycle_count_one_step.sql (KI-160 remainder;
 * contract docs/plans/2026-11-22-ki160-atomic-count-create-CONTRACT.md).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), applies the candidate (autocommit refused,
 * POSTFLIGHT_OK, re-apply refused), then as the signed-in user (role authenticated) checks the contract's cases.
 * Every probe is rolled back.
 *
 * Run: node scripts/smoke/prove-create-cycle-count-real-schema.mjs   (needs Docker; never touches live)
 * Prints CREATE_CYCLE_COUNT_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, signIn, id, USERS, ROOT, NAME, docker, psql } from './undo-paths/harness.mjs';

const CANDIDATE = '20270209160000_create_cycle_count_one_step.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
const [P1, P2, P3, P4] = ['b1', 'b2', 'b3', 'b4'].map(id);
const [I1, I2, I3, I4] = ['d1', 'd2', 'd3', 'd4'].map(id);
const create = (wh, key, notes = null) => `public.create_cycle_count(${wh === null ? 'NULL' : `'${wh}'`}, ${notes === null ? 'NULL' : `'${notes}'`}, NULL, ${key === null ? 'NULL' : `'${key}'`})`;
const countsAt = (wh) => `(SELECT count(*) FROM public.cycle_counts WHERE warehouse = '${wh}')`;

try {
  // Iterating only: CRX_PROVER_REUSE=1 with UNDO_PATHS_CONTAINER=<a kept container> skips the build, seed and apply.
  if (!process.env.CRX_PROVER_REUSE) {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  psql(`INSERT INTO public.products (id, product_name, is_active, product_form, inventory_unit) VALUES
      ('${P1}', '[KI160] one', true, 'liquid', 'Gal'), ('${P2}', '[KI160] two', true, 'liquid', 'Gal'),
      ('${P3}', '[KI160] three', true, 'liquid', 'Gal'), ('${P4}', '[KI160] four', true, 'liquid', 'Gal');
    INSERT INTO public.inventory (id, product_id, location, quantity_available, quantity_prebooked, quantity_on_order) VALUES
      ('${I1}', '${P1}', 'Alpha WH', 10, 0, 0), ('${I2}', '${P2}', 'Alpha WH', 2.5, 0, 0), ('${I3}', '${P3}', 'Alpha WH', 0, 0, 0),
      ('${I4}', '${P4}', 'Beta WH', 7, 0, 0);`);

  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /CREATE_CYCLE_COUNT_EXISTS/, 're-apply must refuse');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');
  }

  // 1. Admin at a warehouse with 3 stock rows: one open count, 3 lines, expected = on-hand, number CC-YYYY-#####.
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${create('Alpha WH', 'k1', '  first  ')};`)}
    v := concat_ws('|', r->>'line_count', r->>'warehouse', (r->>'count_number') ~ '^CC-\\d{4}-\\d{5}$',
      (SELECT concat_ws('/', status, warehouse, notes, initiated_by = '${USERS.admin}') FROM public.cycle_counts WHERE id = (r->>'cycle_count_id')::uuid),
      (SELECT string_agg(inventory_id::text || '=' || (expected_qty::float8)::text || ':' || is_counted, ',' ORDER BY inventory_id) FROM public.cycle_count_items WHERE cycle_count_id = (r->>'cycle_count_id')::uuid));`),
    `ok|3|Alpha WH|t|in_progress/Alpha WH/first/t|${I1}=10:false,${I2}=2.5:false,${I3}=0:false`,
    'admin creates the whole count in one step');
  console.log('[create] one in-progress count with a line per stock row, expected = on-hand');

  // 2. No stock at the location: refused, nothing saved.
  assert.equal(attempt(USERS.admin, `${refuse(`r := ${create('Empty WH', 'k2')};`)} v := t || '|' || ${countsAt('Empty WH')};`),
    'ok|NO_INVENTORY: no stock rows at Empty WH|0', 'no stock refuses and leaves no count');
  console.log('[empty] no stock -> NO_INVENTORY, no count left');

  // 3. Not an active admin: refused. Missing key, blank warehouse, someone else's id: refused.
  for (const [uid, who] of [[USERS.rep, 'sales rep'], [USERS.driver, 'driver'], [USERS.applicator, 'applicator']]) {
    assert.equal(attempt(uid, `${refuse(`r := ${create('Alpha WH', 'k3')};`)} v := t || '|' || ${countsAt('Alpha WH')};`),
      'ok|INSUFFICIENT_ROLE: only an active admin can start a stock count|0', `${who} must be refused`);
  }
  // A second active admin first: the last active admin cannot be deactivated.
  assert.equal(attempt(USERS.admin, `UPDATE public.profiles SET role = 'admin' WHERE id = '${USERS.rep}';
    UPDATE public.profiles SET is_active = false WHERE id = '${USERS.admin}';
    ${refuse(`r := ${create('Alpha WH', 'k3')};`)} v := t || '|' || ${countsAt('Alpha WH')};`),
    'ok|INSUFFICIENT_ROLE: only an active admin can start a stock count|0', 'inactive admin must be refused');
  assert.match(attempt(USERS.admin, `SET LOCAL ROLE anon; BEGIN r := ${create('Alpha WH', 'k3')}; v := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN v := SQLERRM; END; RESET ROLE;`),
    /permission denied/, 'anon cannot run it');
  assert.equal(attempt(USERS.admin, `${refuse(`r := ${create('Alpha WH', null)};`)} v := t;`),
    'ok|IDEMPOTENCY_KEY_REQUIRED: create_cycle_count requires p_idempotency_key');
  assert.equal(attempt(USERS.admin, `${refuse(`r := ${create('  ', 'k3')};`)} v := t;`), 'ok|WAREHOUSE_REQUIRED: choose a location');
  assert.equal(attempt(USERS.admin, `${refuse(`r := public.create_cycle_count('Alpha WH', NULL, '${USERS.rep}', 'k3');`)} v := t;`), 'ok|ACTOR_MISMATCH');
  // A stored name is matched exactly, as the screen did: a padded name is another location with no stock.
  assert.equal(attempt(USERS.admin, `${refuse(`r := ${create(' Alpha WH', 'k3')};`)} v := t;`), 'ok|NO_INVENTORY: no stock rows at  Alpha WH');
  console.log('[refuse] rep, driver, applicator, inactive admin, anon, no key, blank location, forged actor');

  // 4. Warehouse already has an open count: refused by name, nothing new saved.
  assert.match(attempt(USERS.admin, `${asUser(`r := ${create('Alpha WH', 'k4a')};`)}
    ${refuse(`r2 := ${create('Alpha WH', 'k4b')};`)} v := t || '|' || ${countsAt('Alpha WH')};`),
    /^ok\|COUNT_ALREADY_OPEN: Alpha WH already has open count CC-\d{4}-\d{5}; finish or cancel it first\|1$/, 'second open count refused');
  console.log('[open] second count at one warehouse -> COUNT_ALREADY_OPEN, still one count');

  // 5. A stock row on an open count cannot simply change location (the app must transfer it)...
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${create('Beta WH', 'k5a')};`)}
    UPDATE public.inventory SET location = 'Gamma WH' WHERE id = '${I4}';`), 'P0001|INVENTORY_LOCATION_TRANSFER_REQUIRED');
  // ...but if such a stale row ever existed (forced here with triggers off), the refused line rolls the whole call back.
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${create('Beta WH', 'k5a')};`)}
    SET LOCAL session_replication_role = replica; UPDATE public.inventory SET location = 'Gamma WH' WHERE id = '${I4}';
    SET LOCAL session_replication_role = origin;
    ${refuse(`r2 := ${create('Gamma WH', 'k5b')};`)} v := split_part(t, ':', 1) || '|' || ${countsAt('Gamma WH')};`),
    'ok|CYCLE_COUNT_ROW_ALREADY_OPEN|0', 'a refused line leaves no empty count');
  console.log('[atomic] a refused line leaves no count behind');

  // 6. Same key twice: same result, one count. Same key, other location: refused.
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${create('Alpha WH', 'k6')}; r2 := ${create('Alpha WH', 'k6')};`)}
    v := (r = r2)::text || '|' || ${countsAt('Alpha WH')};`), 'ok|true|1', 'replay returns the first result');
  assert.notEqual(attempt(USERS.admin, `${asUser(`r := ${create('Alpha WH', 'k7')};`)}
    ${refuse(`r2 := ${create('Beta WH', 'k7')};`)} v := t || '|' || ${countsAt('Beta WH')};`).split('|')[1], 'NOT REFUSED', 'key reuse for another location refused');
  assert.match(attempt(USERS.admin, `${asUser(`r := ${create('Alpha WH', 'k8')};`)}
    ${refuse(`r2 := ${create('Beta WH', 'k8')};`)} v := t || '|' || ${countsAt('Beta WH')};`), /\|0$/, 'key reuse saves nothing');
  console.log('[replay] same key -> same count; same key elsewhere -> refused, nothing saved');

  // Signed-in identity drives initiated_by even when the caller switches users mid-transaction.
  assert.equal(attempt(USERS.rep, `${signIn(USERS.admin)} ${asUser(`r := ${create('Alpha WH', 'k9')};`)}
    v := (SELECT initiated_by::text FROM public.cycle_counts WHERE id = (r->>'cycle_count_id')::uuid);`), `ok|${USERS.admin}`);

  console.log('\nCREATE_CYCLE_COUNT_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
