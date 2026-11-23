#!/usr/bin/env node
/**
 * Real-schema proof for 20270225120000_ki167_relabel_completed_lines_stock_unit.sql (KI-167).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs). Seeds three invented orders shaped like the three live
 * lines: the same order-line ids (the candidate is pinned to them), order numbers, product names, stock units and
 * quantities, everything else invented. Each is completed through complete_delivery, so it ends fulfilled. Then:
 *   (a) before: void the delivery -> the line reopens -> the replacement delivery (the line's unit, as New Delivery
 *       sends it) is refused with LINE_UNIT_NOT_STOCK_UNIT. Rolled back.
 *   (c) a pinned line that moved (its delivery voided first) -> KI167_ROW_MOVED; an unreviewed bad line elsewhere ->
 *       KI167_OTHER_LINE listing it. Both rolled back; nothing changed.
 *   (b) apply: only unit_size moved on the three lines, quantities and order totals unchanged; a second apply refuses.
 *       Then void -> reopen -> replacement delivery -> complete succeeds for each, ending at the same quantities.
 *
 * Run: node scripts/smoke/prove-ki167-relabel-completed-lines-real-schema.mjs   (needs Docker; never touches live)
 * Prints KI167_RELABEL_PROOF_PASS on success. KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, claims, scalar, docker, USERS, ROOT, NAME } from './undo-paths/harness.mjs';

const CANDIDATE = '20270225120000_ki167_relabel_completed_lines_stock_unit.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
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
const sq = (s) => s.replaceAll("'", "''");
const PSQL = (user) => ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const run = (sql, user = 'postgres') => docker(PSQL(user), { input: sql, allowFailure: true });

function seed() {
  const r = run(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] KI167 Farm', true);
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
      VALUES ('${l.DI}', '${l.D}', '${l.line}', '${l.P}', ${l.qty}, '${l.old}');`).join('')}
    SET session_replication_role = origin;
    -- Order totals as the totals trigger would write them.
    UPDATE public.orders o SET total_price = s.p, total_cost = s.c, total_profit = s.p - s.c, total_margin_pct = 20
      FROM (SELECT order_id, sum(total_price) p, sum(cost_per_unit * total_units_needed) c FROM public.order_items GROUP BY 1) s
     WHERE s.order_id = o.id;`, 'supabase_admin');
  assert.equal(r.status, 0, r.stderr);
  // Completed through the real RPC, as the office records a delivery with no proof.
  for (const [i, l] of LINES.entries()) {
    const c = run(`BEGIN;\n${claims(ADMIN)}\nSET LOCAL ROLE authenticated;
      SELECT public.complete_delivery(p_delivery_id => '${l.D}', p_signed_by => 'No proof — recorded by office', p_performed_by => '${ADMIN}',
        p_quantities => jsonb_build_object('${l.DI}', ${l.qty}), p_idempotency_key => 'ki167-seed-${i}', p_evidence => 'no_proof',
        p_evidence_ref => '[PROVER] KI167 seed');
      COMMIT;`);
    assert.equal(c.status, 0, c.stderr);
  }
  assert.equal(scalar(`SELECT string_agg(o.status || ':' || x.unit_size || ':' || x.quantity_delivered || '/' || x.quantity_remaining, ',' ORDER BY o.order_number)
    FROM public.order_items x JOIN public.orders o ON o.id = x.order_id;`),
  LINES.map((l) => `fulfilled:${l.old}:${l.qty}/0`).join(','));
  console.log('[seed] 3 fulfilled orders, lines in "oz" / "Gallon " / "Gall", each completed through complete_delivery');
}

const lineState = () => scalar(`SELECT string_agg(o.status || ':' || x.unit_size || ':' || x.total_units_needed || ':' || x.quantity_delivered || '/' || x.quantity_remaining, ',' ORDER BY o.order_number)
  FROM public.order_items x JOIN public.orders o ON o.id = x.order_id;`);
const voidSql = (l, key) => `PERFORM public.void_delivery('${l.D}', '[PROVER] wrong load', '${ADMIN}', '${key}');`;
const redeliverSql = (l, key) => `r := public.create_delivery_with_items('${l.O}', '${CUST}', current_date,
    jsonb_build_array(jsonb_build_object('order_item_id', '${l.line}', 'product_id', '${l.P}', 'quantity', ${l.qty},
      'unit_size', (SELECT unit_size FROM public.order_items WHERE id = '${l.line}'))), NULL, NULL, NULL, NULL, '${key}');`;
const reopened = (l) => `(SELECT o.status || ':' || x.quantity_delivered || '/' || x.quantity_remaining FROM public.order_items x
  JOIN public.orders o ON o.id = x.order_id WHERE x.id = '${l.line}')`;

try {
  if (process.env.KI167_REUSE) console.log(`[prover] reusing ${NAME}`);
  else { buildContainer({ stopBefore: CANDIDATE }); seedUsers(); }
  seed();
  const seeded = lineState();
  const totals = () => scalar(`SELECT string_agg(order_number || ':' || total_price || ':' || total_cost || ':' || total_profit || ':' || total_margin_pct, ',' ORDER BY order_number) FROM public.orders;`);
  const totalsBefore = totals();

  // (a) Before: the void reopens the line in its old unit and the replacement delivery is refused.
  for (const [i, l] of LINES.entries()) {
    const res = attempt(ADMIN, `${asUser(voidSql(l, `ki167-a-void-${i}`))} v := ${reopened(l)};
      ${refuse(redeliverSql(l, `ki167-a-new-${i}`))} v := v || ' | ' || t;`);
    assert.equal(res.split(' | ')[0], `ok|confirmed:0/${l.qty}`, `${l.order}: the void must reopen the line: ${res}`);
    assert.match(res, new RegExp(`LINE_UNIT_NOT_STOCK_UNIT: this delivery line is in "${l.old}" but the product is stocked in "${l.stock}"`), `${l.order}: ${res}`);
    console.log(`[a before] ${l.order}: void -> line reopened (${res.split(' | ')[0].slice(3)}) -> replacement refused: ${res.split(' | ')[1].split('.')[0]}`);
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
  const rowVersions = () => scalar(`SELECT string_agg(row_version::text, ',' ORDER BY order_number) FROM public.orders WHERE order_number LIKE 'ORD-%';`);
  const versionsBefore = rowVersions();
  const lineJson = () => scalar(`SELECT string_agg((to_jsonb(x) - 'unit_size')::text, ',' ORDER BY id) FROM public.order_items x;`);
  const jsonBefore = lineJson();
  const once = docker([...PSQL('postgres'), '-1'], { input: candidate, allowFailure: true });
  assert.equal(once.status, 0, once.stderr);
  assert.match(once.stderr, /KI167_HISTORY_LABELS \(unchanged\): /);
  for (const l of LINES) assert.match(once.stderr, new RegExp(`delivery line ${l.DI} \\("${l.old}"\\)`));
  assert.equal(lineState(), LINES.map((l) => `fulfilled:${l.stock}:${l.qty}:${l.qty}/0`).join(','));
  assert.equal(lineJson(), jsonBefore, 'only unit_size moved on any order line');
  assert.equal(totals(), totalsBefore, 'order totals unchanged');
  assert.ok(rowVersions().split(',').every((v, i) => Number(v) > Number(versionsBefore.split(',')[i])), 'each order edit version went up');
  assert.equal(scalar(`SELECT string_agg(unit_size, ',' ORDER BY id) FROM public.delivery_items WHERE id IN (${LINES.map((l) => `'${l.DI}'`).join(',')});`),
    [...LINES].sort((a, b) => a.DI.localeCompare(b.DI)).map((l) => l.old).join(','), 'delivery lines keep their labels');
  console.log(`[b apply] lines now ${LINES.map((l) => `"${l.stock}"`).join(' / ')}; quantities, other columns and order totals unchanged; history notice: ${once.stderr.match(/KI167_HISTORY_LABELS[^\n]*/)[0]}`);
  const again = docker([...PSQL('postgres'), '-1'], { input: candidate, allowFailure: true });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /KI167_ROW_MOVED/);
  console.log('[b apply] a second apply refuses (KI167_ROW_MOVED)');

  // (b) After: the same flow, committed: void -> reopen -> replacement delivery -> complete.
  for (const [i, l] of LINES.entries()) {
    const res = attempt(ADMIN, `${asUser(voidSql(l, `ki167-b-void-${i}`))} v := ${reopened(l)};
      ${asUser(redeliverSql(l, `ki167-b-new-${i}`))} u := (r->>'delivery_id')::uuid;
      v := v || ' | ' || (SELECT unit_size FROM public.delivery_items WHERE delivery_id = u);
      UPDATE public.deliveries SET status = 'in_progress' WHERE id = u;
      ${asUser(`PERFORM public.complete_delivery(p_delivery_id => u, p_signed_by => 'No proof — recorded by office', p_performed_by => '${ADMIN}',
        p_quantities => (SELECT jsonb_object_agg(id, quantity) FROM public.delivery_items WHERE delivery_id = u), p_idempotency_key => 'ki167-b-done-${i}',
        p_evidence => 'no_proof', p_evidence_ref => '[PROVER] KI167 after');`)}
      v := v || ' | ' || ${reopened(l)};`, { commit: true });
    assert.equal(res, `ok|confirmed:0/${l.qty} | ${l.stock} | fulfilled:${l.qty}/0`, `${l.order}: ${res}`);
    console.log(`[b after] ${l.order}: void -> reopened 0/${l.qty} -> replacement delivery in "${l.stock}" -> completed -> fulfilled ${l.qty}/0`);
  }
  assert.equal(lineState(), LINES.map((l) => `fulfilled:${l.stock}:${l.qty}:${l.qty}/0`).join(','));
  assert.equal(totals(), totalsBefore, 'order totals unchanged after the re-delivery');

  console.log('\nKI167_RELABEL_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
