#!/usr/bin/env node
/**
 * Real-schema proof for 20270128195000_farm_group_top_parent_lists.sql (#1995).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), applies the candidate (autocommit refused,
 * POSTFLIGHT_OK, re-apply refused), seeds a four-level group A > B > C > E plus an unrelated D, then as the
 * signed-in admin (role authenticated) checks that the Orders and Deliveries lists name the TOP parent, that a
 * search for the top parent finds every grandchild's rows, and that a loop forced past the KI-146 trigger still
 * returns (direct parent shown).
 *
 * Run: node scripts/smoke/prove-farm-group-top-parent-lists-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a built database: UNDO_PATHS_CONTAINER=<name> FARM_GROUP_TOP_PROOF_REUSE=1 (left running).
 * Prints FARM_GROUP_TOP_PARENT_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, id, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270128195000_farm_group_top_parent_lists.sql';
const reuse = process.env.FARM_GROUP_TOP_PROOF_REUSE === '1';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });

const [A, B, C, D, E] = ['b1', 'b2', 'b3', 'b4', 'b5'].map(id);
const FARMS = { A: [A, 'Alpha Top Farms', null], B: [B, 'Bravo Farms', A], C: [C, 'Charlie Farms', B], E: [E, 'Echo Farms', C], D: [D, 'Delta Farms', null] };
const admin = USERS.admin;

// customer farm name -> farm_group_name, for every row a list returns (one order and one delivery per customer).
const orders = (search) => attempt(admin, `${asUser(`r := public.get_orders_keyset_page('2026-01-01', '2026-12-31', ${search ? `'${search}'` : 'NULL'});`)}
  v := (SELECT string_agg((x->>'customer_name') || '=' || COALESCE(x->>'farm_group_name', '-'), ',' ORDER BY x->>'customer_name')
          FROM jsonb_array_elements(r->'rows') x);`);
const deliveries = (search) => attempt(admin, `${asUser(`r := public.get_deliveries_keyset_page('2026-06-15', '2026-06-14', ${search ? `'${search}'` : 'NULL'});`)}
  v := (SELECT string_agg((x->>'customer_name') || '=' || COALESCE(x->>'farm_group_name', '-'), ',' ORDER BY x->>'customer_name')
          FROM jsonb_array_elements(r->'rows') x);`);

try {
  if (!reuse) buildContainer({ stopBefore: CANDIDATE });

  // Before the candidate: the lists name the DIRECT parent (the bug).
  seedUsers();
  const values = Object.values(FARMS);
  docker(PSQL, { input: `SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, parent_customer_id) VALUES
      ${values.map(([i, n, p]) => `('${i}', '${n}', ${p ? `'${p}'` : 'NULL'})`).join(',\n      ')};
    INSERT INTO public.orders (id, order_number, customer_id, status, total_price, order_date)
      VALUES ${values.map(([i], k) => `(gen_random_uuid(), 'FG-${k}', '${i}', 'confirmed', 10, '2026-06-0${k + 1}')`).join(', ')};
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, scheduled_date, status)
      VALUES ${values.map(([i], k) => `(gen_random_uuid(), 'FGD-${k}', gen_random_uuid(), '${i}', '${admin}', '2026-06-15', 'scheduled')`).join(', ')};` });
  const before = 'ok|Alpha Top Farms=-,Bravo Farms=Alpha Top Farms,Charlie Farms=Bravo Farms,Delta Farms=-,Echo Farms=Charlie Farms';
  assert.equal(orders(), before);
  assert.equal(deliveries(), before);

  const auto = apply();
  assert.notEqual(auto.status, 0, 'autocommit apply must be refused');
  assert.match(auto.stderr, /PREFLIGHT_FAIL/);
  const first = apply(['-1']);
  assert.equal(first.status, 0, `apply failed:\n${first.stderr}`);
  assert.match(first.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.notEqual(again.status, 0, 're-apply must be refused');
  assert.match(again.stderr, /FARM_GROUP_TOP_BASELINE_DRIFT/);

  // 1. Every grouped customer (children, grandchildren, great-grandchildren) shows the top parent; the top and an
  //    ungrouped customer show none.
  const top = 'ok|Alpha Top Farms=-,Bravo Farms=Alpha Top Farms,Charlie Farms=Alpha Top Farms,Delta Farms=-,Echo Farms=Alpha Top Farms';
  assert.equal(orders(), top);
  assert.equal(deliveries(), top);
  // 2. Searching the top parent's name finds the whole group (Alpha's own rows by customer name).
  const group = 'ok|Alpha Top Farms=-,Bravo Farms=Alpha Top Farms,Charlie Farms=Alpha Top Farms,Echo Farms=Alpha Top Farms';
  assert.equal(orders('alpha top'), group);
  assert.equal(deliveries('alpha top'), group);
  // ... and a middle farm's name now finds only its own rows (it is no longer anyone's shown group).
  assert.equal(orders('charlie'), 'ok|Charlie Farms=Alpha Top Farms');
  assert.equal(deliveries('charlie'), 'ok|Charlie Farms=Alpha Top Farms');

  // 3. A loop forced past the KI-146 trigger (C > E > C, detached from A): both lists still return, showing the
  //    direct parent for the looped customers and the top for B.
  const loop = `SET LOCAL session_replication_role = replica; UPDATE public.customers SET parent_customer_id = '${E}' WHERE id = '${C}';
    SET LOCAL session_replication_role = origin; SET LOCAL statement_timeout = '5s';`;
  const looped = 'ok|Alpha Top Farms=-,Bravo Farms=Alpha Top Farms,Charlie Farms=Echo Farms,Delta Farms=-,Echo Farms=Charlie Farms';
  const inLoop = (fn) => attempt(admin, `${loop} ${asUser(`r := ${fn};`)}
    v := (SELECT string_agg((x->>'customer_name') || '=' || COALESCE(x->>'farm_group_name', '-'), ',' ORDER BY x->>'customer_name')
            FROM jsonb_array_elements(r->'rows') x);`);
  assert.equal(inLoop("public.get_orders_keyset_page('2026-01-01', '2026-12-31')"), looped);
  assert.equal(inLoop("public.get_deliveries_keyset_page('2026-06-15', '2026-06-14')"), looped);

  // 4. The offset wrappers follow (they call the keyset functions).
  assert.equal(attempt(admin, `${asUser(`r := public.get_orders_page('2026-01-01', '2026-12-31', 'echo');`)}
    v := r->'rows'->0->>'farm_group_name';`), 'ok|Alpha Top Farms');
  assert.equal(attempt(admin, `${asUser(`r := public.get_deliveries_page('2026-06-15', '2026-06-14', 'echo');`)}
    v := r->'rows'->0->>'farm_group_name';`), 'ok|Alpha Top Farms');

  console.log('FARM_GROUP_TOP_PARENT_PROOF_PASS');
} finally {
  if (!reuse && process.env.KEEP_CONTAINER !== '1') removeContainer();
}
