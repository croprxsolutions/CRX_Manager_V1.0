/**
 * Deliveries: create_delivery_with_items, edit_delivery, cancel_delivery, void_delivery and
 * create_invoice_for_unbilled_delivery.
 */
import assert from 'node:assert/strict';
import { attempt, asUser, id, refuse, seed, signIn, USERS } from './harness.mjs';

const CUST = id('2c1'); const PROD = id('2d2'); const ORDER = id('2e1');
const LINE = { a: id('2f1'), b: id('2f2'), c: id('2f3') };
// SCHED: scheduled (edit, cancel); DONE: completed (void); BILL: completed, its draft invoice deleted.
const DEL = { sched: id('2a1'), done: id('2a2'), bill: id('2a3') };
const { admin: ADMIN, rep: REP, driver: DRIVER } = USERS;
const NO_PROOF_SIGNER = 'No proof — recorded by office';

/** Stock, stock movements, order lines, deliveries and invoices for this area, read as postgres. */
const FP = `(SELECT string_agg(x, ' ' ORDER BY x) FROM (
  SELECT 'stock=' || quantity_available || '/' || quantity_prebooked x FROM public.inventory WHERE product_id = '${PROD}'
  UNION ALL SELECT 'moves=' || coalesce(string_agg(transaction_type || ':' || quantity, ',' ORDER BY transaction_type, quantity), '') FROM public.inventory_transactions WHERE product_id = '${PROD}'
  UNION ALL SELECT 'line' || right(oi.id::text, 1) || '=' || oi.quantity_delivered || '/' || oi.quantity_remaining FROM public.order_items oi WHERE oi.order_id = '${ORDER}'
  UNION ALL SELECT 'order=' || status FROM public.orders WHERE id = '${ORDER}'
  UNION ALL SELECT 'del' || CASE WHEN d.id IN ('${DEL.sched}', '${DEL.done}', '${DEL.bill}') THEN right(d.id::text, 1) ELSE 'new' END || '=' || d.status || ':' || coalesce((SELECT string_agg(di.quantity::text, ',' ORDER BY di.order_item_id) FROM public.delivery_items di WHERE di.delivery_id = d.id), '')
    FROM public.deliveries d WHERE d.order_id = '${ORDER}' AND d.deleted_at IS NULL
  UNION ALL SELECT 'inv=' || count(*) FILTER (WHERE deleted_at IS NULL AND status NOT IN ('voided', 'cancelled')) || ':'
    || coalesce(sum(total_amount_cents) FILTER (WHERE deleted_at IS NULL AND status NOT IN ('voided', 'cancelled')), 0)
    FROM public.invoices WHERE customer_id = '${CUST}') s)`;

function seedDeliveries() {
  const line = (k, units) => `INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size)
    VALUES ('${LINE[k]}', '${ORDER}', '${PROD}', '[UNDO] line ${k}', 10, 6, ${units}, ${units * 10}, ${units * 4}, 40, 0, ${units}, 'GL');`;
  const delivery = (k, lineKey, qty) => `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, scheduled_date, status, created_by)
      VALUES ('${DEL[k]}', '[UNDO] DEL-${k}', '${ORDER}', '${CUST}', CURRENT_DATE, 'scheduled', '${ADMIN}');
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
      VALUES ('${DEL[k]}', '${LINE[lineKey]}', '${PROD}', ${qty}, 0, 'GL');`;
  const complete = (k) => `UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${DEL[k]}';
    SELECT public.complete_delivery(p_delivery_id => '${DEL[k]}', p_signed_by => '${NO_PROOF_SIGNER}', p_performed_by => '${ADMIN}',
      p_idempotency_key => 'undo-seed-complete-${k}', p_evidence => 'no_proof', p_evidence_ref => '[UNDO] fixture');`;
  seed('deliveries', `INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${CUST}', '[UNDO] Delivery Farm', '[UNDO]-DEL-1');
    INSERT INTO public.products (id, product_name, unit_size, epa_registration, product_form)
      VALUES ('${PROD}', '[UNDO] Delivery Product', 'GL', '999999-99999', 'liquid');
    DO $price$
    DECLARE v jsonb;
    BEGIN
      v := public.preview_product_pricing_changes('product_page', NULL,
        jsonb_build_array(jsonb_build_object('product_id', '${PROD}', 'row_version', 1, 'pricing_mode', 'price_driven',
          'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
        '${ADMIN}', 'undo-seed-del-pricing-preview');
      PERFORM public.apply_product_pricing_change_set((v->>'change_set_id')::uuid, v->>'request_fingerprint', '${ADMIN}', 'undo-seed-del-pricing-apply');
    END
    $price$;
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES ('${PROD}', 'Main Warehouse', 100, 20, 'GL');
    INSERT INTO public.orders (id, order_number, customer_id, status, booking_draw) VALUES ('${ORDER}', '[UNDO] DEL-ORDER', '${CUST}', 'confirmed', false);
    ${line('a', 8)} ${line('b', 6)} ${line('c', 6)}
    ${delivery('sched', 'a', 3)} ${delivery('done', 'b', 4)} ${delivery('bill', 'c', 5)}
    ${complete('done')} ${complete('bill')}
    SELECT public.delete_invoices(ARRAY(SELECT id FROM public.invoices WHERE delivery_id = '${DEL.bill}'), '${ADMIN}', 'undo-seed-del-unbill');`);
}

