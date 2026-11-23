#!/usr/bin/env node
/**
 * Real-schema proof for 20270225120000_ki167_relabel_completed_lines_stock_unit.sql (KI-167).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs). Seeds three invented orders shaped like the three live
 * lines: the same order-line ids, order numbers, product names, stock units and quantities, everything else invented.
 * Each is completed through complete_delivery, so it ends fulfilled. ORD-2026-0484 is delivered in two loads: the first
 * is completed short (20 of 25), which leaves an open remainder of 5 in "Gall"; the second delivers those 5.
 * The candidate's LIVE_ID_TODO placeholders (order and product ids, open remainders) are filled with this fixture's ids;
 * the unfilled file refuses. Then:
 *   (a) before: void the (last) delivery -> the line reopens -> the replacement delivery (the line's unit, as New
 *       Delivery sends it) and, on ORD-2026-0484, the follow-up from the open remainder are refused with
 *       LINE_UNIT_NOT_STOCK_UNIT. Rolled back.
 *   (c) a pinned line that moved (its delivery voided first) -> KI167_ROW_MOVED; an unreviewed bad line elsewhere ->
 *       KI167_OTHER_LINE listing it. Both rolled back; nothing changed.
 *   (b) apply: only unit_size moved on the three lines (and unit_size/updated_at on the open remainder), quantities and
 *       order totals unchanged, edit version and updated_at moved; a second apply refuses. Then, each step committed
 *       through the app's signed-in actions: void -> reopen -> replacement (new delivery, or follow-up from the
 *       remainder) -> confirm_delivery -> complete_delivery, ending at the same quantities; stock goes back up on the
 *       void, down on the replacement, and ends where it started.
 *
 * Run: node scripts/smoke/prove-ki167-relabel-completed-lines-real-schema.mjs   (needs Docker; never touches live)
 * Prints KI167_RELABEL_PROOF_PASS on success. KEEP_CONTAINER=1 keeps a container this run built; a container picked
 * for reuse (KI167_REUSE=1 with UNDO_PATHS_CONTAINER) is never removed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, claims, scalar, docker, USERS, ROOT, NAME } from './undo-paths/harness.mjs';

const CANDIDATE = '20270225120000_ki167_relabel_completed_lines_stock_unit.sql';
const RAW = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const REUSE = Boolean(process.env.KI167_REUSE);
const ADMIN = USERS.admin;
const fid = (n) => `16700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUST = fid('c1');
// [order-line id (live), order number, product name, form, stock unit, old line unit, quantity]
const LINES = [
  ['1a9a6d97-8540-47ac-8616-7792774d7502', 'ORD-2026-0188', 'Treaty Extra', 'dry', 'Dry oz', 'oz', 800],
  ['ff563d1a-31d0-46d8-9329-2a928c818c12', 'ORD-2026-0381', 'Trivapro - Bulk', 'liquid', 'Gal', 'Gallon ', 192],
  ['b81e22ff-9596-4abe-80fe-56b8684e5968', 'ORD-2026-0484', 'Gen Select 2LB: (Ceridian 2EC, Clethodim 2EC, Volunteer) - 2.5 Gal', 'liquid', 'Gal', 'Gall', 25],
].map(([line, order, name, form, stock, old, qty], i) => ({
  line, order, name, form, stock, old, qty, P: fid(`f${i}`), O: fid(`d${i}`), D: fid(`b${i}`), DI: fid(`e${i}`),
}));
// ORD-2026-0484: first load 25 completed with 20 (remainder 5 stays open), second load (LAST.D2) delivers the 5.
const SPLIT = LINES[2];
Object.assign(SPLIT, { first: 20, D2: fid('b9'), DI2: fid('e8') });
const lastLoad = (l) => (l.D2 ? { D: l.D2, qty: l.qty - l.first } : { D: l.D, qty: l.qty });
const ORDERS = `(${LINES.map((l) => `'${l.O}'`).join(',')})`;
const PRODUCTS = `(${LINES.map((l) => `'${l.P}'`).join(',')})`;
const sq = (s) => s.replaceAll("'", "''");
const PSQL = (user) => ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const run = (sql, user = 'postgres') => docker(PSQL(user), { input: sql, allowFailure: true });
const asAdmin = (sql) => run(`BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;\n${sql}\nCOMMIT;`);
const complete = (d, dis, key) => `SELECT public.complete_delivery(p_delivery_id => '${d}', p_signed_by => 'No proof — recorded by office',
  p_performed_by => '${ADMIN}', p_quantities => ${dis}, p_idempotency_key => '${key}', p_evidence => 'no_proof', p_evidence_ref => '[PROVER] KI167');`;

function seed() {
  const raw = (sql) => { const r = run(`SET session_replication_role = replica;\n${sql}\nSET session_replication_role = origin;`, 'supabase_admin'); assert.equal(r.status, 0, r.stderr); };
  raw(`INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] KI167 Farm', true);
    ${LINES.map((l, i) => `
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit,
        current_cost, tier1_price, tier2_price, tier3_price, pricing_version, is_active)
      VALUES ('${l.P}', '${sq(l.name)}', 'KI167-${i}', '${l.form}', '${l.stock}', '${l.stock}', '${l.stock}', '${l.stock}', 8, 10, 10, 10, 1, true);
    INSERT INTO public.inventory (product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES ('${l.P}', 'Main Warehouse', '${l.stock}', 1000, ${l.qty}, 0);
    INSERT INTO public.orders (id, order_number, customer_id, status, salesman_id) VALUES ('${l.O}', '${l.order}', '${CUST}', 'confirmed', '${ADMIN}');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, total_units_needed, quantity_delivered,
        quantity_remaining, price_per_unit, cost_per_unit, total_price, profit, net_margin)
      VALUES ('${l.line}', '${l.O}', '${l.P}', '${sq(l.name)}', '${l.old}', ${l.qty}, 0, ${l.qty}, 10, 8, ${l.qty} * 10, ${l.qty} * 2, 20);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, is_quick_delivery)
      VALUES ('${l.D}', 'KI167-D${i}', '${l.O}', '${CUST}', '${ADMIN}', 'in_progress', false);
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${l.DI}', '${l.D}', '${l.line}', '${l.P}', ${l.qty}, '${l.old}');`).join('')}`);
  // Order totals as the totals trigger would write them (the seeded orders only).
  const t = run(`UPDATE public.orders o SET total_price = s.p, total_cost = s.c, total_profit = s.p - s.c, total_margin_pct = 20
      FROM (SELECT order_id, sum(total_price) p, sum(cost_per_unit * total_units_needed) c FROM public.order_items
             WHERE order_id IN ${ORDERS} GROUP BY 1) s
     WHERE s.order_id = o.id AND o.id IN ${ORDERS};`);
  assert.equal(t.status, 0, t.stderr);
  // Completed through the real RPC, as the office records a delivery with no proof.
  for (const [i, l] of LINES.entries()) {
    const c = asAdmin(complete(l.D, `jsonb_build_object('${l.DI}', ${l.first ?? l.qty})`, `ki167-seed-${i}`));
    assert.equal(c.status, 0, c.stderr);
  }
  // ORD-2026-0484's second load of the 5 short (written like the first; its completion is the real RPC).
  raw(`INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, is_quick_delivery)
      VALUES ('${SPLIT.D2}', 'KI167-D2b', '${SPLIT.O}', '${CUST}', '${ADMIN}', 'in_progress', false);
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${SPLIT.DI2}', '${SPLIT.D2}', '${SPLIT.line}', '${SPLIT.P}', ${SPLIT.qty - SPLIT.first}, '${SPLIT.old}');`);
  const c2 = asAdmin(complete(SPLIT.D2, `jsonb_build_object('${SPLIT.DI2}', ${SPLIT.qty - SPLIT.first})`, 'ki167-seed-2b'));
  assert.equal(c2.status, 0, c2.stderr);
  assert.equal(lineState(), LINES.map((l) => `fulfilled:${l.old}:${l.qty}:${l.qty}/0`).join(','));
  assert.equal(remainders(), `pending:${SPLIT.old}:5`, 'the short first load left one open remainder in the old unit');
  console.log('[seed] 3 fulfilled orders, lines in "oz" / "Gallon " / "Gall" through complete_delivery; ORD-2026-0484 has an open remainder of 5 "Gall"');
}

const lineState = () => scalar(`SELECT string_agg(o.status || ':' || x.unit_size || ':' || x.total_units_needed || ':' || x.quantity_delivered || '/' || x.quantity_remaining, ',' ORDER BY o.order_number)
  FROM public.order_items x JOIN public.orders o ON o.id = x.order_id WHERE o.id IN ${ORDERS};`);
const remainders = () => scalar(`SELECT string_agg(status || ':' || unit_size || ':' || quantity_remaining, ',' ORDER BY id) FROM public.delivery_remainders WHERE order_id IN ${ORDERS};`);
const totals = () => scalar(`SELECT string_agg(order_number || ':' || total_price || ':' || total_cost || ':' || total_profit || ':' || total_margin_pct, ',' ORDER BY order_number) FROM public.orders WHERE id IN ${ORDERS};`);
const orderStamps = () => scalar(`SELECT string_agg(row_version || '@' || extract(epoch FROM updated_at), ',' ORDER BY order_number) FROM public.orders WHERE id IN ${ORDERS};`).split(',');
const lineJson = () => scalar(`SELECT string_agg((to_jsonb(x) - 'unit_size')::text, ',' ORDER BY id) FROM public.order_items x WHERE order_id IN ${ORDERS};`);
// on hand / reserved / signed net of the stock movements (a delivery takes, a void puts back) / movements of any other type
const stock = (l) => scalar(`SELECT i.quantity_available::numeric(12,2) || '/' || i.quantity_prebooked::numeric(12,2) || '/' ||
    COALESCE((SELECT sum(CASE t.transaction_type WHEN 'delivered' THEN -t.quantity WHEN 'void_delivery_reversal' THEN t.quantity END)
                FROM public.inventory_transactions t WHERE t.product_id = '${l.P}'), 0)::numeric(12,2) || '/' ||
    (SELECT count(*) FROM public.inventory_transactions t WHERE t.product_id = '${l.P}'
        AND t.transaction_type NOT IN ('delivered', 'void_delivery_reversal'))
  FROM public.inventory i WHERE i.product_id = '${l.P}';`);
const reopened = (l) => `(SELECT o.status || ':' || x.quantity_delivered || '/' || x.quantity_remaining FROM public.order_items x
  JOIN public.orders o ON o.id = x.order_id WHERE x.id = '${l.line}')`;
const voidSql = (l, key) => `PERFORM public.void_delivery('${lastLoad(l).D}', '[PROVER] wrong load', '${ADMIN}', '${key}');`;
const newDeliverySql = (l, key) => `r := public.create_delivery_with_items('${l.O}', '${CUST}', current_date,
    jsonb_build_array(jsonb_build_object('order_item_id', '${l.line}', 'product_id', '${l.P}', 'quantity', ${lastLoad(l).qty},
      'unit_size', (SELECT unit_size FROM public.order_items WHERE id = '${l.line}'))), NULL, NULL, NULL, NULL, '${key}');`;
const followUpSql = (l, key) => `r := public.create_followup_delivery('${l.D}', current_date, '${ADMIN}', '${key}');`;
const replacementSql = (l, key) => (l.D2 ? followUpSql(l, key) : newDeliverySql(l, key));

// The candidate with this fixture's ids in place of its LIVE_ID_TODO placeholders.
function filled(remainderJson) {
  let sql = RAW;
  for (const l of LINES) {
    for (const [what, value] of [['order', l.O], ['product', l.P]]) {
      const marker = `NULL /* LIVE_ID_TODO ${what} ${l.order} */`;
      assert.equal(sql.split(marker).length, 2, `placeholder ${marker} must appear once`);
      sql = sql.replace(marker, `'${value}'`);
    }
  }
  const marker = 'NULL /* LIVE_ID_TODO open remainders */';
  assert.equal(sql.split(marker).length, 2);
  sql = sql.replace(marker, `'${remainderJson}'`);
  assert.doesNotMatch(sql, /NULL \/\* LIVE_ID_TODO/);
  return sql;
}

try {
  if (REUSE) console.log(`[prover] reusing ${NAME}`);
  else { buildContainer({ stopBefore: CANDIDATE }); seedUsers(); }
  seed();
  const seeded = lineState();
  const totalsBefore = totals();
  const remainderJson = scalar(`SELECT jsonb_agg(jsonb_build_object('id', id, 'order_item_id', order_item_id, 'old_unit', unit_size, 'quantity', quantity_remaining))
    FROM public.delivery_remainders WHERE order_id IN ${ORDERS} AND status = 'pending';`);
  const candidate = filled(remainderJson);

  // The checked-in file refuses until its live ids are filled in.
  const unfilled = run(`BEGIN;\n${RAW}\nROLLBACK;`);
  assert.notEqual(unfilled.status, 0);
  assert.match(unfilled.stderr, /KI167_LIVE_IDS_MISSING/);
  assert.equal(lineState(), seeded);
  console.log('[placeholders] the checked-in file refuses: KI167_LIVE_IDS_MISSING');

  // (a) Before: the void reopens the line in its old unit and the replacement is refused.
  for (const [i, l] of LINES.entries()) {
    const back = l.D2 ? `${l.first}/${l.qty - l.first}` : `0/${l.qty}`;
    const res = attempt(ADMIN, `${asUser(voidSql(l, `ki167-a-void-${i}`))} v := ${reopened(l)};
      ${refuse(newDeliverySql(l, `ki167-a-new-${i}`))} v := v || ' | ' || t;
      ${l.D2 ? `${refuse(followUpSql(l, `ki167-a-fu-${i}`))} v := v || ' | ' || t;` : ''}`);
    const parts = res.split(' | ');
    assert.match(parts[0], new RegExp(`^ok\\|(confirmed|partially_fulfilled):${back}$`), `${l.order}: the void must reopen the line: ${res}`);
    for (const p of parts.slice(1)) {
      assert.match(p, new RegExp(`LINE_UNIT_NOT_STOCK_UNIT: this delivery line is in "${l.old}" but the product is stocked in "${l.stock}"`), `${l.order}: ${res}`);
    }
    console.log(`[a before] ${l.order}: void -> line reopened (${parts[0].slice(3)}) -> new delivery refused${l.D2 ? ', follow-up from the open remainder refused' : ''}: ${parts[1].split('.')[0]}`);
  }
  assert.equal(lineState(), seeded, 'the before probes were rolled back');

  // (c) A pinned line that moved: its delivery is voided first (delivered 800 -> 0, order back to confirmed).
  const moved = run(`BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;
    SELECT public.void_delivery('${LINES[0].D}', '[PROVER] moved', '${ADMIN}', 'ki167-c-void');
    RESET ROLE;\n${candidate}\nCOMMIT;`);
  assert.notEqual(moved.status, 0);
  assert.match(moved.stderr, /KI167_ROW_MOVED: these pinned lines no longer match the reviewed state, nothing was changed: ORD-2026-0188 line 1a9a6d97/);
  assert.equal(lineState(), seeded, 'a refused apply changes nothing');
  console.log(`[c moved] ${moved.stderr.match(/KI167_ROW_MOVED[^\n]*/)[0]}`);
  // An unreviewed line in another unit appeared anywhere (here a cancelled order): refused, and it is listed.
  const other = run(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES ('${fid('d9')}', 'KI167-OTHER', '${CUST}', 'cancelled');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, total_units_needed, quantity_remaining, price_per_unit, cost_per_unit)
      VALUES ('${fid('e9')}', '${fid('d9')}', '${LINES[1].P}', 'x', 'Gallons', 5, 5, 10, 8);
    SET LOCAL session_replication_role = origin;\n${candidate}\nCOMMIT;`, 'supabase_admin');
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, new RegExp(`KI167_OTHER_LINE: .*KI167-OTHER line ${fid('e9')} \\("Gallons", stocked in "Gal"\\)`));
  assert.equal(lineState(), seeded);
  console.log(`[c other] ${other.stderr.match(/KI167_OTHER_LINE[^\n]*/)[0]}`);

  // (b) Apply once; the history notice lists the completed delivery lines left in their old spellings.
  const stampsBefore = orderStamps();
  const jsonBefore = lineJson();
  const deliveryUnits = () => scalar(`SELECT string_agg(unit_size, ',' ORDER BY id) FROM public.delivery_items WHERE delivery_id IN (SELECT id FROM public.deliveries WHERE order_id IN ${ORDERS});`);
  const deliveryUnitsBefore = deliveryUnits();
  const once = docker([...PSQL('postgres'), '-1'], { input: candidate, allowFailure: true });
  assert.equal(once.status, 0, once.stderr);
  assert.match(once.stderr, /KI167_HISTORY_LABELS \(unchanged\): /);
  for (const l of LINES) assert.match(once.stderr, new RegExp(`delivery line ${l.DI} \\("${l.old}"\\)`));
  assert.equal(lineState(), LINES.map((l) => `fulfilled:${l.stock}:${l.qty}:${l.qty}/0`).join(','));
  assert.equal(lineJson(), jsonBefore, 'only unit_size moved on the order lines');
  assert.equal(totals(), totalsBefore, 'order totals unchanged');
  orderStamps().forEach((s, i) => {
    const [v, at] = s.split('@').map(Number);
    const [v0, at0] = stampsBefore[i].split('@').map(Number);
    assert.ok(v > v0 && at > at0, `order ${i}: edit version and updated_at must move (${stampsBefore[i]} -> ${s})`);
  });
  assert.equal(remainders(), `pending:${SPLIT.stock}:5`, 'the open remainder takes the stock unit');
  assert.equal(deliveryUnits(), deliveryUnitsBefore, 'delivery lines keep their labels');
  console.log(`[b apply] lines now ${LINES.map((l) => `"${l.stock}"`).join(' / ')}, open remainder "Gal"; quantities, other columns and order totals unchanged; edit version and updated_at moved`);
  console.log(`[b apply] ${once.stderr.match(/KI167_HISTORY_LABELS[^\n]*/)[0].slice(0, 200)}...`);
  const again = docker([...PSQL('postgres'), '-1'], { input: candidate, allowFailure: true });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /KI167_ROW_MOVED/);
  console.log('[b apply] a second apply refuses (KI167_ROW_MOVED)');

  // (b) After: each step committed through the app's signed-in actions.
  for (const [i, l] of LINES.entries()) {
    const load = lastLoad(l);
    const s0 = stock(l);
    const step = (body) => { const res = attempt(ADMIN, body, { commit: true }); assert.match(res, /^ok\|/, `${l.order}: ${res}`); return res.slice(3); };
    const afterVoid = step(`${asUser(voidSql(l, `ki167-b-void-${i}`))} v := ${reopened(l)};`);
    const s1 = stock(l);
    const created = step(`${asUser(replacementSql(l, `ki167-b-new-${i}`))}
      v := COALESCE(r->>'delivery_id', r->>'followup_delivery_id', r->>'id');`);
    const D = /^[0-9a-f-]{36}$/.test(created) ? created
      : scalar(`SELECT id FROM public.deliveries WHERE order_id = '${l.O}' AND status = 'scheduled';`);
    const unit = scalar(`SELECT string_agg(unit_size || ' x ' || quantity, ',') FROM public.delivery_items WHERE delivery_id = '${D}';`);
    step(asUser(`PERFORM public.confirm_delivery('${D}', '${ADMIN}', 'ki167-b-start-${i}');`));
    step(asUser(`PERFORM ${complete(D, `(SELECT jsonb_object_agg(id, quantity) FROM public.delivery_items WHERE delivery_id = '${D}')`, `ki167-b-done-${i}`).replace(/^SELECT /, '').replace(/;$/, '')};`));
    const end = scalar(`SELECT ${reopened(l)};`);
    const s2 = stock(l);
    const [a0, , t0, x0] = s0.split('/').map(Number);
    const [a1, , t1] = s1.split('/').map(Number);
    assert.equal(unit, `${l.stock} x ${load.qty}`, `${l.order}: the replacement is in the stock unit for the voided quantity`);
    assert.equal(end, `fulfilled:${l.qty}/0`, `${l.order}: ends fulfilled`);
    assert.equal(a1, a0 + load.qty, `${l.order}: the void puts ${load.qty} back on hand (${s0} -> ${s1})`);
    assert.equal(t1, t0 + load.qty, `${l.order}: the void records +${load.qty} (${s0} -> ${s1})`);
    assert.equal(s2, s0, `${l.order}: on hand, reserved and net movements end where they started (${s0} -> ${s1} -> ${s2})`);
    assert.equal(x0, 0, `${l.order}: no other kind of stock movement`);
    console.log(`[b after] ${l.order}: void -> reopened ${afterVoid.split(':')[1]} -> ${l.D2 ? 'follow-up from the remainder' : 'new delivery'} in "${unit}" -> confirm -> complete -> ${end}; stock (on hand/reserved/net moves) ${s0} -> ${s1} -> ${s2}`);
  }
  assert.equal(lineState(), LINES.map((l) => `fulfilled:${l.stock}:${l.qty}:${l.qty}/0`).join(','));
  assert.equal(totals(), totalsBefore, 'order totals unchanged after the re-delivery');
  assert.equal(remainders(), `fulfilled:${SPLIT.stock}:5`, 'the follow-up closed the open remainder');

  console.log('\nKI167_RELABEL_PROOF_PASS');
} finally {
  if (!REUSE && process.env.KEEP_CONTAINER !== '1') removeContainer();
}
