#!/usr/bin/env node
/**
 * Real-schema proof for 20261116120000_orders_list_page.sql (Goal 4) and its keyset follow-up
 * 20261125100000_orders_list_keyset_page.sql (get_orders_keyset_page; get_orders_page now wraps it). Builds the checked-in baseline plus
 * every post-baseline migration on this checkout (the candidate included) in a network-disabled PostgreSQL
 * container (scripts/smoke/undo-paths/harness.mjs), seeds 5,250 orders (5,200 in the season, some deleted,
 * 50 before it) with lines, invoices (active, voided, credit memo, over-billed) and deliveries, then checks
 * get_orders_page against the Orders screen's own logic as it stood before this change: the reference reads
 * the raw tables and rebuilds each row the way src/pages/Orders.tsx did, then filters, searches and sorts
 * with the screen's src/lib/tableSearchSort.ts. Checked:
 *   - admin: paging through every row (pages of 1000 and of 37) gives exactly the reference list, row for
 *     row and field for field, with no row twice; total_count and total_price_cents equal the reference;
 *   - every sort key both ways, every filter, and searches (one matching only a row far past page one)
 *     return the reference's rows in the reference's order (ties broken by id);
 *   - a sales rep's invoiced % counts only the invoices that rep can see (as the screen does today);
 *   - a driver sees no order; anon cannot call it; bad sort, range and dates are refused;
 *   - keyset paging (get_orders_keyset_page, p_after = the previous next_cursor) lists exactly the same rows
 *     for every sort key both ways, with nulls in the sort column, for a rep, and in pages of 37;
 *   - an order deleted (or edited out of the filter) between two pages, including the bookmark row itself,
 *     makes offset paging skip a row and keyset paging skip none; stale and malformed bookmarks are refused;
 *   - the live smoke chains pass; applying the candidate a second time is refused;
 *   - with 60,000 more orders (rolled back) a rep's first page, a deep page, an export page, a sort, a search, bookmark pages
 *     and an admin's first page each stay under 8 s and under 3x a rep's plain read of the same rows.
 *
 * Run: node scripts/smoke/prove-orders-list-page-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a built database: UNDO_PATHS_CONTAINER=<name> ORDERS_PAGE_PROOF_REUSE=1 (left running).
 * Print only the seed (for a local test copy): node scripts/smoke/prove-orders-list-page-real-schema.mjs --print-seed <from-date>
 * Prints ORDERS_LIST_PAGE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ORDERS = 5200;
const seedSql = (from, admin, rep) => `
SET session_replication_role = replica;
INSERT INTO public.products (id, product_name)
SELECT md5('g4o-prod-' || g)::uuid, '[G4O] Product ' || g FROM generate_series(1, 40) g;
INSERT INTO public.products (id, product_name) VALUES (md5('g4o-prod-zebra')::uuid, '[G4O] Zebra Unique Blend');
INSERT INTO public.customers (id, farm_name) VALUES (md5('g4o-group')::uuid, '[G4O] Prairie Group');
INSERT INTO public.customers (id, farm_name, parent_customer_id)
SELECT md5('g4o-cust-' || g)::uuid, '[G4O] Farm ' || g, CASE WHEN g % 3 = 0 THEN md5('g4o-group')::uuid END
  FROM generate_series(1, 60) g;
-- Dates repeat (g % 90), so only the id breaks ties. 1 in 97 is deleted; 5201..5250 fall before the season.
INSERT INTO public.orders (id, order_number, customer_id, status, total_price, order_date, is_planned,
                           pricing_status, needs_split_billing, deleted_at)
SELECT md5('g4o-order-' || g)::uuid, 'G4O-' || lpad(g::text, 5, '0'), md5('g4o-cust-' || (1 + g % 60))::uuid,
       (ARRAY['confirmed','partially_fulfilled','fulfilled','cancelled','voided'])[1 + g % 5],
       round(((g * 7919) % 250000) / 100.0 + 0.01, 2),
       CASE WHEN g > ${ORDERS} THEN date '${from}' - 10 ELSE date '${from}' + (g % 90) END,
       g % 7 = 0, CASE WHEN g % 6 = 0 THEN 'needs_pricing' ELSE 'priced' END, g % 11 = 0,
       CASE WHEN g % 97 = 0 THEN now() END
  FROM generate_series(1, ${ORDERS + 50}) g;
-- Two lines per order (none on every 13th); order 4321 carries the one Zebra line.
INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, total_units_needed,
                                quantity_delivered, total_price, sort_order)
SELECT md5('g4o-item-' || g || '-' || k)::uuid, md5('g4o-order-' || g)::uuid,
       CASE WHEN g = 4321 AND k = 2 THEN md5('g4o-prod-zebra')::uuid ELSE md5('g4o-prod-' || (1 + (g + k) % 40))::uuid END,
       CASE WHEN g = 4321 AND k = 2 THEN '[G4O] Zebra Unique Blend' ELSE '[G4O] Product ' || (1 + (g + k) % 40) END,
       round(((g * k * 31) % 5000) / 100.0 + 1, 2), (g % 50) + k,
       CASE g % 4 WHEN 0 THEN 0 WHEN 1 THEN (g % 50) + k WHEN 2 THEN floor(((g % 50) + k) / 3.0) ELSE ((g % 50) + k) / 2.0 END,
       0, k
  FROM generate_series(1, ${ORDERS + 50}) g CROSS JOIN generate_series(1, 2) k
 WHERE g % 13 <> 0;
-- Invoices: half-billed on every 3rd order (half of those the rep's), over-billed on every 10th, plus a
-- voided one (every 9th) and a credit memo (every 15th) that must not count.
INSERT INTO public.invoices (id, invoice_number, order_id, customer_id, invoice_type, status, total_amount_cents,
                             salesman_id, created_by, posted_at)
SELECT md5('g4o-inv-' || g || '-' || k)::uuid, 'G4O-INV-' || g || '-' || k, md5('g4o-order-' || g)::uuid,
       md5('g4o-cust-' || (1 + g % 60))::uuid,
       CASE k WHEN 4 THEN 'credit_memo' ELSE 'chemical_sale' END,
       CASE k WHEN 3 THEN 'voided' ELSE 'unposted' END,
       CASE k WHEN 1 THEN round(((g * 7919) % 250000) / 2.0 + 0.5)::bigint
              WHEN 2 THEN ((g * 7919) % 250000) * 2 + 999
              WHEN 3 THEN 77777 ELSE -500 END,
       CASE WHEN g % 2 = 0 THEN '${rep}'::uuid END, '${admin}'::uuid,
       CASE k WHEN 3 THEN now() END
  FROM generate_series(1, ${ORDERS}) g CROSS JOIN generate_series(1, 4) k
 WHERE (k = 1 AND g % 3 = 0) OR (k = 2 AND g % 10 = 0) OR (k = 3 AND g % 9 = 0) OR (k = 4 AND g % 15 = 0);
-- Deliveries: scheduled on every 4th, in progress on every 8th, completed (not counted) on every 5th.
INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date)
SELECT md5('g4o-del-' || g || '-' || k)::uuid, 'G4O-D-' || g || '-' || k, md5('g4o-order-' || g)::uuid,
       md5('g4o-cust-' || (1 + g % 60))::uuid, '${admin}'::uuid,
       (ARRAY['scheduled','in_progress','completed'])[k], date '${from}' + 40 + (g % 20) - k
  FROM generate_series(1, ${ORDERS}) g CROSS JOIN generate_series(1, 3) k
 WHERE (k = 1 AND g % 4 = 0) OR (k = 2 AND g % 8 = 0) OR (k = 3 AND g % 5 = 0);
SET session_replication_role = origin;`;

if (process.argv[2] === '--print-seed') {
  const [from, admin, rep] = process.argv.slice(3);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') && admin && rep, 'usage: --print-seed <from-date> <admin-uuid> <rep-uuid>');
  process.stdout.write(seedSql(from, admin, rep));
  process.exit(0);
}

const { buildContainer, removeContainer, seedUsers, psql, scalar, attempt, asUser, signIn, USERS, ROOT, NAME, docker } = await import('./undo-paths/harness.mjs');
const { applyTableSearchSort } = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'tableSearchSort.ts')).href);

const FIRST = '20261116120000_orders_list_page.sql';
const CANDIDATE = '20261125100000_orders_list_keyset_page.sql';
const FROM = '2026-10-01';
const TO = '2027-09-30';
const reuse = process.env.ORDERS_PAGE_PROOF_REUSE === '1';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'string' ? `'${v.replaceAll("'", "''")}'` : String(v));

/**
 * Calls get_orders_page (or, with `after` set, get_orders_keyset_page) as `uid` (null = anon) and returns the
 * payload, or { error }. `pre` runs first as the superuser inside the same rolled-back transaction (e.g. a
 * delete "between pages"). `after: 'none'` calls the keyset function with no bookmark.
 */
