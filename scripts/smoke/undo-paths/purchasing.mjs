/**
 * Purchasing: receive_po_items -> reverse_receiving_record, and cancel_purchase_order.
 */
import assert from 'node:assert/strict';
import { attempt, asUser, id, ref, refuse, scalar, seed, signIn, USERS } from './harness.mjs';

const VENDOR = id('3b1'); const PROD = id('3d1');
const PO = { received: ref('po-received'), open: ref('po-open') };
const ITEM = (k) => `(SELECT id FROM public.purchase_order_items WHERE purchase_order_id = ${PO[k]})`;
const { admin: ADMIN, rep: REP, driver: DRIVER } = USERS;

/** Stock, stock movements and both purchase orders, read as postgres. */
const fp = () => `(SELECT string_agg(x, ' ' ORDER BY x) FROM (
  SELECT 'stock=' || quantity_available || '/onorder=' || quantity_on_order x FROM public.inventory WHERE product_id = '${PROD}' AND location = 'Main Warehouse'
  UNION ALL SELECT 'moves=' || coalesce(string_agg(transaction_type || ':' || quantity, ',' ORDER BY transaction_type, quantity), '') FROM public.inventory_transactions WHERE product_id = '${PROD}'
  UNION ALL SELECT 'po' || CASE WHEN po.id = ${PO.received} THEN 'R' ELSE 'O' END || '=' || po.status || ':' || coalesce(poi.quantity_received, 0) || '/' || poi.quantity_ordered
      || ':receipts=' || (SELECT count(*) FROM public.receiving_records rr WHERE rr.po_item_id = poi.id)
    FROM public.purchase_orders po JOIN public.purchase_order_items poi ON poi.purchase_order_id = po.id WHERE po.id IN (${PO.received}, ${PO.open})
) s)`;

function seedPurchasing() {
  const po = (k, n) => `INSERT INTO undo_paths.ids SELECT 'po-${k}', (public.save_purchase_order(NULL,
      jsonb_build_object('po_number', '[UNDO] PO-${k}', 'vendor', '[UNDO] Vendor', 'status', 'draft'),
      jsonb_build_array(jsonb_build_object('product_id', '${PROD}', 'product_name', '[UNDO] Purchased Product', 'quantity_ordered', ${n},
        'unit_cost_cents', 600, 'unit_size', 'GL')), '${ADMIN}', 'undo-seed-po-${k}')->>'po_id')::uuid;
    SELECT public.submit_purchase_order(${PO[k]}, '${ADMIN}', 'undo-seed-po-submit-${k}');`;
  seed('purchasing', `INSERT INTO public.vendors (id, name) VALUES ('${VENDOR}', '[UNDO] Vendor');
    INSERT INTO public.products (id, product_name, unit_size, epa_registration, product_form)
      VALUES ('${PROD}', '[UNDO] Purchased Product', 'GL', '999999-99998', 'liquid');
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES ('${PROD}', 'Main Warehouse', 50, 0, 'GL');
    ${po('received', 10)} ${po('open', 7)}
    SELECT public.receive_po_items(jsonb_build_array(jsonb_build_object('po_item_id',
      ${ITEM('received')}, 'quantity', 4,
      'storage_location', 'Main Warehouse', 'condition', 'good')), '${ADMIN}', 'undo-seed-receive', false);`);
}

const show = (label, got) => { console.log(`  ${label}: ${got}`); return got; };

