#!/usr/bin/env node
/**
 * Real-schema proof for H36 (20261109120000_dashboard_action_true_counts.sql). Builds the checked-in
 * baseline plus every post-baseline migration on this checkout (the candidate included) in a
 * network-disabled PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), then with invented rows
 * past the old limit of 10 per group:
 *   - every group's `counts` entry equals an independent count(*) written here, not copied from the function;
 *   - every group's example rows are exactly what the 20261023090000 body returns for the same call
 *     (installed beside it under another name), so only the `counts` key was added;
 *   - a driver is still refused, anon cannot execute, grants and SECURITY DEFINER are unchanged;
 *   - applying the candidate a second time is refused by its preflight.
 *
 * Run: node scripts/smoke/prove-dashboard-action-counts-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a built database: UNDO_PATHS_CONTAINER=<name> DASHBOARD_PROOF_REUSE=1 (left running).
 * Prints DASHBOARD_ACTION_COUNTS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, psql, scalar, attempt, asUser, refuse, claims, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = '20261109120000_dashboard_action_true_counts.sql';
const OLD = '20261023090000_field_functions_require_field_access.sql';
const reuse = process.env.DASHBOARD_PROOF_REUSE === '1';
const lf = (f) => readFileSync(path.join(MIGRATIONS, f), 'utf8').replaceAll('\r\n', '\n');

// Seeded group sizes, all past the dashboard's 10.
const N = { overdueInvoices: 37, overdueDeliveries: 23, futureUnassigned: 4, expiringQuotes: 12, lowStock: 14,
  cancelledPosted: 11, unassignedJobs: 13, dueToday: 15, unbilled: 16 };

function installOldBody() {
  const src = lf(OLD);
  const start = src.indexOf('CREATE OR REPLACE FUNCTION public.get_dashboard_action_items(');
  const end = src.indexOf('$function$;', src.indexOf('AS $function$', start)) + '$function$;'.length;
  const def = src.slice(start, end).replace('public.get_dashboard_action_items(', 'public.zz_proof_old_dashboard_items(');
  psql(def);
}

function seed() {
  // Rows are invented; triggers are off for the seed only (replica role), so fixtures need no
  // full order-to-invoice lifecycle. The function under test runs afterwards with triggers on.
  const sql = `
${claims(USERS.admin)}
-- current_date must be the function's Chicago "today", or the seed is a day off after 6pm Central.
SET TimeZone = 'America/Chicago';
SET session_replication_role = replica;
INSERT INTO public.customers (id, farm_name) VALUES ('7c7a0000-0000-4000-8000-0000000c0001', '[H36] Proof Farm');
INSERT INTO public.orders (id, order_number, customer_id) VALUES ('7c7a0000-0000-4000-8000-0000000c0002', 'H36-ORD-1', '7c7a0000-0000-4000-8000-0000000c0001');
INSERT INTO public.invoices (id, invoice_number, customer_id, status, invoice_type, invoice_date, due_date,
                             total_amount_cents, posted_at)
SELECT gen_random_uuid(), 'H36-INV-' || g, '7c7a0000-0000-4000-8000-0000000c0001', 'overdue', 'chemical_sale',
       current_date - 60, current_date - (g + 1), 1000 * g, now() - interval '60 days'
  FROM generate_series(1, ${N.overdueInvoices}) g;
-- Not counted: paid, zero balance.
INSERT INTO public.invoices (id, invoice_number, customer_id, status, invoice_type, invoice_date, due_date,
                             total_amount_cents, paid_amount_cents, posted_at)
SELECT gen_random_uuid(), 'H36-PAID-' || g, '7c7a0000-0000-4000-8000-0000000c0001', 'paid', 'chemical_sale',
       current_date - 60, current_date - 30, 500, 500, now() - interval '60 days'
  FROM generate_series(1, 3) g;
INSERT INTO public.deliveries (id, delivery_number, customer_id, order_id, created_by, status, scheduled_date)
SELECT gen_random_uuid(), 'H36-DEL-' || g, '7c7a0000-0000-4000-8000-0000000c0001', '7c7a0000-0000-4000-8000-0000000c0002',
       '${USERS.admin}', 'scheduled', current_date - g
  FROM generate_series(1, ${N.overdueDeliveries}) g;
INSERT INTO public.deliveries (id, delivery_number, customer_id, order_id, created_by, status, scheduled_date)
SELECT gen_random_uuid(), 'H36-FUT-' || g, '7c7a0000-0000-4000-8000-0000000c0001', '7c7a0000-0000-4000-8000-0000000c0002',
       '${USERS.admin}', 'scheduled', current_date + 10 + g
  FROM generate_series(1, ${N.futureUnassigned}) g;
INSERT INTO public.quotes (id, quote_number, customer_id, created_by, status, is_planned, expires_at)
SELECT gen_random_uuid(), 'H36-Q-' || g, '7c7a0000-0000-4000-8000-0000000c0001', '${USERS.admin}', 'sent', false,
       (now() AT TIME ZONE 'America/Chicago')::date + 1 + (g % 6) + (g * interval '1 minute')
  FROM generate_series(1, ${N.expiringQuotes}) g;
INSERT INTO public.products (id, product_name, is_active)
SELECT ('7c7a0000-0000-4000-8000-0000001' || lpad(g::text, 5, '0'))::uuid, 'H36 Product ' || g, true
  FROM generate_series(1, ${N.lowStock}) g;
INSERT INTO public.inventory (product_id, quantity_available, reorder_point)
SELECT ('7c7a0000-0000-4000-8000-0000001' || lpad(g::text, 5, '0'))::uuid, g, 100 + g
  FROM generate_series(1, ${N.lowStock}) g;
INSERT INTO public.orders (id, order_number, customer_id, status, created_at)
SELECT ('7c7a0000-0000-4000-8000-0000002' || lpad(g::text, 5, '0'))::uuid, 'H36-CAN-' || g,
       '7c7a0000-0000-4000-8000-0000000c0001', 'cancelled', now() - g * interval '1 hour'
  FROM generate_series(1, ${N.cancelledPosted}) g;
INSERT INTO public.invoices (invoice_number, customer_id, order_id, status, invoice_type, total_amount_cents, posted_at)
SELECT 'H36-CANINV-' || g, '7c7a0000-0000-4000-8000-0000000c0001',
       ('7c7a0000-0000-4000-8000-0000002' || lpad(g::text, 5, '0'))::uuid, 'posted', 'chemical_sale', 100, now()
  FROM generate_series(1, ${N.cancelledPosted}) g;
INSERT INTO public.jobs (job_number, customer_id, job_date, status)
SELECT 'H36-JOB-' || g, '7c7a0000-0000-4000-8000-0000000c0001', current_date + g, 'scheduled'
  FROM generate_series(1, ${N.unassignedJobs}) g;
INSERT INTO public.deliveries (delivery_number, customer_id, order_id, created_by, status, scheduled_date, assigned_driver)
SELECT 'H36-TODAY-' || lpad(g::text, 3, '0'), '7c7a0000-0000-4000-8000-0000000c0001', '7c7a0000-0000-4000-8000-0000000c0002',
       '${USERS.admin}', 'scheduled', (now() AT TIME ZONE 'America/Chicago')::date, '${USERS.driver}'
  FROM generate_series(1, ${N.dueToday}) g;
-- Completed deliveries on orders with no invoice: unbilled.
INSERT INTO public.orders (id, order_number, customer_id, status)
SELECT ('7c7a0000-0000-4000-8000-0000003' || lpad(g::text, 5, '0'))::uuid, 'H36-UNB-' || g,
       '7c7a0000-0000-4000-8000-0000000c0001', 'fulfilled'
  FROM generate_series(1, ${N.unbilled}) g;
INSERT INTO public.deliveries (delivery_number, customer_id, order_id, created_by, status, scheduled_date, assigned_driver)
SELECT 'H36-UNBDEL-' || g, '7c7a0000-0000-4000-8000-0000000c0001',
       ('7c7a0000-0000-4000-8000-0000003' || lpad(g::text, 5, '0'))::uuid, '${USERS.admin}', 'completed',
       current_date - 40 - g, '${USERS.driver}'
  FROM generate_series(1, ${N.unbilled}) g;
SET session_replication_role = origin;`;
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
    { input: sql, allowFailure: true });
  assert.equal(r.status, 0, `seed failed:\n${r.stderr}`);
}

// Independent counts: the live filters restated here, so a wrong CTE in the candidate cannot certify itself.
const TODAY = "(now() AT TIME ZONE 'America/Chicago')::date";
const INDEPENDENT = {
  overdue_invoices: `SELECT count(*) FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status = 'overdue' AND i.balance_cents > 0 AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL`,
  cancelled_posted: `SELECT count(*) FROM orders o JOIN customers c ON c.id = o.customer_id JOIN invoices i ON i.order_id = o.id AND i.status = 'posted' AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL WHERE o.status = 'cancelled'`,
  overdue_deliveries: `SELECT count(*) FROM deliveries d JOIN customers c ON c.id = d.customer_id WHERE d.status IN ('scheduled','in_progress') AND d.scheduled_date < ${TODAY}`,
  low_stock: `SELECT count(*) FROM products p JOIN inventory inv ON inv.product_id = p.id WHERE p.is_active AND ((inv.reorder_point IS NOT NULL AND inv.reorder_point > 0 AND COALESCE(inv.quantity_available,0) < inv.reorder_point) OR COALESCE(inv.quantity_available,0) < 0)`,
  expiring_quotes: `SELECT count(*) FROM quotes q JOIN customers c ON c.id = q.customer_id WHERE q.status IN ('sent','revised') AND q.is_planned = false AND q.expires_at IS NOT NULL AND q.expires_at::date BETWEEN ${TODAY} AND (${TODAY} + interval '7 days')`,
  unassigned_deliveries: `SELECT count(*) FROM deliveries d JOIN customers c ON c.id = d.customer_id WHERE d.status = 'scheduled' AND d.assigned_driver IS NULL`,
  unassigned_jobs: `SELECT count(*) FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.status = 'scheduled' AND j.deleted_at IS NULL AND j.applicator_id IS NULL AND NOT EXISTS (SELECT 1 FROM job_location_dispatches d WHERE d.job_id = j.id AND d.dispatch_status = 'dispatched')`,
  due_today_not_started: `SELECT count(*) FROM deliveries d JOIN customers c ON c.id = d.customer_id WHERE d.scheduled_date = ${TODAY} AND d.status = 'scheduled' AND d.deleted_at IS NULL`,
  unbilled_deliveries: `SELECT count(*) FROM deliveries d JOIN customers c ON c.id = d.customer_id WHERE d.status = 'completed' AND d.deleted_at IS NULL AND d.order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = d.order_id AND i.status NOT IN ('voided','cancelled') AND (i.delivery_id = d.id OR i.delivery_id IS NULL) AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM delivery_external_billings b WHERE b.delivery_id = d.id)`,
};

function callAs(uid, fn) {
  const out = attempt(uid, `${asUser(`r := public.${fn}(10);`)} v := r::text;`);
  assert.ok(out.startsWith('ok|'), `${fn} as ${uid} failed: ${out}`);
  return JSON.parse(out.slice(3));
}

try {
  if (!reuse) { buildContainer(); seedUsers(); }
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${path.basename(CANDIDATE, '.sql')}';`), '1',
    'the candidate must have replayed (its preflight and postflight passed)');
  if (scalar("SELECT count(*) FROM customers WHERE id = '7c7a0000-0000-4000-8000-0000000c0001';") === '0') seed();
  for (const [g, rows] of Object.entries(N)) if (g !== "futureUnassigned") assert.ok(rows > 10, `${g} must be seeded past the old limit of 10`);
  installOldBody();

  const result = callAs(USERS.admin, 'get_dashboard_action_items');
  const old = callAs(USERS.admin, 'zz_proof_old_dashboard_items');
  const groups = Object.keys(INDEPENDENT);

  // 1. The example rows are byte-for-byte the old function's; only `counts` was added.
  const { counts, ...rows } = result;
  assert.deepEqual(rows, old, 'example rows differ from the 20261023090000 body');
  assert.deepEqual(Object.keys(counts).sort(), [...groups].sort(), 'counts must name exactly the nine groups');

  // 2. Each count matches an independent count(*), and the seeded groups are past the old limit.
  for (const g of groups) {
    const expected = Number(scalar(`${INDEPENDENT[g]};`));
    assert.equal(counts[g], expected, `${g}: count ${counts[g]} but the database holds ${expected}`);
    assert.equal(rows[g].length, Math.min(expected, 10), `${g}: example rows not cut at 10`);
  }
  assert.equal(counts.overdue_invoices, N.overdueInvoices);
  assert.equal(counts.overdue_deliveries, N.overdueDeliveries);
  assert.equal(counts.unassigned_deliveries, N.overdueDeliveries + N.futureUnassigned);
  assert.equal(counts.expiring_quotes, N.expiringQuotes);
  assert.equal(counts.low_stock, N.lowStock);
  assert.equal(counts.cancelled_posted, N.cancelledPosted);
  assert.equal(counts.unassigned_jobs, N.unassignedJobs);
  assert.equal(counts.due_today_not_started, N.dueToday);
  assert.equal(counts.unbilled_deliveries, N.unbilled);
  console.log('[h36] counts', JSON.stringify(counts));

  // 3. Access unchanged: a sales rep may read it, a driver is refused, anon cannot execute.
  callAs(USERS.rep, 'get_dashboard_action_items');
  const refused = attempt(USERS.driver, `${refuse('r := public.get_dashboard_action_items(10);')} v := t;`);
  assert.notEqual(refused, 'ok|NOT REFUSED', 'a driver must still be refused');
  assert.equal(scalar("SELECT has_function_privilege('anon', 'public.get_dashboard_action_items(integer)', 'EXECUTE');"), 'f');
  assert.equal(scalar("SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_dashboard_action_items(integer)'::regprocedure;"), 't');
  console.log('[h36] acl', scalar("SELECT proacl::text FROM pg_proc WHERE oid = 'public.get_dashboard_action_items(integer)'::regprocedure;"));

  // 4. A second apply is refused by the preflight and changes nothing.
  docker(['exec', '-i', NAME, 'sh', '-c', 'cat > /tmp/h36-candidate.sql'], { input: lf(CANDIDATE) });
  const again = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', '/tmp/h36-candidate.sql'], { allowFailure: true });
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.stderr, /DASHBOARD_ACTION_COUNTS_BASELINE_DRIFT/);

  psql('DROP FUNCTION public.zz_proof_old_dashboard_items(integer);');
  console.log('\nDASHBOARD_ACTION_COUNTS_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
