#!/usr/bin/env node
/**
 * Real-schema proof for 20270129200000_inactive_customer_refuses_new_work (#2000; contract
 * docs/plans/2026-11-19-inactive-customer-no-new-work-CONTRACT.md, proof cases 1 to 8).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (KI-148's deactivation check included), shows
 * an inactive customer can get a new order today, applies the candidate, then checks that new, reopened and
 * moved orders, deliveries, holds and spray jobs are refused for an inactive customer for every role, that
 * finishing down existing work stays allowed, and that two sessions racing a deactivation against a new
 * order cannot both win.
 *
 * Run: node scripts/smoke/prove-inactive-customer-new-work-real-schema.mjs   (needs Docker)
 * Prints INACTIVE_CUSTOMER_NEW_WORK_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

process.env.UNDO_PATHS_CONTAINER ||= `crx-inactive-work-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, scalar, psql, claims, USERS, ROOT, NAME, docker, id } =
  await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270129200000_inactive_customer_refuses_new_work.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const ADMIN = USERS.admin;
const REP = USERS.rep;
const DRIVER = USERS.driver;
const PRODUCT = id('d1');
const ACTIVE = id('c1'); // active customer
const INACTIVE = id('c2'); // inactive, with open and closed work (like the live customer with 2 confirmed orders)
const RACE1 = id('c3'); // active, deactivated while an order is being saved
const RACE2 = id('c4'); // active, gets an order while a deactivation is running
const RACE3 = id('c5'); // active, its deactivation rolls back while an order waits
// Fixture rows of INACTIVE (seeded past the other triggers) and of ACTIVE.
const R = {
  openOrder: id('e1'), cancelledOrder: id('e2'), deletedOrder: id('e3'), activeOrder: id('e4'), activeDone: id('e5'), inactiveDone: id('e6'),
  delDelivery: id('e7'), activeDelivery: id('e8'),
  offHold: id('e9'), expiredHold: id('ea'), openHold: id('eb'), activeHold: id('ec'),
  delJob: id('ed'), activeJob: id('ee'), openJob: id('ef'), activeClosed: id('f1'),
};
const W = /CUSTOMER_INACTIVE_NEW_WORK: nothing was saved\. This customer is inactive\. An admin or sales rep must reactivate the customer before new orders, deliveries, stock holds or spray jobs are added/;

// One script as `role`, signed in as `uid` (null: no claims at all); the last output line is the answer.
function run(uid, sql, { role = 'authenticated', commit = false } = {}) {
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
    { input: `BEGIN;\n${uid ? claims(uid) : ''}\n${role === 'postgres' ? '' : `SET LOCAL ROLE ${role};`}\n${sql}\n${commit ? 'COMMIT' : 'ROLLBACK'};`, allowFailure: true });
  return { status: r.status, out: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '', err: r.stderr };
}
const allowed = (sql, opts = { role: 'postgres' }) => { const r = run(opts.uid ?? ADMIN, sql, opts); assert.equal(r.status, 0, `${sql}\n${r.err}`); return r.out; };
const refused = (sql, pattern = W, opts = { role: 'postgres' }, uid = ADMIN) => {
  const r = run(uid, sql, opts);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`); assert.match(r.err, pattern, r.err);
};

let n = 0;
const newOrder = (cid, status = 'confirmed') => `INSERT INTO public.orders (order_number, customer_id, status) VALUES ('NW-O${++n}', '${cid}', '${status}');`;
const newDelivery = (cid, orderId) => `INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, status)
  VALUES ('NW-D${++n}', '${orderId}', '${cid}', '${ADMIN}', 'scheduled');`;
const newHold = (cid, source = null) => `INSERT INTO public.inventory_holds (product_id, customer_id, quantity, created_by, is_active, hold_type, source_id)
  VALUES ('${PRODUCT}', '${cid}', 1, '${ADMIN}', true, 'job', ${source ? `'${source}'` : 'NULL'});`;
const newJob = (cid, status = 'scheduled') => `INSERT INTO public.jobs (job_number, customer_id, job_date, status) VALUES ('NW-J${++n}', '${cid}', current_date, '${status}');`;

function seed() {
  buildContainer({ stopBefore: CANDIDATE }); seedUsers();
  psql(`BEGIN; SET LOCAL session_replication_role = replica; ${claims(ADMIN)}
    INSERT INTO public.customers (id, farm_name, is_active) VALUES
      ('${ACTIVE}', '[NEWWORK] active', true), ('${INACTIVE}', '[NEWWORK] inactive', false),
      ('${RACE1}', '[NEWWORK] race1', true), ('${RACE2}', '[NEWWORK] race2', true),
      ('${RACE3}', '[NEWWORK] race3', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, tier1_price, tier2_price, tier3_price, pricing_version, is_active)
      VALUES ('${PRODUCT}', '[NEWWORK] Product', 'NW-P', 'liquid', 'Gal', 'Gal', 40, 36, 32, 1, true);
    INSERT INTO public.orders (id, order_number, customer_id, status, deleted_at) VALUES
      ('${R.openOrder}', 'NW-OPEN', '${INACTIVE}', 'confirmed', NULL),
      ('${R.cancelledOrder}', 'NW-CANC', '${INACTIVE}', 'cancelled', NULL),
      ('${R.deletedOrder}', 'NW-DEL', '${INACTIVE}', 'confirmed', now()),
      ('${R.inactiveDone}', 'NW-IDONE', '${INACTIVE}', 'fulfilled', NULL),
      ('${R.activeOrder}', 'NW-AOPEN', '${ACTIVE}', 'confirmed', NULL),
      ('${R.activeDone}', 'NW-ADONE', '${ACTIVE}', 'fulfilled', NULL),
      ('${R.activeClosed}', 'NW-ACLOSED', '${ACTIVE}', 'cancelled', NULL);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, deleted_at) VALUES
      ('${R.delDelivery}', 'NW-DDEL', '${R.inactiveDone}', '${INACTIVE}', '${ADMIN}', 'scheduled', now()),
      ('${R.activeDelivery}', 'NW-DACT', '${R.activeDone}', '${ACTIVE}', '${ADMIN}', 'scheduled', NULL);
    INSERT INTO public.inventory_holds (id, product_id, customer_id, quantity, created_by, is_active, expires_at, hold_type) VALUES
      ('${R.offHold}', '${PRODUCT}', '${INACTIVE}', 1, '${ADMIN}', false, NULL, 'manual'),
      ('${R.expiredHold}', '${PRODUCT}', '${INACTIVE}', 1, '${ADMIN}', true, (now() AT TIME ZONE 'America/Chicago')::date - 1, 'manual'),
      ('${R.openHold}', '${PRODUCT}', '${INACTIVE}', 1, '${ADMIN}', true, NULL, 'manual'),
      ('${R.activeHold}', '${PRODUCT}', '${ACTIVE}', 1, '${ADMIN}', true, NULL, 'manual');
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, deleted_at) VALUES
      ('${R.delJob}', 'NW-JDEL', '${INACTIVE}', current_date, 'scheduled', now()),
      ('${R.openJob}', 'NW-JOPEN', '${INACTIVE}', current_date, 'scheduled', NULL),
      ('${R.activeJob}', 'NW-JACT', '${ACTIVE}', current_date, 'scheduled', NULL);
    COMMIT;`, { user: 'supabase_admin' });
}

// Two psql sessions at once: `first` starts, `second` starts after `delayMs`; resolves both results.
function session(sql) {
  return new Promise((resolve) => {
    const p = spawn('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { cwd: ROOT });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (status) => resolve({ status, out, err, at: Date.now() }));
    p.stdin.end(sql);
  });
}
async function race(first, second, delayMs = 1500) {
  const a = session(first);
  await new Promise((r) => { setTimeout(r, delayMs); });
  const start = Date.now();
  const b = await session(second);
  return { a: await a, b, bWaitedMs: b.at - start };
}

async function main() {
  seed();
  // Case 8, before: an inactive customer gets a new order today (rolled back).
  allowed(newOrder(INACTIVE));
  console.log('[new-work] BEFORE: a new order for an inactive customer is saved (the hole is real)');

  const applied = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
    { input: candidate, allowFailure: true });
  assert.equal(applied.status, 0, `candidate failed:\n${applied.stderr}`);
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
    { input: candidate, allowFailure: true });
  assert.notEqual(again.status, 0); assert.match(again.stderr, /INACTIVE_NEW_WORK_PREFLIGHT: the guard already exists/);
  console.log('[new-work] candidate applied; postflight passed; a second apply is refused by the preflight');

  // Case 1 and 5: every new row for the inactive customer is refused; the same row for the active one is saved.
  const inserts = {
    order: (c) => newOrder(c), 'closed order': (c) => newOrder(c, 'fulfilled'),
    delivery: (c) => newDelivery(c, c === ACTIVE ? R.activeDone : R.inactiveDone),
    'job-type hold with no source': (c) => newHold(c), job: (c) => newJob(c), 'cancelled job': (c) => newJob(c, 'cancelled'),
  };
  for (const sql of Object.values(inserts)) {
    allowed(sql(ACTIVE));
    refused(sql(INACTIVE));
    refused(sql(INACTIVE), W, { role: 'service_role' }, null);
  }
  // A hold built from a job (source set) follows its job (starting an existing job rebuilds its holds).
  allowed(newHold(INACTIVE, R.openJob));
  console.log('[new-work] new order (open or closed), delivery, source-free hold of any type and spray job: refused for the inactive customer as postgres and service_role; saved for the active one; a job-built hold is left to its job');
  // Signed-in admin and rep (the guard ignores who is asking; row-level security does not hide the flag).
  for (const uid of [ADMIN, REP]) refused(newJob(INACTIVE), W, { role: 'authenticated' }, uid);
  // A driver may not add a spray job: the same permission error for either customer, so it reveals no status.
  const driverErr = (cid) => { const r = run(DRIVER, newJob(cid)); assert.notEqual(r.status, 0, 'a driver saved a spray job'); return r.err.replace(/NW-J\d+/g, ''); };
  const [driverActive, driverInactive] = [driverErr(ACTIVE), driverErr(INACTIVE)];
  assert.doesNotMatch(driverInactive, /CUSTOMER_INACTIVE_NEW_WORK/, driverInactive);
  assert.equal(driverInactive, driverActive);
  console.log(`[new-work] a driver adding a spray job gets the same permission error for an active and an inactive customer: ${driverActive.split('\n')[0]}`);
  // The real screen path for a hold: create_inventory_hold, signed in.
  const holdRpc = (cid, uid) => `SELECT (public.create_inventory_hold('${PRODUCT}', '${cid}', 1, 'manual', NULL, 'NW', '${uid}', true, 'prover', gen_random_uuid()::text)) IS NOT NULL;`;
  // Admin with force (no stock is seeded; a rep may not force, so the rep is proved on the job insert above).
  assert.equal(allowed(holdRpc(ACTIVE, ADMIN), { role: 'authenticated', uid: ADMIN }), 't');
  refused(holdRpc(INACTIVE, ADMIN), W, { role: 'authenticated' }, ADMIN);
  console.log('[new-work] signed in: create_inventory_hold (admin) saves for the active customer and is refused for the inactive one; a direct spray job insert by an admin and a sales rep is refused');

  // Case 6: a delivery of the inactive customer's order is refused even when its row names an active customer.
  refused(newDelivery(ACTIVE, R.inactiveDone));
  refused(newDelivery(INACTIVE, R.activeDone));
  console.log('[new-work] a delivery is refused when either its own customer or its order\'s customer is inactive');

  // Case 2: reopening closed work of the inactive customer.
  const reopen = {
    'undelete a confirmed order': `UPDATE public.orders SET deleted_at = NULL WHERE id = '${R.deletedOrder}';`,
    'undelete a scheduled delivery': `UPDATE public.deliveries SET deleted_at = NULL WHERE id = '${R.delDelivery}';`,
    'switch a hold back on': `UPDATE public.inventory_holds SET is_active = true WHERE id = '${R.offHold}';`,
    'extend an expired hold': `UPDATE public.inventory_holds SET expires_at = NULL WHERE id = '${R.expiredHold}';`,
    'undelete a scheduled job': `UPDATE public.jobs SET deleted_at = NULL WHERE id = '${R.delJob}';`,
  };
  // Restoring a deleted order is already refused by an older guard: that route does not exist.
  refused(reopen['undelete a confirmed order'], /ORDER_DELETED_STATUS_LOCKED/);
  delete reopen['undelete a confirmed order'];
  for (const sql of Object.values(reopen)) refused(sql);
  console.log(`[new-work] reopening refused: ${Object.keys(reopen).join(', ')} (restoring a deleted order was already impossible)`);

  // Case 3: moving open work onto the inactive customer.
  const move = {
    order: `UPDATE public.orders SET customer_id = '${INACTIVE}' WHERE id = '${R.activeOrder}';`,
    'delivery (customer)': `UPDATE public.deliveries SET customer_id = '${INACTIVE}' WHERE id = '${R.activeDelivery}';`,
    'delivery (order)': `UPDATE public.deliveries SET order_id = '${R.inactiveDone}' WHERE id = '${R.activeDelivery}';`,
    hold: `UPDATE public.inventory_holds SET customer_id = '${INACTIVE}' WHERE id = '${R.activeHold}';`,
    job: `UPDATE public.jobs SET customer_id = '${INACTIVE}' WHERE id = '${R.activeJob}';`,
    'closed order': `UPDATE public.orders SET customer_id = '${INACTIVE}' WHERE id = '${R.activeClosed}';`,
  };
  for (const sql of Object.values(move)) refused(sql);
  console.log(`[new-work] moving work onto the inactive customer refused: ${Object.keys(move).join(', ')}`);

  // Case 4: finishing down existing work of the inactive customer stays allowed.
  const finish = {
    'edit an open order': `UPDATE public.orders SET notes = 'edited' WHERE id = '${R.openOrder}' RETURNING 1;`,
    'part-fill an open order': `UPDATE public.orders SET status = 'partially_fulfilled' WHERE id = '${R.openOrder}' RETURNING 1;`,
    'cancel an open order': `UPDATE public.orders SET status = 'cancelled' WHERE id = '${R.openOrder}' RETURNING 1;`,
    'release a hold': `UPDATE public.inventory_holds SET is_active = false WHERE id = '${R.openHold}' RETURNING 1;`,
    'start a scheduled job': `UPDATE public.jobs SET status = 'in_progress' WHERE id = '${R.openJob}' RETURNING 1;`,
    'cancel a scheduled job': `UPDATE public.jobs SET status = 'cancelled' WHERE id = '${R.openJob}' RETURNING 1;`,
  };
  for (const sql of Object.values(finish)) assert.equal(allowed(sql), '1', sql);
  console.log(`[new-work] still allowed on the inactive customer's existing work: ${Object.keys(finish).join(', ')}`);

  // Case 5: reactivating lifts the refusal.
  assert.equal(allowed(`UPDATE public.customers SET is_active = true WHERE id = '${INACTIVE}' RETURNING 1; ${newOrder(INACTIVE)} SELECT 1;`), '1');
  console.log('[new-work] after reactivation the same new order is saved');

  // Case 7a: a deactivation is running when an order is saved: the order waits, then is refused.
  const r1 = await race(
    `BEGIN; UPDATE public.customers SET is_active = false WHERE id = '${RACE1}'; SELECT pg_sleep(4); COMMIT;`,
    `BEGIN; ${newOrder(RACE1)} COMMIT;`);
  assert.equal(r1.a.status, 0, r1.a.err);
  assert.notEqual(r1.b.status, 0, 'the racing order was saved'); assert.match(r1.b.err, /CUSTOMER_INACTIVE_NEW_WORK/);
  assert.ok(r1.bWaitedMs >= 1500, `the order did not wait for the deactivation (${r1.bWaitedMs} ms)`);
  assert.equal(scalar(`SELECT count(*) FROM public.orders WHERE customer_id = '${RACE1}';`), '0');
  console.log(`[new-work] race 1: an order saved during a deactivation waited ${r1.bWaitedMs} ms, then was refused; customer inactive, no order`);

  // Case 7b: an order is being saved when the deactivation runs: the deactivation waits, then KI-148 refuses it.
  const r2 = await race(
    `BEGIN; ${newOrder(RACE2)} SELECT pg_sleep(4); COMMIT;`,
    `BEGIN; UPDATE public.customers SET is_active = false WHERE id = '${RACE2}'; COMMIT;`);
  assert.equal(r2.a.status, 0, r2.a.err);
  assert.notEqual(r2.b.status, 0, 'the racing deactivation went through'); assert.match(r2.b.err, /CUSTOMER_HAS_OPEN_WORK: nothing was deactivated\. \[NEWWORK\] race2 still has 1 open order/);
  assert.ok(r2.bWaitedMs >= 1500, `the deactivation did not wait for the order (${r2.bWaitedMs} ms)`);
  assert.equal(scalar(`SELECT is_active FROM public.customers WHERE id = '${RACE2}';`), 't');
  console.log(`[new-work] race 2: a deactivation during an order save waited ${r2.bWaitedMs} ms, then KI-148 refused it; customer active with its order`);

  // Case 7c: a deactivation that rolls back lets the waiting order through.
  const r3 = await race(
    `BEGIN; UPDATE public.customers SET is_active = false WHERE id = '${RACE3}'; SELECT pg_sleep(4); ROLLBACK;`,
    `BEGIN; ${newOrder(RACE3)} COMMIT;`);
  assert.equal(r3.a.status, 0, r3.a.err); assert.equal(r3.b.status, 0, r3.b.err);
  assert.ok(r3.bWaitedMs >= 1500, `the order did not wait (${r3.bWaitedMs} ms)`);
  assert.equal(scalar(`SELECT count(*) FROM public.orders WHERE customer_id = '${RACE3}';`), '1');
  console.log(`[new-work] race 3: a deactivation that rolled back released the waiting order after ${r3.bWaitedMs} ms; it was saved`);

  // Case 7d: a delivery is being saved on a closed order when someone moves that order to another
  // customer: the move waits for the delivery, then the older lineage guard refuses it.
  const r4 = await race(
    `BEGIN; ${newDelivery(ACTIVE, R.activeClosed)} SELECT pg_sleep(4); COMMIT;`,
    `BEGIN; UPDATE public.orders SET customer_id = '${RACE3}' WHERE id = '${R.activeClosed}'; COMMIT;`);
  assert.equal(r4.a.status, 0, r4.a.err);
  assert.notEqual(r4.b.status, 0, 'the order moved under a new delivery'); assert.match(r4.b.err, /ORDER_CUSTOMER_LINEAGE_LOCKED/, r4.b.err);
  assert.ok(r4.bWaitedMs >= 1500, `the order move did not wait for the delivery (${r4.bWaitedMs} ms)`);
  assert.equal(scalar(`SELECT customer_id FROM public.orders WHERE id = '${R.activeClosed}';`), ACTIVE);
  console.log(`[new-work] race 4: moving an order while a delivery on it is saved waited ${r4.bWaitedMs} ms, then was refused; the order kept its customer`);

  console.log('INACTIVE_CUSTOMER_NEW_WORK_PROOF_PASS');
}

try { await main(); } finally { if (!KEEP) removeContainer(); else console.log(`Kept ${NAME}`); }
