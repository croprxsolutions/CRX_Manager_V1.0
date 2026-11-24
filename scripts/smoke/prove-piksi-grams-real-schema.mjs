#!/usr/bin/env node
/**
 * Real-schema proof for KI-114 / #1958 (20270228230000_piksi_mg_to_grams.sql): Piksi Dust is relabelled MG -> g with
 * no number changed. Builds the production baseline plus every migration before the candidate in Docker (no network;
 * the image may be pulled once), seeds live's Piksi rows (ids, units and quantities as read 2026-11-22) and a control
 * product, then proves the contract's cases (docs/plans/2026-11-22-ki114-piksi-grams-CONTRACT.md):
 *   B1 the bug: an 18 g rate on MG stock prices 1000x; P1 drift / P2 open count refuse with nothing changed;
 *   M1 apply: every pinned row says g, no number moved, one open cost basis per product at the same cents, guards on;
 *   A1 18 g on g stock prices today's per-acre price; A2 receiving the open PO line adds 9,000 g; A3 a new MG line is
 *   refused and a blank one becomes g; M2 a second run refuses; M3 the rate lock still refuses an app admin; R1 the
 *   reverse script restores every label with versions moving forward, and the forward then refuses.
 *
 * Run: node scripts/smoke/prove-piksi-grams-real-schema.mjs   (needs Docker)
 * Prints PIKSI_GRAMS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

process.env.UNDO_PATHS_CONTAINER ||= `crx-piksi-g-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, psql, scalar, attempt, asUser, refuse, USERS, ROOT } = await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270228230000_piksi_mg_to_grams.sql';
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const lf = (f) => readFileSync(f, 'utf8').replaceAll('\r\n', '\n');
// Both directions pin live's 13 Piksi stock movements by id; this fixture seeds none, so pin the empty set (md5 of '').
const LIVE_MOVEMENTS_PIN = "c_movements_md5 constant text := '55f9f30a1ab11f683093743f27168fd2';";
const EMPTY_MOVEMENTS_PIN = "c_movements_md5 constant text := 'd41d8cd98f00b204e9800998ecf8427e';";
const FORWARD_LIVE = lf(path.join(MIGRATIONS, CANDIDATE));
assert.ok(FORWARD_LIVE.includes(LIVE_MOVEMENTS_PIN), 'forward still pins the live movement set');
const LIVE_COUNTS_PIN = "c_counts_md5 constant text := 'b1a5558d9e8b96a22839a02f99137226';";
const EMPTY_COUNTS_PIN = "c_counts_md5 constant text := 'd41d8cd98f00b204e9800998ecf8427e';";
assert.ok(FORWARD_LIVE.includes(LIVE_COUNTS_PIN), 'forward still pins the live cycle-count set');
const FORWARD = FORWARD_LIVE.replace(LIVE_MOVEMENTS_PIN, EMPTY_MOVEMENTS_PIN).replace(LIVE_COUNTS_PIN, EMPTY_COUNTS_PIN);
const REVERSE_LIVE = lf(path.join(ROOT, 'scripts', 'smoke', 'piksi-grams-reverse.sql'));
assert.ok(REVERSE_LIVE.includes(LIVE_MOVEMENTS_PIN), 'reverse still pins the live movement set');
assert.ok(REVERSE_LIVE.includes(LIVE_COUNTS_PIN), 'reverse still pins the live cycle-count set');
const REVERSE = REVERSE_LIVE.replace(LIVE_MOVEMENTS_PIN, EMPTY_MOVEMENTS_PIN).replace(LIVE_COUNTS_PIN, EMPTY_COUNTS_PIN);
const SWEEP = lf(path.join(ROOT, 'scripts', 'smoke', 'piksi-grams-sweep.sql')).replace(/--[^\n]*\n/g, '').trim().replace(/;$/, '');
const ADMIN = USERS.admin;
const raw = (sql) => psql(`SET session_replication_role = replica; ${sql} SET session_replication_role = origin;`, { user: 'supabase_admin' });
/** Runs SQL in one transaction (committed or rolled back) as postgres with every trigger on. */
const tx = (sql, commit) => {
  const r = psql(`BEGIN;\n${sql}\n${commit ? 'COMMIT' : 'ROLLBACK'};`, { allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
};

const PLUS = '36732b8d-b4ed-4643-8a13-d793975d13c7', INF = 'c22ce37d-cb11-4145-be9a-5469e453bca1', OLD = '9a1716a2-8ac3-42e6-887b-64795fca3a57';
const P_PLUS = 'afdae5f9-3410-4f17-975b-07a1650089ae', P_INF = 'c9933638-612a-407a-a4a8-6422b5e38c9c';
const fx = (s) => `b9140000-0000-4000-8000-${String(s).padStart(12, '0')}`;
const CUST = fx('c1'), CTRL = fx('d1'), CTRL_INV = fx('d2'), CTRL_OI = fx('d3');
const O_A = 'c34e4901-66ad-4f77-b952-015cf7072caa', O_B = '97bf6b05-1653-4b61-b1a9-322f9f2a44a7', O_C = '002579ab-feb7-4a47-93c5-4c83251e160e';
const PO = '88126b10-cf90-483f-aedc-46b59603ee07', PO_OPEN = '4664da15-393f-4381-b36c-852a4f2199e2';
const INV = { plus: '40224943-7238-4504-ae72-1dbc0ad0bdf6', inf: '6a758cb1-b1d9-4458-bdcc-944dfdc465d7' };
const OI = { a: '69766da1-a9bf-4fc6-90c0-f9ced47556bc', b: 'c12acb4c-45ec-424e-bb13-9566ea3c73f9', c: 'c8fd3a29-e44b-4ba5-9318-b574845d69a4', inf: 'c87bc85e-9751-4bac-90f3-94ebe0a2c168' };
// Live's deliveries [id, status, order]; delivery lines [id, product, unit, quantity, delivery, order line].
const DEL = { d1: ['8e943c48-045e-43d9-abe0-3251d71a7e12', 'in_progress', O_B], d2: ['f66fac69-654b-4288-bca9-c8cad645ba5c', 'cancelled', O_C],
  d3: ['4669ebce-cec6-4d30-b7f4-38eb35c0e61e', 'cancelled', O_C], d4: ['f21ab0e6-9234-4592-829c-9bdd96b47bfa', 'completed', O_C],
  d5: ['2dadcc17-3e24-41b0-a1a2-0b576c607a71', 'completed', O_A] };
const DI = [
  ['d33b3ba5-8c72-49e5-81a1-6a60a5507c93', PLUS, 'MG', 27000, 'd1', OI.b],
  ['4cb70b28-7b6f-48f3-a5b0-268a908aac0b', PLUS, 'Dry oz', 21600, 'd2', OI.c],
  ['ee67433f-698b-49fc-ac17-bd12fd926c89', PLUS, 'Dry oz', 21600, 'd3', OI.c],
  ['d1a6127d-b3d6-431e-a4ce-a78b23402812', PLUS, 'Dry oz', 21600, 'd4', OI.c],
  ['f2402811-20b8-4be8-b9a3-c2f10a6995fd', PLUS, 'Dry oz', 10800, 'd5', OI.a],
  ['5bfae54e-79cf-43b6-b4bc-3795031b297e', INF, 'MG', 5250, 'd4', OI.inf],
  ['74b0c82b-171a-4fa1-8d67-258eece1d150', INF, 'MG', 5250, 'd2', OI.inf],
  ['781b3324-d70a-407d-b0b8-6c06198befaa', INF, 'MG', 5250, 'd3', OI.inf],
];
const POI = { open: '59a5c466-7e4a-46d8-a65c-55cd8397d52c', plusDone: '74b7f457-b4ef-462a-a3a2-0a125a98392f', infDone: 'd76d553c-4a29-490a-9a61-0382eb46941a' };
const RR = [['b79cca8f-6c7e-4f8b-a590-d4906cd13c6e', POI.plusDone, PLUS, 40500], ['e2575bc7-88d4-4a05-8637-4ec96de53238', POI.plusDone, PLUS, 4500],
  ['253d018e-e0a8-4999-a3fc-428b52ea993f', POI.infDone, INF, 11250]];
const PRODUCTS = `'${PLUS}', '${INF}', '${OLD}'`;

function seed() {
  raw(`INSERT INTO public.product_rate_lock (id, is_locked) VALUES (true, true) ON CONFLICT (id) DO UPDATE SET is_locked = true;
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Piksi Farm', true);
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, container_unit, container_size,
        container_type, rate_per_acre, suggested_rate, current_cost, tier1_price, tier2_price, tier3_price, tier1_price_per_acre,
        tier2_price_per_acre, tier3_price_per_acre, pricing_version, is_active) VALUES
      ('${PLUS}', 'Piksi Dust Plus - 1800G Jar', 'P-PLUS', 'dry', 'MG', 'MG', 'MG', 'MG', 1800, 'Jar', 18, '18 grams per Acre', 0.50, 1.00, 1.00, 1.10, 18.00, 18.00, 19.80, 1, true),
      ('${INF}', 'Piksi Dust Inffurow - 750 G Jar', 'P-INF', 'dry', 'MG', 'MG', 'MG', 'MG', 750, 'Jar', 6, '1.5 gram per G', 0.60, 2.00, 2.00, 2.20, 12.00, 12.00, 13.20, 1, true),
      ('${OLD}', 'Piksi Dust Plus', 'P-OLD', 'dry', 'MG', 'MG', 'MG', 'MG', 1800, 'Jar', 18, '18 MG', 0.50, 1.00, 1.00, 1.10, 18.00, 18.00, 19.80, 1, false),
      ('${CTRL}', '[PROVER] Control Dry', 'P-CTRL', 'dry', 'Lb', 'Lb', 'Lb', 'Lb', 50, 'Bag', 2, NULL, 10, 12, 12, 12, 24, 24, 24, 1, true);
    INSERT INTO public.product_parents (id, name, product_form, rate_unit, rate_source, created_by, updated_by) VALUES
      ('${P_PLUS}', 'Piksi Dust Plus', 'dry', 'MG', 'legacy', '${ADMIN}', '${ADMIN}'),
      ('${P_INF}', 'Piksi Dust Infurrow', 'dry', 'MG', 'legacy', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by) VALUES
      ('${PLUS}', '${P_PLUS}', 'package', '${ADMIN}'), ('${INF}', '${P_INF}', 'package', '${ADMIN}');
    INSERT INTO public.product_cost_basis (id, product_id, basis_type, cost_cents, selection_source, reason) VALUES
      ('0522b9ea-401e-41df-bce8-23822c286d4e', '${PLUS}', 'manual_override', 50, 'migration_baseline', 'baseline'),
      ('b31d8263-2cfc-4f8e-ae22-d1efa8b762b8', '${INF}', 'manual_override', 60, 'migration_baseline', 'baseline'),
      ('eb32265b-301f-498d-8602-058ed845ffb4', '${OLD}', 'manual_override', 50, 'migration_baseline', 'baseline');
    INSERT INTO public.inventory (id, product_id, location, unit_size, quantity_available, quantity_prebooked, quantity_on_order) VALUES
      ('${INV.plus}', '${PLUS}', 'Main Warehouse', 'MG', 58500, 27000, 9000),
      ('${INV.inf}', '${INF}', 'Main Warehouse', 'MG', 6000, 0, 0),
      ('${CTRL_INV}', '${CTRL}', 'Main Warehouse', 'Lb', 100, 0, 0);
    INSERT INTO public.orders (id, order_number, customer_id, status) VALUES
      ('${O_A}', 'PK-A', '${CUST}', 'partially_fulfilled'), ('${O_B}', 'PK-B', '${CUST}', 'confirmed'),
      ('${O_C}', 'PK-C', '${CUST}', 'partially_fulfilled');
    INSERT INTO public.order_items (id, order_id, product_id, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit) VALUES
      ('${OI.a}', '${O_A}', '${PLUS}', 'MG', 10800, 10800, 0, 1.00),
      ('${OI.b}', '${O_B}', '${PLUS}', 'MG', 27000, 0, 27000, 1.00),
      ('${OI.c}', '${O_C}', '${PLUS}', 'MG', 21600, 21600, 0, 1.00),
      ('${OI.inf}', '${O_C}', '${INF}', 'MG', 5250, 5250, 0, 2.00),
      ('${CTRL_OI}', '${O_B}', '${CTRL}', 'Lb', 5, 0, 5, 12);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status) VALUES
      ${Object.entries(DEL).map(([k, [did, st, ord]]) => `('${did}', 'PK-${k}', '${ord}', '${CUST}', '${ADMIN}', '${st}')`).join(',\n      ')};
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, unit_size) VALUES
      ${DI.map(([did, pid, u, q, d, oi]) => `('${did}', '${DEL[d][0]}', '${oi}', '${pid}', ${q}, '${u}')`).join(',\n      ')};
    INSERT INTO public.purchase_orders (id, po_number, created_by, status) VALUES ('${PO}', 'PK-PO', '${ADMIN}', 'partially_received'),
      ('${PO_OPEN}', 'PK-PO2', '${ADMIN}', 'partially_received');
    INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, unit_size, quantity_ordered, quantity_received, unit_cost,
        inventory_units_per_supplier_unit_snapshot, inventory_unit_snapshot) VALUES
      ('${POI.open}', '${PO_OPEN}','${PLUS}', 'MG', 9000, 0, 0.50, NULL, NULL),
      ('${POI.plusDone}', '${PO}', '${PLUS}', 'MG', 45000, 45000, 0.50, 1, 'MG'),
      ('${POI.infDone}', '${PO}', '${INF}', 'MG', 11250, 11250, 0.60, 1, 'MG');
    INSERT INTO public.receiving_records (id, purchase_order_id, po_item_id, product_id, quantity_received, unit_size, received_by) VALUES
      ${RR.map(([rid, poi, pid, q]) => `('${rid}', '${PO}', '${poi}', '${pid}', ${q}, 'MG', '${ADMIN}')`).join(',\n      ')};
    -- Live: two Piksi net-weight state rows, no net-weight value.
    INSERT INTO public.product_size_net_weight_state (product_id) VALUES ('${PLUS}'), ('${INF}') ON CONFLICT DO NOTHING;`);
  console.log('[piksi] seeded live\'s 3 Piksi products, 2 groups, 2 stock rows, 4 order lines, 8 delivery lines, 3 PO lines, 3 receipts and a control product');
}

// Every number the correction must not move, across all products and lines.
const numbers = () => scalar(`SELECT md5(concat_ws('#',
  (SELECT string_agg(concat_ws('|', id, rate_per_acre, current_cost, tier1_price, tier2_price, tier3_price, tier1_price_per_acre,
      tier2_price_per_acre, tier3_price_per_acre, container_size), ',' ORDER BY id) FROM public.products),
  (SELECT string_agg(concat_ws('|', id, quantity_available, quantity_prebooked, quantity_on_order), ',' ORDER BY id) FROM public.inventory),
  (SELECT string_agg(concat_ws('|', id, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit, total_price), ',' ORDER BY id) FROM public.order_items),
  (SELECT string_agg(concat_ws('|', id, quantity), ',' ORDER BY id) FROM public.delivery_items),
  (SELECT string_agg(concat_ws('|', id, quantity_ordered, quantity_received, unit_cost, unit_cost_cents, inventory_units_per_supplier_unit_snapshot, cost_needs_review), ',' ORDER BY id) FROM public.purchase_order_items),
  (SELECT string_agg(concat_ws('|', id, quantity_received), ',' ORDER BY id) FROM public.receiving_records)));`);
const labels = () => scalar(`SELECT concat_ws(' ',
  (SELECT string_agg(DISTINCT inventory_unit || '/' || unit_size || '/' || rate_unit || '/' || container_unit, ',') FROM public.products WHERE id IN (${PRODUCTS})),
  (SELECT string_agg(rate_unit || 'v' || parent_version, ',' ORDER BY id) FROM public.product_parents WHERE id IN ('${P_PLUS}', '${P_INF}')),
  (SELECT string_agg(DISTINCT unit_size, ',') FROM public.inventory WHERE product_id IN (${PRODUCTS})),
  (SELECT string_agg(DISTINCT unit_size, ',') FROM public.order_items WHERE product_id IN (${PRODUCTS})),
  (SELECT string_agg(unit_size, ',' ORDER BY id) FROM public.delivery_items WHERE product_id IN (${PRODUCTS})),
  (SELECT string_agg(unit_size || '/' || COALESCE(inventory_unit_snapshot, '-'), ',' ORDER BY id) FROM public.purchase_order_items WHERE product_id IN (${PRODUCTS})),
  (SELECT string_agg(DISTINCT unit_size, ',') FROM public.receiving_records WHERE product_id IN (${PRODUCTS})));`);
const control = () => scalar(`SELECT md5(concat_ws('#', (SELECT to_jsonb(p)::text FROM public.products p WHERE id = '${CTRL}'),
  (SELECT to_jsonb(i)::text FROM public.inventory i WHERE id = '${CTRL_INV}'), (SELECT to_jsonb(x)::text FROM public.order_items x WHERE id = '${CTRL_OI}')));`);
const basis = () => scalar(`SELECT string_agg(product_id::text || ':' || cost_cents || ':' || (effective_to IS NULL), ',' ORDER BY product_id, effective_to NULLS LAST, created_at)
  FROM public.product_cost_basis WHERE product_id IN (${PRODUCTS});`);
const guardsOn = () => scalar(`SELECT count(*) FROM pg_trigger WHERE tgenabled = 'O' AND tgname IN ('a1_product_unit_keeps_open_lines',
  'a2_product_unit_keeps_history', 'trg_validate_product_setup_fields', 'trigger_zz_guard_product_parent_values',
  'trigger_0_guard_closed_po_item', 'trigger_capture_purchase_order_item_cost_snapshot');`);
const priceIs = (rateUnit, stockUnit, expected) => scalar(`SELECT public.product_price_per_acre(1.00, 18, '${rateUnit}', '${stockUnit}', '${stockUnit}') = ${expected}::numeric;`);

const MG_LABELS = 'MG/MG/MG/MG MGv1,MGv1 MG MG '
  + [...DI].sort((a, b) => a[0].localeCompare(b[0])).map((d) => d[2]).join(',') + ' MG/-,MG/MG,MG/MG MG';

function beforeCases() {
  assert.equal(labels(), MG_LABELS, 'seed matches live');
  assert.equal(priceIs('MG', 'MG', 18), 't', 'today: 18 MG on MG stock is the stored $18.00 per acre (made-up test price)');
  assert.equal(priceIs('g', 'MG', 18000), 't', 'the bug: the approved 18 g rate on MG stock prices 1000x');
  console.log('[case] B1 before: 18 MG on MG stock prices $18.00/acre; the approved 18 g rate on MG stock prices $18,000/acre (1000x; made-up test prices)');

  const n0 = numbers(), l0 = labels();
  const drift = tx(`UPDATE public.order_items SET total_units_needed = 27001 WHERE id = '${OI.b}';\n${FORWARD}`, false);
  assert.notEqual(drift.status, 0); assert.match(drift.output, /PIKSI_G_ROW_MOVED/);
  const extra = tx(`SET session_replication_role = replica; INSERT INTO public.receiving_records (purchase_order_id, po_item_id, product_id, quantity_received, unit_size, received_by)
      VALUES ('${PO_OPEN}', '${POI.open}', '${PLUS}', 1, 'MG', '${ADMIN}'); SET session_replication_role = origin;\n${FORWARD}`, false);
  assert.notEqual(extra.status, 0); assert.match(extra.output, /PIKSI_G_UNLISTED_ROW/);
  const count = tx(`INSERT INTO public.cycle_counts (count_number, status, initiated_by) VALUES ('CC-PIKSI', 'in_progress', '${ADMIN}');\n${FORWARD}`, false);
  assert.notEqual(count.status, 0); assert.match(count.output, /PIKSI_G_COUNT_IN_PROGRESS/);
  const snap = tx(`SET session_replication_role = replica; UPDATE public.purchase_order_items SET inventory_units_per_supplier_unit_snapshot = 2 WHERE id = '${POI.infDone}';
      SET session_replication_role = origin;\n${FORWARD}`, false);
  assert.notEqual(snap.status, 0); assert.match(snap.output, /PIKSI_G_ROW_MOVED/);
  const unlocked = tx(`UPDATE public.product_rate_lock SET is_locked = false;\n${FORWARD}`, false);
  assert.notEqual(unlocked.status, 0); assert.match(unlocked.output, /PIKSI_G_RATE_LOCK_OFF/);
  const weight = tx(`SET session_replication_role = replica; INSERT INTO public.product_size_net_weight_values (product_id, net_lb, entered_value, source, basis, review_state)
      VALUES ('${INF}', 2, 2, 'label', '{}'::jsonb, 'draft'); SET session_replication_role = origin;\n${FORWARD}`, false);
  assert.notEqual(weight.status, 0); assert.match(weight.output, /PIKSI_G_ROW_MOVED/);
  const stray = tx(`SET session_replication_role = replica; UPDATE public.products SET product_name = 'Piksi Dust Plus - 900G Jar' WHERE id = '${CTRL}';
      SET session_replication_role = origin;\n${FORWARD}`, false);
  assert.notEqual(stray.status, 0); assert.match(stray.output, /another product is Piksi or uses MG/);
  const strayMg = tx(`SET session_replication_role = replica; UPDATE public.products SET rate_unit = 'MG' WHERE id = '${CTRL}';
      SET session_replication_role = origin;\n${FORWARD}`, false);
  assert.notEqual(strayMg.status, 0); assert.match(strayMg.output, /another product is Piksi or uses MG/);
  const rateUnit = tx(`SET session_replication_role = replica; UPDATE public.order_items SET rate_unit = 'MG' WHERE id = '${OI.b}';
      SET session_replication_role = origin;\n${FORWARD}`, false);
  assert.notEqual(rateUnit.status, 0); assert.match(rateUnit.output, /PIKSI_G_ROW_MOVED/);
  assert.equal(numbers(), n0); assert.equal(labels(), l0);
  console.log('[case] P1 a moved pinned line, a pinned order line carrying a rate unit, or a changed PO conversion snapshot refuses (PIKSI_G_ROW_MOVED), an unlisted receipt refuses (PIKSI_G_UNLISTED_ROW); P2 an open count, an unlocked rate lock or a recorded jar net weight refuses; P3 another Piksi-named or MG product refuses; nothing changed');
}

// The live test-data reset (#2407) deletes every Piksi order, delivery, PO and receipt line, stock movement and
// cycle-count line and sets stock to 0. The forward accepts exactly that state (all or nothing); each case rolls back.
const RESET = `SET session_replication_role = replica;
  DELETE FROM public.receiving_records WHERE product_id IN (${PRODUCTS});
  DELETE FROM public.delivery_items WHERE product_id IN (${PRODUCTS});
  DELETE FROM public.purchase_order_items WHERE product_id IN (${PRODUCTS});
  DELETE FROM public.order_items WHERE product_id IN (${PRODUCTS});
  DELETE FROM public.inventory_transactions WHERE product_id IN (${PRODUCTS});
  DELETE FROM public.cycle_count_items WHERE product_id IN (${PRODUCTS});
  UPDATE public.inventory SET quantity_available = 0, quantity_prebooked = 0, quantity_on_order = 0, last_counted_at = NULL;
  SET session_replication_role = origin;`;
function resetCases() {
  const n0 = numbers(), l0 = labels();
  const ok = tx(`${RESET}
${FORWARD}
    DO $c$ BEGIN
      IF (SELECT count(*) FROM public.products WHERE id IN (${PRODUCTS}) AND (inventory_unit, unit_size, rate_unit, container_unit) = ('g', 'g', 'g', 'g')) <> 3
         OR (SELECT count(*) FROM public.product_parents WHERE id IN ('${P_PLUS}', '${P_INF}') AND rate_unit = 'g' AND parent_version = 2) <> 2
         OR (SELECT count(*) FROM public.inventory WHERE id IN ('${INV.plus}', '${INV.inf}') AND unit_size = 'g' AND quantity_available = 0) <> 2
         OR (SELECT count(*) FROM public.product_cost_basis WHERE product_id IN (${PRODUCTS}) AND effective_to IS NULL) <> 3 THEN
        RAISE EXCEPTION 'RESET_APPLY_WRONG';
      END IF;
    END $c$;`, false);
  assert.equal(ok.status, 0, ok.output);
  const partial = tx(`SET session_replication_role = replica; DELETE FROM public.receiving_records WHERE product_id IN (${PRODUCTS});
      SET session_replication_role = origin;
${FORWARD}`, false);
  assert.notEqual(partial.status, 0); assert.match(partial.output, /PIKSI_G_ROW_MOVED/);
  const stock = tx(`${RESET}
UPDATE public.inventory SET quantity_available = 1 WHERE id = '${INV.inf}';
${FORWARD}`, false);
  assert.notEqual(stock.status, 0); assert.match(stock.output, /PIKSI_G_ROW_MOVED/);
  const movement = tx(`${RESET}
SET session_replication_role = replica; INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, performed_by)
      VALUES ('${PLUS}', 'adjusted', 0, '${ADMIN}'); SET session_replication_role = origin;
${FORWARD}`, false);
  assert.notEqual(movement.status, 0); assert.match(movement.output, /PIKSI_G_ROW_MOVED/);
  assert.equal(numbers(), n0); assert.equal(labels(), l0);
  console.log('[case] Z1 after the live test-data reset (no Piksi lines, movements or count lines, stock 0) the forward relabels the 3 products, 2 groups and 2 stock rows to g with one open cost basis each; a half-reset (only receipts gone), a stock row not at 0, or a new movement after the reset refuses (PIKSI_G_ROW_MOVED)');
}

let numbers0, control0;
function applyCases() {
  numbers0 = numbers(); control0 = control();
  const versions0 = scalar(`SELECT string_agg(pricing_version::text, ',' ORDER BY id) FROM public.products WHERE id IN (${PRODUCTS});`);
  const r = tx(FORWARD, true);
  assert.equal(r.status, 0, r.output);
  assert.equal(numbers(), numbers0, 'no quantity, price, cost or per-acre price changed');
  assert.equal(control(), control0, 'the control product is untouched');
  assert.equal(labels(), `g/g/g/g gv2,gv2 g g ${DI.map(() => 'g').join(',')} g/-,g/g,g/g g`);
  assert.equal(guardsOn(), '6', 'every switched-off guard is on again');
  assert.equal(scalar('SELECT count(*) FROM public.product_rate_correction_passes;'), '0', 'no correction pass left');
  assert.equal(scalar('SELECT is_locked::text FROM public.product_rate_lock;'), 'true', 'rates stay locked');
  const b = basis().split(',');
  assert.equal(b.length, 6); assert.deepEqual(b.filter((x) => x.endsWith(':true')).map((x) => x.split(':')[1]).sort(), ['50', '50', '60']);
  const versions1 = scalar(`SELECT string_agg(pricing_version::text, ',' ORDER BY id) FROM public.products WHERE id IN (${PRODUCTS});`);
  assert.equal(versions0, '1,1,1'); assert.equal(versions1, '2,2,2', 'pricing_version advances by exactly one');
  assert.equal(scalar(`SELECT count(*) FROM public.product_cost_basis n JOIN public.product_cost_basis o ON o.product_id = n.product_id
    AND o.effective_to = n.effective_from AND o.cost_cents = n.cost_cents WHERE n.product_id IN (${PRODUCTS}) AND n.effective_to IS NULL;`), '3',
  'each new cost basis starts the instant the old one ended');
  console.log(`[case] M1 applied: every Piksi label is g (products, groups v2, stock, 4 order, 8 delivery, 3 PO lines + 2 snapshots, 3 receipts); no number moved; control untouched; guards on; rates still locked; one open cost basis per product at 50/60/50 cents, no gap; pricing_version ${versions0} -> ${versions1}`);

  const rate = attempt(ADMIN, `${refuse(`UPDATE public.products SET rate_per_acre = 19 WHERE id = '${PLUS}';`)}
    v := t || '/' || (SELECT rate_per_acre FROM public.products WHERE id = '${PLUS}');`);
  assert.match(rate, /^ok\|.+\/18$/, rate); assert.doesNotMatch(rate, /NOT REFUSED/, rate);
  const owner = tx(`UPDATE public.products SET rate_per_acre = 19 WHERE id = '${OLD}';`, false); // no parent, so only the rate lock can refuse
  assert.notEqual(owner.status, 0); assert.match(owner.output, /PRODUCT_RATES_LOCKED/, 'the rate lock itself refuses, no pass left');
  console.log(`[case] M3 after the migration a signed-in admin changing the Piksi rate directly is still refused (${rate.split('|')[1].slice(0, 60)}), and even the database owner hits PRODUCT_RATES_LOCKED`);

  assert.equal(priceIs('g', 'g', 18), 't', 'exactly 18.00, compared as numeric');
  assert.equal(scalar(`SELECT tier1_price_per_acre || '/' || tier3_price_per_acre FROM public.products WHERE id = '${PLUS}';`), '18.00/19.80');
  console.log('[case] A1 after: the approved 18 g rate on g stock prices $18.00/acre, the same as before');

  const recv = attempt(ADMIN, `${asUser(`PERFORM public.receive_po_items('[{"po_item_id":"${POI.open}","quantity":9000}]'::jsonb, '${ADMIN}'::uuid, 'piksi-g-recv-1');`)}
    SELECT (SELECT quantity_available FROM public.inventory WHERE id = '${INV.plus}') || '/' ||
           (SELECT string_agg(unit_size, ',') FROM public.receiving_records WHERE po_item_id = '${POI.open}') INTO v;`);
  assert.equal(recv, 'ok|67500/g', recv);
  console.log('[case] A2 receiving the open 9,000 PO line adds 9,000 to stock (58,500 -> 67,500) and records the receipt in g');

  const mg = tx(`INSERT INTO public.order_items (order_id, product_id, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit)
      VALUES ('${O_B}', '${PLUS}', 'MG', 1800, 0, 1800, 1.00);`, false);
  assert.notEqual(mg.status, 0); assert.match(mg.output, /LINE_UNIT_NOT_STOCK_UNIT/);
  const blank = tx(`INSERT INTO public.order_items (id, order_id, product_id, unit_size, total_units_needed, quantity_delivered, quantity_remaining, price_per_unit)
      VALUES ('${fx('f1')}', '${O_B}', '${PLUS}', NULL, 1800, 0, 1800, 1.00);
    DO $c$ BEGIN IF (SELECT unit_size FROM public.order_items WHERE id = '${fx('f1')}') IS DISTINCT FROM 'g' THEN RAISE EXCEPTION 'BLANK_NOT_G'; END IF; END $c$;`, false);
  assert.equal(blank.status, 0, blank.output);
  console.log('[case] A3 a new order line typed in MG is refused (LINE_UNIT_NOT_STOCK_UNIT); a blank unit becomes g');

  const sweep = (pre) => tx(`${pre}\nDO $s$ BEGIN RAISE NOTICE 'SWEEP_ROWS=%', (SELECT count(*) FROM (${SWEEP}) s); END $s$;`, false);
  assert.match(sweep('').output, /SWEEP_ROWS=0/, 'the after-apply sweep is clean on the migrated data');
  assert.match(sweep(`SET session_replication_role = replica; UPDATE public.order_items SET rate_unit = 'MG' WHERE id = '${OI.b}'; SET session_replication_role = origin;`).output,
    /SWEEP_ROWS=1/, 'the sweep finds a Piksi line saved in MG after the apply');
  console.log('[case] S1 the after-apply sweep (piksi-grams-sweep.sql) finds nothing on the migrated data and flags a Piksi line saved in MG afterwards');

  const again = tx(FORWARD, false);
  assert.notEqual(again.status, 0); assert.match(again.output, /PIKSI_G_ROW_MOVED/);
  console.log('[case] M2 a second run refuses (PIKSI_G_ROW_MOVED)');
}

function reverseCases() {
  // A gram-era stock movement (even one that nets to zero) makes the reverse refuse.
  const moved = tx(`SET session_replication_role = replica; INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, performed_by)
      VALUES ('${PLUS}', 'adjusted', 0, '${ADMIN}'); SET session_replication_role = origin;\n${REVERSE}`, false);
  assert.notEqual(moved.status, 0); assert.match(moved.output, /stock movement was recorded after the change to grams/);
  // A cancelled delivery put back on the schedule during the gram era makes the reverse refuse (no Dry oz line goes live).
  const reopened = tx(`SET session_replication_role = replica; UPDATE public.deliveries SET status = 'scheduled' WHERE id = 'f66fac69-654b-4288-bca9-c8cad645ba5c';
      SET session_replication_role = origin;\n${REVERSE}`, false);
  assert.notEqual(reopened.status, 0); assert.match(reopened.output, /PIKSI_REV_ROW_MOVED: these rows moved/);
  // A2 committed nothing (rolled back), so the database is the state the migration left.
  const r = tx(REVERSE, true);
  assert.equal(r.status, 0, r.output);
  assert.equal(labels(), MG_LABELS.replaceAll('MGv1', 'MGv3'), 'every label is back; group versions move forward');
  assert.equal(numbers(), numbers0, 'no number moved');
  assert.equal(control(), control0);
  assert.equal(guardsOn(), '6');
  assert.equal(scalar(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.delivery_items'::regclass AND tgenabled = 'O'
    AND tgname IN ('a1_line_unit_is_stock_unit', 'a2_delivery_line_matches_order_line');`), '2');
  assert.equal(scalar(`SELECT string_agg(pricing_version::text, ',') FROM public.products WHERE id IN (${PRODUCTS});`), '3,3,3');
  assert.deepEqual(basis().split(',').filter((x) => x.endsWith(':true')).map((x) => x.split(':')[1]).sort(), ['50', '50', '60']);
  const redo = tx(FORWARD, false);
  assert.notEqual(redo.status, 0); assert.match(redo.output, /PIKSI_G_ROW_MOVED/);
  console.log('[case] R1 the reverse script restores every MG and "Dry oz" label with no number moved, one open cost basis per product, versions moving forward (3) and every guard on; a gram-era stock movement or a reopened cancelled delivery makes it refuse; the reviewed forward then refuses (versions moved)');
}

try {
  assert.deepEqual(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f > CANDIDATE), [], 'no migration after the candidate on this branch');
  if (process.env.PIKSI_DEV_REUSE !== '1') { buildContainer({ stopBefore: CANDIDATE }); seedUsers(); seed(); }
  beforeCases();
  resetCases();
  applyCases();
  reverseCases();
  console.log('PIKSI_GRAMS_PROOF_PASS');
} finally {
  if (process.env.CRX_PROVER_KEEP_CONTAINER !== '1') removeContainer();
}