// Two completions (4 and 5 units) took stock from 100 on hand / 20 reserved to 91/11.
const START = 'del1=scheduled:3 del2=completed:4 del3=completed:5 inv=1:4000 line1=0/8 line2=4/2 line3=5/1 '
  + 'moves=delivered:4,delivered:5 order=partially_fulfilled stock=91/11';
const show = (label, got) => { console.log(`  ${label}: ${got}`); return got; };

const create = (key, qty = 2) => `public.create_delivery_with_items('${ORDER}', '${CUST}', CURRENT_DATE,
  jsonb_build_array(jsonb_build_object('order_item_id', '${LINE.a}', 'product_id', '${PROD}', 'quantity', ${qty}, 'unit_size', 'GL')),
  NULL, NULL, NULL, '[UNDO] new delivery', '${key}')`;
const cancel = (del, uid, key) => `public.cancel_delivery('${del}', '[UNDO] customer called', '${uid}', '${key}')`;
const voidDel = (del, uid, key) => `public.void_delivery('${del}', '[UNDO] delivered in error', '${uid}', '${key}')`;
const edit = (qty, uid, key) => `public.edit_delivery('${DEL.sched}', p_items => jsonb_build_array(jsonb_build_object('order_item_id', '${LINE.a}',
  'product_id', '${PROD}', 'quantity', ${qty}, 'unit_size', 'GL')), p_performed_by => '${uid}', p_idempotency_key => '${key}')`;
const bill = (uid, key) => `public.create_invoice_for_unbilled_delivery('${DEL.bill}', '${uid}', '${key}')`;