function page(uid, { search = null, status = null, planned = null, pricing = null, split = null, key = null, dir = 'asc', limit = 1000, offset = 0, from = FROM, to = TO, after, pre = '' } = {}) {
  const who = uid
    ? `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true); SET LOCAL ROLE authenticated;`
    : 'SET LOCAL ROLE anon;';
  const args = `${q(from)}::date, ${q(to)}::date, ${q(search)}, ${q(status)}, ${q(planned)}, ${q(pricing)}, ${q(split)}, ${q(key)}, ${q(dir)}, ${limit}, ${offset}`;
  const call = after === undefined
    ? `public.get_orders_page(${args})`
    : `public.get_orders_keyset_page(${args}, ${after === 'none' ? 'NULL' : q(typeof after === 'string' ? after : JSON.stringify(after))}::jsonb)`;
  const sql = `BEGIN; ${pre}
${who}
SELECT ${call}::text;
ROLLBACK;`;
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input: sql, allowFailure: true });
  if (r.status !== 0) return { error: r.stderr };
  return JSON.parse(r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).at(-1));
}

function allPages(uid, opts, size) {
  const rows = [];
  let first;
  for (let offset = 0; ; offset += size) {
    const p = page(uid, { ...opts, limit: size, offset });
    assert.ok(!p.error, `page failed: ${p.error}`);
    first ??= p;
    assert.equal(p.total_count, first.total_count, 'total_count moved between pages');
    rows.push(...p.rows);
    if (p.rows.length < size) break;
  }
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'a row appeared twice across pages');
  return { rows, total: first.total_count, cents: first.total_price_cents };
}

