#!/usr/bin/env node
/**
 * Real-schema proof for 20270204120000_driver_available_deliveries.sql (#2018).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), applies the candidate (autocommit refused,
 * POSTFLIGHT_OK, re-apply refused), then as the signed-in user (role authenticated) checks:
 *   1. an active driver sees every open delivery (unassigned, scheduled, not deleted), soonest first, with only
 *      five fields and the TOP farm group (a farm-group loop still returns), and nothing assigned, in another
 *      status, or deleted;
 *   2. an admin, sales rep, applicator, inactive driver and anon are refused;
 *   3. a driver takes an open delivery for themself; assigning it to someone else, or taking one already taken,
 *      started or deleted, is refused; inactive drivers and applicators are refused; a same-key retry replays;
 *   4. two drivers taking one delivery at once: the second waits, then is refused and the first keeps it; one
 *      driver's double tap (same key) at once: both get the result, one notification;
 *   5. an admin and a sales rep still reassign scheduled and in-progress deliveries to anyone.
 *
 * Run: node scripts/smoke/prove-driver-available-deliveries-real-schema.mjs   (needs Docker; never touches live)
 * Prints DRIVER_AVAILABLE_DELIVERIES_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, scalar, attempt, asUser, refuse, claims, id, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270204120000_driver_available_deliveries.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });

const [A, B, C, D] = ['c1', 'c2', 'c3', 'c4'].map(id);
const DRIVER2 = id('a6');
const OFF_DRIVER = id('a7');
const DEL = Object.fromEntries(['open1', 'open2', 'mine', 'started', 'deleted', 'race', 'other', 'double'].map((k, i) => [k, id(`d${i + 1}`)]));
const key = () => `'${crypto.randomUUID()}'`;
const take = (delivery, driver, k = key()) => `public.reassign_delivery('${delivery}', '${driver}', NULL, ${k})`;
const LIST = `r := public.get_available_deliveries_for_driver();
  v := (SELECT string_agg((x->>'delivery_number') || '=' || (x->>'customer_name') || '/' || COALESCE(x->>'farm_group_name', '-'), ',' ORDER BY ord)
          FROM jsonb_array_elements(r->'rows') WITH ORDINALITY AS e(x, ord));`;
const owner = (delivery) => scalar(`SELECT COALESCE(assigned_driver::text, '-') FROM public.deliveries WHERE id = '${delivery}';`);
const REFUSED = 'ok|Not authorized to reassign deliveries';
const GONE = 'ok|This delivery was already taken or changed. Refresh the list.';

/** One psql session taking `delivery` as `uid` after `delay` s, holding its transaction open 2 s after the call. */
const session = (uid, delay, k, delivery) => new Promise((resolve) => {
  const started = Date.now();
  const p = spawn('docker', [...PSQL, '-A', '-t'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  p.stderr.on('data', (b) => { out += b; });
  p.on('close', (code) => resolve({ code, out, ms: Date.now() - started }));
  p.stdin.end(`SELECT pg_sleep(${delay}); BEGIN; ${claims(uid)} SET LOCAL ROLE authenticated;
    SELECT (${take(delivery, uid, k)})->>'status'; SELECT pg_sleep(2); COMMIT;`);
});

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  docker(PSQL, { input: `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${DRIVER2}', 'avail-driver2@example.invalid', '{"full_name":"[AVAIL] Driver Two","role":"driver"}'::jsonb),
      ('${OFF_DRIVER}', 'avail-off@example.invalid', '{"full_name":"[AVAIL] Off Driver","role":"driver"}'::jsonb);
    SET session_replication_role = replica;
    UPDATE public.profiles SET is_active = false WHERE id = '${OFF_DRIVER}';
    INSERT INTO public.customers (id, farm_name, parent_customer_id) VALUES
      ('${A}', 'Alpha Top Farms', NULL), ('${B}', 'Bravo Farms', '${A}'), ('${C}', 'Charlie Farms', '${B}'), ('${D}', 'Delta Farms', NULL);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, scheduled_date, status, assigned_driver, deleted_at) VALUES
      ('${DEL.open1}', 'AV-01', gen_random_uuid(), '${C}', '${USERS.admin}', '2026-06-10', 'scheduled', NULL, NULL),
      ('${DEL.open2}', 'AV-02', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-11', 'scheduled', NULL, NULL),
      ('${DEL.mine}', 'AV-03', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-01', 'scheduled', '${USERS.driver}', NULL),
      ('${DEL.started}', 'AV-04', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-01', 'in_progress', NULL, NULL),
      ('${DEL.deleted}', 'AV-05', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-01', 'scheduled', NULL, now()),
      ('${DEL.race}', 'AV-06', gen_random_uuid(), '${B}', '${USERS.admin}', '2026-06-12', 'scheduled', NULL, NULL),
      ('${DEL.other}', 'AV-07', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-02', 'scheduled', '${DRIVER2}', NULL),
      ('${DEL.double}', 'AV-08', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-13', 'scheduled', NULL, NULL);
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, scheduled_date, status)
      SELECT 'AV-X' || lpad(g::text, 2, '0'), gen_random_uuid(), '${D}', '${USERS.admin}', date '2026-07-01' + g, 'scheduled'
      FROM generate_series(1, 25) g;
    SET session_replication_role = origin;` });

  // Before the candidate: the driver's direct read finds no open delivery (the bug).
  assert.equal(attempt(USERS.driver, asUser("v := (SELECT count(*) FROM public.deliveries WHERE assigned_driver IS NULL AND status = 'scheduled')::text;")), 'ok|0');

  const auto = apply();
  assert.notEqual(auto.status, 0, 'autocommit apply must be refused');
  assert.match(auto.stderr, /PREFLIGHT_FAIL/);
  const first = apply(['-1']);
  assert.equal(first.status, 0, `apply failed:\n${first.stderr}`);
  assert.match(first.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.notEqual(again.status, 0, 're-apply must be refused');
  assert.match(again.stderr, /DRIVER_AVAILABLE_BASELINE_DRIFT/);
  console.log('[apply] autocommit refused, applied once, re-apply refused');

  // 1. An active driver sees every open delivery, soonest first, with the TOP farm group, and only five fields.
  const extra = Array.from({ length: 25 }, (_, i) => `AV-X${String(i + 1).padStart(2, '0')}=Delta Farms/-`);
  const expected = ['AV-01=Charlie Farms/Alpha Top Farms', 'AV-02=Delta Farms/-', 'AV-06=Bravo Farms/Alpha Top Farms', 'AV-08=Delta Farms/-', ...extra];
  assert.equal(attempt(USERS.driver, asUser(LIST)), `ok|${expected.join(',')}`, 'every open delivery, in order, nothing else');
  assert.equal(attempt(USERS.driver, `${asUser('r := public.get_available_deliveries_for_driver();')} v := (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r->'rows'->0) k);`),
    'ok|customer_name,delivery_number,farm_group_name,id,scheduled_date', 'only the five card fields leave the database');
  // A farm-group loop forced past the KI-146 trigger (B <-> C, detached from A) still returns: direct parent shown.
  assert.match(attempt(USERS.driver, `SET LOCAL session_replication_role = replica; UPDATE public.customers SET parent_customer_id = '${C}' WHERE id = '${B}';
    SET LOCAL session_replication_role = origin; SET LOCAL statement_timeout = '5s'; ${asUser(LIST)}`),
    /^ok\|AV-01=Charlie Farms\/Bravo Farms,AV-02=Delta Farms\/-,AV-06=Bravo Farms\/Charlie Farms,/);
  console.log('[read] driver sees every open delivery in order, five fields, top farm group; a loop still returns');

  // 2. Everyone else is refused.
  for (const [who, uid] of Object.entries({ admin: USERS.admin, rep: USERS.rep, applicator: USERS.applicator, off_driver: OFF_DRIVER })) {
    assert.equal(attempt(uid, `${refuse('r := public.get_available_deliveries_for_driver();')} v := t;`), 'ok|Not authorized to view available deliveries', `${who} must be refused`);
  }
  assert.match(attempt(USERS.driver, `SET LOCAL ROLE anon; BEGIN r := public.get_available_deliveries_for_driver(); v := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN v := SQLERRM; END; RESET ROLE;`),
    /^ok\|permission denied/, 'anon has no execute');
  console.log('[read] admin, sales rep, applicator, inactive driver refused; anon has no execute');

  // 3. A driver takes an open delivery for themself only.
  assert.equal(attempt(USERS.driver, `${refuse(`r := ${take(DEL.open1, DRIVER2)};`)} v := t;`), REFUSED, 'a driver cannot assign to someone else');
  assert.equal(attempt(OFF_DRIVER, `${refuse(`r := ${take(DEL.open1, OFF_DRIVER)};`)} v := t;`), REFUSED, 'an inactive driver cannot take');
  assert.equal(attempt(USERS.applicator, `${refuse(`r := ${take(DEL.open1, USERS.applicator)};`)} v := t;`), REFUSED, 'an applicator cannot take');
  assert.equal(attempt(USERS.driver, `${refuse(`r := ${take(DEL.other, USERS.driver)};`)} v := t;`), GONE, 'a driver cannot take a delivery already taken');
  assert.equal(attempt(USERS.driver, `${refuse(`r := ${take(DEL.started, USERS.driver)};`)} v := t;`), GONE, 'a driver cannot take a started delivery');
  assert.equal(attempt(USERS.driver, `${refuse(`r := ${take(DEL.deleted, USERS.driver)};`)} v := t;`), GONE, 'a driver cannot take a deleted delivery');
  const k1 = key();
  assert.equal(attempt(USERS.driver, `${asUser(`r := ${take(DEL.open1, USERS.driver, k1)};`)} v := r->>'status';`, { commit: true }), 'ok|reassigned');
  assert.equal(owner(DEL.open1), USERS.driver);
  assert.equal(attempt(USERS.driver, `${asUser(`r := ${take(DEL.open1, USERS.driver, k1)};`)} v := r->>'status';`), 'ok|reassigned', 'a retry with the same key replays');
  assert.equal(attempt(DRIVER2, `${refuse(`r := ${take(DEL.open1, DRIVER2)};`)} v := t;`), GONE, 'another driver cannot take it afterwards');
  assert.ok(!attempt(USERS.driver, asUser(LIST)).includes('AV-01='), 'a taken delivery leaves the list');
  console.log('[take] self only, open only; inactive driver and applicator refused; retry replays; taken delivery leaves the list');

  // 4. Two drivers take one delivery at once: the first holds its lock 2 s; the second waits, then is refused.
  const [one, two] = await Promise.all([session(USERS.driver, 0, key(), DEL.race), session(DRIVER2, 0.5, key(), DEL.race)]);
  assert.equal(one.code, 0, `first driver failed:\n${one.out}`);
  assert.match(one.out, /reassigned/);
  assert.notEqual(two.code, 0, `second driver must be refused:\n${two.out}`);
  assert.match(two.out, /already taken or changed/);
  assert.ok(two.ms >= 2000, `the second driver must have waited for the first (${two.ms} ms)`);
  assert.equal(owner(DEL.race), USERS.driver, 'the first driver keeps it');
  // One driver's double tap with the same key, at once: both calls report success, one assignment, one notification.
  const k2 = key();
  const [tap1, tap2] = await Promise.all([session(DRIVER2, 0, k2, DEL.double), session(DRIVER2, 0.5, k2, DEL.double)]);
  assert.equal(tap1.code, 0, tap1.out);
  assert.match(tap1.out, /reassigned/);
  assert.equal(tap2.code, 0, tap2.out);
  assert.match(tap2.out, /reassigned/);
  assert.equal(owner(DEL.double), DRIVER2);
  assert.equal(scalar(`SELECT count(*) FROM public.notifications WHERE related_entity_id = '${DEL.double}';`), '1', 'a double tap notifies once');
  console.log('[race] two drivers at once: second waits and is refused, first keeps it; a double tap notifies once');

  // 5. Admin and sales rep reassign as before (scheduled and in-progress, to anyone).
  const k3 = key();
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${take(DEL.mine, DRIVER2, k3)};`)} v := r->>'status';`, { commit: true }), 'ok|reassigned');
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${take(DEL.mine, DRIVER2, k3)};`)} v := r::text;`),
    `ok|{"status": "reassigned", "delivery_id": "${DEL.mine}"}`, 'an admin same-key retry replays the same result');
  assert.equal(scalar(`SELECT count(*) FROM public.notifications WHERE related_entity_id = '${DEL.mine}' AND title = 'New Delivery Assigned';`), '1', 'the admin retry notifies once');
  assert.equal(attempt(USERS.rep, `${asUser(`r := ${take(DEL.started, USERS.driver)};`)} v := r->>'status';`), 'ok|reassigned');
  console.log('[take] admin and sales rep reassign as before');

  console.log('\nDRIVER_AVAILABLE_DELIVERIES_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
