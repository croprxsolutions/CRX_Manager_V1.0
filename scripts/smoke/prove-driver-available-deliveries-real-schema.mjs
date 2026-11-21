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
 *   2. an admin, sales rep, applicator, inactive driver, driver denied the Deliveries page and anon are refused;
 *   3. a driver takes an open delivery for themself; assigning it to someone else, or taking one already taken,
 *      started or deleted, is refused; inactive, denied drivers and applicators are refused; a same-key retry
 *      replays; a fresh key on one already theirs says "already assigned to you";
 *   4. two drivers taking one delivery at once: the second waits, then is refused and the first keeps it; one
 *      driver's double tap (same key) at once: both get the result, one notification;
 *   5. an admin and a sales rep still reassign scheduled and in-progress deliveries to anyone;
 *   6. get_driver_customers gives an active driver, for any farm, only id, farm name, phone, email and the delivery
 *      address (shipping, else billing); never the seeded credit limit, prepay balance, payment terms or notes;
 *      everyone else is refused;
 *   7. a driver's direct table update of their in-progress or completed delivery changes nothing (it did before);
 *      admin and sales rep direct updates still work;
 *   8. no SECURITY DEFINER function a signed-in user can run returns the seeded credit limit, prepay balance,
 *      payment terms or notes to a driver (the same sweep as an admin finds them, so the sweep can see a leak).
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
const DENIED_DRIVER = id('a8');
const NULL_ENTRY_DRIVER = id('a9');
const REVOKED_DRIVER = id('aa');
const DEMOTED_REP = id('ab');
const DEL = Object.fromEntries(['open1', 'open2', 'mine', 'started', 'deleted', 'race', 'other', 'double', 'replay', 'late', 'closed', 'revoke', 'voidopen', 'cancelme', 'inprog', 'done'].map((k, i) => [k, id(`d${i + 1}`)]));
const key = () => `'${crypto.randomUUID()}'`;
const take = (delivery, driver, k = key()) => `public.reassign_delivery('${delivery}', '${driver}', NULL, ${k})`;
const LIST = `r := public.get_available_deliveries_for_driver();
  v := (SELECT string_agg((x->>'delivery_number') || '=' || (x->>'customer_name') || '/' || COALESCE(x->>'farm_group_name', '-'), ',' ORDER BY ord)
          FROM jsonb_array_elements(r->'rows') WITH ORDINALITY AS e(x, ord));`;
// A driver's direct table edit of their in-progress and completed deliveries; v = rows changed.
const directEdit = (set) => asUser(`UPDATE public.deliveries SET ${set} WHERE id IN ('${DEL.inprog}', '${DEL.done}'); GET DIAGNOSTICS n = ROW_COUNT; v := n::text;`);
const SECRETS = ['987654321', '9876543.21', '123456789', '1234567.89', 'ZZTERMS2018', 'ZZNOTE2018'];
// Calls every SECURITY DEFINER function authenticated may run (uuid arguments = farm D, uuid[] = {D}, the rest
// NULL), each as the signed-in user in its own rolled-back step, and lists the ones whose result shows a secret.
const SWEEP = `SET LOCAL statement_timeout = '5s';
  n := 0; v := '';
  FOR f0, f1 IN
    SELECT format('public.%I', p.proname),
           COALESCE((SELECT string_agg(CASE t.oid WHEN 'uuid'::regtype THEN quote_literal('${D}') || '::uuid'
                                                WHEN 'uuid[]'::regtype THEN 'ARRAY[' || quote_literal('${D}') || ']::uuid[]'
                                                ELSE 'NULL::' || format_type(t.oid, NULL) END, ', ' ORDER BY a.ord)
                     FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY a(typ, ord) JOIN pg_type t ON t.oid = a.typ), '')
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND p.prokind = 'f'
      AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ORDER BY 1, 2
  LOOP
    BEGIN
      SET LOCAL ROLE authenticated;
      EXECUTE format('SELECT string_agg(x::text, %L) FROM %s(%s) AS x', '|', f0, f1) INTO t;
      RESET ROLE;
      n := n + 1;
      IF t ~ '${SECRETS.map((x) => x.replaceAll('.', '\\.')).join('|')}' THEN v := v || f0 || ' '; END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  v := n::text || ':' || btrim(v);`;