/** Every row by bookmark: each call passes the previous page's next_cursor (as text, like the browser). */
function keysetAll(uid, opts, size, pre = '') {
  const rows = [];
  let first;
  for (let after = 'none'; ;) {
    const p = page(uid, { ...opts, limit: size, after, pre });
    assert.ok(!p.error, `keyset page failed: ${p.error}`);
    first ??= p;
    assert.equal(p.total_count, first.total_count, 'keyset: total_count moved between pages');
    assert.ok(p.rows.length <= size, 'keyset: page too long');
    rows.push(...p.rows);
    if (!p.next_cursor) break;
    assert.equal(p.rows.length, size, 'keyset: a short page must not carry a next_cursor');
    after = p.next_cursor;
  }
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'keyset: a row appeared twice across pages');
  return { rows, total: first.total_count, cents: first.total_price_cents };
}

const json = (sql) => JSON.parse(scalar(sql) || '[]');

/** The Orders screen's rows as src/pages/Orders.tsx built them before this change, for the user `who`. */
function reference(who) {
  const orders = json(`SELECT json_agg(json_build_object('id', o.id, 'order_number', o.order_number, 'customer_id', o.customer_id,
      'status', o.status, 'total_price', o.total_price, 'order_date', o.order_date, 'is_planned', o.is_planned,
      'pricing_status', o.pricing_status, 'needs_split_billing', o.needs_split_billing,
      'customer', json_build_object('farm_name', c.farm_name, 'parent_customer_id', c.parent_customer_id)) ORDER BY o.order_date DESC, o.id)
    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
   WHERE o.order_date BETWEEN '${FROM}' AND '${TO}' AND o.deleted_at IS NULL;`);
  const items = json('SELECT json_agg(json_build_object(\'order_id\', order_id, \'total_units_needed\', total_units_needed, \'quantity_delivered\', quantity_delivered, \'price_per_unit\', price_per_unit, \'product_name\', product_name) ORDER BY id) FROM order_items;');
  const invs = json(`SELECT json_agg(json_build_object('order_id', order_id, 'total_amount_cents', total_amount_cents, 'invoice_type', invoice_type, 'status', status, 'deleted_at', deleted_at, 'salesman_id', salesman_id, 'created_by', created_by))
    FROM invoices WHERE status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL;`);
  const dels = json("SELECT json_agg(json_build_object('order_id', order_id, 'scheduled_date', scheduled_date)) FROM deliveries WHERE status IN ('scheduled', 'in_progress');");
  const names = Object.fromEntries(json('SELECT json_agg(json_build_array(id, farm_name)) FROM customers;'));
  // invoices_select: admin sees all; anyone else only invoices they created or sell.
  const visible = (inv) => who === USERS.admin || inv.salesman_id === who || inv.created_by === who;

  const itemsByOrder = {};
  const productNamesByOrder = {};
  for (const item of items) {
    itemsByOrder[item.order_id] ??= { neededValue: 0, deliveredValue: 0 };
    const price = Number(item.price_per_unit) || 0;
    itemsByOrder[item.order_id].neededValue += (Number(item.total_units_needed) || 0) * price;
    itemsByOrder[item.order_id].deliveredValue += (Number(item.quantity_delivered) || 0) * price;
    if (item.product_name) (productNamesByOrder[item.order_id] ??= new Set()).add(item.product_name);
  }
  const invoicedByOrder = {};
  for (const inv of invs) {
    if (visible(inv) && inv.invoice_type !== 'credit_memo') invoicedByOrder[inv.order_id] = (invoicedByOrder[inv.order_id] || 0) + inv.total_amount_cents;
  }
  const deliveryByOrder = {};
  for (const del of dels) {
    const d = (deliveryByOrder[del.order_id] ??= { count: 0, earliestDate: null });
    d.count += 1;
    if (!d.earliestDate || del.scheduled_date < d.earliestDate) d.earliestDate = del.scheduled_date;
  }
  return orders.map((o) => {
    const counts = itemsByOrder[o.id] || { neededValue: 0, deliveredValue: 0 };
    const orderCents = Math.round((o.total_price || 0) * 100);
    const invCents = invoicedByOrder[o.id] || 0;
    const invPct = orderCents > 0 ? Math.round((invCents / orderCents) * 100) : 0;
    const del = deliveryByOrder[o.id] || { count: 0, earliestDate: null };
    return {
      ...o,
      fulfillment_pct: counts.neededValue > 0 ? Math.round((counts.deliveredValue / counts.neededValue) * 100) : 0,
      invoiced_pct: Math.min(invPct, 100),
      farm_group_name: o.customer.parent_customer_id ? names[o.customer.parent_customer_id] || null : null,
      customer_name: o.customer.farm_name || '',
      active_delivery_count: del.count,
      earliest_delivery_date: del.earliestDate,
      product_names: [...(productNamesByOrder[o.id] || [])].sort().join(', '),
    };
  });
}

