#!/usr/bin/env node
/**
 * Real-schema proof for 20270308170000_unbilled_rest_and_delivery_price_carry_over.sql (A4 + delivery price carry-over,
 * Mason 25 Nov).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds invented orders, and runs each case through the
 * real complete_delivery, save_invoice (the invoice editor's save) and create_invoice_for_unbilled_delivery, signed in
 * as an admin, each in a rolled-back probe:
 *   carry_down  10 at $40 in two deliveries; delivery 1's 6 edited to $35 ($210); delivery 2's 4 must draft $160.00
 *   carry_up    the same with $45 ($270); delivery 2 still $160.00
 *   short       10 delivered, the draft lowered to 6 ($240): the delivery must stay on Unbilled, and Create Invoice must
 *               draft exactly 4 for $160.00 (total $400.00, to the cent), then the delivery leaves the list and a
 *               second Create Invoice is refused
 *   whole       the same short bill on a whole-order invoice (save_invoice, no delivery): the rest is drafted on the
 *               order (no delivery id), $160.00
 *   rounding    3 units for $100.00 ($33.33 each) in three deliveries: 3333 + 3334 + 3333 cents (unchanged)
 *   void        a cancelled delivery draft frees its units: the next delivery bills $40.00 (unchanged)
 *   two_lines   two order lines of one product ($30 x 5, $40 x 5); the office lowers line A to 1: the rest is
 *               line A's 4, $120.00 (line B's invoice line never counts for A)
 *   whole_two   two deliveries of 10 under a whole-order invoice for 6: Bill the rest on delivery 2 drafts all 14 on
 *               the order ($560.00) and neither delivery stays listed
 *   editor_line 2 units for $80.01; a whole-order editor line (no order line) bills the first at $40.01: the rest is
 *               $40.00, so the order bills $80.01 exactly
 *   void_rebill $100 for 3 in three deliveries, the first draft cancelled and billed again last: staging $100.00;
 *               KNOWN LIMIT after (Taha's option c): $100.01, pinned; the stored-cents follow-up PR makes it exact
 *               (a few cents at worst, about one per out-of-order re-bill: see drift7)
 *   carry_void  the carry-over sale with delivery 2's draft cancelled and billed again: still $160.00
 *   scope       Create Invoice refuses a scope other than the one the screen showed (UNBILLED_SCOPE_CHANGED); no
 *               scope (a screen from before A4) means a first invoice only
 *   misc        a miscellaneous charge naming the product bills those units, as the order cap counts it (unchanged)
 *   ambiguous   an editor line with no order line, for a product on two differently priced order lines: Bill the
 *               rest is refused (UNBILLED_REST_LINE_AMBIGUOUS), nothing drafted
 *   drift7      KNOWN LIMIT pinned: $149 for 7 units, three drafts cancelled and billed again: $149.03 (staging $149.00)
 * BEFORE (old bodies) the A4 and carry-over cases fail, AFTER they pass, rounding, void and misc are identical and void_rebill shows its known 1-cent limit; autocommit, a second
 * apply and a drifted reverse are refused; the reverse (scripts/smoke/unbilled-rest-and-carry-over-reverse.sql)
 * restores the old bodies byte for byte and every case gives its BEFORE result again; the candidate re-applies.
 *
 * Run: node scripts/smoke/prove-unbilled-rest-and-carry-over-real-schema.mjs   (needs Docker; never touches live)
 * Reuse a container built up to (not including) the candidate: UNDO_PATHS_CONTAINER=<name> A4CARRY_PROOF_REUSE=1
 * (it is left as found: the candidate is reversed again at the end).
 * Prints UNBILLED_REST_CARRY_OVER_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, seed, attempt, asUser, USERS, ROOT, NAME, docker, scalar } from './undo-paths/harness.mjs';

const CANDIDATE = '20270308170000_unbilled_rest_and_delivery_price_carry_over.sql';
const lf = (f) => readFileSync(f, 'utf8').replaceAll('\r\n', '\n');
const candidate = lf(path.join(ROOT, 'supabase', 'migrations', CANDIDATE));
const reverse = lf(path.join(ROOT, 'scripts', 'smoke', 'unbilled-rest-and-carry-over-reverse.sql'));
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const run = (sql, flags = []) => docker([...PSQL, ...flags], { input: sql, allowFailure: true });
const ADMIN = USERS.admin;
// Every function the candidate replaces, adds or drops, by name: signature and body, so a changed argument list counts.
const FNS = ['_allocated_delivery_cents', '_create_invoice_for_unbilled_delivery_impl_20260718',
  '_create_invoice_for_unbilled_delivery_idem_impl_20260721', 'create_invoice_for_unbilled_delivery', 'get_dashboard_action_items'];
const reuse = process.env.A4CARRY_PROOF_REUSE === '1';
if (reuse && !/^(crx-undo-paths|a4carry)-/.test(process.env.UNDO_PATHS_CONTAINER || '')) {
  throw new Error('A4CARRY_PROOF_REUSE needs UNDO_PATHS_CONTAINER naming a throwaway proof container (crx-undo-paths-* or a4carry-*)');
}
const md5s = () => scalar(`SELECT string_agg(p.oid::regprocedure::text || '=' || md5(replace(p.prosrc, chr(13), '')) || ':' || COALESCE(p.proacl::text, ''), ',' ORDER BY 1)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('${FNS.join("','")}');`);

// Invented ids (tag 'a4..'; the harness's users use 'a1'..'a4' in the last places, so these sit higher).
const uid = (n) => `7c7a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUST = uid('a4c1'); const PROD = uid('a4d1');
// order -> [order id, lines [id, units, total $, unit price $], deliveries [id, [[line index, units]]]]. Prices are
// written as decimal text, never derived by binary division.
const ORDERS = {
  carry_down: [uid('a4e1'), [[uid('a4f1'), 10, '400.00', '40.00']], [[uid('a4b11'), [[0, 6]]], [uid('a4b12'), [[0, 4]]]]],
  carry_up: [uid('a4e2'), [[uid('a4f2'), 10, '400.00', '40.00']], [[uid('a4b21'), [[0, 6]]], [uid('a4b22'), [[0, 4]]]]],
  short: [uid('a4e3'), [[uid('a4f3'), 10, '400.00', '40.00']], [[uid('a4b31'), [[0, 10]]]]],
  whole: [uid('a4e4'), [[uid('a4f4'), 10, '400.00', '40.00']], [[uid('a4b41'), [[0, 10]]]]],
  rounding: [uid('a4e5'), [[uid('a4f5'), 3, '100.00', '33.33']], [[uid('a4b51'), [[0, 1]]], [uid('a4b52'), [[0, 1]]], [uid('a4b53'), [[0, 1]]]]],
  void: [uid('a4e6'), [[uid('a4f6'), 2, '80.00', '40.00']], [[uid('a4b61'), [[0, 1]]], [uid('a4b62'), [[0, 1]]]]],
  // Sol r1: two order lines of one product; the invoice names line B only.
  two_lines: [uid('a4e7'), [[uid('a4f7'), 5, '150.00', '30.00'], [uid('a4f8'), 5, '200.00', '40.00']], [[uid('a4b71'), [[0, 5], [1, 5]]]]],
  // Sol r1: two deliveries under one whole-order invoice.
  whole_two: [uid('a4e8'), [[uid('a4f9'), 20, '800.00', '40.00']], [[uid('a4b81'), [[0, 10]]], [uid('a4b82'), [[0, 10]]]]],
  // Sol r1: an editor-added line (no order line) bills the first unit of two allocated $80.01.
  editor_line: [uid('a4e9'), [[uid('a4fa'), 2, '80.01', '40.01']], [[uid('a4b91'), [[0, 2]]]]],
  // Taha r2: $100 for 3 in three deliveries; the first draft is cancelled after the second, then billed again last.
  void_rebill: [uid('a4ea'), [[uid('a4fb'), 3, '100.00', '33.33']], [[uid('a4ba1'), [[0, 1]]], [uid('a4ba2'), [[0, 1]]], [uid('a4ba3'), [[0, 1]]]]],
  // Taha r2: a price edit, then a void and re-bill of the edited delivery's sibling.
  carry_void: [uid('a4eb'), [[uid('a4fc'), 10, '400.00', '40.00']], [[uid('a4bb1'), [[0, 6]]], [uid('a4bb2'), [[0, 4]]]]],
  // Taha r2: the server refuses a scope other than the one the screen showed.
  scope: [uid('a4ed'), [[uid('a4fe'), 10, '400.00', '40.00']], [[uid('a4bd1'), [[0, 10]]]]],
  // Sol r2: a miscellaneous charge naming the product. The order cap counts it as billing those units, so the list must
  // not show them as owed (it would offer a draft the cap refuses): unchanged from staging.
  misc: [uid('a4ee'), [[uid('a4ff'), 10, '400.00', '40.00']], [[uid('a4be1'), [[0, 10]]]]],
  // Taha r4: an editor line with no order line for a product on two differently priced order lines is refused.
  ambiguous: [uid('a4ef'), [[uid('a4f10'), 5, '150.00', '30.00'], [uid('a4f11'), 5, '200.00', '40.00']], [[uid('a4bf1'), [[0, 5], [1, 5]]]]],
  // Taha r4, known limit pinned: $149 for 7 units in seven deliveries; drafts 2, 4 and 6 cancelled and billed again.
  drift7: [uid('a4e10'), [[uid('a4f12'), 7, '149.00', '21.29']],
    [1, 2, 3, 4, 5, 6, 7].map((n) => [uid(`a4b10${n}`), [[0, 1]]])],
};

function seedAll() {
  const price = `DO $price$ DECLARE v jsonb; BEGIN
      v := public.preview_product_pricing_changes('product_page', NULL,
        jsonb_build_array(jsonb_build_object('product_id', '${PROD}', 'row_version', 1, 'pricing_mode', 'price_driven',
          'new_cost', '20.00', 'tier1_price', '40.00', 'tier2_price', '40.00', 'tier3_price', '40.00')), '${ADMIN}', 'a4carry-preview');
      PERFORM public.apply_product_pricing_change_set((v->>'change_set_id')::uuid, v->>'request_fingerprint', '${ADMIN}', 'a4carry-apply');
    END $price$;`;
  const orders = Object.entries(ORDERS).map(([k, [o, lines, dels]]) => [k, `
    INSERT INTO public.orders (id, order_number, customer_id, status, booking_draw) VALUES ('${o}', '[A4] ${k}', '${CUST}', 'confirmed', false);
    ${lines.map(([l, units, total, ppu]) => `INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size)
      VALUES ('${l}', '${o}', '${PROD}', '[A4] product', ${ppu}, 20, ${units}, ${total}, ${total} - ${units * 20}, 50, 0, ${units}, 'Gal');`).join('\n    ')}
    ${dels.map(([d, items], i) => `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, scheduled_date, status, created_by)
        VALUES ('${d}', '[A4] ${k}-${i + 1}', '${o}', '${CUST}', CURRENT_DATE, 'scheduled', '${ADMIN}');
      INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
        VALUES ${items.map(([li, q]) => `('${d}', '${lines[li][0]}', '${PROD}', ${q}, 0, 'Gal')`).join(', ')};`).join('\n    ')}`]);
  seed('a4carry', `INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${CUST}', '[A4] Farm', '[A4]-1');
    INSERT INTO public.products (id, product_name, unit_size, epa_registration, product_form, inventory_unit)
      VALUES ('${PROD}', '[A4] product', 'Gal', '999999-99991', 'liquid', 'Gal');
    ${price}
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
      VALUES ('${PROD}', 'Main Warehouse', 1000, 0, 'Gal');`);
  // One seed per order, so a reused container picks up orders added later.
  for (const [k, sql] of orders) seed(`a4carry-${k}`, sql);
}

// --- probe pieces (plpgsql inside the harness's probe; r jsonb, t text, u uuid, n bigint are declared) ---------------
const complete = (del) => `UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${del}';
  ${asUser(`r := public.complete_delivery(p_delivery_id => '${del}', p_signed_by => 'No proof — recorded by office',
    p_performed_by => '${ADMIN}', p_quantities => NULL, p_idempotency_key => 'a4carry-c-${del}', p_evidence => 'no_proof',
    p_evidence_ref => '[A4] fixture');`)}`;
const invoiceOf = (del) => `(SELECT i.id FROM public.invoices i WHERE i.delivery_id = '${del}' AND i.status NOT IN ('voided', 'cancelled') AND i.deleted_at IS NULL)`;
// The invoice editor's save: every line kept, its quantity and unit price replaced.
const edit = (inv, q, cents, key) => `u := ${inv};
  r3 := (SELECT jsonb_agg(jsonb_build_object('id', ii.id, 'order_item_id', ii.order_item_id, 'product_id', ii.product_id,
       'description', ii.description, 'quantity', ${q}, 'unit_price_cents', ${cents}, 'extended_cents', ${q} * ${cents},
       'cost_cents', ii.cost_cents, 'unit_size', ii.unit_size)) FROM public.invoice_items ii WHERE ii.invoice_id = u);
  ${asUser(`u := public.save_invoice(
    jsonb_build_object('id', u, 'customer_id', '${CUST}', 'invoice_type', 'chemical_sale'), r3, 'a4carry-e-${key}');`)}`;
const cents = (del) => `COALESCE((SELECT total_amount_cents FROM public.invoices WHERE id = ${invoiceOf(del)})::text, 'none')`;
const orderBilled = (o) => `(SELECT COALESCE(sum(ii.extended_cents), 0) || '/' || COALESCE(sum(ii.quantity), 0)::numeric(12,2)
  FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
  WHERE i.order_id = '${o}' AND i.invoice_type <> 'credit_memo' AND i.deleted_at IS NULL AND i.status NOT IN ('voided', 'cancelled'))`;
// Sets t2 to whether the dashboard's "Delivered, not invoiced" lists the delivery.
const listed = (del) => `${asUser(`r2 := public.get_dashboard_action_items(500);`)}
  t2 := EXISTS (SELECT 1 FROM jsonb_array_elements(r2->'unbilled_deliveries') e WHERE e->>'id' = '${del}')::text;`;
// After the candidate the screens send the scope their confirmation showed; staging's chain takes three arguments.
let withScope = false;
const billRest = (del, key, scope) => `BEGIN
    ${asUser(withScope
      ? `r := public.create_invoice_for_unbilled_delivery('${del}', '${ADMIN}', 'a4carry-b-${key}', '${scope}');`
      : `r := public.create_invoice_for_unbilled_delivery('${del}', '${ADMIN}', 'a4carry-b-${key}');`)}
    t := 'drafted ' || (r->>'total_cents') || ' qty=' || (SELECT sum(quantity)::numeric(12,2) FROM public.invoice_items WHERE invoice_id = (r->>'invoice_id')::uuid)
      || ' on=' || COALESCE((SELECT CASE WHEN delivery_id IS NULL THEN 'order' ELSE 'delivery' END FROM public.invoices WHERE id = (r->>'invoice_id')::uuid), '?');
  EXCEPTION WHEN OTHERS THEN t := 'refused: ' || left(SQLERRM, 60); END;`;

// Bill the rest on delivery d of order o, then: what was drafted, the order's billed cents/units, whether each
// delivery in `watch` is still listed, and a second try.
const restSteps = (o, d, key, scope, watch = [d]) => `${listed(d)} v := v || 'listed=' || t2;
    ${billRest(d, `${key}1`, scope)} v := v || ' | ' || t || ' | billed=' || ${orderBilled(o)};
    ${watch.map((w, i) => `${listed(w)} v := v || ' listed${watch.length > 1 ? i + 1 : ''}=' || t2;`).join('\n    ')}
    ${billRest(d, `${key}2`, scope)} v := v || ' | again ' || t;`;
// Replace a delivery's draft with one whole-order invoice (save_invoice, no delivery: the editor adds lines without
// an order line) billing `q` units at `cents` each.
const wholeOrder = (o, dels, q, cents, key) => `${dels.map((d) => `UPDATE public.invoices SET status = 'cancelled' WHERE id = ${invoiceOf(d)};`).join(' ')}
    ${asUser(`u := public.save_invoice(jsonb_build_object('order_id', '${o}', 'customer_id', '${CUST}', 'invoice_type', 'chemical_sale'),
      jsonb_build_array(jsonb_build_object('product_id', '${PROD}', 'description', '[A4] product',
        'quantity', ${q}, 'unit_price_cents', ${cents}, 'extended_cents', ${q} * ${cents}, 'cost_cents', 2000, 'unit_size', 'Gal')), 'a4carry-w-${key}');`)}`;

const CASES = {
  carry_down: () => { const [, , [[d1], [d2]]] = ORDERS.carry_down; return `${complete(d1)} ${edit(invoiceOf(d1), 6, 3500, 'cd')} ${complete(d2)}
    v := ${cents(d1)} || ' then ' || ${cents(d2)};`; },
  carry_up: () => { const [, , [[d1], [d2]]] = ORDERS.carry_up; return `${complete(d1)} ${edit(invoiceOf(d1), 6, 4500, 'cu')} ${complete(d2)}
    v := ${cents(d1)} || ' then ' || ${cents(d2)};`; },
  short: () => { const [o, , [[d]]] = ORDERS.short; return `${complete(d)} ${edit(invoiceOf(d), 6, 4000, 'sh')}
    ${listed(d)} v := 'listed=' || t2;
    ${billRest(d, 'sh1', 'rest_delivery')} ${listed(d)} v := v || ' | ' || t || ' | billed=' || ${orderBilled(o)} || ' listed=' || t2;
    ${billRest(d, 'sh2', 'rest_delivery')} v := v || ' | again ' || t;`; },
  whole: () => { const [o, [[l]], [[d]]] = ORDERS.whole; return `${complete(d)}
    -- The office replaces the delivery's draft with one whole-order invoice (save_invoice, no delivery) for 6.
    UPDATE public.invoices SET status = 'cancelled' WHERE id = ${invoiceOf(d)};
    ${asUser(`u := public.save_invoice(jsonb_build_object('order_id', '${o}', 'customer_id', '${CUST}', 'invoice_type', 'chemical_sale'),
      jsonb_build_array(jsonb_build_object('order_item_id', '${l}', 'product_id', '${PROD}', 'description', '[A4] product',
        'quantity', 6, 'unit_price_cents', 4000, 'extended_cents', 24000, 'cost_cents', 2000, 'unit_size', 'Gal')), 'a4carry-w');`)}
    ${listed(d)}
    v := 'whole=' || (SELECT total_amount_cents || (CASE WHEN delivery_id IS NULL THEN ' on order' ELSE ' on delivery' END) FROM public.invoices WHERE id = u)
      || ' listed=' || t2;
    ${billRest(d, 'wh1', 'rest_order')} ${listed(d)} v := v || ' | ' || t || ' | billed=' || ${orderBilled(o)} || ' listed=' || t2;
    ${billRest(d, 'wh2', 'rest_order')} v := v || ' | again ' || t;`; },
  two_lines: () => { const [o, [[la]], [[d]]] = ORDERS.two_lines; return `${complete(d)}
    -- The office lowers line A to 1 unit ($30.00) and keeps line B's 5.
    u := ${invoiceOf(d)};
    r3 := (SELECT jsonb_agg(jsonb_build_object('id', ii.id, 'order_item_id', ii.order_item_id, 'product_id', ii.product_id,
       'description', ii.description, 'quantity', CASE WHEN ii.order_item_id = '${la}' THEN 1 ELSE ii.quantity END,
       'unit_price_cents', ii.unit_price_cents,
       'extended_cents', CASE WHEN ii.order_item_id = '${la}' THEN ii.unit_price_cents ELSE ii.extended_cents END,
       'cost_cents', ii.cost_cents, 'unit_size', ii.unit_size)) FROM public.invoice_items ii WHERE ii.invoice_id = u);
    ${asUser(`u := public.save_invoice(jsonb_build_object('id', u, 'customer_id', '${CUST}', 'invoice_type', 'chemical_sale'), r3, 'a4carry-e-tl');`)}
    v := '';
    ${restSteps(o, d, 'tl', 'rest_delivery')}`; },
  whole_two: () => { const [o, , [[d1], [d2]]] = ORDERS.whole_two; return `${complete(d1)} ${complete(d2)}
    ${wholeOrder(o, [d1, d2], 6, 4000, 'w2')}
    v := '';
    ${restSteps(o, d2, 'w2', 'rest_order', [d1, d2])}`; },
  editor_line: () => { const [o, , [[d]]] = ORDERS.editor_line; return `${complete(d)}
    ${wholeOrder(o, [d], 1, 4001, 'el')}
    v := '';
    ${restSteps(o, d, 'el', 'rest_order')}`; },
  void_rebill: () => { const [o, , [[d1], [d2], [d3]]] = ORDERS.void_rebill; return `${complete(d1)} ${complete(d2)}
    UPDATE public.invoices SET status = 'cancelled' WHERE id = ${invoiceOf(d1)};
    ${complete(d3)}
    ${billRest(d1, 'vr', 'new')}
    v := ${cents(d2)} || '+' || ${cents(d3)} || '+' || ${cents(d1)} || ' billed=' || ${orderBilled(o)};`; },
  carry_void: () => { const [o, , [[d1], [d2]]] = ORDERS.carry_void; return `${complete(d1)} ${edit(invoiceOf(d1), 6, 3500, 'cv')} ${complete(d2)}
    UPDATE public.invoices SET status = 'cancelled' WHERE id = ${invoiceOf(d2)};
    ${billRest(d2, 'cv', 'new')}
    v := ${cents(d1)} || ' then ' || ${cents(d2)} || ' billed=' || ${orderBilled(o)};`; },
  scope: () => { const [o, , [[d]]] = ORDERS.scope; return `${complete(d)} ${edit(invoiceOf(d), 6, 4000, 'sc')}
    -- A screen from before A4 sends no scope: it only ever offered a first invoice.
    BEGIN ${asUser(`r := public.create_invoice_for_unbilled_delivery('${d}', '${ADMIN}', 'a4carry-s-0');`)} t := 'NOT REFUSED';
    EXCEPTION WHEN OTHERS THEN t := left(SQLERRM, 40); END;
    v := 'none: ' || t || ' | ';
    BEGIN ${asUser(`r := public.create_invoice_for_unbilled_delivery(p_delivery_id => '${d}', p_performed_by => '${ADMIN}',
      p_idempotency_key => 'a4carry-s-1', p_expected_scope => 'rest_order');`)} t := 'NOT REFUSED';
    EXCEPTION WHEN OTHERS THEN t := left(SQLERRM, 40); END;
    v := v || 'order: ' || t;
    BEGIN ${asUser(`r := public.create_invoice_for_unbilled_delivery(p_delivery_id => '${d}', p_performed_by => '${ADMIN}',
      p_idempotency_key => 'a4carry-s-2', p_expected_scope => 'new');`)} t := 'NOT REFUSED';
    EXCEPTION WHEN OTHERS THEN t := left(SQLERRM, 40); END;
    v := v || ' | new: ' || t;
    BEGIN ${asUser(`r := public.create_invoice_for_unbilled_delivery(p_delivery_id => '${d}', p_performed_by => '${ADMIN}',
      p_idempotency_key => 'a4carry-s-3', p_expected_scope => 'rest_delivery');`)} t := 'drafted ' || (r->>'total_cents') || ' ' || (r->>'scope');
    EXCEPTION WHEN OTHERS THEN t := left(SQLERRM, 60); END;
    v := v || ' | delivery: ' || t || ' billed=' || ${orderBilled(o)};`; },
  misc: () => { const [o, , [[d]]] = ORDERS.misc; return `${complete(d)}
    UPDATE public.invoices SET status = 'cancelled' WHERE id = ${invoiceOf(d)};
    BEGIN ${asUser(`u := public.save_invoice(jsonb_build_object('order_id', '${o}', 'customer_id', '${CUST}', 'invoice_type', 'misc_charge'),
      jsonb_build_array(jsonb_build_object('product_id', '${PROD}', 'description', '[A4] product',
        'quantity', 10, 'unit_price_cents', 2500, 'extended_cents', 25000, 'cost_cents', 2000, 'unit_size', 'Gal')), 'a4carry-w-misc');`)}
      t := 'misc saved';
    EXCEPTION WHEN OTHERS THEN t := 'misc refused: ' || left(SQLERRM, 50); END;
    v := t || ' | ';
    ${restSteps(o, d, 'mc', 'rest_order')}`; },
  ambiguous: () => { const [o, , [[d]]] = ORDERS.ambiguous; return `${complete(d)}
    ${wholeOrder(o, [d], 5, 4000, 'amb')}
    v := '';
    ${restSteps(o, d, 'am', 'rest_order')}`; },
  drift7: () => { const [o, , dels] = ORDERS.drift7; return `${dels.map(([d]) => complete(d)).join('\n')}
    ${[1, 3, 5].map((i) => `UPDATE public.invoices SET status = 'cancelled' WHERE id = ${invoiceOf(dels[i][0])};
    ${billRest(dels[i][0], `d7-${i}`, 'new')}`).join('\n    ')}
    v := 'billed=' || ${orderBilled(o)};`; },
  rounding: () => { const [o, , dels] = ORDERS.rounding; return `${dels.map(([d]) => complete(d)).join('\n')}
    v := ${dels.map(([d]) => cents(d)).join(" || '+' || ")} || ' billed=' || ${orderBilled(o)};`; },
  void: () => { const [o, , [[d1], [d2]]] = ORDERS.void; return `${complete(d1)}
    UPDATE public.invoices SET status = 'cancelled' WHERE id = ${invoiceOf(d1)};
    ${complete(d2)} v := ${cents(d2)} || ' billed=' || ${orderBilled(o)};`; },
};
const probeAll = (label) => {
  console.log(`${label}:`);
  return Object.fromEntries(Object.entries(CASES).map(([name, body]) => {
    const out = attempt(ADMIN, body());
    console.log(`  ${name}: ${out}`);
    return [name, out];
  }));
};

// Expected AFTER, from the rules (each delivery's units at the order price; bill exactly the unbilled rest).
const EXPECT = {
  carry_down: 'ok|21000 then 16000',
  carry_up: 'ok|27000 then 16000',
  short: 'ok|listed=true | drafted 16000 qty=4.00 on=delivery | billed=40000/10.00 listed=false | again refused: This delivery already has an active invoice (or an order-lev',
  whole: 'ok|whole=24000 on order listed=true | drafted 16000 qty=4.00 on=order | billed=40000/10.00 listed=false | again refused: This delivery already has an active invoice (or an order-lev',
  // Line A's other 4 ($120.00) are drafted; line B's 5 on the invoice never count for A.
  two_lines: 'ok|listed=true | drafted 12000 qty=4.00 on=delivery | billed=35000/10.00 listed=false | again refused: This delivery already has an active invoice (or an order-lev',
  // The whole-order invoice covers the order: the rest is every unbilled unit on it, and neither delivery stays listed.
  whole_two: 'ok|listed=true | drafted 56000 qty=14.00 on=order | billed=80000/20.00 listed1=false listed2=false | again refused: This delivery already has an active invoice (or an order-lev',
  // The second unit of $80.01 is $40.00 (8001 - 4001), so the order bills $80.01 exactly, not $80.02.
  editor_line: 'ok|listed=true | drafted 4000 qty=1.00 on=order | billed=8001/2.00 listed=false | again refused: This delivery already has an active invoice (or an order-lev',
  // KNOWN LIMIT (Taha, 2026-11-26, option c): billing by units, a cancel and re-bill out of order can drift a few cents
  // (about one per re-bill) on a line that does not divide evenly. Pinned so it cannot grow unseen; the stored-cents
  // follow-up makes it $100.00.
  void_rebill: 'ok|3334+3334+3333 billed=10001/3.00',
  // Delivery 2 re-billed after its draft was cancelled still prices its own 4 at $160.00.
  carry_void: 'ok|21000 then 16000 billed=37000/10.00',
  scope: 'ok|none: UNBILLED_SCOPE_CHANGED: delivery [A4] sc | order: UNBILLED_SCOPE_CHANGED: delivery [A4] sc | new: UNBILLED_SCOPE_CHANGED: delivery [A4] sc | delivery: drafted 16000 rest_delivery billed=40000/10.00',
  // Which of the two order lines the $40 editor line billed is unknown: refused, nothing drafted.
  ambiguous: 'ok|listed=true | refused: UNBILLED_REST_LINE_AMBIGUOUS: an invoice line for [A4] produ | billed=20000/5.00 listed=true | again refused: UNBILLED_REST_LINE_AMBIGUOUS: an invoice line for [A4] produ',
  // KNOWN LIMIT, pinned: three out-of-order re-bills drift three cents ($149.03 on $149.00); stored cents closes it.
  drift7: 'ok|billed=14903/7.00',
};

try {
  if (!reuse) { buildContainer({ stopBefore: CANDIDATE }); seedUsers(); }
  seedAll();
  const oldMd5 = md5s();

  const before = probeAll('Before the candidate');
  assert.equal(before.carry_down, 'ok|21000 then 19000', 'carry-over must reproduce on the old body ($190, not $160)');
  assert.equal(before.carry_up, 'ok|27000 then 13000', 'carry-over must reproduce upward on the old body ($130)');
  assert.match(before.short, /^ok\|listed=false \| refused: This delivery already has an active invoice/, 'A4 must reproduce: off the list, refused');
  assert.match(before.short, /billed=24000\/6\.00/, 'A4: 4 units left unbilled on the old body');
  assert.match(before.whole, /^ok\|whole=24000 on order listed=false \| refused:/, 'A4 whole-order must reproduce');
  for (const name of ['two_lines', 'whole_two', 'editor_line']) {
    assert.match(before[name], /^ok\|listed=false \| refused: This delivery already has an active invoice/, `${name}: A4 must reproduce`);
  }
  assert.match(before.rounding, /^ok\|3333\+3334\+3333 billed=10000\/3\.00$/);
  assert.match(before.void, /^ok\|4000 billed=4000\/1\.00$/);
  assert.equal(before.void_rebill, 'ok|3334+3333+3333 billed=10000/3.00', 'staging re-bills to the cent after a cancel');
  assert.equal(before.drift7, 'ok|billed=14900/7.00', 'staging re-bills seven units to the cent');
  assert.match(before.ambiguous, /^ok\|listed=false \| refused: This delivery already has an active invoice/);
  assert.match(before.carry_void, /^ok\|21000 then 19000 billed=40000\/10\.00$/, 'carry-over must reproduce after a re-bill');
  assert.match(before.scope, /p_expected_scope|function public.create_invoice_for_unbilled_delivery/, 'staging has no scope argument');

  console.log('Apply:');
  const auto = run(candidate);
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  assert.equal(md5s(), oldMd5, 'a refused apply changes nothing');
  const once = run(candidate, ['-1']);
  assert.equal(once.status, 0, `${once.stdout}${once.stderr}`);
  assert.match(`${once.stdout}${once.stderr}`, /POSTFLIGHT_OK/);
  assert.match(run(candidate, ['-1']).stderr, /UNBILLED_REST_BASELINE_DRIFT/, 're-apply must refuse');
  const newMd5 = md5s();

  withScope = true;
  const after = probeAll('After the candidate');
  withScope = false;
  for (const [name, expected] of Object.entries(EXPECT)) assert.equal(after[name], expected, name);
  assert.equal(after.rounding, before.rounding, 'rounding across partial deliveries must not change');
  assert.equal(after.void, before.void, 'a void must still free its units');
  assert.equal(after.misc, before.misc, 'a product line on a miscellaneous charge bills as the order cap counts it');
  assert.match(after.misc, /^ok\|misc saved \| listed=false/);
  // What the screens read: the short bill's rest, as the signed-in admin (row policies on).
  const [, , [[shortDel]]] = ORDERS.short;
  const viewRow = attempt(ADMIN, `${complete(shortDel)} ${edit(invoiceOf(shortDel), 6, 4000, 'sv')}
    ${asUser(`v := (SELECT string_agg(delivered_qty::numeric(12,2) || ' delivered, ' || billed_qty::numeric(12,2) || ' billed, '
      || unbilled_qty::numeric(12,2) || ' unbilled, ' || unbilled_cents || ' cents', '; ')
      FROM public.delivery_billing_remainders WHERE delivery_id = '${shortDel}');`)}`);
  console.log(`  view (admin): ${viewRow}`);
  assert.equal(viewRow, 'ok|10.00 delivered, 6.00 billed, 4.00 unbilled, 16000 cents');
  // Access: anon reads nothing; the view runs under the reader's own policies.
  assert.equal(scalar("SELECT has_table_privilege('anon', 'public.delivery_billing_remainders', 'SELECT');"), 'f');
  assert.equal(scalar("SELECT reloptions::text FROM pg_class WHERE oid = 'public.delivery_billing_remainders'::regclass;"), '{security_invoker=true}');

  console.log('Reverse:');
  assert.match(run(reverse).stderr, /UNBILLED_REST_REVERSE_DRIFT: run this file as one transaction/, 'autocommit reverse must refuse');
  assert.equal(md5s(), newMd5, 'a refused reverse changes nothing');
  const back = run(reverse, ['-1']);
  assert.equal(back.status, 0, `${back.stdout}${back.stderr}`);
  assert.match(`${back.stdout}${back.stderr}`, /REVERSE_OK/);
  assert.equal(md5s(), oldMd5, 'reverse must restore the earlier bodies byte for byte');
  assert.equal(scalar("SELECT to_regclass('public.delivery_billing_remainders') IS NULL;"), 't');
  assert.match(run(reverse, ['-1']).stderr, /UNBILLED_REST_REVERSE_DRIFT/, 'reverse must refuse when the candidate is not installed');
  const reversed = probeAll('After the reverse');
  assert.deepEqual(reversed, before, 'the reverse must give every BEFORE result back');
  const again = run(candidate, ['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /POSTFLIGHT_OK/, 'candidate must re-apply after the reverse');
  assert.equal(md5s(), newMd5);
  if (reuse) assert.equal(run(reverse, ['-1']).status, 0, 'leave a reused container as found');

  console.log('UNBILLED_REST_CARRY_OVER_PROOF_PASS');
} finally {
  if (!reuse && process.env.CRX_PROVER_KEEP_CONTAINER !== '1') removeContainer();
}
