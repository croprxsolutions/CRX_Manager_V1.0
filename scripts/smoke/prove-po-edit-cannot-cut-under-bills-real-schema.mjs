#!/usr/bin/env node
/**
 * Real-schema proof for 20270302180000_po_edit_cannot_cut_under_bills.sql (Mason, 2026-11-24: once a PO has an
 * active vendor bill, Edit PO cannot change its lines, for anyone; the extra cost-cut rules were dropped).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), shows the Edit PO gap, applies the candidate (autocommit
 * refused, POSTFLIGHT_OK, re-apply refused), then checks Edit PO saves on billed and unbilled POs. Every probe is
 * rolled back.
 *
 * Run: node scripts/smoke/prove-po-edit-cannot-cut-under-bills-real-schema.mjs   (needs Docker; never touches live)
 * Prints PO_EDIT_BILLS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, id, USERS, ROOT, NAME, docker, psql, scalar, claims } from './undo-paths/harness.mjs';

const CANDIDATE = '20270302180000_po_edit_cannot_cut_under_bills.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
const [PROD, VENDOR] = ['e1', 'e2'].map(id);
const [PO1, PO2, PO3, PO4] = ['f1', 'f2', 'f3', 'f4'].map(id);
const [L1A, L1B, L2A, L3A, L3B, L4A] = ['91', '92', '93', '94', '95', '96'].map(id);
let n = 0;
const key = () => `po-edit-bills-${(n += 1)}`;

// Edit PO as the admin screen sends it ($10.00 lines; a rep's cost keys are stripped by the wrapper).
// lines: [[id or null for a new line, qty_ordered, qty_received, unit cost cents = 1000]].
const save = (po, status, lines, notes = null) => `public.save_purchase_order('${po}'::uuid, '${JSON.stringify({
  vendor: '[POEB] Vendor', status, submitted_date: null, expected_delivery_date: null, notes,
})}'::jsonb, '${JSON.stringify(lines.map(([lid, q, rcv, cents = 1000]) => ({
  ...(lid ? { id: lid } : {}), product_id: PROD, product_name: '[POEB] Chem', unit_size: 'Gal', quantity_ordered: q, quantity_received: rcv, unit_cost: cents / 100, unit_cost_cents: cents,
})))}'::jsonb, '${USERS.admin}'::uuid, '${key()}')`;
const saveAs = (uid, po, status, lines, notes) => save(po, status, lines, notes).replace(`'${USERS.admin}'::uuid`, `'${uid}'::uuid`);
const total = (po) => `(SELECT total_cost_cents FROM public.purchase_orders WHERE id = '${po}')`;
const saved = (uid, call, po) => attempt(uid, `${asUser(`r := ${call};`)} v := ${total(po)};`);
const refused = (uid, call, po) => attempt(uid, `${refuse(`r := ${call};`)} v := split_part(t, ':', 1) || '|' || ${total(po)};`);

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  // PO1 (Taha's #2266 example): L1A 60 @ $10 all arrived, L1B 40 @ $10 none. Ordered $1000, bill $1000 up front.
  // PO2 a bill confirmed over the whole order: L2A 10 @ $10, bill $110. PO3 a part bill: L3A 10 @ $10,
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

  // Rule 1 (Mason, 2026-11-24, one rule for everyone): once a PO has an active vendor bill, Edit PO cannot change its
  // lines, for admin or rep; header edits still save. Every refusal is the same message with no amount.
  const LOCKED = 'ok|PO_BILLED_LINES_LOCKED';
  // 1. Lower a quantity (40 -> 1 and 40 -> 39), drop a line, raise a quantity, add a line, change a cost: all refused.
  assert.equal(refused(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 1, 0]]), PO1), `${LOCKED}|100000`);
  assert.equal(refused(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 39, 0]]), PO1), `${LOCKED}|100000`);
  assert.equal(refused(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60]]), PO1), `${LOCKED}|100000`);
  assert.equal(refused(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 50, 0]]), PO1), `${LOCKED}|100000`);
  assert.equal(refused(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 0], [null, 5, 0]]), PO1), `${LOCKED}|100000`);
  assert.equal(refused(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 0, 900]]), PO1), `${LOCKED}|100000`);
  assert.equal(scalar(`SELECT quantity_ordered FROM public.purchase_order_items WHERE id = '${L1B}';`), '40');
  // 2. A rep gets the same refusal for a small and a large cut and a total-neutral mixed edit, and so does an admin:
  //    one message, no amount, no DETAIL.
  const msgOf = (uid, call) => attempt(uid, `BEGIN ${asUser(`r := ${call};`)} t := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS t2 = PG_EXCEPTION_DETAIL; t := SQLSTATE || '|' || SQLERRM || '|' || COALESCE(NULLIF(t2, ''), '<none>'); END; v := t;`);
  const repBig = msgOf(USERS.rep, saveAs(USERS.rep, PO1, 'partially_received', [[L1A, 60, 60], [L1B, 1, 0]]));
  assert.match(repBig, /^ok\|22023\|PO_BILLED_LINES_LOCKED: [^|]*\|<none>$/);
  assert.equal(msgOf(USERS.rep, saveAs(USERS.rep, PO1, 'partially_received', [[L1A, 60, 60], [L1B, 39, 0]])), repBig);
  assert.equal(msgOf(USERS.rep, saveAs(USERS.rep, PO3, 'submitted', [[L3A, 9, 0], [L3B, 11, 0]])), repBig);
  assert.equal(msgOf(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 1, 0]])), repBig);
  assert.doesNotMatch(repBig.split('|').slice(2).join('|'), /\d|\$/, 'no amounts');
  // 3. Notes-only edits save, for admin and rep, on a billed PO and on one billed over its whole order ($110 on $100).
  assert.equal(saved(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 0]], 'admin note'), PO1), 'ok|100000');
  assert.equal(saved(USERS.rep, saveAs(USERS.rep, PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 0]], 'rep note'), PO1), 'ok|100000');
  assert.equal(saved(USERS.admin, save(PO2, 'submitted', [[L2A, 10, 0]], 'call vendor'), PO2), 'ok|10000');
  assert.equal(refused(USERS.admin, save(PO2, 'submitted', [[L2A, 9, 0]]), PO2), `${LOCKED}|10000`);
  // 4. Any active bill counts, even $0; no bill or a voided bill locks nothing.
  assert.equal(attempt(USERS.rep, `SET LOCAL session_replication_role = replica;
    INSERT INTO public.vendor_bills (vendor_id, purchase_order_id, bill_number, bill_date, due_date, subtotal_cents, total_cents)
      VALUES ('${VENDOR}', '${PO4}', 'POEB-B0', CURRENT_DATE, CURRENT_DATE + 30, 0, 0);
    SET LOCAL session_replication_role = origin;
    ${refuse(`r := ${saveAs(USERS.rep, PO4, 'submitted', [[L4A, 1, 0]])};`)} v := split_part(t, ':', 1) || '|' || ${total(PO4)};`), `${LOCKED}|10000`);
  assert.equal(saved(USERS.rep, saveAs(USERS.rep, PO4, 'submitted', [[L4A, 1, 0]]), PO4), 'ok|1000');
  assert.equal(saved(USERS.admin, save(PO4, 'submitted', [[L4A, 1, 0]]), PO4), 'ok|1000');
  for (const uid of [USERS.admin, USERS.rep]) {
    assert.equal(attempt(uid, `SET LOCAL session_replication_role = replica;
      UPDATE public.vendor_bills SET status = 'voided' WHERE purchase_order_id = '${PO1}'; SET LOCAL session_replication_role = origin;
      ${asUser(`r := ${saveAs(uid, PO1, 'partially_received', [[L1A, 60, 60], [L1B, 1, 0]])};`)} v := ${total(PO1)};`), 'ok|61000');
  }
  // 4b. Any change counts, however small, and line notes count; a resent catalog name is not a change (the stored
  // name is kept); a received quantity sent in the edit changes nothing (receipts are the only writer).
  assert.equal(refused(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40.000001, 0]]), PO1), `${LOCKED}|100000`);
  // Sol round 4 HIGH: an admin's header-only save that spells a line id in capitals keeps the line's cost and total.
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 0]], 'admin note').replace(`"id":"${L1B}"`, `"id":"${L1B.toUpperCase()}"`)};`)}
    v := ${total(PO1)} || '|' || (SELECT unit_cost_cents FROM public.purchase_order_items WHERE id = '${L1B}');`), 'ok|100000|1000');
  // Sol round 4 MED: a stored null unit sent back as '' saves the stored null, not ''.
  assert.equal(attempt(USERS.admin, `SET LOCAL session_replication_role = replica;
    UPDATE public.purchase_order_items SET unit_size = NULL WHERE id = '${L2A}'; SET LOCAL session_replication_role = origin;
    ${asUser(`r := ${save(PO2, 'submitted', [[L2A, 10, 0]], 'call vendor').replace('"unit_size":"Gal"', '"unit_size":""')};`)}
    v := COALESCE((SELECT unit_size FROM public.purchase_order_items WHERE id = '${L2A}'), '<null>');`), 'ok|<null>');
  // Sol round 4 MED: a billed-PO save outside READ COMMITTED is refused (it could miss a bill committed while it waited).
  const rr = psql(`BEGIN ISOLATION LEVEL REPEATABLE READ;
${claims(USERS.admin)}
SET LOCAL ROLE authenticated;
    SELECT ${save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 0]], 'rr note')};
ROLLBACK;`, { allowFailure: true });
  assert.match(rr.stderr, /PO_SAVE_READ_COMMITTED_REQUIRED/);
  assert.equal(refused(USERS.admin, save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 0]]).replace('"unit_size":"Gal"', '"unit_size":"Gal","notes":"deliver to barn"'), PO1), `${LOCKED}|100000`);
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 0]]).replace('[POEB] Chem', '[POEB] Renamed')};`)}
    v := (SELECT string_agg(DISTINCT product_name, ',') FROM public.purchase_order_items WHERE purchase_order_id = '${PO1}');`), 'ok|[POEB] Chem');
  assert.equal(attempt(USERS.admin, `${refuse(`r := ${save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 5]])};`)}
    v := COALESCE(split_part(t, ':', 1), '') || '|' || (SELECT quantity_received FROM public.purchase_order_items WHERE id = '${L1B}');`),
    'ok|NOT REFUSED|0');
  // The real Edit PO screen sends a blank unit as null: a stored blank or null unit is not a change.
  for (const stored of ['NULL', "''"]) {
    assert.equal(attempt(USERS.admin, `SET LOCAL session_replication_role = replica;
      UPDATE public.purchase_order_items SET unit_size = ${stored} WHERE id = '${L2A}'; SET LOCAL session_replication_role = origin;
      ${asUser(`r := ${save(PO2, 'submitted', [[L2A, 10, 0]], 'call vendor').replace('"unit_size":"Gal"', '"unit_size":null')};`)} v := ${total(PO2)};`), 'ok|10000');
  }
  // Luna: a save that leaves line notes out keeps the stored notes on a billed PO.
  assert.equal(attempt(USERS.admin, `SET LOCAL session_replication_role = replica;
    UPDATE public.purchase_order_items SET notes = 'deliver to barn' WHERE id = '${L1B}'; SET LOCAL session_replication_role = origin;
    ${asUser(`r := ${save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 0]], 'admin note')};`)}
    v := (SELECT notes FROM public.purchase_order_items WHERE id = '${L1B}');`), 'ok|deliver to barn');
  // 4c. Sol round 3 HIGH: a rep's huge quantity on a billed PO is refused before any arithmetic, with the same text
  // as every other refusal (no overflow error that would depend on the hidden cost).
  assert.equal(msgOf(USERS.rep, saveAs(USERS.rep, PO1, 'partially_received', [[L1A, 60, 60], [L1B, 10000000000000000, 0]])), repBig);
  // 4d. Sol round 3 HIGH: the same line twice (two spellings of its id) is refused, and nothing (cost log, cost
  // confirmation) is written: an admin's $9 then $10 on one line.
  const dup = save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 0, 900], [L1B, 40, 0]]).replace(`"id":"${L1B}"`, `"id":"${L1B.toUpperCase()}"`);
  assert.equal(attempt(USERS.admin, `n := (SELECT count(*) FROM public.purchase_order_item_cost_changes);
    ${refuse(`r := ${dup};`)} v := split_part(t, ':', 1) || '|' || ((SELECT count(*) FROM public.purchase_order_item_cost_changes) = n)::text;`), `${LOCKED}|true`);
  // 4e. An admin's notes edit on a billed PO writes no cost log either (costs are left out of a billed PO's lines).
  assert.equal(attempt(USERS.admin, `n := (SELECT count(*) FROM public.purchase_order_item_cost_changes);
    ${asUser(`r := ${save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 0]], 'admin note')};`)}
    v := ((SELECT count(*) FROM public.purchase_order_item_cost_changes) = n)::text;`), 'ok|true');
  console.log('[edit PO] billed PO: every line change refused before saving, for admin and rep (cut, raise, add, drop, cost, mixed, tiny, line notes, huge, duplicate id), same text, no amounts, no side effects; notes edits save; $0 bill counts; no bill / voided bill: edits save');
  // 5. A replay of a saved notes edit returns the receipt, is not refused, and writes no second activity entry.
  const k = key();
  const keyed = () => save(PO1, 'partially_received', [[L1A, 60, 60], [L1B, 40, 0]], 'replayed').replace(/'po-edit-bills-\d+'\)$/, `'${k}')`);
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${keyed()};`)} n := (SELECT count(*) FROM public.activity_feed);
    ${asUser(`r2 := ${keyed()};`)} v := (r = r2)::text || '|' || ${total(PO1)} || '|' || ((SELECT count(*) FROM public.activity_feed) = n)::text;`), 'ok|true|100000|true');
  console.log('[edit PO] replay not refused, no second activity entry');


  console.log('\nPO_EDIT_BILLS_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
