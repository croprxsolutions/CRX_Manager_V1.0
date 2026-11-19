#!/usr/bin/env node
/**
 * Real-schema proof for 20270128140000_customer_deactivation_checks_open_work (KI-148; contract
 * docs/plans/2026-11-18-ki148-customer-deactivation-CONTRACT.md, proof cases 1 to 8).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (the shared undo-paths harness), shows an admin
 * can deactivate a customer with an open order today, applies the candidate, then checks as a signed-in
 * admin, a sales rep and the server role that every kind of open work refuses deactivation, closed work
 * does not, a bulk update is all-or-nothing, and an already-inactive customer stays editable.
 *
 * Run: node scripts/smoke/prove-ki148-customer-deactivation-real-schema.mjs   (needs Docker)
 * Prints KI148_DEACTIVATION_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

process.env.UNDO_PATHS_CONTAINER ||= `crx-ki148-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, scalar, psql, claims, USERS, ROOT, NAME, docker, id } =
  await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270128140000_customer_deactivation_checks_open_work.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const ADMIN = USERS.admin;
const REP = USERS.rep;
const PRODUCT = id('d1');

// One customer per case; `c` + suffix is its fixture id.
const C = Object.fromEntries(['order', 'partial', 'sched', 'inprog', 'hold', 'qdraft', 'qsent', 'qrevised', 'qacc',
  'posted', 'overdue', 'closed', 'clean', 'inactive', 'bulkok', 'many', 'dorder', 'race', 'race2'].map((k, i) => [k, id(`c${(i + 1).toString(16).padStart(2, '0')}`)]));
const N = Object.fromEntries(Object.keys(C).map((k) => [k, `[KI148] ${k}`]));

// One statement as `role`, signed in as `uid` (null: no claims at all); the last output line is the answer.
function run(uid, sql, { role = 'authenticated', commit = false, iso = '' } = {}) {
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
    { input: `BEGIN${iso ? ` ISOLATION LEVEL ${iso}` : ''};\n${uid ? claims(uid) : ''}\n${role === 'postgres' ? '' : `SET LOCAL ROLE ${role};`}\n${sql}\n${commit ? 'COMMIT' : 'ROLLBACK'};`, allowFailure: true });
  return { status: r.status, out: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '', err: r.stderr };
}
const count = (sql) => `WITH w AS (${sql} RETURNING 1) SELECT count(*) FROM w;`;
const deactivate = (ids) => count(`UPDATE public.customers SET is_active = false WHERE id IN (${[].concat(ids).map((x) => `'${x}'`).join(',')})`);
const allowed = (uid, sql, opts) => { const r = run(uid, sql, opts); assert.equal(r.status, 0, `${sql}\n${r.err}`); return r.out; };
const refused = (uid, sql, pattern, opts) => {
  const r = run(uid, sql, opts);
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`); assert.match(r.err, pattern, r.err);
};
const active = (cid) => scalar(`SELECT is_active FROM public.customers WHERE id = '${cid}';`);

function seed() {
  buildContainer({ stopBefore: CANDIDATE }); seedUsers();
  // Fixtures go in past every other trigger (replica), as the other provers seed them; the checks run normally.
  const customers = Object.keys(C).map((k) => `('${C[k]}', '${N[k]}', ${k === 'inactive' ? 'false' : 'true'})`).join(',');
  let n = 0;
  const order = (cid, status, extra = '') => `INSERT INTO public.orders (id, order_number, customer_id, status${extra ? ', quote_id' : ''})
    VALUES ('${id(`e${(++n).toString(16).padStart(2, '0')}`)}', 'KI148-O${n}', '${cid}', '${status}'${extra ? `, ${extra}` : ''});`;
  const fulfilled = (cid) => id(`f${cid.slice(-2)}`);
  const quote = (cid, status, qid = `gen_random_uuid()`) => `INSERT INTO public.quotes (id, quote_number, customer_id, created_by, status)
    VALUES (${qid}, 'KI148-Q${++n}', '${cid}', '${ADMIN}', '${status}');`;
  const invoice = (cid, status) => `INSERT INTO public.invoices (invoice_number, customer_id, status, posted_at)
    VALUES ('KI148-I${++n}', '${cid}', '${status}', ${['draft', 'unposted', 'cancelled'].includes(status) ? 'NULL' : 'now()'});`;
  const delivery = (cid, status, onRow = cid) => `INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, status)
    VALUES ('KI148-D${++n}', '${fulfilled(cid)}', '${onRow}', '${ADMIN}', '${status}');`;
  const hold = (cid, on, expires = 'NULL') => `INSERT INTO public.inventory_holds (product_id, customer_id, quantity, created_by, is_active, expires_at)
    VALUES ('${PRODUCT}', '${cid}', 1, '${ADMIN}', ${on}, ${expires});`;
  const doneOrder = (cid) => `INSERT INTO public.orders (id, order_number, customer_id, status) VALUES ('${fulfilled(cid)}', 'KI148-F${cid.slice(-2)}', '${cid}', 'fulfilled');`;
  psql(`BEGIN; SET LOCAL session_replication_role = replica; ${claims(ADMIN)}
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ${customers};
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, tier1_price, tier2_price, tier3_price, pricing_version, is_active)
      VALUES ('${PRODUCT}', '[KI148] Product', 'KI148-P', 'liquid', 'Gal', 'Gal', 40, 36, 32, 1, true);
    ${Object.values(C).map(doneOrder).join('\n')}
    ${order(C.order, 'confirmed')}
    ${order(C.partial, 'partially_fulfilled')}
    ${delivery(C.sched, 'scheduled')}
    ${delivery(C.inprog, 'in_progress')}
    ${hold(C.hold, true)} ${hold(C.hold, true, "(now() AT TIME ZONE 'America/Chicago')::date")}
    -- A delivery whose row names another customer still counts for the customer of its order.
    ${delivery(C.dorder, 'scheduled', C.many)}
    ${quote(C.qdraft, 'draft')}
    ${quote(C.qsent, 'sent')}
    ${quote(C.qrevised, 'revised')}
    ${invoice(C.posted, 'posted')}
    ${invoice(C.overdue, 'overdue')}
    -- Closed work of every kind: none of it is open.
    ${order(C.closed, 'cancelled')} ${order(C.closed, 'voided')}
    UPDATE public.orders SET deleted_at = now() WHERE order_number = 'KI148-O${n}';
    ${order(C.closed, 'confirmed')} UPDATE public.orders SET deleted_at = now() WHERE order_number = 'KI148-O${n}';
    ${delivery(C.closed, 'completed')} ${delivery(C.closed, 'cancelled')} ${delivery(C.closed, 'voided')}
    ${hold(C.closed, false)} ${hold(C.closed, true, "(now() AT TIME ZONE 'America/Chicago')::date - 1")}
    ${['declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short'].map((s) => quote(C.closed, s)).join('\n')}
    ${quote(C.closed, 'accepted', `'${id('a1')}'`)} ${order(C.closed, 'fulfilled', `'${id('a1')}'`)}
    -- An accepted quote with no order still promises product (the purchasing plan counts it).
    ${quote(C.qacc, 'accepted')}
    ${quote(C.closed, 'draft')} UPDATE public.quotes SET deleted_at = now() WHERE quote_number = 'KI148-Q${n}';
    ${['draft', 'unposted', 'paid', 'voided', 'cancelled'].map((s) => invoice(C.closed, s)).join('\n')}
    -- The live case (To-Do decision 23): inactive with 2 confirmed orders.
    ${order(C.inactive, 'confirmed')} ${order(C.inactive, 'confirmed')}
    -- Several kinds at once, for the message.
    ${order(C.many, 'confirmed')} ${order(C.many, 'confirmed')} ${quote(C.many, 'sent')} ${invoice(C.many, 'posted')}
    COMMIT;`, { user: 'supabase_admin' });
}

async function main() {
  seed();
  // Case 8, before: an admin can deactivate a customer with an open order today (rolled back).
  assert.equal(allowed(ADMIN, deactivate(C.order)), '1');
  console.log('[ki148] BEFORE: an admin deactivates a customer with an open order (the hole is real)');

  const applied = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
    { input: candidate, allowFailure: true });
  assert.equal(applied.status, 0, `candidate failed:\n${applied.stderr}`);
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
    { input: candidate, allowFailure: true });
  assert.notEqual(again.status, 0); assert.match(again.stderr, /KI148_PREFLIGHT: the deactivation guard already exists/);
  console.log('[ki148] candidate applied; postflight passed; a second apply is refused by the preflight');

  // Cases 1-3: every kind of open work refuses, for an admin; the row stays active.
  const kinds = { order: /1 open order\(s\)/, partial: /1 open order\(s\)/, sched: /1 undelivered delivery/, inprog: /1 undelivered delivery/,
    hold: /2 active stock hold/, dorder: /1 undelivered delivery/, qdraft: /1 open quote/, qsent: /1 open quote/, qrevised: /1 open quote/, qacc: /1 open quote/,
    posted: /open invoices\./, overdue: /open invoices\./ };
  for (const [k, pattern] of Object.entries(kinds)) {
    refused(ADMIN, deactivate(C[k]), new RegExp(`CUSTOMER_HAS_OPEN_WORK: nothing was deactivated\\. \\[KI148\\] ${k} still has ${pattern.source}`));
    assert.equal(active(C[k]), 't');
  }
  console.log('[ki148] admin refused for each kind: open/part-filled order, scheduled/in-progress delivery (also one whose row names another customer but whose order is this one), active hold (one expiring today), draft/sent/revised quote, accepted quote with no order, posted/overdue invoice');
  refused(REP, deactivate(C.sched), /CUSTOMER_HAS_OPEN_WORK/);
  refused(REP, deactivate(C.hold), /CUSTOMER_HAS_OPEN_WORK/);
  refused(ADMIN, deactivate(C.order), /CUSTOMER_HAS_OPEN_WORK/, { role: 'postgres' });
  refused(ADMIN, deactivate(C.qdraft), /CUSTOMER_HAS_OPEN_WORK/, { role: 'service_role' });
  refused(null, deactivate(C.hold), /CUSTOMER_HAS_OPEN_WORK/, { role: 'service_role' });
  refused(null, deactivate(C.posted), /CUSTOMER_HAS_OPEN_WORK/, { role: 'postgres' });
  console.log('[ki148] sales rep, server role (postgres) and service_role refused too, with and without a signed-in user');
  // The rep guard still answers first for a rep's forbidden edit made together with a deactivation.
  refused(REP, count(`UPDATE public.customers SET is_active = false, assigned_tier = 3 WHERE id = '${C.order}'`), /TIER_ADMIN_ONLY/);
  refused(REP, deactivate(C.posted), /CUSTOMER_HAS_OPEN_INVOICES/);
  console.log('[ki148] a rep\'s tier change with a deactivation still gets TIER_ADMIN_ONLY; a rep\'s open-invoice case keeps CUSTOMER_HAS_OPEN_INVOICES');
  refused(ADMIN, deactivate(C.many), /\[KI148\] many still has 2 open order\(s\), 1 undelivered delivery\(ies\), 1 open quote\(s\), open invoices\. Finish or cancel/);
  console.log('[ki148] the refusal names the customer and every open kind (with counts, except invoices)');

  // Sol round 1 / Luna round 2: a transaction still creating work when the deactivation runs is waited for, then seen.
  async function race(cid, insert, pattern, what) {
    const creator = spawn('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
      { stdio: ['pipe', 'ignore', 'pipe'] });
    let creatorErr = '';
    creator.stderr.on('data', (b) => { creatorErr += b; });
    const creatorDone = new Promise((resolve) => creator.on('close', resolve));
    creator.stdin.end(`BEGIN; ${claims(ADMIN)}
${insert}
SELECT pg_sleep(6); COMMIT;
`);
    // Wait until the insert is done and the creator sleeps, holding its key-share lock.
    for (let i = 0; i < 100 && scalar(`SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE 'SELECT pg_sleep(6)%';`) !== '1'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const started = Date.now();
    refused(ADMIN, deactivate(cid), pattern);
    const waited = Date.now() - started;
    assert.equal(await creatorDone, 0, `the creating transaction failed:
${creatorErr}`);
    assert.ok(waited >= 1000, `the deactivation did not wait for the creating transaction (${waited} ms)`);
    assert.equal(active(cid), 't');
    console.log(`[ki148] a deactivation during an uncommitted ${what} waits for it (${waited} ms), then refuses`);
  }
  await race(C.race, `INSERT INTO public.orders (order_number, customer_id, status) VALUES ('KI148-RACE', '${C.race}', 'confirmed');`,
    /\[KI148\] race still has 1 open order\(s\)/, 'order insert');
  await race(C.race2, `INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, status)
      VALUES ('KI148-RACE-D', '${id(`f${C.race2.slice(-2)}`)}', '${C.race2}', '${ADMIN}', 'scheduled');`,
    /\[KI148\] race2 still has 1 undelivered delivery/, 'delivery insert');
  // Sol round 2: outside READ COMMITTED the snapshot is fixed, so the guard refuses to run at all.
  for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
    refused(ADMIN, deactivate(C.clean), /CUSTOMER_DEACTIVATION_ISOLATION/, { iso: level });
  }
  assert.equal(active(C.clean), 't');
  console.log('[ki148] repeatable-read and serializable deactivations are refused (CUSTOMER_DEACTIVATION_ISOLATION)');

  // Case 4: closed work of every kind does not block; neither does no work.
  assert.equal(allowed(ADMIN, deactivate(C.closed)), '1');
  assert.equal(allowed(REP, deactivate(C.clean)), '1');
  console.log('[ki148] closed work (fulfilled/cancelled/voided/deleted orders, completed/cancelled/voided deliveries, inactive or expired hold, closed, accepted-with-order and deleted quotes, draft/paid/voided invoices) does not block; admin and rep deactivate');

  // Case 5: bulk is all-or-nothing.
  refused(ADMIN, deactivate([C.bulkok, C.order]), /CUSTOMER_HAS_OPEN_WORK: nothing was deactivated\. \[KI148\] order/);
  assert.equal(active(C.bulkok), 't');
  console.log('[ki148] bulk deactivate with one blocked customer changes nothing');

  // Case 6: the live inactive customer with open orders stays editable and can be reactivated, then is checked again.
  assert.equal(allowed(ADMIN, count(`UPDATE public.customers SET notes = 'edited', is_active = false WHERE id = '${C.inactive}'`), { commit: true }), '1');
  assert.equal(allowed(REP, count(`UPDATE public.customers SET notes = 'rep edit' WHERE id = '${C.inactive}'`), { commit: true }), '1');
  assert.equal(allowed(ADMIN, count(`UPDATE public.customers SET is_active = true WHERE id = '${C.inactive}'`), { commit: true }), '1');
  refused(ADMIN, deactivate(C.inactive), /2 open order\(s\)/);
  console.log('[ki148] the inactive customer with open orders is editable (admin and rep) and reactivates; deactivating it again is checked');

  // A committed success really persists (the other checks roll back).
  assert.equal(allowed(ADMIN, deactivate(C.clean), { commit: true }), '1');
  assert.equal(active(C.clean), 'f');
  console.log('KI148_DEACTIVATION_PROOF_PASS');
}

try { await main(); } finally { if (!KEEP) removeContainer(); else console.log(`Kept ${NAME}`); }
