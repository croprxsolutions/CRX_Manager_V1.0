#!/usr/bin/env node
/**
 * Real-schema proof for 20270225130000_refuse_impossible_quantities_and_dates.sql (#2237).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds one invented row in each table, then checks:
 *   - autocommit is refused and changes nothing;
 *   - a row that already breaks a rule makes the migration refuse, naming table.column=count, and change nothing;
 *   - the migration applies once (POSTFLIGHT_OK) and a second apply is refused;
 *   - each of the 11 columns refuses NaN, Infinity and -Infinity (dates: 1999-12-31, 2100-01-01, infinity,
 *     -infinity) in replica mode (no trigger can help) and from an ordinary privileged write; finite values, the
 *     window edges 2000-01-01 / 2099-12-31 and a NULL delivered quantity are accepted;
 *   - the purchasing-plan reservations smoke passes with the constraints on;
 *   - the reverse drops exactly the 11 constraints, refuses a second run, and the candidate re-applies.
 *
 * Run: node scripts/smoke/prove-refuse-impossible-quantities-and-dates-real-schema.mjs   (needs Docker; never touches live)
 * Prints REFUSE_IMPOSSIBLE_QUANTITIES_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, USERS, ROOT, NAME, docker, scalar } from './undo-paths/harness.mjs';

const CANDIDATE = '20270225130000_refuse_impossible_quantities_and_dates.sql';
const lf = (f) => readFileSync(f, 'utf8').replaceAll('\r\n', '\n');
const candidate = lf(path.join(ROOT, 'supabase', 'migrations', CANDIDATE));
const reverse = lf(path.join(ROOT, 'scripts', 'smoke', 'refuse-impossible-quantities-and-dates-reverse.sql'));
const smoke = lf(path.join(ROOT, 'scripts', 'smoke', 'smoke-purchasing-plan-reservations.sql'));
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const run = (sql, flags = []) => docker([...PSQL, ...flags], { input: sql, allowFailure: true });
const out = (r) => `${r.stdout}${r.stderr}`;
const ADMIN = USERS.admin;
const ids = (n) => `22370000-0000-4000-8000-${Buffer.from(String(n)).toString('hex').padStart(12, '0')}`; // any short tag, valid uuid
const R = { cust: ids('c1'), prod: ids('p1'), order: ids('o1'), line: ids('l1'), del: ids('d1'), item: ids('i1'), job: ids('j1'), chem: ids('k1') };

// table, key column = id, column, kind, constraint name
const COLS = [
  ['job_chemicals', R.chem, 'quantity', 'n', 'job_chemicals_quantity_finite_chk'],
  ['jobs', R.job, 'job_date', 'd', 'jobs_job_date_window_chk'],
  ['inventory', null, 'quantity_available', 'n', 'inventory_quantity_available_finite_chk'],
  ['inventory', null, 'quantity_prebooked', 'n', 'inventory_quantity_prebooked_finite_chk'],
  ['inventory', null, 'quantity_on_order', 'n', 'inventory_quantity_on_order_finite_chk'],
  ['order_items', R.line, 'quantity_remaining', 'n', 'order_items_quantity_remaining_finite_chk'],
  ['order_items', R.line, 'total_units_needed', 'n', 'order_items_total_units_needed_finite_chk'],
  ['order_items', R.line, 'quantity_delivered', 'n', 'order_items_quantity_delivered_finite_chk'],
  ['deliveries', R.del, 'scheduled_date', 'd', 'deliveries_scheduled_date_window_chk'],
  ['delivery_items', R.item, 'quantity', 'n', 'delivery_items_quantity_finite_chk'],
  ['delivery_items', R.item, 'quantity_delivered', 'n', 'delivery_items_quantity_delivered_finite_chk'],
];
const NAMES = COLS.map((c) => `'${c[4]}'`).join(', ');
const present = () => scalar(`SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname IN (${NAMES});`);
const where = (tbl, key) => (key ? `id = '${key}'` : `product_id = '${R.prod}'`);
const BAD = { n: ["'NaN'", "'Infinity'", "'-Infinity'"], d: ["'1999-12-31'", "'2100-01-01'", "'infinity'", "'-infinity'"] };
const GOOD = { n: ['0', '123.45', '-0.5'], d: ["'2000-01-01'", "'2099-12-31'"] };
// One rolled-back write; replica mode skips every trigger, so only the CHECK can refuse.
const write = (tbl, key, col, val, replica) => run(`BEGIN; ${replica ? 'SET LOCAL session_replication_role = replica;' : ''}
  UPDATE public.${tbl} SET ${col} = ${val} WHERE ${where(tbl, key)}; ROLLBACK;`);

function seedRows() {
  const r = run(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${R.cust}', '[2237] Farm', '[2237]-1');
    INSERT INTO public.products (id, product_name, unit_size, epa_registration, product_form, inventory_unit)
      VALUES ('${R.prod}', '[2237] Product', 'Gal', '999997-99990', 'liquid', 'Gal');
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES ('${R.prod}', 'Main Warehouse', 10, 0, 0, 'Gal');
    INSERT INTO public.orders (id, order_number, customer_id, status, booking_draw) VALUES ('${R.order}', '[2237] O1', '${R.cust}', 'confirmed', false);
    INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit, total_units_needed,
        total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size)
      VALUES ('${R.line}', '${R.order}', '${R.prod}', '[2237] line', 10, 6, 5, 50, 20, 40, 0, 5, 'Gal');
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, scheduled_date, status, created_by)
      VALUES ('${R.del}', '[2237] D1', '${R.order}', '${R.cust}', CURRENT_DATE, 'scheduled', '${ADMIN}');
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
      VALUES ('${R.item}', '${R.del}', '${R.line}', '${R.prod}', 5, NULL, 'Gal');
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, created_by)
      VALUES ('${R.job}', '[2237] J1', '${R.cust}', CURRENT_DATE, 'scheduled', '${ADMIN}');
    INSERT INTO public.job_chemicals (id, job_id, product_id, quantity, unit, sort_order)
      VALUES ('${R.chem}', '${R.job}', '${R.prod}', 2, 'Gal', 1);`, ['-1']);
  assert.equal(r.status, 0, `seed: ${out(r)}`);
}

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  seedRows();
  assert.equal(present(), '0', 'no #2237 constraint before the candidate');

  console.log('Before the candidate:');
  const beforeSmoke = out(run(smoke));
  console.log(`  purchasing-plan reservations smoke: ${(beforeSmoke.match(/ERROR:.{0,110}/) ?? ['(no error)'])[0]}`);

  console.log('Refusals that change nothing:');
  assert.match(out(run(candidate)), /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit must be refused');
  assert.equal(present(), '0', 'a refused autocommit run adds nothing');
  // Two rows already break a rule: the migration names both and adds nothing.
  const bad = run(`SET session_replication_role = replica;
    UPDATE public.inventory SET quantity_on_order = 'NaN' WHERE product_id = '${R.prod}';
    UPDATE public.jobs SET job_date = '1999-06-01' WHERE id = '${R.job}';`, ['-1']);
  assert.equal(bad.status, 0, out(bad));
  const refused = out(run(candidate, ['-1']));
  assert.match(refused, /IMPOSSIBLE_VALUES_PRESENT: .*jobs\.job_date=1.*inventory\.quantity_on_order=1.*nothing was changed/, refused);
  assert.equal(present(), '0', 'a refused apply adds nothing');
  assert.equal(scalar(`SELECT quantity_on_order::text || '/' || (SELECT job_date FROM public.jobs WHERE id = '${R.job}')
    FROM public.inventory WHERE product_id = '${R.prod}';`), 'NaN/1999-06-01', 'a refused apply changes no row');
  assert.equal(run(`SET session_replication_role = replica;
    UPDATE public.inventory SET quantity_on_order = 0 WHERE product_id = '${R.prod}';
    UPDATE public.jobs SET job_date = CURRENT_DATE WHERE id = '${R.job}';`, ['-1']).status, 0);
  console.log('  autocommit refused; existing breaking rows named (jobs.job_date, inventory.quantity_on_order), nothing changed');

  console.log('Apply:');
  const applied = out(run(candidate, ['-1']));
  assert.match(applied, /POSTFLIGHT_OK: 11 constraints/, applied);
  assert.equal(present(), '11');
  assert.match(out(run(candidate, ['-1'])), /PREFLIGHT_FAIL: already applied/, 'a second apply must be refused');
  console.log('  applied once (11 validated constraints); a second apply is refused');

  console.log('Each column:');
  for (const [tbl, key, col, kind, con] of COLS) {
    for (const val of BAD[kind]) {
      for (const replica of [true, false]) {
        const r = write(tbl, key, col, val, replica);
        assert.notEqual(r.status, 0, `${tbl}.${col} = ${val} (replica=${replica}) must be refused`);
        if (replica) assert.match(out(r), new RegExp(`violates check constraint "${con}"`), `${tbl}.${col} = ${val}: ${out(r)}`);
      }
    }
    for (const val of GOOD[kind]) {
      const r = write(tbl, key, col, val, true);
      assert.equal(r.status, 0, `${tbl}.${col} = ${val} must be accepted: ${out(r)}`);
    }
    console.log(`  ${tbl}.${col}: refuses ${BAD[kind].join(' ')}; accepts ${GOOD[kind].join(' ')}`);
  }
  const nullOk = write('delivery_items', R.item, 'quantity_delivered', 'NULL', true);
  assert.equal(nullOk.status, 0, `a NULL delivered quantity must be accepted: ${out(nullOk)}`);
  console.log('  delivery_items.quantity_delivered NULL accepted');

  console.log('Purchasing plan:');
  const after = out(run(smoke));
  assert.match(after, /SMOKE_PASS_ROLLBACK: \d+ booking-reservation groups passed \(#2237 constraints on\)/, after);
  console.log(`  ${after.match(/SMOKE_PASS_ROLLBACK[^\n]*/)[0]}`);

  console.log('Reverse:');
  assert.match(out(run(reverse)), /ROLLBACK_REFUSED: run this file as one transaction/, 'reverse autocommit must be refused');
  assert.equal(present(), '11', 'a refused reverse changes nothing');
  const back = out(run(reverse, ['-1']));
  assert.match(back, /POSTFLIGHT_OK: the 11 #2237 constraints are removed/, back);
  assert.equal(present(), '0');
  assert.match(out(run(reverse, ['-1'])), /ROLLBACK_REFUSED: .* is missing/, 'a second reverse must be refused');
  assert.equal(write('inventory', null, 'quantity_available', "'NaN'", true).status, 0, 'after the reverse NaN is storable again');
  assert.match(out(run(candidate, ['-1'])), /POSTFLIGHT_OK: 11 constraints/, 'candidate must re-apply after the reverse');
  console.log('  reverse removes exactly the 11, refuses a second run; the candidate re-applies');

  console.log('REFUSE_IMPOSSIBLE_QUANTITIES_PROOF_PASS');
} finally {
  if (process.env.CRX_PROVER_KEEP_CONTAINER !== '1') removeContainer();
}
