#!/usr/bin/env node
/**
 * Real-schema proof for 20270224210000_drop_inert_delivery_short_stock_trigger.sql (#2225).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate (so #2135 is applied) in a
 * network-disabled PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds invented rows and completes
 * three deliveries through the real complete_delivery (rolled-back probes, signed in as the admin): one short on a
 * repeated product, one fully stocked, one with no stock row. Then it applies the candidate and checks:
 *   - the trigger was inert: before the drop it still flagged a row only when its settings were set by hand;
 *   - autocommit is refused, the drop applies once (POSTFLIGHT_OK), a re-apply is refused;
 *   - the ledger rows each completion writes (product, quantity, requires_review, notes) and on-hand are byte for byte
 *     the same after the drop, including the '[SHORT STOCK — review required]' flag on the short product;
 *   - the reverse script restores the function body byte for byte, its grants and the trigger; and the candidate
 *     refuses while a function still sets the settings (#2135 undone).
 *
 * Run: node scripts/smoke/prove-drop-inert-delivery-short-stock-trigger-real-schema.mjs   (needs Docker; never touches live)
 * Prints DROP_INERT_SHORT_STOCK_TRIGGER_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, seed, attempt, asUser, USERS, ROOT, NAME, docker, scalar } from './undo-paths/harness.mjs';

const CANDIDATE = '20270224210000_drop_inert_delivery_short_stock_trigger.sql';
const lf = (f) => readFileSync(f, 'utf8').replaceAll('\r\n', '\n');
const candidate = lf(path.join(ROOT, 'supabase', 'migrations', CANDIDATE));
const reverse = lf(path.join(ROOT, 'scripts', 'smoke', 'drop-inert-delivery-short-stock-trigger-reverse.sql'));
const reverse2135 = lf(path.join(ROOT, 'scripts', 'smoke', 'single-short-stock-warning-reverse.sql'));
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const run = (sql, flags = []) => docker([...PSQL, ...flags], { input: sql, allowFailure: true });
const ADMIN = USERS.admin;
const FN = 'public._mark_delivery_aggregate_short_stock()';
const fnState = () => scalar(`SELECT coalesce((SELECT md5(replace(prosrc, chr(13), '')) || ' secdef=' || prosecdef || ' config=' || array_to_string(proconfig, ',')
    || ' owner=' || proowner::regrole || ' acl=' || coalesce(array_to_string(proacl, ','), 'default') || ' comment=' || md5(coalesce(obj_description(oid, 'pg_proc'), ''))
    FROM pg_proc WHERE oid = to_regprocedure('${FN}')), 'absent')
  || ' trigger=' || coalesce((SELECT md5(pg_get_triggerdef(oid)) FROM pg_trigger WHERE tgname = 'trg_mark_delivery_aggregate_short_stock'), 'absent');`);

const uid = (n) => `7c7a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUST = uid('d5c1'); const ORDER = uid('d5e1');
const P = { ok: uid('d5d1'), short10: uid('d5d2'), noRow: uid('d5d4') };
const L = { ok: uid('d5f1'), a: uid('d5f2'), b: uid('d5f3'), noRow: uid('d5f5') };
const DELIVERIES = {
  repeated: [uid('d5b1'), [[L.a, P.short10, 6], [L.b, P.short10, 6]]], // each line fits on-hand 10, together 12 do not
  enough: [uid('d5b3'), [[L.ok, P.ok, 5]]],
  noStockRow: [uid('d5b5'), [[L.noRow, P.noRow, 2]]],
};

function seedAll() {
  const line = (lid, prod, units) => `INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size)
    VALUES ('${lid}', '${ORDER}', '${prod}', '[2225] line', 10, 6, ${units}, ${units * 10}, ${units * 4}, 40, 0, ${units}, 'Gal');`;
  const delivery = (did, items) => `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, scheduled_date, status, created_by)
      VALUES ('${did}', '[2225] ${did.slice(-2)}', '${ORDER}', '${CUST}', CURRENT_DATE, 'scheduled', '${ADMIN}');
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size) VALUES
      ${items.map(([l, p, q]) => `('${did}', '${l}', '${p}', ${q}, 0, 'Gal')`).join(', ')};`;
  const price = (p, key) => `DO $price$ DECLARE v jsonb; BEGIN
      v := public.preview_product_pricing_changes('product_page', NULL,
        jsonb_build_array(jsonb_build_object('product_id', '${p}', 'row_version', 1, 'pricing_mode', 'price_driven',
          'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')), '${ADMIN}', '${key}-preview');
      PERFORM public.apply_product_pricing_change_set((v->>'change_set_id')::uuid, v->>'request_fingerprint', '${ADMIN}', '${key}-apply');
    END $price$;`;
  const products = Object.entries(P).map(([k, p], i) => `('${p}', '[2225] ${k}', 'Gal', '999998-9999${i}', 'liquid', 'Gal')`).join(', ');
  seed('issue-2225', `INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${CUST}', '[2225] Farm', '[2225]-1');
    INSERT INTO public.products (id, product_name, unit_size, epa_registration, product_form, inventory_unit) VALUES ${products};
    ${Object.entries(P).map(([k, p]) => price(p, `d5-${k}`)).join(' ')}
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES
      ('${P.ok}', 'Main Warehouse', 100, 0, 'Gal'), ('${P.short10}', 'Main Warehouse', 10, 0, 'Gal');
    INSERT INTO public.orders (id, order_number, customer_id, status, booking_draw) VALUES ('${ORDER}', '[2225] O1', '${CUST}', 'confirmed', false);
    ${line(L.ok, P.ok, 10)} ${line(L.a, P.short10, 6)} ${line(L.b, P.short10, 6)} ${line(L.noRow, P.noRow, 2)}
    ${Object.values(DELIVERIES).map(([d, items]) => delivery(d, items)).join('\n    ')}`);
}

// Everything the drop must not change: the ledger rows the completion writes and on-hand.
const ledger = (del) => `coalesce((SELECT string_agg(product_id || ':' || quantity::numeric(12,2) || ':' || requires_review || ':' || coalesce(notes, '<null>'), '|' ORDER BY product_id, quantity, notes)
      FROM public.inventory_transactions WHERE delivery_id = '${del}'), '<none>') || ' # ' ||
    (SELECT string_agg(product_id || ':' || quantity_available::numeric(12,2) || ':' || quantity_prebooked::numeric(12,2), '|' ORDER BY product_id)
      FROM public.inventory WHERE product_id IN ('${Object.values(P).join("','")}'))`;
const complete = (name) => {
  const [del] = DELIVERIES[name];
  return attempt(ADMIN, `UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${del}';
    ${asUser(`r := public.complete_delivery(p_delivery_id => '${del}', p_signed_by => 'No proof — recorded by office',
      p_performed_by => '${ADMIN}', p_quantities => NULL, p_idempotency_key => 'd5-${name}', p_evidence => 'no_proof', p_evidence_ref => '[2225] fixture');`)}
    v := 'short=' || coalesce(r->>'short_stock_count', 'none') || ' ledger=' || ${ledger(del)};`);
};
// A delivered ledger row inserted with the trigger's two settings set by hand (nothing in the app sets them since #2135).
const handSet = () => attempt(ADMIN, `PERFORM set_config('app.delivery_aggregate_short_delivery_id', '${DELIVERIES.enough[0]}', true);
    PERFORM set_config('app.delivery_aggregate_short_product_ids', '${P.ok}', true);
    INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, delivery_id, notes, performed_by)
      VALUES ('${P.ok}', 'delivered', -1, '${DELIVERIES.enough[0]}', '[2225] hand', '${ADMIN}')
      RETURNING requires_review || ':' || notes INTO v;`);

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  seedAll();
  const fnBefore = fnState();
  console.log('  baseline:', fnBefore);
  console.log('  function md5 (for the preflight):', scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${FN}'::regprocedure;`));

  console.log('Before the candidate:');
  const old = Object.fromEntries(Object.keys(DELIVERIES).map((n) => [n, complete(n)]));
  for (const [n, got] of Object.entries(old)) console.log(`  ${n}: ${got}`);
  assert.match(old.repeated, /^ok\|short=1 .*:true:[^|]*\[SHORT STOCK — review required\]/, 'the short product must be flagged for review');
  assert.doesNotMatch(old.enough, /:true:/, 'a stocked delivery must not be flagged');
  assert.match(handSet(), /^ok\|true: ?\[2225\] hand \[SHORT STOCK — review required\]$/, 'before the drop the trigger still acts on hand-set settings');
  console.log('  trigger still acts only when its settings are set by hand');

  console.log('Apply:');
  const auto = run(candidate);
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  assert.equal(fnState(), fnBefore, 'a refused apply changes nothing');
  const once = run(candidate, ['-1']);
  assert.equal(once.status, 0, `${once.stdout}${once.stderr}`);
  assert.match(`${once.stdout}${once.stderr}`, /POSTFLIGHT_OK/);
  assert.equal(fnState(), 'absent trigger=absent');
  assert.match(run(candidate, ['-1']).stderr, /DROP_SHORT_STOCK_TRIGGER_BASELINE_DRIFT/, 're-apply must refuse');

  console.log('After the candidate:');
  for (const n of Object.keys(DELIVERIES)) {
    const now = complete(n);
    console.log(`  ${n}: ${now}`);
    assert.equal(now, old[n], `${n}: ledger rows, review flags, notes and on-hand must match the old schema exactly`);
  }
  assert.equal(handSet(), 'ok|false:[2225] hand', 'after the drop hand-set settings flag nothing');

  console.log('Reverse:');
  const back = run(reverse, ['-1']);
  assert.equal(back.status, 0, `${back.stdout}${back.stderr}`);
  assert.equal(fnState(), fnBefore, 'reverse must restore the function body, settings, owner, grants, comment and trigger');
  assert.match(run(reverse, ['-1']).stderr, /DROP_SHORT_STOCK_TRIGGER_REVERSE_DRIFT/, 'reverse must refuse when the trigger is back');
  const again = run(candidate, ['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /POSTFLIGHT_OK/, 'candidate must re-apply after the reverse');
  assert.equal(run(reverse, ['-1']).status, 0, 'reverse again');

  console.log('Order:');
  const undo2135 = run(reverse2135, ['-1']);
  assert.equal(undo2135.status, 0, `#2135 reverse: ${undo2135.stdout}${undo2135.stderr}`);
  assert.match(run(candidate, ['-1']).stderr, /a function still uses the trigger's settings \(apply 20270213100000 first\)/,
    'candidate must refuse while the old wrapper still sets the settings');
  assert.equal(fnState(), fnBefore, 'a refused candidate changes nothing');

  console.log('DROP_INERT_SHORT_STOCK_TRIGGER_PROOF_PASS');
} finally {
  if (process.env.CRX_PROVER_KEEP_CONTAINER !== '1') removeContainer();
}