const SEARCH_KEYS = ['order_number', 'farm_group_name', 'customer_name', 'product_names'];
/** The reference rows the screen would show: its filters, then its search and sort (stable over the read order). */
function expected(ref, { search = '', status = null, planned = null, pricing = null, split = null, key = null, dir = 'asc' } = {}) {
  const filtered = ref.filter((o) => (!status || o.status === status)
    // As the screen: "committed" is every order not marked planned, a missing flag included.
    && (planned === null || Boolean(o.is_planned) === planned)
    && (!pricing || o.pricing_status === pricing)
    && (!split || o.needs_split_billing));
  // The screen's sort is stable over its read order (order_date DESC, id): equal values stay newest first.
  return applyTableSearchSort(filtered, SEARCH_KEYS, search, key, dir);
}

const FIELDS = ['id', 'order_number', 'status', 'total_price', 'order_date', 'is_planned', 'pricing_status', 'needs_split_billing',
  'customer', 'fulfillment_pct', 'invoiced_pct', 'farm_group_name', 'customer_name', 'active_delivery_count', 'earliest_delivery_date'];
function sameRows(label, got, want) {
  assert.equal(got.length, want.length, `${label}: ${got.length} rows, expected ${want.length}`);
  got.forEach((g, i) => {
    const w = want[i];
    for (const f of FIELDS) assert.deepEqual(g[f], w[f], `${label}: row ${i} (${w.order_number}) field ${f}: got ${JSON.stringify(g[f])}, expected ${JSON.stringify(w[f])}`);
    assert.equal(g.product_names.split(', ').sort().join(', '), w.product_names, `${label}: row ${i} product names`);
  });
}
const cents = (rows) => rows.reduce((s, o) => s + Math.round((o.total_price || 0) * 100), 0);