export function run() {
  seedPurchasing();
  // The app role cannot read undo_paths, so pin the RPC-chosen ids as literals before probing.
  for (const k of Object.keys(PO)) PO[k] = `'${scalar(`SELECT ${PO[k]};`)}'::uuid`;
  const fixture = show('fixture', attempt(ADMIN, `v := ${fp()};`));
  const receiptId = scalar(`SELECT id FROM public.receiving_records WHERE po_item_id = ${ITEM('received')};`);
  const RECEIPT = `'${receiptId}'::uuid`;

  // reverse_receiving_record: the 4 received units leave stock and go back on order; replay; again; rep refused.
  const rev = (who, key) => `r := public.reverse_receiving_record(${RECEIPT}, '[UNDO] wrong count', '${who}', '${key}');`;
  const rr = show('reverse receipt', attempt(ADMIN, `
    f0 := ${fp()};
    ${signIn(REP)} ${refuse(rev(REP, 'undo-rr-rep'))} t2 := t || '|rep_unchanged=' || (f0 = ${fp()}); ${signIn(ADMIN)}
    ${asUser(rev(ADMIN, 'undo-rr-1'))} f1 := ${fp()};
    r2 := r; ${asUser(rev(ADMIN, 'undo-rr-1'))} f2 := ${fp()};
    ${refuse(rev(ADMIN, 'undo-rr-2'))}
    v := f1 || '|replay_same=' || (r = r2) || '|replay_unchanged=' || (f1 = f2) || '|again=' || t || '|again_unchanged=' || (f1 = ${fp()}) || '|rep=' || t2;`));

  // cancel_purchase_order (admins and sales reps by design): the 7 on order come off; replay; a second
  // cancel is a deliberate no-op answering already_cancelled; a driver is refused.
  const can = (who, key) => `r := public.cancel_purchase_order(${PO.open}, '[UNDO] not needed', '${who}', '${key}');`;
  const cp = show('cancel PO', attempt(ADMIN, `
    f0 := ${fp()};
    ${signIn(DRIVER)} ${refuse(can(DRIVER, 'undo-cp-driver'))} t2 := t || '|driver_unchanged=' || (f0 = ${fp()}); ${signIn(ADMIN)}
    ${asUser(can(ADMIN, 'undo-cp-1'))} f1 := ${fp()};
    r2 := r; ${asUser(can(ADMIN, 'undo-cp-1'))} f2 := ${fp()};
    r3 := r; ${asUser(can(ADMIN, 'undo-cp-2'))}
    v := f1 || '|replay_same=' || (r2 = r3) || '|replay_unchanged=' || (f1 = f2) || '|again=' || (r->>'status') || '|again_unchanged=' || (f1 = ${fp()})
      || '|cancelled_audit=' || (SELECT count(*) FROM public.activity_feed WHERE related_entity_id = ${PO.open} AND event_type = 'po_cancelled') || '|driver=' || t2;`));

  // A PO with stock already received cannot simply be cancelled.
  const cr = show('cancel received PO', attempt(ADMIN, `
    f0 := ${fp()};
    ${refuse(`r := public.cancel_purchase_order(${PO.received}, '[UNDO] x', '${ADMIN}', 'undo-cp-recv');`)}
    v := t || '|unchanged=' || (f0 = ${fp()});`));

  assert.equal(fixture, 'ok|moves=received:4 poO=submitted:0/7:receipts=0 poR=partially_received:4/10:receipts=1 stock=54/onorder=13');
  // Reversing the receipt takes the 4 units out of stock (54 -> 50), puts them back on order (13 -> 17),
  // records an adjusting movement and returns the PO to submitted.
  assert.equal(rr, 'ok|moves=adjusted:-4,received:4 poO=submitted:0/7:receipts=0 poR=submitted:0/10:receipts=0 stock=50/onorder=17'
    + `|replay_same=true|replay_unchanged=true|again=Receiving record not found: ${receiptId}|again_unchanged=true|rep=INSUFFICIENT_ROLE|rep_unchanged=true`);
  // Cancelling the open PO takes its 7 units off order (13 -> 6) and touches no stock.
  assert.equal(cp, 'ok|moves=received:4 poO=cancelled:0/7:receipts=0 poR=partially_received:4/10:receipts=1 stock=54/onorder=6'
    + '|replay_same=true|replay_unchanged=true|again=already_cancelled|again_unchanged=true|cancelled_audit=1'
    + '|driver=INSUFFICIENT_ROLE: only admins or sales reps can cancel purchase orders|driver_unchanged=true');
  assert.match(cr, /^ok\|Cannot cancel PO PO-\d{4}-\d{4}: 4 units already received\. Use partial receive workflow instead\.\|unchanged=true$/);
}
