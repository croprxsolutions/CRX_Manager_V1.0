#!/usr/bin/env node
/**
 * Real-schema proof for 20270223100000_po_cost_cut_judged_against_received.sql (KI-151; Mason 2026-11-22: corrections
 * are judged against what actually arrived, the KI-143 vendor-bill rule).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate (KI-197 included) in a
 * network-disabled PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), checks the candidate body is the KI-197
 * body with only the vendor-bill block changed, applies it (autocommit refused, POSTFLIGHT_OK, re-apply refused), then
 * as the signed-in admin checks cuts against what arrived. Every probe is rolled back.
 *
 * Run: node scripts/smoke/prove-po-cost-cut-received-real-schema.mjs   (needs Docker; never touches live)
 * Prints PO_COST_CUT_RECEIVED_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, id, USERS, ROOT, NAME, docker, psql, scalar, claims } from './undo-paths/harness.mjs';

const CANDIDATE = '20270223100000_po_cost_cut_judged_against_received.sql';
const MIG = path.join(ROOT, 'supabase', 'migrations');
const candidate = readFileSync(path.join(MIG, CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
const [PROD, VENDOR] = ['b1', 'b2'].map(id);
const [PO1, PO2, PO3, PO4] = ['c1', 'c2', 'c3', 'c4'].map(id);
const [LA, LB, LC, LD, LE, LF] = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map(id);
let n = 0;
const setCosts = (po, items, reason = null) =>
  `public.set_purchase_order_item_costs('${po}'::uuid, '${JSON.stringify(items)}'::jsonb, ${reason === null ? 'NULL' : `'${reason}'`}, NULL, 'ki151-${(n += 1)}')`;
const cents = (line) => `(SELECT unit_cost_cents FROM public.purchase_order_items WHERE id = '${line}')`;
const saved = (po, items, reason) => attempt(USERS.admin, `${asUser(`r := ${setCosts(po, items, reason)};`)} v := r->>'lines_changed';`);
const refused = (po, items, reason, line) =>
  attempt(USERS.admin, `${refuse(`r := ${setCosts(po, items, reason)};`)} v := split_part(t, ':', 1) || '|' || ${cents(line)};`);

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  // PO1 partly received: LA 10 ordered @ $10.00, 8 arrived; LB 5 ordered @ $20.00, none arrived. Ordered $200, arrived
  // $80, active bill $80. PO2 nothing arrived: LC 10 @ $10.00, early bill $100. PO3 billed in full up front, then partly
  // received: LD 10 @ $10.00, 5 arrived; LE 10 @ $10.00, none arrived. Ordered $200, arrived $50, bill $200. PO4 bill
  // confirmed over the order before anything arrived: LF 10 @ $10.00, bill $110.
  psql(`BEGIN; ${claims(USERS.admin)}
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, inventory_unit, is_active)
      VALUES ('${PROD}', '[KI151] Chem', 'gal', 10.00, 15.00, 'liquid', 'Gal', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.purchase_orders (id, po_number, vendor, status, submitted_date, created_by) VALUES
      ('${PO1}', 'KI151-PO-1', '[KI151] Vendor', 'submitted', CURRENT_DATE - 2, '${USERS.admin}'),
      ('${PO2}', 'KI151-PO-2', '[KI151] Vendor', 'submitted', CURRENT_DATE - 1, '${USERS.admin}'),
      ('${PO3}', 'KI151-PO-3', '[KI151] Vendor', 'submitted', CURRENT_DATE - 1, '${USERS.admin}'),
      ('${PO4}', 'KI151-PO-4', '[KI151] Vendor', 'submitted', CURRENT_DATE - 1, '${USERS.admin}');
    INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, quantity_ordered, unit_cost, quantity_received, unit_size, product_name) VALUES
      ('${LA}', '${PO1}', '${PROD}', 10, 10.00, 8, 'gal', '[KI151] Chem'),
      ('${LB}', '${PO1}', '${PROD}', 5, 20.00, 0, 'gal', '[KI151] Chem'),
      ('${LC}', '${PO2}', '${PROD}', 10, 10.00, 0, 'gal', '[KI151] Chem'),
      ('${LD}', '${PO3}', '${PROD}', 10, 10.00, 5, 'gal', '[KI151] Chem'),
      ('${LE}', '${PO3}', '${PROD}', 10, 10.00, 0, 'gal', '[KI151] Chem'),
      ('${LF}', '${PO4}', '${PROD}', 10, 10.00, 0, 'gal', '[KI151] Chem');
    UPDATE public.purchase_orders SET total_cost = 200.00, status = 'partially_received' WHERE id = '${PO1}';
    UPDATE public.purchase_orders SET total_cost = 100.00 WHERE id = '${PO2}';
    UPDATE public.purchase_orders SET total_cost = 200.00, status = 'partially_received' WHERE id = '${PO3}';
    UPDATE public.purchase_orders SET total_cost = 100.00 WHERE id = '${PO4}';
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.vendors (id, name) VALUES ('${VENDOR}', '[KI151] Vendor');
    INSERT INTO public.vendor_bills (vendor_id, purchase_order_id, bill_number, bill_date, due_date, subtotal_cents, total_cents) VALUES
      ('${VENDOR}', '${PO1}', 'KI151-B1', CURRENT_DATE, CURRENT_DATE + 30, 8000, 8000),
      ('${VENDOR}', '${PO2}', 'KI151-B2', CURRENT_DATE, CURRENT_DATE + 30, 10000, 10000),
      ('${VENDOR}', '${PO3}', 'KI151-B3', CURRENT_DATE, CURRENT_DATE + 30, 20000, 20000),
      ('${VENDOR}', '${PO4}', 'KI151-B4', CURRENT_DATE, CURRENT_DATE + 30, 11000, 11000);
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(status || ':' || total_cost_cents, ',' ORDER BY id) FROM public.purchase_orders WHERE id IN ('${PO1}','${PO2}','${PO3}','${PO4}');`),
    'partially_received:20000,submitted:10000,partially_received:20000,submitted:10000');

  // Before: the old rule (ordered total) lets a received line's cost drop below what was billed for it.
  assert.equal(saved(PO1, [{ id: LA, unit_cost_cents: 700 }], 'vendor credit'), 'ok|1', 'old rule allowed the cut');
  console.log('[before] cutting the received line to $7.00 (arrived $56, billed $80) was allowed');

  // The candidate body = the KI-197 body with only the vendor-bill block changed.
  const oldFile = readFileSync(path.join(MIG, '20270217120000_po_cost_expected_cost_check.sql'), 'utf8').replaceAll('\r\n', '\n');
  const fnOf = (text) => {
    const a = text.indexOf('CREATE OR REPLACE FUNCTION public.set_purchase_order_item_costs(');
    return text.slice(a, text.indexOf('$function$;', a)).split('\n');
  };
  const oldLines = fnOf(oldFile);
  const newLines = fnOf(candidate);
  const removed = oldLines.filter((l) => !newLines.includes(l)).filter((l) => l.trim());
  const added = newLines.filter((l) => !oldLines.includes(l)).filter((l) => l.trim());
  assert.ok(removed.every((l) => /vendor-bill control|bill is created|LOWERS the total|PO row lock above|v_new_total < v_old_total|PO_COST_BELOW_BILLED|DETAIL = jsonb_build_object\('po_total_cents', v_new_total, 'active/.test(l)),
    `unexpected removed lines:\n${removed.join('\n')}`);
  assert.ok(added.every((l) => /KI-151|KI-143|v_received|v_old_limit|v_new_limit|poi\.|LOWERS that limit|ordered total before|PO row lock above|PO_COST_BELOW_BILLED|DETAIL|limit_cents|USING ERRCODE|INTO v_received|THIS cut|v_billed|v_new_total|ordered total, so|billed up front|Sol, 2026-11-22/.test(l)),
    `unexpected added lines:\n${added.join('\n')}`);
  // Order and duplicates too: the kept lines must be the old body's kept lines, in order (Sol LOW).
  const kept = (lines, drop) => lines.filter((l) => !drop.includes(l) || !l.trim());
  assert.deepEqual(kept(newLines, added), kept(oldLines, removed), 'kept lines moved or duplicated');
  console.log(`[body] KI-197 body with ${removed.length} lines replaced by ${added.length}`);

  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /PREFLIGHT_FAIL: set_purchase_order_item_costs is not the KI-197 body/, 're-apply must refuse');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');

  // 1. The same cut is now refused: what arrived ($56) is more than 5% under the bill ($80). Nothing saved.
  assert.equal(refused(PO1, [{ id: LA, unit_cost_cents: 700 }], 'vendor credit', LA), 'ok|PO_COST_BELOW_BILLED|1000');
  assert.match(attempt(USERS.admin, `${refuse(`r := ${setCosts(PO1, [{ id: LA, unit_cost_cents: 700 }], 'vendor credit')};`)} v := t;`),
    /what arrived on the purchase order/);
  // 2. A cut that keeps what arrived within 5% of the bill is allowed: 8 x $9.60 = $76.80; $80 <= $80.64.
  assert.equal(saved(PO1, [{ id: LA, unit_cost_cents: 960 }], 'vendor credit'), 'ok|1');
  // 3. Cutting the line that has not arrived does not change what arrived: allowed, even to $0.
  assert.equal(saved(PO1, [{ id: LB, unit_cost_cents: 0 }]), 'ok|1');
  // 4. A received line cut to $0 leaves nothing arrived to bill against: refused.
  assert.equal(refused(PO1, [{ id: LA, unit_cost_cents: 0 }], 'free goods', LA), 'ok|PO_COST_BELOW_BILLED|1000');
  // 5. Raising a cost is never refused.
  assert.equal(saved(PO1, [{ id: LA, unit_cost_cents: 1200 }], 'price up'), 'ok|1');
  // 5a. One call that cuts the received line and raises the one still to come: the ordered total goes up, but what
  //     arrived drops from $80 to $56 under the $80 bill. Refused (security review LOW 3).
  assert.equal(refused(PO1, [{ id: LA, unit_cost_cents: 700 }, { id: LB, unit_cost_cents: 3000 }], 'vendor credit', LA), 'ok|PO_COST_BELOW_BILLED|1000');
  console.log('[received] cut below what arrived refused; within 5% allowed; unreceived line free; $0 refused; raise allowed');

  // 6. Nothing arrived yet: judged against the ordered total, as before (bill $100).
  assert.equal(refused(PO2, [{ id: LC, unit_cost_cents: 900 }], null, LC), 'ok|PO_COST_BELOW_BILLED|1000');
  assert.equal(saved(PO2, [{ id: LC, unit_cost_cents: 960 }]), 'ok|1');
  // 6a. The 5% line to the cent: $95.30 total x 1.05 = $100.065 covers the $100 bill; $95.20 x 1.05 = $99.96 does not.
  assert.equal(saved(PO2, [{ id: LC, unit_cost_cents: 953 }]), 'ok|1');
  assert.equal(refused(PO2, [{ id: LC, unit_cost_cents: 952 }], null, LC), 'ok|PO_COST_BELOW_BILLED|1000');
  console.log('[early bill] nothing arrived: ordered total rule unchanged ($90 refused, $96 allowed)');

  // 7. Billed in full up front, half arrived: cutting the line still to come to $0 would leave the $200 bill over the
  //    $100 that can ever arrive. Refused (the ordered-total line; Sol RLS review H1).
  assert.equal(refused(PO3, [{ id: LE, unit_cost_cents: 0 }], null, LE), 'ok|PO_COST_BELOW_BILLED|1000');
  // 8. Same PO: the bill is already over what arrived ($50), so a 1-cent fix to the received line is not what puts it
  //    over; allowed (Mason, 2026-11-22: refuse only when THIS cut creates the overage).
  assert.equal(saved(PO3, [{ id: LD, unit_cost_cents: 999 }], 'typo'), 'ok|1');
  // 8a. A bill confirmed over the whole order ($110 on $100, nothing arrived): a cut can never make it worse (Sol HIGH).
  assert.equal(refused(PO4, [{ id: LF, unit_cost_cents: 0 }], null, LF), 'ok|PO_COST_BELOW_BILLED|1000');
  console.log('[billed up front] cut that leaves the bill over the whole order refused; 1-cent fix while goods still coming allowed');

  // 9. A voided bill does not count.
  assert.equal(attempt(USERS.admin, `SET LOCAL session_replication_role = replica;
    UPDATE public.vendor_bills SET status = 'voided' WHERE purchase_order_id = '${PO1}'; SET LOCAL session_replication_role = origin;
    ${asUser(`r := ${setCosts(PO1, [{ id: LA, unit_cost_cents: 0 }], 'free goods')};`)} v := r->>'lines_changed';`), 'ok|1');
  // 10. Non-admins still refused; a stale screen (KI-197) still refused.
  assert.match(attempt(USERS.rep, `${refuse(`r := ${setCosts(PO1, [{ id: LA, unit_cost_cents: 960 }], 'x')};`)} v := t;`), /admin/i);
  assert.equal(attempt(USERS.admin, `${refuse(`r := ${setCosts(PO1, [{ id: LA, unit_cost_cents: 960, expected_unit_cost_cents: 999, expected_product_id: PROD }], 'x')};`)} v := split_part(t, ':', 1);`),
    'ok|PO_COST_CHANGED_SINCE_LOADED');
  console.log('[controls] voided bill ignored; rep refused; stale screen refused');

  const smoke = docker([...PSQL], { input: readFileSync(path.join(ROOT, 'scripts', 'smoke', 'smoke-po-cost-expected-cost.sql'), 'utf8'), allowFailure: true });
  assert.match(smoke.stderr, /SMOKE_PASS_ROLLBACK/, `smoke chain failed:\n${smoke.stderr}`);
  console.log('[smoke] smoke-po-cost-expected-cost.sql -> SMOKE_PASS_ROLLBACK');

  console.log('\nPO_COST_CUT_RECEIVED_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
