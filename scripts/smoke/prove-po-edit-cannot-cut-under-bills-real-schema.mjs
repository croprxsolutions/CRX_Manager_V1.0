#!/usr/bin/env node
/**
 * Real-schema proof for 20270302020000_po_edit_cannot_cut_under_bills.sql (Mason, 2026-11-23, Taha's #2266 questions:
 * "The 5% rule also applies when Edit PO lowers a quantity, and the exception covers bills that went over because a
 * receipt was reversed").
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), shows the Edit PO gap, applies the candidate (autocommit
 * refused, POSTFLIGHT_OK, re-apply refused), then checks Edit PO saves against the bills and cost cuts after real
 * receipts and real reversals. Edit PO probes are rolled back; the receipts, reversals and re-entered bills commit inside
 * the throwaway container, so later probes see them.
 *
 * Run: node scripts/smoke/prove-po-edit-cannot-cut-under-bills-real-schema.mjs   (needs Docker; never touches live)
 * Prints PO_EDIT_BILLS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, id, USERS, ROOT, NAME, docker, psql, scalar, claims } from './undo-paths/harness.mjs';

const CANDIDATE = '20270302020000_po_edit_cannot_cut_under_bills.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
const [PROD, VENDOR] = ['e1', 'e2'].map(id);
const [PO1, PO2, PO3, PO4] = ['f1', 'f2', 'f3', 'f4'].map(id);
const [L1A, L1B, L2A, L3A, L3B, L4A] = ['91', '92', '93', '94', '95', '96'].map(id);
let n = 0;
const key = () => `po-edit-bills-${(n += 1)}`;

// Edit PO as the admin screen sends it ($10.00 lines; a rep's cost keys are stripped by the wrapper).
// lines: [[id, qty_ordered, qty_received]].
const save = (po, status, lines, notes = null) => `public.save_purchase_order('${po}'::uuid, '${JSON.stringify({
  vendor: '[POEB] Vendor', status, submitted_date: null, expected_delivery_date: null, notes,
})}'::jsonb, '${JSON.stringify(lines.map(([lid, q, rcv]) => ({
  id: lid, product_id: PROD, product_name: '[POEB] Chem', unit_size: 'Gal', quantity_ordered: q, quantity_received: rcv, unit_cost: 10, unit_cost_cents: 1000,
})))}'::jsonb, '${USERS.admin}'::uuid, '${key()}')`;
const saveAs = (uid, po, status, lines, notes) => save(po, status, lines, notes).replace(`'${USERS.admin}'::uuid`, `'${uid}'::uuid`);
const total = (po) => `(SELECT total_cost_cents FROM public.purchase_orders WHERE id = '${po}')`;
const saved = (uid, call, po) => attempt(uid, `${asUser(`r := ${call};`)} v := ${total(po)};`);
const refused = (uid, call, po) => attempt(uid, `${refuse(`r := ${call};`)} v := split_part(t, ':', 1) || '|' || ${total(po)};`);
const setCosts = (po, items, reason = null) =>
  `public.set_purchase_order_item_costs('${po}'::uuid, '${JSON.stringify(items)}'::jsonb, ${reason === null ? 'NULL' : `'${reason}'`}, NULL, '${key()}')`;
const costSaved = (po, items, reason) => attempt(USERS.admin, `${asUser(`r := ${setCosts(po, items, reason)};`)} v := r->>'lines_changed';`);
const costRefused = (po, items, reason) => attempt(USERS.admin, `${refuse(`r := ${setCosts(po, items, reason)};`)} v := split_part(t, ':', 1);`);
const receive = (line, qty) => attempt(USERS.admin, `${asUser(`r := public.receive_po_items('${JSON.stringify([{ po_item_id: line, quantity: qty }])}'::jsonb, '${USERS.admin}'::uuid, '${key()}', false);`)} v := r::text;`, { commit: true });
const received = (line) => scalar(`SELECT quantity_received FROM public.purchase_order_items WHERE id = '${line}';`);

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  // PO1 (Taha's #2266 example): L1A 60 @ $10 all arrived, L1B 40 @ $10 none. Ordered $1000, bill $1000 up front.
  // PO2 a bill confirmed over the whole order: L2A 10 @ $10, bill $110. PO3 for receipts and reversals: L3A 10 @ $10,
  // L3B 10 @ $10, ordered $200, bill $100. PO4 no bills: L4A 10 @ $10.
  psql(`BEGIN; ${claims(USERS.admin)}
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, inventory_unit, is_active)
      VALUES ('${PROD}', '[POEB] Chem', 'gal', 10.00, 15.00, 'liquid', 'Gal', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.purchase_orders (id, po_number, vendor, status, submitted_date, created_by) VALUES
      ('${PO1}', 'POEB-1', '[POEB] Vendor', 'submitted', CURRENT_DATE - 2, '${USERS.admin}'),
      ('${PO2}', 'POEB-2', '[POEB] Vendor', 'submitted', CURRENT_DATE - 2, '${USERS.admin}'),
      ('${PO3}', 'POEB-3', '[POEB] Vendor', 'submitted', CURRENT_DATE - 2, '${USERS.admin}'),
      ('${PO4}', 'POEB-4', '[POEB] Vendor', 'submitted', CURRENT_DATE - 2, '${USERS.admin}');
    INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, quantity_ordered, unit_cost, quantity_received, unit_size, product_name) VALUES
      ('${L1A}', '${PO1}', '${PROD}', 60, 10.00, 60, 'gal', '[POEB] Chem'),
      ('${L1B}', '${PO1}', '${PROD}', 40, 10.00, 0, 'gal', '[POEB] Chem'),
      ('${L2A}', '${PO2}', '${PROD}', 10, 10.00, 0, 'gal', '[POEB] Chem'),
      ('${L3A}', '${PO3}', '${PROD}', 10, 10.00, 0, 'gal', '[POEB] Chem'),
      ('${L3B}', '${PO3}', '${PROD}', 10, 10.00, 0, 'gal', '[POEB] Chem'),
      ('${L4A}', '${PO4}', '${PROD}', 10, 10.00, 0, 'gal', '[POEB] Chem');
    UPDATE public.purchase_orders SET total_cost = 1000.00, status = 'partially_received' WHERE id = '${PO1}';
    UPDATE public.purchase_orders SET total_cost = 100.00 WHERE id = '${PO2}';
    UPDATE public.purchase_orders SET total_cost = 200.00 WHERE id = '${PO3}';
    UPDATE public.purchase_orders SET total_cost = 100.00 WHERE id = '${PO4}';
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.vendors (id, name) VALUES ('${VENDOR}', '[POEB] Vendor');
    INSERT INTO public.vendor_bills (vendor_id, purchase_order_id, bill_number, bill_date, due_date, subtotal_cents, total_cents) VALUES
      ('${VENDOR}', '${PO1}', 'POEB-B1', CURRENT_DATE, CURRENT_DATE + 30, 100000, 100000),
      ('${VENDOR}', '${PO2}', 'POEB-B2', CURRENT_DATE, CURRENT_DATE + 30, 11000, 11000),
      ('${VENDOR}', '${PO3}', 'POEB-B3', CURRENT_DATE, CURRENT_DATE + 30, 10000, 10000);
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(total_cost_cents::text, ',' ORDER BY id) FROM public.purchase_orders WHERE id IN ('${PO1}','${PO2}','${PO3}','${PO4}');`),
    '100000,10000,20000,10000');

  // Before: Edit PO lowers L1B 40 -> 1 under the $1000 bill and saves (Taha's #2266 review, LOW).
  assert.equal(saved(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 1, 0]]), PO1), 'ok|61000');
  console.log('[before] Edit PO cutting 40 -> 1 left a $1000 bill on a $610 PO');

  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /PREFLIGHT_FAIL: save_purchase_order is not the 20261021140000 wrapper/, 're-apply must refuse');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');

  // Rule 1: Edit PO lowering a quantity.
  // 1. The same edit is refused; nothing saved.
  assert.equal(refused(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 1, 0]]), PO1), 'ok|PO_EDIT_BELOW_BILLED|100000');
  assert.equal(scalar(`SELECT quantity_ordered FROM public.purchase_order_items WHERE id = '${L1B}';`), '40');
  // 2. The 5% line to the cent: 36 left = $960 x 1.05 = $1008 covers $1000; 35 left = $950 x 1.05 = $997.50 does not.
  assert.equal(saved(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 36, 0]]), PO1), 'ok|96000');
  assert.equal(refused(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 35, 0]]), PO1), 'ok|PO_EDIT_BELOW_BILLED|100000');
  // 3. Leaving the unreceived line out of the edit deletes it: same rule.
  assert.equal(refused(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60]]), PO1), 'ok|PO_EDIT_BELOW_BILLED|100000');
  // 4. A sales rep may not lower the total of a PO with an active bill at all (Mason, 2026-11-24, Sol HIGH): the same
  //    refusal for a cut the 5% rule would refuse (40 -> 1) and one it would allow (40 -> 36), with no amounts anywhere.
  const repTry = (lines) => attempt(USERS.rep, `BEGIN ${asUser(`r := ${saveAs(USERS.rep, PO1, 'partially_received', lines)};`)} t := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS t2 = PG_EXCEPTION_DETAIL; t := SQLSTATE || '|' || SQLERRM || '|' || COALESCE(NULLIF(t2, ''), '<none>'); END; v := t;`);
  const repBig = repTry([[L1A, 60, 60], [L1B, 1, 0]]);
  const repSmall = repTry([[L1A, 60, 60], [L1B, 36, 0]]);
  assert.match(repBig, /^ok\|42501\|PO_EDIT_NEEDS_ADMIN: [^|]*\|<none>$/);
  assert.equal(repSmall, repBig, 'a rep cannot tell a small cut from a large one');
  assert.doesNotMatch(repBig.split('|').slice(2).join('|'), /\d|\$/, 'no amounts to a rep');
  assert.equal(scalar(`SELECT quantity_ordered FROM public.purchase_order_items WHERE id = '${L1B}';`), '40');
  // 4z. Any active bill counts, even a $0 one (Luna MED): a rep's cut on PO4 with a $0 bill is refused.
  assert.equal(attempt(USERS.rep, `SET LOCAL session_replication_role = replica;
    INSERT INTO public.vendor_bills (vendor_id, purchase_order_id, bill_number, bill_date, due_date, subtotal_cents, total_cents)
      VALUES ('${VENDOR}', '${PO4}', 'POEB-B0', CURRENT_DATE, CURRENT_DATE + 30, 0, 0);
    SET LOCAL session_replication_role = origin;
    ${refuse(`r := ${saveAs(USERS.rep, PO4, 'submitted', [[L4A, 1, 0]])};`)} v := split_part(t, ':', 1) || '|' || ${total(PO4)};`), 'ok|PO_EDIT_NEEDS_ADMIN|10000');
  // 4y. A mixed edit that keeps the total (L3A 10 -> 9, L3B 10 -> 11) is refused too: the outcome never depends on
  //     which line costs more (Sol HIGH). So is a rep's cut on a PO whose bill an admin voids in the same moment: the
  //     cut then saves with no amounts anywhere (the rep path never raises PO_EDIT_BELOW_BILLED).
  assert.equal(attempt(USERS.rep, `${refuse(`r := ${saveAs(USERS.rep, PO3, 'submitted', [[L3A, 9, 0], [L3B, 11, 0]])};`)} v := split_part(t, ':', 1) || '|' || ${total(PO3)};`), 'ok|PO_EDIT_NEEDS_ADMIN|20000');
  assert.equal(attempt(USERS.rep, `SET LOCAL session_replication_role = replica;
    UPDATE public.vendor_bills SET status = 'voided' WHERE purchase_order_id = '${PO1}'; SET LOCAL session_replication_role = origin;
    ${asUser(`r := ${saveAs(USERS.rep, PO1, 'partially_received', [[L1A, 60, 60], [L1B, 1, 0]])};`)} v := ${total(PO1)};`), 'ok|61000');
  // 4a. A rep may still raise it, and may cut a PO with no bills.
  assert.equal(saved(USERS.rep, saveAs(USERS.rep, PO1, 'partially_received', [[L1A, 60, 60], [L1B, 50, 0]]), PO1), 'ok|110000');
  assert.equal(saved(USERS.rep, saveAs(USERS.rep, PO4, 'submitted', [[L4A, 1, 0]]), PO4), 'ok|1000');
  // 4b. An admin's refusal carries the amounts in DETAIL.
  const detailOf = (uid, call) => attempt(uid, `BEGIN ${asUser(`r := ${call};`)} t := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS t2 = PG_EXCEPTION_DETAIL; t := COALESCE(NULLIF(t2, ''), '<none>'); END; v := t;`);
  assert.equal(detailOf(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 1, 0]])), 'ok|{"po_total_cents": 61000, "active_billed_cents": 100000}');
  // 5. Raising a quantity is never refused.
  assert.equal(saved(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 50, 0]]), PO1), 'ok|110000');
  console.log('[edit PO] 40 -> 1 refused; 36 allowed, 35 refused (5% to the cent); dropped line refused; rep cannot cut a line on a billed PO, even with a $0 bill or a total-neutral mixed edit (same refusal, no amounts), can raise it or cut an unbilled PO; admin DETAIL has amounts; raise allowed');

  // 6. A bill already over the whole order ($110 on $100): an edit that keeps the total (notes) still saves, a cut does not.
  assert.equal(saved(USERS.admin, save(PO2, 'submitted', [[L2A, 10, 0]], 'call vendor'), PO2), 'ok|10000');
  assert.equal(refused(USERS.admin, save(PO2, 'submitted', [[L2A, 9, 0]]), PO2), 'ok|PO_EDIT_BELOW_BILLED|10000');
  // 7. No bills: any cut saves. A voided bill does not count.
  assert.equal(saved(USERS.admin, save(PO4, 'submitted', [[L4A, 1, 0]]), PO4), 'ok|1000');
  assert.equal(attempt(USERS.admin, `SET LOCAL session_replication_role = replica;
    UPDATE public.vendor_bills SET status = 'voided' WHERE purchase_order_id = '${PO1}'; SET LOCAL session_replication_role = origin;
    ${asUser(`r := ${save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 1, 0]])};`)} v := ${total(PO1)};`), 'ok|61000');
  // 7b. Exactly 5% over is allowed, a cent past it is not: PO4 (10 gal, $100) with a $21 bill cut to 2 gal = $20 x 1.05 = $21.
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.vendor_bills (vendor_id, purchase_order_id, bill_number, bill_date, due_date, subtotal_cents, total_cents)
      VALUES ('${VENDOR}', '${PO4}', 'POEB-B4', CURRENT_DATE, CURRENT_DATE + 30, 2100, 2100); COMMIT;`);
  assert.equal(saved(USERS.admin, save(PO4, 'submitted', [[L4A, 2, 0]]), PO4), 'ok|2000');
  psql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE public.vendor_bills SET subtotal_cents = 2101, total_cents = 2101 WHERE bill_number = 'POEB-B4'; COMMIT;`);
  assert.equal(refused(USERS.admin, save(PO4, 'submitted', [[L4A, 2, 0]]), PO4), 'ok|PO_EDIT_BELOW_BILLED|10000');
  // 8. A replay of a saved edit returns the receipt and is not refused.
  //    The retry writes nothing: no second activity entry.
  const k = key();
  const keyed = () => save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 36, 0]]).replace(/'po-edit-bills-\d+'\)$/, `'${k}')`);
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${keyed()};`)} n := (SELECT count(*) FROM public.activity_feed);
    ${asUser(`r2 := ${keyed()};`)} v := (r = r2)::text || '|' || ${total(PO1)} || '|' || ((SELECT count(*) FROM public.activity_feed) = n)::text;`), 'ok|true|96000|true');
  console.log('[edit PO] over-billed PO: notes edit saves, cut refused; no bills / voided bill: cut saves; exactly 5% over saves, a cent more refused; replay not refused');

  // Rule 2: a bill that went over because a receipt was reversed does not block a cost correction. A receipt cannot
  // be reversed while an active bill is on the PO (RECEIVING_REVERSAL_BLOCKED_BY_VENDOR_BILL), so the real path is:
  // void the bill, reverse, enter the bill again (create_vendor_bill asks for a confirmed reason when it is over what
  // arrived). Here the bill is voided directly and entered again through create_vendor_bill.
  // PO3: two real receipts of 5 on L3A (arrived $100 = the $100 bill).
  for (const qty of [5, 5]) assert.match(receive(L3A, qty), /^ok\|/);
  assert.equal(received(L3A), '10');
  const records = scalar(`SELECT string_agg(id::text, ',' ORDER BY received_at, id) FROM public.receiving_records WHERE po_item_id = '${L3A}';`).split(',');
  assert.equal(records.length, 2);
  // Void the active bill, then (after the reversal) enter it again through the real create_vendor_bill RPC.
  let billNo = 'POEB-B3';
  const voidBill = () => psql(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE public.vendor_bills SET status = 'voided' WHERE bill_number = '${billNo}'; COMMIT;`);
  const reenterBill = (confirm) => {
    billNo = `${billNo}x`;
    return attempt(USERS.admin, `${asUser(`u := public.create_vendor_bill('${VENDOR}'::uuid, '${PO3}'::uuid, '${billNo}', CURRENT_DATE, CURRENT_DATE + 30, NULL, 10000, 0, NULL, '${key()}', ${confirm}, ${confirm ? "'receipt reversed, bill stands'" : 'NULL'});`)} v := u::text;`, { commit: true });
  };
  const reverse = (rec) => attempt(USERS.admin, `${asUser(`r := public.reverse_receiving_record('${rec}'::uuid, 'counted wrong', NULL, '${key()}');`)} v := r::text;`, { commit: true });
  // 9. Control: bill within what arrived, cutting L3A to $9 puts it over ($90 x 1.05 = $94.50 < $100): refused.
  assert.equal(costRefused(PO3, [{ id: L3A, unit_cost_cents: 900 }], 'vendor credit'), 'ok|PO_COST_BELOW_BILLED');
  assert.match(reverse(records[1]), /^P0001\|RECEIVING_REVERSAL_BLOCKED_BY_VENDOR_BILL/);
  // Reverse one receipt for real with the bill voided, then the bill is active again: 5 arrived ($50) under $100.
  voidBill();
  assert.match(reverse(records[1]), /^ok\|/);
  assert.equal(received(L3A), '5');
  // The $100 bill is now over what arrived ($50): re-entry needs a confirmed reason, and then saves.
  assert.match(reenterBill(false), /^22023\|PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED/);
  assert.match(reenterBill(true), /^ok\|[0-9a-f-]{36}$/);
  // 10. The same cut is now allowed: the bill was already over what arrived because of the reversal.
  assert.equal(costSaved(PO3, [{ id: L3A, unit_cost_cents: 900 }], 'vendor credit'), 'ok|1');
  // 11. The ordered-total rule still holds: L3A to $9 and L3B to $0 leaves a $90 order ($94.50 with 5%) under the bill.
  assert.equal(costRefused(PO3, [{ id: L3A, unit_cost_cents: 900 }, { id: L3B, unit_cost_cents: 0 }], 'vendor credit'), 'ok|PO_COST_BELOW_BILLED');
  // 12. Reverse the other receipt too: nothing arrived, judged on the ordered total ($150 x 1.05 covers $100): allowed.
  voidBill();
  assert.match(reverse(records[0]), /^ok\|/);
  assert.equal(received(L3A), '0');
  // Nothing arrived: judged on the ordered total ($190), so the $100 bill re-enters with no confirmation.
  assert.match(reenterBill(false), /^ok\|[0-9a-f-]{36}$/);
  assert.equal(costSaved(PO3, [{ id: L3A, unit_cost_cents: 500 }], 'vendor credit'), 'ok|1');
  console.log('[reversed receipt] within: cut refused; after a reversal put the bill over: same cut allowed; ordered-total rule still refuses; all reversed: judged on the order');

  console.log('\nPO_EDIT_BILLS_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
