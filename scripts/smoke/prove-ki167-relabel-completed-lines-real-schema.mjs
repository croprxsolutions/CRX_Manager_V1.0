#!/usr/bin/env node
/**
 * Real-schema proof for 20270225230000_ki167_relabel_completed_lines_stock_unit.sql (KI-167).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs). Seeds three invented orders shaped like the three live
 * lines: the same order-line ids, order numbers, product names, stock units and quantities, everything else invented.
 * Every load is completed through complete_delivery, so each order ends fulfilled:
 *   ORD-2026-0188  one load of 800 "oz".
 *   ORD-2026-0381  first load completed short (180 of 192), leaving an OPEN remainder of 12 "Gallon "; a second load
 *                  delivers the 12 directly, so the remainder stays pending (the candidate pins and relabels it).
 *   ORD-2026-0484  first load completed short (20 of 25), remainder 5 "Gall"; the real follow-up lifecycle then
 *                  delivers it (create_followup_delivery, written before the line-unit guard existed, so the guard is
 *                  off for that one call), which closes the remainder as fulfilled (history).
 * The candidate's live ids are swapped for this fixture's ids; a copy with them NULL refuses. Then:
 *   (a) before: void the last load -> the line reopens -> the replacement (a new delivery in the line's unit, as New
 *       Delivery sends it, and on ORD-2026-0381 a follow-up from the open remainder) is refused with
 *       LINE_UNIT_NOT_STOCK_UNIT. Rolled back.
 *   (c) refusals, each rolled back with nothing changed: a pinned line moved (KI167_ROW_MOVED); a remainder pinned in a
 *       unit other than its line's old spelling (KI167_ROW_MOVED); a malformed remainder list (KI167_LIVE_IDS_MISSING);
 *       an unfinished delivery with an old-spelling line (KI167_ACTIVE_DELIVERY_LINE); an unreviewed bad line
 *       elsewhere (KI167_OTHER_LINE).
 *   (b) apply: only unit_size moved on the three lines (unit_size/updated_at on the open remainder), quantities and
 *       order totals unchanged; a second apply refuses. A follow-up from the open remainder while the line is fully
 *       delivered is still refused (no extra shipment). Then, each step committed through the app's signed-in actions:
 *       void -> reopen -> replacement -> confirm_delivery -> complete_delivery, ending at the same quantities; stock goes
 *       back up on the void, down on the replacement, and ends where it was before the migration. Voiding the
 *       ORD-2026-0484 follow-up leaves its parent remainder fulfilled (no code path reopens a remainder).
 *
 * Run: node scripts/smoke/prove-ki167-relabel-completed-lines-real-schema.mjs   (needs Docker; never touches live)
 * Prints KI167_RELABEL_PROOF_PASS on success. KEEP_CONTAINER=1 (or true) keeps a container this run built; a
 * container picked for reuse (KI167_REUSE=1 or true, with UNDO_PATHS_CONTAINER) is never removed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, claims, scalar, docker, USERS, ROOT, NAME } from './undo-paths/harness.mjs';

const CANDIDATE = '20270225230000_ki167_relabel_completed_lines_stock_unit.sql';
const RAW = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const flag = (name) => ['1', 'true'].includes(String(process.env[name] ?? '').trim().toLowerCase());
const REUSE = flag('KI167_REUSE');
const KEEP = flag('KEEP_CONTAINER');
const ADMIN = USERS.admin;
const fid = (n) => `16700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUST = fid('c1');
// [order-line id (live), order number, product name, form, stock unit, old line unit, quantity, split]
const LINES = [
  ['1a9a6d97-8540-47ac-8616-7792774d7502', 'ORD-2026-0188', 'Treaty Extra', 'dry', 'Dry oz', 'oz', 800, null],
  ['ff563d1a-31d0-46d8-9329-2a928c818c12', 'ORD-2026-0381', 'Trivapro - Bulk', 'liquid', 'Gal', 'Gallon ', 192, { first: 180, mode: 'direct' }],
  ['b81e22ff-9596-4abe-80fe-56b8684e5968', 'ORD-2026-0484', 'Gen Select 2LB: (Ceridian 2EC, Clethodim 2EC, Volunteer) - 2.5 Gal', 'liquid', 'Gal', 'Gall', 25, { first: 20, mode: 'followup' }],
].map(([line, order, name, form, stock, old, qty, split], i) => ({
  line, order, name, form, stock, old, qty, split, P: fid(`f${i}`), O: fid(`d${i}`), D: fid(`b${i}`), DI: fid(`e${i}`), D2: null,
}));
const DIRECT = LINES[1];
const FOLLOW = LINES[2];
const lastQty = (l) => (l.split ? l.qty - l.split.first : l.qty);
const ORDERS = `(${LINES.map((l) => `'${l.O}'`).join(',')})`;
const sq = (s) => s.replaceAll("'", "''");
const PSQL = (user) => ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const run = (sql, user = 'postgres') => docker(PSQL(user), { input: sql, allowFailure: true });
const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r; };
const asAdmin = (sql) => run(`BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;\n${sql}\nCOMMIT;`);
const complete = (d, qty, key) => `public.complete_delivery(p_delivery_id => '${d}', p_signed_by => 'No proof — recorded by office',
  p_performed_by => '${ADMIN}', p_quantities => (SELECT jsonb_object_agg(id, ${qty ?? 'quantity'}) FROM public.delivery_items WHERE delivery_id = '${d}'),
  p_idempotency_key => '${key}', p_evidence => 'no_proof', p_evidence_ref => '[PROVER] KI167')`;
const raw = (sql) => ok(run(`SET session_replication_role = replica;\n${sql}\nSET session_replication_role = origin;`, 'supabase_admin'));

function seed() {
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
  ok(run(`UPDATE public.orders o SET total_price = s.p, total_cost = s.c, total_profit = s.p - s.c, total_margin_pct = 20
      FROM (SELECT order_id, sum(total_price) p, sum(cost_per_unit * total_units_needed) c FROM public.order_items
             WHERE order_id IN ${ORDERS} GROUP BY 1) s
     WHERE s.order_id = o.id AND o.id IN ${ORDERS};`));
  // First loads, completed through the real RPC as the office records a delivery with no proof (split ones short).
  for (const [i, l] of LINES.entries()) ok(asAdmin(`SELECT ${complete(l.D, l.split?.first, `ki167-seed-${i}`)};`));
  // ORD-2026-0381: the 12 short go out on a second load of their own, so the first load's remainder stays open.
  DIRECT.D2 = fid('b8');
  raw(`INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, is_quick_delivery)
      VALUES ('${DIRECT.D2}', 'KI167-D1b', '${DIRECT.O}', '${CUST}', '${ADMIN}', 'in_progress', false);
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${fid('e8')}', '${DIRECT.D2}', '${DIRECT.line}', '${DIRECT.P}', ${lastQty(DIRECT)}, '${DIRECT.old}');`);
  ok(asAdmin(`SELECT ${complete(DIRECT.D2, null, 'ki167-seed-1b')};`));
  // ORD-2026-0484: the real follow-up lifecycle. Live follow-ups in "Gall" were made before the line-unit guard, so the
  // guard is off for this one call only; confirm and complete run with every trigger on.
  ok(run(`BEGIN;
    ALTER TABLE public.delivery_items DISABLE TRIGGER a1_line_unit_is_stock_unit;
    ${claims(ADMIN)}
    SET LOCAL ROLE authenticated;
    SELECT public.create_followup_delivery('${FOLLOW.D}', current_date, '${ADMIN}', 'ki167-seed-2fu');
    RESET ROLE;
    ALTER TABLE public.delivery_items ENABLE TRIGGER a1_line_unit_is_stock_unit;
    COMMIT;`, 'supabase_admin'));
  FOLLOW.D2 = scalar(`SELECT id FROM public.deliveries WHERE order_id = '${FOLLOW.O}' AND id <> '${FOLLOW.D}';`);
  ok(asAdmin(`SELECT public.confirm_delivery('${FOLLOW.D2}', '${ADMIN}', 'ki167-seed-2start');
    SELECT ${complete(FOLLOW.D2, null, 'ki167-seed-2b')};`));
  assert.equal(scalar("SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.delivery_items'::regclass AND tgname = 'a1_line_unit_is_stock_unit';"), 'O');
  assert.equal(lineState(), LINES.map((l) => `fulfilled:${l.old}:${l.qty}:${l.qty}/0`).join(','));
  assert.equal(remainders(), `${DIRECT.order}:pending:${DIRECT.old}:12,${FOLLOW.order}:fulfilled:${FOLLOW.old}:5`);
  console.log('[seed] 3 fulfilled orders in "oz" / "Gallon " / "Gall" through complete_delivery; ORD-2026-0381 has an open remainder of 12 "Gallon "; ORD-2026-0484 delivered its remainder of 5 "Gall" by follow-up (remainder fulfilled)');
}

const lineState = () => scalar(`SELECT string_agg(o.status || ':' || x.unit_size || ':' || x.total_units_needed || ':' || x.quantity_delivered || '/' || x.quantity_remaining, ',' ORDER BY o.order_number)
  FROM public.order_items x JOIN public.orders o ON o.id = x.order_id WHERE o.id IN ${ORDERS};`);
const remainders = () => scalar(`SELECT string_agg(o.order_number || ':' || m.status || ':' || m.unit_size || ':' || m.quantity_remaining, ',' ORDER BY o.order_number, m.id)
  FROM public.delivery_remainders m JOIN public.orders o ON o.id = m.order_id WHERE m.order_id IN ${ORDERS};`);
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
const voidSql = (l, key) => `PERFORM public.void_delivery('${l.D2 ?? l.D}', '[PROVER] wrong load', '${ADMIN}', '${key}');`;
const newDeliverySql = (l, key) => `r := public.create_delivery_with_items('${l.O}', '${CUST}', current_date,
    jsonb_build_array(jsonb_build_object('order_item_id', '${l.line}', 'product_id', '${l.P}', 'quantity', ${lastQty(l)},
      'unit_size', (SELECT unit_size FROM public.order_items WHERE id = '${l.line}'))), NULL, NULL, NULL, NULL, '${key}');`;
const followUpSql = (l, key) => `r := public.create_followup_delivery('${l.D}', current_date, '${ADMIN}', '${key}');`;
// The replacement the office would use: a follow-up while the first load's remainder is open, else a new delivery.
const replacementSql = (l, key) => (l === DIRECT ? followUpSql(l, key) : newDeliverySql(l, key));

// The candidate carries the live ids (read 2026-11-23); the proof swaps in this fixture's ids, and an unfilled copy
// (ids and remainder list NULL) must refuse.
const LIVE = {
  'ORD-2026-0188': { order: '401d9573-1569-4400-a586-4b976b7361ca', product: 'ac926057-cfae-4070-9cb6-ff2ecc421c3c' },
  'ORD-2026-0381': { order: 'c44975be-eb7d-4ebf-b6f9-04c0f8180091', product: 'c4d75524-7426-4e3d-87a5-9524dbba7280' },
  'ORD-2026-0484': { order: '79a42790-635e-4868-9a9d-a19a46adefea', product: '0c093448-80d9-4d50-aa43-738500f919b8' },
};
const LIVE_REMAINDERS = "c_remainders constant text := '[]';";
function swap(sql, from, to) {
  assert.equal(sql.split(from).length, 2, `${from} must appear once in the candidate`);
  return sql.replace(from, to);
}
function filled(remainderJson) {
  let sql = RAW;
  for (const l of LINES) for (const what of ['order', 'product']) sql = swap(sql, `'${LIVE[l.order][what]}'`, `'${what === 'order' ? l.O : l.P}'`);
  return swap(sql, LIVE_REMAINDERS, `c_remainders constant text := '${sq(remainderJson)}';`);
}
let UNFILLED = RAW;
for (const l of LINES) for (const what of ['order', 'product']) UNFILLED = swap(UNFILLED, `'${LIVE[l.order][what]}'`, 'NULL');
UNFILLED = swap(UNFILLED, LIVE_REMAINDERS, 'c_remainders constant text := NULL;');
const refused = (label, r, pattern) => {
  assert.notEqual(r.status, 0, `${label}: must refuse`);
  assert.match(r.stderr, pattern, `${label}: ${r.stderr}`);
  console.log(`[c ${label}] ${r.stderr.match(/KI167_[A-Z_]+[^\n]*/)[0].slice(0, 230)}`);
};

try {
  if (REUSE) console.log(`[prover] reusing ${NAME}`);
  else { buildContainer({ stopBefore: CANDIDATE }); seedUsers(); }
  seed();
  const seeded = lineState();
  const remaindersSeeded = remainders();
  const totalsBefore = totals();
  const openRemainder = scalar(`SELECT jsonb_agg(jsonb_build_object('id', id, 'order_item_id', order_item_id, 'old_unit', unit_size, 'quantity', quantity_remaining))::text
    FROM public.delivery_remainders WHERE order_id IN ${ORDERS} AND status = 'pending';`);
  const candidate = filled(openRemainder);
  const unchanged = () => { assert.equal(lineState(), seeded); assert.equal(remainders(), remaindersSeeded); };

  // The checked-in file refuses until its live ids are filled in.
  refused('placeholders', run(`BEGIN;\n${UNFILLED}\nROLLBACK;`), /KI167_LIVE_IDS_MISSING: the live order and product ids/);
  unchanged();

  // (a) Before: the void reopens the line in its old unit and every replacement is refused.
  for (const [i, l] of LINES.entries()) {
    const res = attempt(ADMIN, `${asUser(voidSql(l, `ki167-a-void-${i}`))} v := ${reopened(l)};
      ${refuse(newDeliverySql(l, `ki167-a-new-${i}`))} v := v || ' | ' || t;
      ${l === DIRECT ? `${refuse(followUpSql(l, `ki167-a-fu-${i}`))} v := v || ' | ' || t;` : ''}`);
    const parts = res.split(' | ');
    const back = l.split ? `${l.split.first}/${lastQty(l)}` : `0/${l.qty}`;
    assert.match(parts[0], new RegExp(`^ok\\|(confirmed|partially_fulfilled):${back}$`), `${l.order}: the void must reopen the line: ${res}`);
    for (const p of parts.slice(1)) {
      assert.match(p, new RegExp(`LINE_UNIT_NOT_STOCK_UNIT: this delivery line is in "${l.old}" but the product is stocked in "${l.stock}"`), `${l.order}: ${res}`);
    }
    console.log(`[a before] ${l.order}: void -> line reopened (${parts[0].slice(3)}) -> new delivery refused${l === DIRECT ? ', follow-up from the open remainder refused' : ''}: ${parts[1].split('.')[0]}`);
  }
  unchanged();

  // (c) Refusals; each one changes nothing.
  refused('moved', run(`BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;
    SELECT public.void_delivery('${LINES[0].D}', '[PROVER] moved', '${ADMIN}', 'ki167-c-void');
    RESET ROLE;\n${candidate}\nCOMMIT;`), /KI167_ROW_MOVED: these pinned lines no longer match the reviewed state, nothing was changed: ORD-2026-0188 line 1a9a6d97/);
  unchanged();
  const wrongUnit = JSON.parse(openRemainder).map((m) => ({ ...m, old_unit: 'Qt' }));
  refused('remainder-unit', run(`BEGIN; UPDATE public.delivery_remainders SET unit_size = 'Qt' WHERE order_id = '${DIRECT.O}';\n${filled(JSON.stringify(wrongUnit))}\nCOMMIT;`),
    /KI167_ROW_MOVED: the open-remainder list has .*approved old spelling/);
  unchanged();
  refused('malformed-list', run(`BEGIN;\n${filled('[{"id": "", "order_item_id": "x", "old_unit": "Gall", "quantity": 5}]')}\nCOMMIT;`),
    /KI167_LIVE_IDS_MISSING: the open-remainder list has a blank or malformed entry/);
  refused('not-json', run(`BEGIN;\n${filled('[{oops')}\nCOMMIT;`), /KI167_LIVE_IDS_MISSING: the open-remainder list is not valid JSON/);
  unchanged();
  refused('active-delivery', run(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, is_quick_delivery)
      VALUES ('${fid('b7')}', 'KI167-OPEN', '${LINES[0].O}', '${CUST}', '${ADMIN}', 'scheduled', false);
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size)
      VALUES ('${fid('e7')}', '${fid('b7')}', '${LINES[0].line}', '${LINES[0].P}', 1, 'oz');
    SET LOCAL session_replication_role = origin;\n${candidate}\nCOMMIT;`, 'supabase_admin'),
  /KI167_ACTIVE_DELIVERY_LINE: .*delivery KI167-OPEN \(scheduled\) line 16700000-0000-4000-8000-0000000000e7 \("oz"\)/);
  unchanged();
  refused('other-line', run(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES ('${fid('d9')}', 'KI167-OTHER', '${CUST}', 'cancelled');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, total_units_needed, quantity_remaining, price_per_unit, cost_per_unit)
      VALUES ('${fid('e9')}', '${fid('d9')}', '${LINES[1].P}', 'x', 'Gallons', 5, 5, 10, 8);
    SET LOCAL session_replication_role = origin;\n${candidate}\nCOMMIT;`, 'supabase_admin'),
  new RegExp(`KI167_OTHER_LINE: .*KI167-OTHER line ${fid('e9')} \\("Gallons", stocked in "Gal"\\)`));
  unchanged();

  // (b) Apply once. Stock is read before the migration, so a relabel that moved stock would show at the end.
  const stockBefore = LINES.map(stock);
  const stampsBefore = orderStamps();
  const jsonBefore = lineJson();
  const deliveryUnits = () => scalar(`SELECT string_agg(unit_size, ',' ORDER BY id) FROM public.delivery_items WHERE delivery_id IN (SELECT id FROM public.deliveries WHERE order_id IN ${ORDERS});`);
  const deliveryUnitsBefore = deliveryUnits();
  const once = docker([...PSQL('postgres'), '-1'], { input: candidate, allowFailure: true });
  assert.equal(once.status, 0, once.stderr);
  assert.match(once.stderr, /KI167_HISTORY_LABELS \(unchanged\): /);
  for (const l of LINES) assert.match(once.stderr, new RegExp(`delivery line ${l.DI} \\("${l.old}"\\)`));
  assert.match(once.stderr, /delivery remainder [0-9a-f-]+ \("Gall", fulfilled\)/, 'the fulfilled remainder is history and is listed');
  assert.equal(lineState(), LINES.map((l) => `fulfilled:${l.stock}:${l.qty}:${l.qty}/0`).join(','));
  assert.equal(lineJson(), jsonBefore, 'only unit_size moved on the order lines');
  assert.equal(totals(), totalsBefore, 'order totals unchanged');
  orderStamps().forEach((s, i) => {
    const [v, at] = s.split('@').map(Number);
    const [v0, at0] = stampsBefore[i].split('@').map(Number);
    assert.ok(v > v0 && at >= at0, `order ${i}: edit version must move and updated_at never go back (${stampsBefore[i]} -> ${s})`);
  });
  assert.equal(remainders(), `${DIRECT.order}:pending:Gal:12,${FOLLOW.order}:fulfilled:${FOLLOW.old}:5`, 'only the open remainder takes the stock unit');
  assert.equal(deliveryUnits(), deliveryUnitsBefore, 'delivery lines keep their labels');
  assert.deepEqual(LINES.map(stock), stockBefore, 'the relabel moved no stock');
  console.log(`[b apply] lines now ${LINES.map((l) => `"${l.stock}"`).join(' / ')}; open remainder "Gal", fulfilled remainder kept "Gall"; quantities, other columns, stock and order totals unchanged; edit version moved`);
  console.log(`[b apply] ${once.stderr.match(/KI167_HISTORY_LABELS[^\n]*/)[0].slice(0, 160)}...`);
  refused('second-apply', docker([...PSQL('postgres'), '-1'], { input: candidate, allowFailure: true }), /KI167_ROW_MOVED/);
  // The relabelled open remainder cannot ship extra while its line is fully delivered.
  const extra = attempt(ADMIN, `${refuse(followUpSql(DIRECT, 'ki167-b-extra'))} v := t;`);
  assert.doesNotMatch(extra, /NOT REFUSED|LINE_UNIT_NOT_STOCK_UNIT/, extra);
  console.log(`[b apply] a follow-up from the open remainder while ${DIRECT.order} is fully delivered is still refused: ${extra.slice(3, 140)}`);

  // (b) After: each step committed through the app's signed-in actions.
  for (const [i, l] of LINES.entries()) {
    const step = (body) => { const res = attempt(ADMIN, body, { commit: true }); assert.match(res, /^ok\|/, `${l.order}: ${res}`); return res.slice(3); };
    const s0 = stock(l);
    const afterVoid = step(`${asUser(voidSql(l, `ki167-b-void-${i}`))} v := ${reopened(l)};`);
    const s1 = stock(l);
    if (l === FOLLOW) assert.equal(remainders().split(',')[1], `${FOLLOW.order}:fulfilled:${FOLLOW.old}:5`, 'voiding a follow-up does not reopen its parent remainder');
    const before = new Set(scalar(`SELECT string_agg(id::text, ',') FROM public.deliveries WHERE order_id = '${l.O}';`).split(','));
    step(asUser(replacementSql(l, `ki167-b-new-${i}`)));
    const D = scalar(`SELECT string_agg(id::text, ',') FROM public.deliveries WHERE order_id = '${l.O}';`).split(',').filter((x) => !before.has(x));
    assert.equal(D.length, 1, `${l.order}: exactly one replacement delivery`);
    const unit = scalar(`SELECT string_agg(unit_size || ' x ' || quantity, ',') FROM public.delivery_items WHERE delivery_id = '${D[0]}';`);
    step(asUser(`PERFORM public.confirm_delivery('${D[0]}', '${ADMIN}', 'ki167-b-start-${i}');`));
    step(asUser(`PERFORM ${complete(D[0], null, `ki167-b-done-${i}`)};`));
    const end = scalar(`SELECT ${reopened(l)};`);
    const s2 = stock(l);
    const [a0, , t0, x0] = s0.split('/').map(Number);
    const [a1, , t1] = s1.split('/').map(Number);
    assert.equal(unit, `${l.stock} x ${lastQty(l)}`, `${l.order}: the replacement is in the stock unit for the voided quantity`);
    assert.equal(end, `fulfilled:${l.qty}/0`, `${l.order}: ends fulfilled`);
    assert.equal(a1, a0 + lastQty(l), `${l.order}: the void puts ${lastQty(l)} back on hand (${s0} -> ${s1})`);
    assert.equal(t1, t0 + lastQty(l), `${l.order}: the void records +${lastQty(l)} (${s0} -> ${s1})`);
    assert.equal(s2, stockBefore[i], `${l.order}: on hand, reserved and net movements end where they were before the migration (${stockBefore[i]} -> ${s1} -> ${s2})`);
    assert.equal(x0, 0, `${l.order}: no other kind of stock movement`);
    console.log(`[b after] ${l.order}: void -> reopened ${afterVoid.split(':')[1]} -> ${l === DIRECT ? 'follow-up from the open remainder' : 'new delivery'} in "${unit}" -> confirm -> complete -> ${end}; stock (on hand/reserved/net moves/other) ${stockBefore[i]} -> ${s1} -> ${s2}`);
  }
  assert.equal(lineState(), LINES.map((l) => `fulfilled:${l.stock}:${l.qty}:${l.qty}/0`).join(','));
  assert.equal(totals(), totalsBefore, 'order totals unchanged after the re-delivery');
  assert.equal(remainders(), `${DIRECT.order}:fulfilled:Gal:12,${FOLLOW.order}:fulfilled:${FOLLOW.old}:5`, 'the follow-up closed the open remainder');

  console.log('\nKI167_RELABEL_PROOF_PASS');
} finally {
  if (!REUSE && !KEEP) removeContainer();
}