try {
  if (!reuse) { buildContainer(); seedUsers(); }
  for (const m of [FIRST, CANDIDATE]) {
    assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${path.basename(m, '.sql')}';`), '1',
      `${m} must have replayed`);
  }
  if (scalar("SELECT count(*) FROM orders WHERE order_number LIKE 'G4O-%';") === '0') {
    const r = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
      { input: seedSql(FROM, USERS.admin, USERS.rep), allowFailure: true });
    assert.equal(r.status, 0, `seed failed:\n${r.stderr}`);
  }
  const ref = reference(USERS.admin);
  assert.ok(ref.length > 5000, `expected over 5,000 season orders, got ${ref.length}`);

  // 1. Every row, default order, in pages of 1000 and of 37.
  for (const size of [1000, 37]) {
    const all = allPages(USERS.admin, {}, size);
    sameRows(`default order, pages of ${size}`, all.rows, ref);
    assert.equal(all.total, ref.length, 'total_count');
    assert.equal(all.cents, cents(ref), 'total_price_cents');
  }
  console.log(`[orders-page] admin: ${ref.length} orders, $${(cents(ref) / 100).toFixed(2)}; pages of 1000 and 37 match the screen's rows field for field`);

  // 2. Every sort key, both ways.
  for (const key of ['order_number', 'status', 'total_price', 'order_date', 'fulfillment_pct', 'invoiced_pct']) {
    for (const dir of ['asc', 'desc']) {
      sameRows(`sort ${key} ${dir}`, allPages(USERS.admin, { key, dir }, 1000).rows, expected(ref, { key, dir }));
    }
  }
  console.log('[orders-page] six sort keys, both directions: same order as the screen, ties newest first');

  // 3. Filters and search: count, money total and the first and a later page.
  const cases = [
    { status: 'fulfilled' }, { planned: true }, { planned: false }, { pricing: 'needs_pricing' }, { split: true },
    { status: 'confirmed', planned: false, pricing: 'priced', key: 'total_price', dir: 'desc' },
    { search: 'zebra' }, { search: 'PRAIRIE group' }, { search: 'g4o-0432' }, { search: 'Farm 17' }, { search: 'product 3', split: true },
    { search: 'no such order' },
  ];
  for (const c of cases) {
    const want = expected(ref, c);
    const p1 = page(USERS.admin, { ...c, limit: 50 });
    assert.ok(!p1.error, p1.error);
    assert.equal(p1.total_count, want.length, `${JSON.stringify(c)}: total_count`);
    assert.equal(p1.total_price_cents, cents(want), `${JSON.stringify(c)}: total_price_cents`);
    sameRows(`${JSON.stringify(c)} page 1`, p1.rows, want.slice(0, 50));
    if (want.length > 100) sameRows(`${JSON.stringify(c)} page 3`, page(USERS.admin, { ...c, limit: 50, offset: 100 }).rows, want.slice(100, 150));
    console.log(`[orders-page] ${JSON.stringify(c)}: ${p1.total_count} match, $${(p1.total_price_cents / 100).toFixed(2)}`);
  }
  const zebraAt = ref.findIndex((o) => o.order_number === 'G4O-04321');
  assert.ok(zebraAt >= 1000, `the Zebra order must sit past the first page of the default list (at ${zebraAt})`);
  console.log(`[orders-page] search "zebra" finds the order listed at row ${zebraAt + 1} of the default list`);

  // 4. A sales rep: same orders; invoiced % from the invoices the rep can see.
  const refRep = reference(USERS.rep);
  const rep = allPages(USERS.rep, {}, 1000);
  sameRows('sales rep', rep.rows, refRep);
  assert.ok(refRep.some((o, i) => o.invoiced_pct !== ref[i].invoiced_pct), 'the seed must make a rep see a different invoiced %');
  console.log('[orders-page] sales rep: same orders; invoiced % counts only the rep\'s visible invoices');

  // 5. Driver sees nothing; anon cannot call; bad arguments refused.
  const drv = page(USERS.driver, {});
  assert.equal(drv.total_count, 0, 'a driver must see no order');
  assert.equal(drv.total_price_cents, 0);
  assert.match(page(null, {}).error ?? '', /permission denied for function get_orders_page/);
  assert.match(page(USERS.admin, { key: 'total_cost' }).error ?? '', /ORDERS_PAGE_BAD_SORT/);
  assert.match(page(USERS.admin, { dir: 'sideways' }).error ?? '', /ORDERS_PAGE_BAD_SORT_DIR/);
  assert.match(page(USERS.admin, { limit: 1001 }).error ?? '', /ORDERS_PAGE_BAD_RANGE/);
  assert.match(page(USERS.admin, { offset: -1 }).error ?? '', /ORDERS_PAGE_BAD_RANGE/);
  assert.match(page(USERS.admin, { from: null }).error ?? '', /ORDERS_PAGE_DATES_REQUIRED/);
  console.log('[orders-page] driver sees 0; anon refused; bad sort, direction, range and dates refused');

  // 6. Keyset paging lists exactly what the reference lists: default order (pages of 1000 and 37), every
  //    sort key both ways, filters with search, and a rep.
  for (const size of [1000, 37]) {
    const all = keysetAll(USERS.admin, {}, size);
    sameRows(`keyset default, pages of ${size}`, all.rows, ref);
    assert.equal(all.total, ref.length, 'keyset total_count');
    assert.equal(all.cents, cents(ref), 'keyset total_price_cents');
  }
  for (const key of ['order_number', 'status', 'total_price', 'order_date', 'fulfillment_pct', 'invoiced_pct']) {
    for (const dir of ['asc', 'desc']) {
      // Pages of 400 put page breaks inside runs of equal values (status, dates, percentages).
      sameRows(`keyset sort ${key} ${dir}`, keysetAll(USERS.admin, { key, dir }, 400).rows, expected(ref, { key, dir }));
    }
  }
  for (const c of [{ search: 'product 3', split: true }, { status: 'confirmed', planned: false, pricing: 'priced', key: 'total_price', dir: 'desc' }]) {
    sameRows(`keyset ${JSON.stringify(c)}`, keysetAll(USERS.admin, c, 50).rows, expected(ref, c));
  }
  sameRows('keyset sales rep', keysetAll(USERS.rep, {}, 1000).rows, refRep);
  console.log('[orders-page] keyset: default (1000 and 37), six sort keys both ways (pages of 400), filters, rep: same rows as the screen');

  // 7. Nulls in the sort column sort last both ways, and keyset paging walks across them with no skip.
  //    Every sort column is NOT NULL today; the constraint is lifted inside the rolled-back call to test the branch.
  const nulls = "ALTER TABLE public.orders ALTER COLUMN total_price DROP NOT NULL; UPDATE public.orders SET total_price = NULL WHERE order_number < 'G4O-00300';";
  for (const dir of ['asc', 'desc']) {
    const byOffset = allPages(USERS.admin, { key: 'total_price', dir, pre: nulls }, 1000).rows;
    assert.ok(byOffset.at(-1).total_price === null && byOffset[0].total_price !== null, 'nulls must sort last');
    sameRows(`keyset with null totals ${dir}`, keysetAll(USERS.admin, { key: 'total_price', dir }, 113, nulls).rows, byOffset);
  }
  console.log('[orders-page] keyset with null totals: nulls last both ways, same rows as one long read');

  // 8. The skip itself: page 1 (50 rows) is read, then an order on page 1 leaves the list before page 2.
  for (const [label, filt, key, dir, removeAt, how] of [
    ['deleted (default order)', {}, null, 'asc', 10, 'UPDATE public.orders SET deleted_at = now() WHERE id = $1;'],
    ['the bookmark row itself deleted', {}, null, 'asc', 49, 'UPDATE public.orders SET deleted_at = now() WHERE id = $1;'],
    ['edited out of the status filter', { status: 'fulfilled' }, 'order_number', 'desc', 0, "SET LOCAL session_replication_role = replica; UPDATE public.orders SET status = 'cancelled' WHERE id = $1;"],
    ['deleted (status sort, inside a run of equal values)', {}, 'status', 'asc', 25, 'UPDATE public.orders SET deleted_at = now() WHERE id = $1;'],
  ]) {
    const want = expected(ref, { ...filt, key, dir });
    const p1 = page(USERS.admin, { ...filt, key, dir, limit: 50, after: 'none' });
    sameRows(`${label}: page 1`, p1.rows, want.slice(0, 50));
    const pre = how.replace('$1', q(p1.rows[removeAt].id));
    const offset2 = page(USERS.admin, { ...filt, key, dir, limit: 50, offset: 50, pre });
    const keyset2 = page(USERS.admin, { ...filt, key, dir, limit: 50, after: p1.next_cursor, pre });
    assert.ok(!offset2.error && !keyset2.error, offset2.error || keyset2.error);
    // The old offset paging skips the first row of page 2 (the bug being fixed) ...
    assert.equal(offset2.rows[0].id, want[51].id, `${label}: expected the offset page to start one row late`);
    // ... and the bookmark page starts exactly where page 1 ended.
    sameRows(`${label}: keyset page 2`, keyset2.rows, want.slice(50, 100));
    assert.equal(keyset2.total_count, want.length - 1, `${label}: total_count counts the change`);
    console.log(`[orders-page] ${label} between pages: offset paging skipped ${want[50].order_number}; keyset page 2 starts with it`);
  }

  // 9. Bookmarks: a stale one (other sort) and malformed ones are refused; anon refused; driver sees 0.
  const firstCursor = page(USERS.admin, { limit: 5, after: 'none' }).next_cursor;
  assert.ok(firstCursor?.id, 'page 1 must carry a next_cursor');
  assert.match(page(USERS.admin, { key: 'status', limit: 5, after: firstCursor }).error ?? '', /ORDERS_PAGE_STALE_CURSOR/);
  assert.match(page(USERS.admin, { dir: 'desc', limit: 5, after: firstCursor }).error ?? '', /ORDERS_PAGE_STALE_CURSOR/);
  assert.match(page(USERS.admin, { limit: 5, offset: 5, after: firstCursor }).error ?? '', /ORDERS_PAGE_BAD_RANGE/, 'a bookmark with an offset must be refused');
  for (const bad of ['[]', '"x"', '{"k":null,"dir":"asc"}', '{"k":null,"dir":"asc","d":"2026-10-05"}',
    '{"k":null,"dir":"asc","d":"2026-10-05","id":"x"}', '{"k":null,"dir":"asc","d":"not a date","id":"00000000-0000-0000-0000-000000000000"}',
    '{"k":null,"dir":"asc","n":"abc","d":"2026-10-05","id":"00000000-0000-0000-0000-000000000000"}',
    '{"k":null,"dir":"asc","t":"G4O","d":"2026-10-05","id":"00000000-0000-0000-0000-000000000000"}',
    '{"k":null,"dir":"asc","n":"5","d":"2026-10-05","id":"00000000-0000-0000-0000-000000000000"}']) {
    assert.match(page(USERS.admin, { limit: 5, after: bad }).error ?? '', /ORDERS_PAGE_BAD_CURSOR/, `bookmark ${bad} must be refused`);
  }
  // A bookmark missing its own sort value (or carrying it as a non-text JSON value) is refused, not read as "nothing after".
  const ID0 = '"d":"2026-10-05","id":"00000000-0000-0000-0000-000000000000"';
  for (const [key, bad] of [['order_number', `{"k":"order_number","dir":"asc",${ID0}}`],
    ['status', `{"k":"status","dir":"asc","t":5,${ID0}}`],
    ['total_price', `{"k":"total_price","dir":"asc",${ID0}}`],
    ['order_date', `{"k":"order_date","dir":"asc","n":9000,${ID0}}`]]) {
    assert.match(page(USERS.admin, { key, limit: 5, after: bad }).error ?? '', /ORDERS_PAGE_BAD_CURSOR/, `bookmark ${bad} must be refused`);
  }
  // A real bookmark whose sort value is null (nulls sort last) is still accepted.
  assert.ok(!page(USERS.admin, { key: 'total_price', limit: 5, after: `{"k":"total_price","dir":"asc","n":null,${ID0}}` }).error, 'a null sort value is a valid bookmark');
  assert.match(page(null, { after: 'none' }).error ?? '', /permission denied for function get_orders_keyset_page/);
  assert.equal(page(USERS.driver, { after: 'none' }).total_count, 0, 'a driver must see no order (keyset)');
  const lastPage = page(USERS.admin, { limit: 1000, offset: ref.length - 3, after: 'none' });
  assert.equal(lastPage.rows.length, 3);
  assert.equal(lastPage.next_cursor, null, 'the last page must carry no next_cursor');
  console.log('[orders-page] stale and malformed bookmarks refused; anon refused; driver sees 0; last page has no next_cursor');

  // 10. The live smoke chains pass here first.
  for (const file of ['smoke-goal4-orders-page.sql', 'smoke-goal4-orders-keyset-page.sql']) {
    const chain = readFileSync(path.join(ROOT, 'scripts', 'smoke', file), 'utf8');
    const smoked = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-1'], { input: chain, allowFailure: true });
    assert.match(smoked.stderr, /SMOKE_PASS_ROLLBACK/, `${file} did not pass:\n${smoked.stderr}`);
    console.log(`[orders-page] ${file}: PASS (rolled back)`);
  }

  // 11. A second apply is refused.
  const again = psql(candidate, { allowFailure: true });
  assert.notEqual(again.status, 0, 'a second apply must be refused');
  assert.match(again.stderr, /already exists/);

  // 12. Cost-exposure sweep keys for both functions (SECURITY INVOKER: expected none).
  const costSql = readFileSync(path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'cost-exposure-review.sql'), 'utf8').replace(/;\s*$/, '');
  console.log('[orders-page] cost-exposure keys:', scalar(`SELECT string_agg(violation_key, ' ; ') FROM (${costSql}) s WHERE violation_key LIKE 'get_orders_page(%' OR violation_key LIKE 'get_orders_keyset_page(%';`) || '<none>');

  // 13. Speed at 60,000 more orders (the Deliveries lesson, 2026-11-06: a rep's first page took ~9 s at 60,000 rows,
  // over the 8 s statement timeout for `authenticated`, and nobody had timed it before review). Seeded in one
  // rolled-back transaction. Each read is also held under 3x a rep's plain read of the same orders, lines, invoices
  // and deliveries (the same row level security cost), so the check means the same on a slow or a fast PC.
  const ms = (label, stmt) => `f0 := clock_timestamp(); ${asUser(stmt)} t := concat_ws(',', t, '${label}=' || round(extract(epoch FROM clock_timestamp() - f0::timestamptz) * 1000));`;
  const rpc = (o = {}) => `r := public.get_orders_page(p_from => '${FROM}', p_to => '${TO}'${Object.entries(o).map(([k, v]) => `, p_${k} => ${q(v)}`).join('')});`;
  const keyset = (o, after) => `r := public.get_orders_keyset_page(p_from => '${FROM}', p_to => '${TO}'${Object.entries(o).map(([k, v]) => `, p_${k} => ${q(v)}`).join('')}, p_after => ${after});`;
  const plain = 'n := (SELECT count(*) FROM public.orders) + (SELECT count(*) FROM public.order_items) + (SELECT count(*) FROM public.invoices) + (SELECT count(*) FROM public.deliveries);';
  const timed = attempt(USERS.rep, `
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.orders (id, order_number, customer_id, status, total_price, order_date, is_planned, pricing_status, needs_split_billing)
    SELECT md5('g4v-order-' || g)::uuid, 'G4V-' || lpad(g::text, 6, '0'), md5('g4o-cust-' || (1 + g % 60))::uuid,
           (ARRAY['confirmed','partially_fulfilled','fulfilled','cancelled','voided'])[1 + g % 5],
           round(((g * 7919) % 250000) / 100.0 + 0.01, 2), date '${FROM}' + (g % 365), g % 7 = 0,
           CASE WHEN g % 6 = 0 THEN 'needs_pricing' ELSE 'priced' END, g % 11 = 0
      FROM generate_series(1, 60000) g;
    INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, total_units_needed, quantity_delivered, total_price, sort_order)
    SELECT md5('g4v-order-' || g)::uuid, md5('g4o-prod-' || (1 + (g + k) % 40))::uuid, '[G4O] Product ' || (1 + (g + k) % 40),
           round(((g * k * 31) % 5000) / 100.0 + 1, 2), (g % 50) + k, (g % 3) * k, 0, k
      FROM generate_series(1, 60000) g CROSS JOIN generate_series(1, 4) k WHERE k <= 1 + g % 4;
    INSERT INTO public.invoices (invoice_number, order_id, customer_id, invoice_type, status, total_amount_cents, salesman_id, created_by)
    SELECT 'G4V-INV-' || g, md5('g4v-order-' || g)::uuid, md5('g4o-cust-' || (1 + g % 60))::uuid, 'chemical_sale', 'unposted',
           ((g * 7919) % 250000) / 2, CASE WHEN g % 4 = 0 THEN '${USERS.rep}'::uuid END, '${USERS.admin}'::uuid
      FROM generate_series(1, 60000) g WHERE g % 2 = 0;
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, status, scheduled_date)
    SELECT 'G4V-D-' || g, md5('g4v-order-' || g)::uuid, md5('g4o-cust-' || (1 + g % 60))::uuid, '${USERS.admin}'::uuid,
           (ARRAY['scheduled','in_progress','completed'])[1 + g % 3], date '${FROM}' + (g % 365)
      FROM generate_series(1, 60000) g WHERE g % 3 = 0;
    SET LOCAL session_replication_role = origin;
    ANALYZE public.orders; ANALYZE public.order_items; ANALYZE public.invoices; ANALYZE public.deliveries; ANALYZE public.customers;
    ${ms('warm', plain)}
    ${ms('base', plain)}
    ${ms('rep_first', rpc({ limit: 50 }))} t := t || ',rep_first_seen=' || (r->>'total_count') || ',rep_first_rows=' || jsonb_array_length(r->'rows');
    ${ms('rep_deep_page', rpc({ limit: 50, offset: 30000 }))} t := t || ',rep_deep_rows=' || jsonb_array_length(r->'rows');
    ${ms('rep_export', rpc({ limit: 1000, offset: 30000 }))} t := t || ',rep_export_rows=' || jsonb_array_length(r->'rows');
    ${ms('rep_sort', rpc({ limit: 50, sort_key: 'invoiced_pct', sort_dir: 'desc' }))} t := t || ',rep_sort_rows=' || jsonb_array_length(r->'rows');
    ${ms('rep_search', rpc({ limit: 50, search: 'product 3' }))} t := t || ',rep_search_seen=' || (r->>'total_count') || ',rep_search_rows=' || jsonb_array_length(r->'rows');
    ${ms('rep_bookmark_first', keyset({ limit: 50 }, 'NULL'))} t := t || ',rep_bookmark_first_rows=' || jsonb_array_length(r->'rows');
    ${ms('rep_bookmark_next', keyset({ limit: 50 }, "r->'next_cursor'"))} t := t || ',rep_bookmark_next_rows=' || jsonb_array_length(r->'rows');
    ${ms('rep_bookmark_sort_first', keyset({ limit: 50, sort_key: 'invoiced_pct', sort_dir: 'desc' }, 'NULL'))}
    ${ms('rep_bookmark_sort_next', keyset({ limit: 50, sort_key: 'invoiced_pct', sort_dir: 'desc' }, "r->'next_cursor'"))} t := t || ',rep_bookmark_sort_rows=' || jsonb_array_length(r->'rows');
    ${signIn(USERS.admin)}
    ${ms('admin_first', rpc({ limit: 50 }))}
    v := t || ',admin_seen=' || (r->>'total_count');`);
  assert.ok(timed.startsWith('ok|'), `speed probe failed: ${timed}`);
  const times = Object.fromEntries(timed.slice(3).split(',').map((kv) => kv.split('=')).map(([k, n]) => [k, Number(n)]));
  console.log(`[orders-page] 60,000 more orders, ms: ${JSON.stringify(times)}`);
  // The rep's timed reads must have done the full work, not returned an empty list fast.
  assert.ok(times.admin_seen > 60000 && times.rep_first_seen > 60000, `the timed reads saw too few orders: ${timed}`);
  assert.ok(times.rep_first_rows === 50 && times.rep_deep_rows === 50 && times.rep_export_rows === 1000 && times.rep_sort_rows === 50 && times.rep_search_seen > 1000 && times.rep_search_rows === 50
    && times.rep_bookmark_first_rows === 50 && times.rep_bookmark_next_rows === 50 && times.rep_bookmark_sort_rows === 50,
    `a rep's timed read returned a short page: ${timed}`);
  for (const k of ['base', 'rep_first', 'rep_deep_page', 'rep_export', 'rep_sort', 'rep_search', 'rep_bookmark_first', 'rep_bookmark_next', 'rep_bookmark_sort_first', 'rep_bookmark_sort_next', 'admin_first']) {
    assert.ok(Number.isFinite(times[k]), `no timing for ${k}: ${timed}`);
    assert.ok(times[k] < 8000, `${k} took ${times[k]} ms at 60,000 orders (authenticated statement_timeout is 8 s)`);
    // Floor of 1 s: on a fast PC a tiny baseline must not fail a healthy page.
    if (k !== 'base') assert.ok(times[k] < 3 * Math.max(times.base, 1000), `${k} took ${times[k]} ms, over 3x a rep's plain read (${times.base} ms): the per-page cost regressed`);
  }
  console.log('\nORDERS_LIST_PAGE_PROOF_PASS');
} finally {
  if (!reuse) removeContainer();
}