const owner = (delivery) => scalar(`SELECT COALESCE(assigned_driver::text, '-') FROM public.deliveries WHERE id = '${delivery}';`);
const REFUSED = 'ok|Not authorized to reassign deliveries';
const GONE = 'ok|This delivery was already taken or changed. Refresh the list.';
const MINE = 'ok|This delivery is already assigned to you. Refresh the list.';

/** One superuser psql session running `sql` after `delay` s; resolves with its exit code and output. */
const raw = (sql, delay) => new Promise((resolve) => {
  const p = spawn('docker', [...PSQL, '-A', '-t'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  p.stderr.on('data', (b) => { out += b; });
  p.on('close', (code) => resolve({ code, out }));
  p.stdin.end(`SELECT pg_sleep(${delay}); ${sql}`);
});

/**
 * One psql session taking `delivery` as `uid` after `delay` s, holding its transaction open 4 s after the call.
 * It reports the call's result and the database's own time spent inside the call (any lock wait included).
 */
const session = (uid, delay, k, delivery) => new Promise((resolve) => {
  const p = spawn('docker', [...PSQL, '-A', '-t'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  p.stderr.on('data', (b) => { out += b; });
  p.on('close', (code) => {
    const m = out.match(/WAITED ([0-9.]+) (.*)/);
    resolve({ code, out, waited: m ? Number(m[1]) : -1, result: m ? m[2].trim() : '' });
  });
  p.stdin.end(`SELECT pg_sleep(${delay}); BEGIN; ${claims(uid)} SET LOCAL ROLE authenticated;
    DO $s$ DECLARE t0 timestamptz := clock_timestamp(); v text; BEGIN
      BEGIN v := (${take(delivery, uid, k)})->>'status'; EXCEPTION WHEN OTHERS THEN v := SQLERRM; END;
      RAISE NOTICE 'WAITED % %', extract(epoch FROM clock_timestamp() - t0), v; END $s$;
    SELECT pg_sleep(4); COMMIT;`);
});

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  docker(PSQL, { input: `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${DRIVER2}', 'avail-driver2@example.invalid', '{"full_name":"[AVAIL] Driver Two","role":"driver"}'::jsonb),
      ('${OFF_DRIVER}', 'avail-off@example.invalid', '{"full_name":"[AVAIL] Off Driver","role":"driver"}'::jsonb),
      ('${DENIED_DRIVER}', 'avail-denied@example.invalid', '{"full_name":"[AVAIL] Denied Driver","role":"driver"}'::jsonb),
      ('${NULL_ENTRY_DRIVER}', 'avail-null@example.invalid', '{"full_name":"[AVAIL] Null Entry Driver","role":"driver"}'::jsonb),
      ('${REVOKED_DRIVER}', 'avail-revoked@example.invalid', '{"full_name":"[AVAIL] Revoked Driver","role":"driver"}'::jsonb),
      ('${DEMOTED_REP}', 'avail-demoted@example.invalid', '{"full_name":"[AVAIL] Demoted Rep","role":"sales_rep"}'::jsonb);
    SET session_replication_role = replica;
    UPDATE public.profiles SET is_active = false WHERE id = '${OFF_DRIVER}';
    UPDATE public.profiles SET denied_pages = '{deliveries}' WHERE id = '${DENIED_DRIVER}';
    UPDATE public.profiles SET denied_pages = ARRAY['reports', NULL] WHERE id = '${NULL_ENTRY_DRIVER}';
    UPDATE public.profiles SET role = 'sales_rep' WHERE id = '${DEMOTED_REP}';
    INSERT INTO public.customers (id, farm_name, parent_customer_id) VALUES
      ('${A}', 'Alpha Top Farms', NULL), ('${B}', 'Bravo Farms', '${A}'), ('${C}', 'Charlie Farms', '${B}'), ('${D}', 'Delta Farms', NULL);
    -- Distinctive values a driver must never receive (part 6 and 8), plus the addresses a driver may.
    UPDATE public.customers SET credit_limit_cents = 987654321, prepay_balance_cents = 123456789,
      payment_terms = 'ZZTERMS2018', notes = 'ZZNOTE2018', phone = '555-0104', email = 'delta@example.invalid',
      billing_address = 'BILL 1 Rd', shipping_address = 'SHIP 9 Ln' WHERE id = '${D}';
    UPDATE public.customers SET billing_address = 'A Billing St', shipping_address = '  ' WHERE id = '${A}';
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, scheduled_date, status, assigned_driver, deleted_at) VALUES
      ('${DEL.open1}', 'AV-01', gen_random_uuid(), '${C}', '${USERS.admin}', '2026-06-10', 'scheduled', NULL, NULL),
      ('${DEL.open2}', 'AV-02', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-11', 'scheduled', NULL, NULL),
      ('${DEL.mine}', 'AV-03', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-01', 'scheduled', '${USERS.driver}', NULL),
      ('${DEL.started}', 'AV-04', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-01', 'in_progress', NULL, NULL),
      ('${DEL.deleted}', 'AV-05', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-01', 'scheduled', NULL, now()),
      ('${DEL.race}', 'AV-06', gen_random_uuid(), '${B}', '${USERS.admin}', '2026-06-12', 'scheduled', NULL, NULL),
      ('${DEL.other}', 'AV-07', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-02', 'scheduled', '${DRIVER2}', NULL),
      ('${DEL.double}', 'AV-08', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-13', 'scheduled', NULL, NULL),
      ('${DEL.replay}', 'AV-09', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-14', 'scheduled', NULL, NULL),
      ('${DEL.late}', 'AV-00', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-08-01', 'scheduled', NULL, NULL),
      ('${DEL.closed}', 'AV-10', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-01', 'cancelled', '${USERS.driver}', NULL),
      ('${DEL.revoke}', 'AV-11', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-15', 'scheduled', NULL, NULL),
      ('${DEL.voidopen}', 'AV-12', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-01', 'cancelled', NULL, NULL),
      ('${DEL.cancelme}', 'AV-13', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-16', 'scheduled', NULL, NULL),
      ('${DEL.inprog}', 'AV-14', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-01', 'in_progress', '${USERS.driver}', NULL),
      ('${DEL.done}', 'AV-15', gen_random_uuid(), '${D}', '${USERS.admin}', '2026-06-01', 'completed', '${USERS.driver}', NULL);
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, scheduled_date, status)
      SELECT 'AV-X' || lpad(g::text, 2, '0'), gen_random_uuid(), '${D}', '${USERS.admin}', date '2026-07-01' + g, 'scheduled'
      FROM generate_series(1, 25) g;
    SET session_replication_role = origin;` });

  // Before the candidate: the driver's direct read finds no open delivery (the bug).
  assert.equal(attempt(USERS.driver, asUser("v := (SELECT count(*) FROM public.deliveries WHERE assigned_driver IS NULL AND status = 'scheduled')::text;")), 'ok|0');
  // Before the candidate: a driver CAN change their in-progress and completed deliveries straight through the table.
  assert.equal(attempt(USERS.driver, `${directEdit('is_quick_delivery = NOT is_quick_delivery')}`), 'ok|2', 'before: the driver direct edit works');

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
  // AV-00 has the lowest number but the latest date: it must come last (date order, not number order).
  const expected = ['AV-01=Charlie Farms/Alpha Top Farms', 'AV-02=Delta Farms/-', 'AV-06=Bravo Farms/Alpha Top Farms', 'AV-08=Delta Farms/-',
    'AV-09=Delta Farms/-', 'AV-11=Delta Farms/-', 'AV-13=Delta Farms/-', ...extra, 'AV-00=Delta Farms/-'];
  assert.equal(attempt(USERS.driver, asUser(LIST)), `ok|${expected.join(',')}`, 'every open delivery, in order, nothing else');
  assert.equal(attempt(USERS.driver, `${asUser('r := public.get_available_deliveries_for_driver();')}
    v := (r->'rows'->0->>'id') || '/' || (r->'rows'->0->>'scheduled_date') || '/' || (r->'rows'->-1->>'id') || '/' || (r->'rows'->-1->>'scheduled_date');`),
    `ok|${DEL.open1}/2026-06-10/${DEL.late}/2026-08-01`, 'ids and dates are the rows own');
  // A stray null entry in denied_pages does not lock out a driver allowed the Deliveries page.
  assert.equal(attempt(NULL_ENTRY_DRIVER, asUser(LIST)), `ok|${expected.join(',')}`, 'a null denied_pages entry does not refuse');
  assert.equal(attempt(USERS.driver, `${asUser('r := public.get_available_deliveries_for_driver();')} v := (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r->'rows'->0) k);`),
    'ok|customer_name,delivery_number,farm_group_name,id,scheduled_date', 'only the five card fields leave the database');
  // A farm-group loop forced past the KI-146 trigger (B <-> C, detached from A) still returns: direct parent shown.
  assert.match(attempt(USERS.driver, `SET LOCAL session_replication_role = replica; UPDATE public.customers SET parent_customer_id = '${C}' WHERE id = '${B}';
    SET LOCAL session_replication_role = origin; SET LOCAL statement_timeout = '5s'; ${asUser(LIST)}`),
    /^ok\|AV-01=Charlie Farms\/Bravo Farms,AV-02=Delta Farms\/-,AV-06=Bravo Farms\/Charlie Farms,/);
  console.log('[read] driver sees every open delivery in order, five fields, top farm group; a loop still returns');

  // 2. Everyone else is refused.
  for (const [who, uid] of Object.entries({ admin: USERS.admin, rep: USERS.rep, applicator: USERS.applicator, off_driver: OFF_DRIVER, denied_driver: DENIED_DRIVER })) {
    assert.equal(attempt(uid, `${refuse('r := public.get_available_deliveries_for_driver();')} v := t;`), 'ok|Not authorized to view available deliveries', `${who} must be refused`);
  }
  assert.match(attempt(USERS.driver, `SET LOCAL ROLE anon; BEGIN r := public.get_available_deliveries_for_driver(); v := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN v := SQLERRM; END; RESET ROLE;`),
    /^ok\|permission denied/, 'anon has no execute');
  console.log('[read] admin, sales rep, applicator, inactive driver, driver denied Deliveries refused; anon has no execute');

  // 3. A driver takes an open delivery for themself only.
  assert.equal(attempt(USERS.driver, `${refuse(`r := ${take(DEL.open1, DRIVER2)};`)} v := t;`), REFUSED, 'a driver cannot assign to someone else');
  assert.equal(attempt(OFF_DRIVER, `${refuse(`r := ${take(DEL.open1, OFF_DRIVER)};`)} v := t;`), REFUSED, 'an inactive driver cannot take');
  assert.equal(attempt(DENIED_DRIVER, `${refuse(`r := ${take(DEL.open1, DENIED_DRIVER)};`)} v := t;`), REFUSED, 'a driver denied Deliveries cannot take');
  assert.equal(attempt(USERS.applicator, `${refuse(`r := ${take(DEL.open1, USERS.applicator)};`)} v := t;`), REFUSED, 'an applicator cannot take');
  assert.equal(attempt(USERS.driver, `${refuse(`r := ${take(DEL.other, USERS.driver)};`)} v := t;`), GONE, 'a driver cannot take a delivery already taken');
  assert.equal(attempt(USERS.driver, `${refuse(`r := ${take(DEL.started, USERS.driver)};`)} v := t;`), GONE, 'a driver cannot take a started delivery');
  assert.equal(attempt(USERS.driver, `${refuse(`r := ${take(DEL.deleted, USERS.driver)};`)} v := t;`), GONE, 'a driver cannot take a deleted delivery');
  assert.equal(attempt(USERS.driver, `${refuse(`r := ${take(DEL.closed, USERS.driver)};`)} v := t;`), GONE, 'a cancelled one of theirs is taken-or-changed, not already-yours');
  const k1 = key();
  assert.equal(attempt(USERS.driver, `${asUser(`r := ${take(DEL.open1, USERS.driver, k1)};`)} v := r->>'status';`, { commit: true }), 'ok|reassigned');
  assert.equal(owner(DEL.open1), USERS.driver);
  assert.equal(attempt(USERS.driver, `${asUser(`r := ${take(DEL.open1, USERS.driver, k1)};`)} v := r->>'status';`), 'ok|reassigned', 'a retry with the same key replays');
  assert.equal(attempt(USERS.driver, `${refuse(`r := ${take(DEL.open1, USERS.driver)};`)} v := t;`), MINE, 'a fresh key on a delivery already yours says so');
  assert.equal(attempt(DRIVER2, `${refuse(`r := ${take(DEL.open1, DRIVER2)};`)} v := t;`), GONE, 'another driver cannot take it afterwards');
  const after = attempt(USERS.driver, asUser(LIST));
  assert.ok(after.startsWith('ok|AV-02='), `the list still loads after the take: ${after}`);
  assert.ok(!after.includes('AV-01='), 'a taken delivery leaves the list');
  // A same-key replay after dispatch moved the delivery: the current state wins.
  const k4 = key();
  assert.equal(attempt(USERS.driver, `${asUser(`r := ${take(DEL.replay, USERS.driver, k4)};`)} v := r->>'status';`, { commit: true }), 'ok|reassigned');
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${take(DEL.replay, DRIVER2)};`)} v := r->>'status';`, { commit: true }), 'ok|reassigned');
  assert.equal(attempt(USERS.driver, `${refuse(`r := ${take(DEL.replay, USERS.driver, k4)};`)} v := t;`), GONE, 'a replay for a delivery dispatch moved is refused');
  // A same-key replay after dispatch cancelled it (still assigned): the current state wins.
  const k6 = key();
  assert.equal(attempt(USERS.driver, `${asUser(`r := ${take(DEL.cancelme, USERS.driver, k6)};`)} v := r->>'status';`, { commit: true }), 'ok|reassigned');
  docker(PSQL, { input: `SET session_replication_role = replica; UPDATE public.deliveries SET status = 'cancelled' WHERE id = '${DEL.cancelme}';` });
  assert.equal(attempt(USERS.driver, `${refuse(`r := ${take(DEL.cancelme, USERS.driver, k6)};`)} v := t;`), GONE, 'a replay for a cancelled delivery is refused');
  console.log('[take] self only, open only; inactive, denied and applicator refused; retry replays; own fresh key named; taken delivery leaves the list');

  // 4. Two drivers take one delivery at once: whoever locks first holds it 4 s; the other waits, then is refused.
  // Order-independent: a slow container start may let either driver win.
  const racers = await Promise.all([session(USERS.driver, 0, key(), DEL.race), session(DRIVER2, 0.5, key(), DEL.race)]);
  const winners = racers.filter((r) => r.result === 'reassigned');
  const losers = racers.filter((r) => /already taken or changed/.test(r.result));
  assert.ok(winners.length === 1 && losers.length === 1, `exactly one driver wins:\n${racers.map((r) => r.out).join('\n---\n')}`);
  // The winner holds its lock 4 s after its call and the two calls start about 0.5 s apart, so the loser waits inside.
  assert.ok(losers[0].waited >= 0.5, `the refused driver's call must have waited on the winner's lock (${losers[0].waited} s)`);
  assert.equal(owner(DEL.race), racers[0] === winners[0] ? USERS.driver : DRIVER2, 'the winner keeps it');
  // One driver's double tap with the same key, at once: both calls report success, one assignment, one notification.
  const k2 = key();
  const [tap1, tap2] = await Promise.all([session(DRIVER2, 0, k2, DEL.double), session(DRIVER2, 0.5, k2, DEL.double)]);
  assert.ok(Math.max(tap1.waited, tap2.waited) >= 0.5, `one tap must have waited on the other (${tap1.waited} s, ${tap2.waited} s)`);
  assert.equal(tap1.result, 'reassigned', tap1.out);
  assert.equal(tap2.result, 'reassigned', tap2.out);
  assert.ok(tap1.code === 0 && tap2.code === 0, `both taps must commit:\n${tap1.out}\n---\n${tap2.out}`);
  assert.equal(owner(DEL.double), DRIVER2);
  assert.equal(scalar(`SELECT count(*) FROM public.notifications WHERE related_entity_id = '${DEL.double}';`), '1', 'a double tap notifies once');
  // A take waiting on dispatch's row lock is refused if the driver is denied Deliveries before the lock frees.
  const [dispatch, revoked] = await Promise.all([
    raw(`BEGIN; SELECT 1 FROM public.deliveries WHERE id = '${DEL.revoke}' FOR UPDATE; SELECT pg_sleep(4);
      ${claims(USERS.admin)} UPDATE public.profiles SET denied_pages = '{deliveries}' WHERE id = '${REVOKED_DRIVER}'; COMMIT;`, 0),
    session(REVOKED_DRIVER, 0.5, key(), DEL.revoke)]);
  assert.equal(dispatch.code, 0, dispatch.out);
  assert.ok(revoked.waited >= 0.5, `the take must have waited on dispatch (${revoked.waited} s)`);
  assert.equal(revoked.result, 'Not authorized to reassign deliveries', revoked.out);
  assert.equal(owner(DEL.revoke), '-', 'the revoked driver did not get it');
  console.log('[race] access revoked while a take waits: refused');
  // A sales rep demoted to driver while their call waits on its key is refused (no office power after the wait).
  const k5 = key();
  const [demote, demoted] = await Promise.all([
    raw(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('crx:idempotency:' || ${k5}, 0)); SELECT pg_sleep(4);
      ${claims(USERS.admin)} UPDATE public.profiles SET role = 'driver' WHERE id = '${DEMOTED_REP}'; COMMIT;`, 0),
    session(DEMOTED_REP, 0.5, k5, DEL.open2)]);
  assert.equal(demote.code, 0, demote.out);
  assert.ok(demoted.waited >= 0.5, `the call must have waited on its key (${demoted.waited} s)`);
  assert.equal(demoted.result, 'Not authorized to reassign deliveries', demoted.out);
  assert.equal(owner(DEL.open2), '-', 'the demoted rep assigned nothing');
  console.log('[race] office role removed while a call waits: refused');
  console.log('[race] two drivers at once: one wins and keeps it, the other waits and is refused; a double tap notifies once');

  // 5. Admin and sales rep reassign as before (scheduled and in-progress, to anyone).
  const k3 = key();
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${take(DEL.mine, DRIVER2, k3)};`)} v := r->>'status';`, { commit: true }), 'ok|reassigned');
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${take(DEL.mine, DRIVER2, k3)};`)} v := r::text;`),
    `ok|{"status": "reassigned", "delivery_id": "${DEL.mine}"}`, 'an admin same-key retry replays the same result');
  assert.equal(scalar(`SELECT count(*) FROM public.notifications WHERE related_entity_id = '${DEL.mine}' AND title = 'New Delivery Assigned';`), '1', 'the admin retry notifies once');
  assert.equal(attempt(USERS.rep, `${asUser(`r := ${take(DEL.started, USERS.driver)};`)} v := r->>'status';`), 'ok|reassigned');
  console.log('[take] admin and sales rep reassign as before');

  // 6. A driver's farm contact lookup: any farm, five fields, delivery address = shipping, else billing.
  const CONTACTS = `r := public.get_driver_customers(ARRAY['${D}', '${A}', '${B}', '${D}', '${id('ff')}']::uuid[]);`;
  assert.equal(attempt(USERS.driver, `${asUser(CONTACTS)} v := (SELECT string_agg((e->>'farm_name') || '=' || COALESCE(e->>'address', '-'), ',' ORDER BY e->>'id') FROM jsonb_array_elements(r->'rows') e);`),
    'ok|Alpha Top Farms=A Billing St,Bravo Farms=-,Delta Farms=SHIP 9 Ln', 'one row per known farm, shipping else billing');
  assert.equal(attempt(USERS.driver, `${asUser(CONTACTS)} v := (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r->'rows'->2) k) || ' ' || (r->'rows'->2->>'phone') || ' ' || (r->'rows'->2->>'email');`),
    'ok|address,email,farm_name,id,phone 555-0104 delta@example.invalid', 'only five fields');
  const contactsText = attempt(USERS.driver, `${asUser(CONTACTS)} v := r::text;`);
  for (const secret of SECRETS) assert.ok(!contactsText.includes(secret), `the contact lookup must not return ${secret}`);
  assert.equal(attempt(DENIED_DRIVER, `${asUser("r := public.get_driver_customers('{}'::uuid[]);")} v := r::text;`), 'ok|{"rows": []}', 'an empty request returns no rows');
  assert.equal(attempt(USERS.driver, `${refuse('r := public.get_driver_customers(NULL);')} v := t;`), 'ok|Pass up to 500 farm ids');
  assert.equal(attempt(USERS.driver, `${refuse(`r := public.get_driver_customers(ARRAY(SELECT '${D}'::uuid FROM generate_series(1, 501)));`)} v := t;`), 'ok|Pass up to 500 farm ids');
  for (const [uid, who] of [[USERS.admin, 'admin'], [USERS.rep, 'sales rep'], [USERS.applicator, 'applicator'], [OFF_DRIVER, 'inactive driver']]) {
    assert.equal(attempt(uid, `${refuse(`r := public.get_driver_customers(ARRAY['${D}']::uuid[]);`)} v := t;`), 'ok|Not authorized to view farm contacts', `${who} must be refused`);
  }
  assert.match(attempt(USERS.driver, `SET LOCAL ROLE anon; BEGIN r := public.get_driver_customers(ARRAY['${D}']::uuid[]); v := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN v := SQLERRM; END; RESET ROLE;`),
    /permission denied/, 'anon cannot run the contact lookup');
  console.log('[contacts] a driver gets five safe fields for any farm; everyone else refused');

  // 7. A driver's direct table edits change nothing now; admin and sales rep direct edits still work.
  for (const set of ['is_quick_delivery = NOT is_quick_delivery', "delivery_notes = 'driver edit'", "status = 'completed'"]) {
    assert.equal(attempt(USERS.driver, directEdit(set)), 'ok|0', `a driver direct edit (${set}) changes nothing`);
  }
  assert.equal(scalar(`SELECT string_agg(is_quick_delivery::text || '/' || COALESCE(delivery_notes, '-') || '/' || status, ',' ORDER BY delivery_number) FROM public.deliveries WHERE id IN ('${DEL.inprog}', '${DEL.done}');`),
    'false/-/in_progress,false/-/completed', 'both deliveries are untouched');
  for (const uid of [USERS.admin, USERS.rep]) {
    assert.equal(attempt(uid, asUser(`UPDATE public.deliveries SET delivery_notes = 'office edit' WHERE id = '${DEL.inprog}'; GET DIAGNOSTICS n = ROW_COUNT; v := n::text;`)), 'ok|1', 'office direct edit still works');
  }
  console.log('[edits] a driver direct table edit changes nothing; admin and sales rep still edit');

  // 8. No server function hands a driver the secret farm fields; the same sweep as an admin does find them.
  const driverSweep = attempt(USERS.driver, SWEEP);
  assert.match(driverSweep, /^ok\|\d+:$/, `functions showing a driver secret farm fields: ${driverSweep}`);
  const adminSweep = attempt(USERS.admin, SWEEP);
  assert.match(adminSweep, /^ok\|\d+:\S/, `the sweep must see the secrets as an admin: ${adminSweep}`);
  console.log(`[sweep] driver: ${driverSweep.split('|')[1].split(':')[0]} functions answered, none showed a secret; admin sees them in: ${adminSweep.split(':')[1]}`);

  console.log('\nDRIVER_AVAILABLE_DELIVERIES_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
