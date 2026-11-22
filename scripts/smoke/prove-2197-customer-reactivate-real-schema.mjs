#!/usr/bin/env node
/**
 * Real-schema proof for #2197: the customer page's admin Reactivate button sends
 *   UPDATE customers SET is_active = true WHERE id = $1 AND is_active = false RETURNING *
 * as the signed-in user. Builds the production baseline plus the replayable migrations on disk (Docker; the image may be pulled once),
 * then checks: an admin reactivates an inactive customer (row comes back active, row_version moves on),
 * the inactive-customer refusal (#2048) stops new work before and not after, a second click matches no row,
 * and a driver cannot do it.
 *
 * Run: node scripts/smoke/prove-2197-customer-reactivate-real-schema.mjs   (needs Docker)
 * Prints CUSTOMER_REACTIVATE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';

process.env.UNDO_PATHS_CONTAINER ||= `crx-2197-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, scalar, psql, claims, USERS, NAME, docker, id } =
  await import('./undo-paths/harness.mjs');

const CUST = id('c2197');
function run(uid, sql, role = 'authenticated') {
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
    { input: `BEGIN;\n${claims(uid)}\n${role === 'postgres' ? '' : `SET LOCAL ROLE ${role};`}\n${sql}\nCOMMIT;`, allowFailure: true });
  return { status: r.status, out: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '', err: r.stderr };
}
const reactivateAt = (v) => `WITH w AS (UPDATE public.customers SET is_active = true WHERE id = '${CUST}' AND is_active = false AND row_version = ${v} RETURNING row_version) SELECT count(*) FROM w;`;
const newOrder = `INSERT INTO public.orders (order_number, customer_id, status) VALUES ('R2197-' || gen_random_uuid(), '${CUST}', 'confirmed') RETURNING 1;`;

try {
  buildContainer(); seedUsers();
  psql(`INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[2197] Inactive Farm', false);`, { user: 'supabase_admin' });
  const before = scalar(`SELECT row_version FROM public.customers WHERE id = '${CUST}';`);

  // The #2048 trigger guards every path; insert as the server role so only that trigger can refuse.
  const blocked = run(USERS.admin, newOrder, 'postgres');
  assert.match(blocked.err, /CUSTOMER_INACTIVE_NEW_WORK/, blocked.err);
  console.log(`[2197] before: new order for the inactive customer refused: ${blocked.err.split('\n')[0]}`);

  const reactivate = reactivateAt(before);
  const driver = run(USERS.driver, reactivate);
  assert.ok(driver.status !== 0 || driver.out === '0', `a driver reactivated the customer: ${driver.out}`);
  assert.equal(scalar(`SELECT is_active FROM public.customers WHERE id = '${CUST}';`), 'f');
  console.log('[2197] a driver cannot reactivate (no row changed)');

  const admin = run(USERS.admin, reactivate);
  assert.equal(admin.status, 0, admin.err);
  assert.equal(admin.out, '1');
  assert.equal(scalar(`SELECT is_active FROM public.customers WHERE id = '${CUST}';`), 't');
  const after = scalar(`SELECT row_version FROM public.customers WHERE id = '${CUST}';`);
  assert.equal(Number(after), Number(before) + 1, 'row_version should move on by exactly one');
  console.log(`[2197] admin reactivated: 1 row, is_active true, row_version ${before} -> ${after}`);

  assert.equal(run(USERS.admin, reactivate).out, '0');
  console.log('[2197] a second click matches no row (already active)');

  // Sol HIGH: an old confirmation must not undo a newer deactivation.
  psql(`UPDATE public.customers SET is_active = false WHERE id = '${CUST}';`, { user: 'supabase_admin' });
  assert.equal(run(USERS.admin, reactivateAt(before)).out, '0');
  assert.equal(scalar(`SELECT is_active FROM public.customers WHERE id = '${CUST}';`), 'f');
  console.log('[2197] a stale confirmation (old row_version) after a newer deactivation changes nothing');
  psql(`UPDATE public.customers SET is_active = true WHERE id = '${CUST}';`, { user: 'supabase_admin' });

  const ok = run(USERS.admin, newOrder, 'postgres');
  assert.equal(ok.status, 0, ok.err);
  console.log('[2197] after: a new order for the reactivated customer is accepted');
  console.log('CUSTOMER_REACTIVATE_PROOF_PASS');
} finally { removeContainer(); }