export function run() {
  seedDeliveries();
  assert.equal(show('fixture', attempt(ADMIN, `v := ${FP};`)), `ok|${START}`);

  const cc = show('create then cancel', attempt(ADMIN, `
    f0 := ${FP};
    ${signIn(DRIVER)} ${refuse(`r := ${create('undo-create-driver')};`)} t2 := t || '|driver_unchanged=' || (f0 = ${FP}); ${signIn(ADMIN)}
    ${asUser(`r := ${create('undo-create-1')};`)} f1 := ${FP};
    ${asUser(`r2 := ${create('undo-create-1')};`)} f2 := ${FP};
    u := (r->>'delivery_id')::uuid;
    ${asUser(`r3 := public.cancel_delivery(u, '[UNDO] customer called', '${ADMIN}', 'undo-create-cancel');`)}
    v := f0 || ' -> ' || f1 || ' | items=' || (r->>'item_count') || ' | replay_same=' || (r = r2) || ' replay_unchanged=' || (f1 = f2)
      || ' | after cancel back_to_start=' || (f0 = replace(${FP}, ' delnew=cancelled:2', '')) || ' | driver=' || t2;`));

  const cs = show('cancel scheduled', attempt(ADMIN, `
    f0 := ${FP};
    ${signIn(DRIVER)} ${refuse(`r := ${cancel(DEL.sched, DRIVER, 'undo-cancel-driver')};`)} t2 := t || '|driver_unchanged=' || (f0 = ${FP}); ${signIn(ADMIN)}
    ${asUser(`r := ${cancel(DEL.sched, ADMIN, 'undo-cancel-1')};`)} f1 := ${FP};
    ${asUser(`r2 := ${cancel(DEL.sched, ADMIN, 'undo-cancel-1')};`)} f2 := ${FP};
    ${refuse(`r3 := ${cancel(DEL.sched, ADMIN, 'undo-cancel-2')};`)}
    v := f0 || ' -> ' || f1 || ' | replay_same=' || (r = r2) || ' replay_unchanged=' || (f1 = f2) || ' | again=' || t || ' | driver=' || t2;`));

  const vd = show('void completed', attempt(ADMIN, `
    f0 := ${FP};
    ${signIn(REP)} ${refuse(`r := ${voidDel(DEL.done, REP, 'undo-void-rep')};`)} t2 := t || '|rep_unchanged=' || (f0 = ${FP}); ${signIn(ADMIN)}
    ${asUser(`r := ${voidDel(DEL.done, ADMIN, 'undo-void-1')};`)} f1 := ${FP};
    ${asUser(`r2 := ${voidDel(DEL.done, ADMIN, 'undo-void-1')};`)} f2 := ${FP};
    ${refuse(`r3 := ${voidDel(DEL.done, ADMIN, 'undo-void-2')};`)}
    v := f0 || ' -> ' || f1 || ' | posted_invoices_exist=' || (r->>'posted_invoices_exist') || ' | replay_same=' || (r = r2) || ' replay_unchanged=' || (f1 = f2) || ' | again=' || t || ' | rep=' || t2;`));

  const ed = show('edit there and back', attempt(ADMIN, `
    f0 := ${FP};
    ${signIn(DRIVER)} ${refuse(`r := ${edit(1, DRIVER, 'undo-edit-driver')};`)} t2 := t || '|driver_unchanged=' || (f0 = ${FP}); ${signIn(ADMIN)}
    ${asUser(`r := ${edit(1, ADMIN, 'undo-edit-1')};`)} f1 := ${FP};
    ${asUser(`r2 := ${edit(1, ADMIN, 'undo-edit-1')};`)} f2 := ${FP};
    ${asUser(`r3 := ${edit(3, ADMIN, 'undo-edit-2')};`)}
    v := f0 || ' -> ' || f1 || ' | replay_same=' || (r = r2) || ' replay_unchanged=' || (f1 = f2) || ' | back=' || (f0 = ${FP}) || ' | driver=' || t2;`));

  const bl = show('bill unbilled', attempt(ADMIN, `
    f0 := ${FP};
    ${signIn(DRIVER)} ${refuse(`r := ${bill(DRIVER, 'undo-bill-driver')};`)} t2 := t || '|driver_unchanged=' || (f0 = ${FP}); ${signIn(ADMIN)}
    ${asUser(`r := ${bill(ADMIN, 'undo-bill-1')};`)} f1 := ${FP};
    ${asUser(`r2 := ${bill(ADMIN, 'undo-bill-1')};`)} f2 := ${FP};
    ${refuse(`r3 := ${bill(ADMIN, 'undo-bill-2')};`)}
    v := f0 || ' -> ' || f1 || ' | total_cents=' || (r->>'total_cents') || ' | replay_same=' || (r = r2) || ' replay_unchanged=' || (f1 = f2) || ' | again=' || left(t, 50) || ' | driver=' || t2;`));
  const replayed = ' | replay_same=true replay_unchanged=true';
  // Scheduling reserves nothing extra (the order already holds it); cancelling the new delivery
  // leaves every row exactly as before it was created. One delivery however often it is retried.
  assert.equal(cc, `ok|${START} -> ${START.replace('inv=', 'delnew=scheduled:2 inv=')} | items=1${replayed}`
    + ' | after cancel back_to_start=true | driver=FORBIDDEN|driver_unchanged=true');
  assert.equal(cs, `ok|${START} -> ${START.replace('del1=scheduled:3', 'del1=cancelled:3')}${replayed}`
    + ' | again=Cannot cancel a cancelled delivery | driver=Not authorized to cancel deliveries|driver_unchanged=true');
  // Voiding the completed 4-unit delivery puts back 4 on hand and 4 reserved (91/11 -> 95/15), the
  // order line's delivered count, and cancels its draft invoice, with one reversal movement.
  assert.equal(vd, `ok|${START} -> del1=scheduled:3 del2=voided:4 del3=completed:5 inv=0:0 line1=0/8 line2=0/6 line3=5/1 `
    + `moves=delivered:4,delivered:5,void_delivery_reversal:4 order=partially_fulfilled stock=95/15 | posted_invoices_exist=false${replayed}`
    + ' | again=Only completed deliveries can be voided (current status: voided) | rep=Admin access required to void a completed delivery|rep_unchanged=true');
  // 3 -> 1 -> 3 units on the scheduled delivery lands exactly where it started.
  assert.equal(ed, `ok|${START} -> ${START.replace('del1=scheduled:3', 'del1=scheduled:1')}${replayed} | back=true | driver=INSUFFICIENT_ROLE|driver_unchanged=true`);
  // The unbilled 5-unit delivery gets one $50.00 invoice, the same total as the draft it lost.
  assert.equal(bl, `ok|${START} -> ${START.replace('inv=1:4000', 'inv=2:9000')} | total_cents=5000${replayed}`
    + ' | again=This delivery already has an active invoice (or an | driver=Admin access required to create an invoice for a delivery|driver_unchanged=true');
  assert.equal(attempt(ADMIN, `v := (SELECT string_agg(total_amount_cents::text, ',') FROM public.invoices WHERE delivery_id = '${DEL.bill}' AND deleted_at IS NOT NULL);`), 'ok|5000');
}
