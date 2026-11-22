#!/usr/bin/env node
/**
 * Real-schema proof for 20270213100000_single_short_stock_warning.sql (#2135; contract
 * docs/plans/2026-11-22-single-short-stock-warning-CONTRACT.md).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), seeds invented rows, completes five deliveries through
 * the real complete_delivery (each in a rolled-back probe, signed in as the admin) on the old body, applies the
 * candidate (autocommit refused, POSTFLIGHT_OK, re-apply refused), completes them again and checks:
 *   - warnings: one per short product (count, warning text, one delivery_short_stock activity, one stock_warning
 *     notification per active admin) and none when stock covers the delivery;
 *   - stock: on-hand, ledger rows, their notes and review flags are byte for byte what the old body wrote;
 *   - a replay with the same key returns the same receipt and writes nothing.
 * Then the reverse script restores the old body byte for byte and the candidate re-applies.
 *
 * Run: node scripts/smoke/prove-single-short-stock-warning-real-schema.mjs   (needs Docker; never touches live)
 * Prints SINGLE_SHORT_STOCK_WARNING_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, seed, attempt, asUser, USERS, ROOT, NAME, docker, scalar } from './undo-paths/harness.mjs';

const CANDIDATE = '20270213100000_single_short_stock_warning.sql';
const lf = (f) => readFileSync(f, 'utf8').replaceAll('\r\n', '\n');
const candidate = lf(path.join(ROOT, 'supabase', 'migrations', CANDIDATE));
const reverse = lf(path.join(ROOT, 'scripts', 'smoke', 'single-short-stock-warning-reverse.sql'));
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const run = (sql, flags = []) => docker([...PSQL, ...flags], { input: sql, allowFailure: true });
const ADMIN = USERS.admin;
const WRAP = 'public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamptz)';
const wrapMd5 = () => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${WRAP}'::regprocedure;`);
const show = (label, got) => { console.log(`  ${label}: ${got}`); return got; };

// Invented ids (tag 'c2..'; the harness's users use 'a1'..'a4').
const uid = (n) => `7c7a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CUST = uid('c2c1'); const ORDER = uid('c2e1');
const P = { ok: uid('c2d1'), short10: uid('c2d2'), short1: uid('c2d3'), noRow: uid('c2d4') };
const L = { ok: uid('c2f1'), a: uid('c2f2'), b: uid('c2f3'), s1: uid('c2f4'), noRow: uid('c2f5') };
// delivery -> lines [order line, product, quantity]
const DELIVERIES = {
  repeated: [uid('c2b1'), [[L.a, P.short10, 6], [L.b, P.short10, 6]]], // each line fits on-hand 10, together 12 do not
  twoShortOneFine: [uid('c2b2'), [[L.a, P.short10, 6], [L.b, P.short10, 6], [L.s1, P.short1, 3], [L.ok, P.ok, 5]]],
  enough: [uid('c2b3'), [[L.ok, P.ok, 5]]],
  partialFits: [uid('c2b4'), [[L.a, P.short10, 6], [L.b, P.short10, 6]]], // delivering 4 + 4 = 8 of on-hand 10
  noStockRow: [uid('c2b5'), [[L.noRow, P.noRow, 2]]],
};
const PARTIAL_QTY = (del) => `(SELECT jsonb_object_agg(id::text, 4) FROM public.delivery_items WHERE delivery_id = '${del}')`;

function seedAll() {
  const line = (lid, prod, units) => `INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size)
    VALUES ('${lid}', '${ORDER}', '${prod}', '[C2] line', 10, 6, ${units}, ${units * 10}, ${units * 4}, 40, 0, ${units}, 'Gal');`;
  const delivery = (did, items) => `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, scheduled_date, status, created_by)
      VALUES ('${did}', '[C2] ${did.slice(-2)}', '${ORDER}', '${CUST}', CURRENT_DATE, 'scheduled', '${ADMIN}');
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size) VALUES
      ${items.map(([l, p, q]) => `('${did}', '${l}', '${p}', ${q}, 0, 'Gal')`).join(', ')};`;
  const price = (p, key) => `DO $price$ DECLARE v jsonb; BEGIN
      v := public.preview_product_pricing_changes('product_page', NULL,
        jsonb_build_array(jsonb_build_object('product_id', '${p}', 'row_version', 1, 'pricing_mode', 'price_driven',
          'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')), '${ADMIN}', '${key}-preview');
      PERFORM public.apply_product_pricing_change_set((v->>'change_set_id')::uuid, v->>'request_fingerprint', '${ADMIN}', '${key}-apply');
    END $price$;`;
  const products = Object.entries(P).map(([k, p], i) => `('${p}', '[C2] ${k}', 'Gal', '999999-9999${i}', 'liquid', 'Gal')`).join(', ');
  seed('lane-c2', `INSERT INTO public.customers (id, farm_name, account_number) VALUES ('${CUST}', '[C2] Farm', '[C2]-1');
    INSERT INTO public.products (id, product_name, unit_size, epa_registration, product_form, inventory_unit) VALUES ${products};
    ${Object.entries(P).map(([k, p]) => price(p, `c2-${k}`)).join(' ')}
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES
      ('${P.ok}', 'Main Warehouse', 100, 0, 'Gal'), ('${P.short10}', 'Main Warehouse', 10, 0, 'Gal'), ('${P.short1}', 'Main Warehouse', 1, 0, 'Gal');
    INSERT INTO public.orders (id, order_number, customer_id, status, booking_draw) VALUES ('${ORDER}', '[C2] O1', '${CUST}', 'confirmed', false);
    ${line(L.ok, P.ok, 10)} ${line(L.a, P.short10, 6)} ${line(L.b, P.short10, 6)} ${line(L.s1, P.short1, 3)} ${line(L.noRow, P.noRow, 2)}
    ${Object.values(DELIVERIES).map(([d, items]) => delivery(d, items)).join('\n    ')}`);
}

const complete = (del, key, qty) => `UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${del}';
  r := public.complete_delivery(p_delivery_id => '${del}', p_signed_by => 'No proof — recorded by office',
    p_performed_by => '${ADMIN}', p_quantities => ${qty ?? 'NULL'}, p_idempotency_key => '${key}', p_evidence => 'no_proof', p_evidence_ref => '[C2] fixture');`;
const warnings = (del) => `'count=' || coalesce(r->>'short_stock_count', 'none') || ' flag=' || coalesce(r->>'stock_warning', 'none')
    || ' warnings=' || coalesce(jsonb_array_length(r->'warnings'), -1)
    || ' activity=' || (SELECT count(*) FROM public.activity_feed WHERE related_entity_id = '${del}' AND event_type = 'delivery_short_stock')
    || ' notices=' || (SELECT count(*) FROM public.notifications WHERE related_entity_id = '${del}' AND notification_type = 'stock_warning')
    || ' admins=' || (SELECT count(*) FROM public.profiles WHERE role = 'admin' AND is_active)`;
// Stock and ledger: everything the warning change must not touch.
const stock = (del) => `(SELECT md5(coalesce((SELECT string_agg(product_id || ':' || quantity::numeric(12,2) || ':' || requires_review || ':' || notes, '|' ORDER BY product_id, quantity, notes)
      FROM public.inventory_transactions WHERE delivery_id = '${del}'), '') || '#' ||
    (SELECT string_agg(product_id || ':' || quantity_available::numeric(12,2) || ':' || quantity_prebooked::numeric(12,2), '|' ORDER BY product_id)
      FROM public.inventory WHERE product_id IN ('${Object.values(P).join("','")}'))))`;
const probe = (name) => {
  const [del] = DELIVERIES[name];
  const qty = name === 'partialFits' ? PARTIAL_QTY(del) : null;
  return show(name, attempt(ADMIN, `${asUser(complete(del, `c2-${name}`, qty))}
    v := ${warnings(del)} || ' stock=' || ${stock(del)};
    ${asUser(`r2 := public.complete_delivery(p_delivery_id => '${del}', p_signed_by => 'No proof — recorded by office', p_performed_by => '${ADMIN}',
      p_quantities => ${qty ?? 'NULL'}, p_idempotency_key => 'c2-${name}', p_evidence => 'no_proof', p_evidence_ref => '[C2] fixture');`)}
    v := v || ' | replay_same=' || (r = r2)
      || ' activity=' || (SELECT count(*) FROM public.activity_feed WHERE related_entity_id = '${del}' AND event_type = 'delivery_short_stock')
      || ' notices=' || (SELECT count(*) FROM public.notifications WHERE related_entity_id = '${del}' AND notification_type = 'stock_warning');`));
};

// Expected warnings come from the business rule (one warning per short product), not from the new code.
const EXPECT = {
  repeated: 'count=1 flag=true warnings=1 activity=1 notices=1 admins=1',
  twoShortOneFine: 'count=2 flag=true warnings=2 activity=1 notices=1 admins=1',
  enough: 'count=0 flag=false warnings=0 activity=0 notices=0 admins=1',
  partialFits: 'count=0 flag=false warnings=0 activity=0 notices=0 admins=1',
  noStockRow: 'count=1 flag=true warnings=1 activity=1 notices=1 admins=1',
};
const split = (got) => {
  const m = got.match(/^ok\|(.*) stock=(\w+) \| replay_same=(\w+) activity=(\d+) notices=(\d+)$/);
  assert.ok(m, `unexpected probe output: ${got}`);
  return { warn: m[1], stock: m[2], replaySame: m[3], replayWarn: `activity=${m[4]} notices=${m[5]}` };
};

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  seedAll();
  const before = wrapMd5();
  console.log('  baseline wrapper body:', before);

  console.log('Before the candidate:');
  const old = Object.fromEntries(Object.keys(DELIVERIES).map((n) => [n, split(probe(n))]));
  assert.match(old.repeated.warn, /^count=2 .*activity=2 notices=2 /, '#2135 must reproduce on the old body');

  console.log('Apply:');
  const auto = run(candidate);
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = run(candidate, ['-1']);
  assert.equal(once.status, 0, `${once.stdout}${once.stderr}`);
  assert.match(`${once.stdout}${once.stderr}`, /POSTFLIGHT_OK/);
  assert.match(`${run(candidate, ['-1']).stderr}`, /BASELINE_DRIFT/, 're-apply must refuse');
  assert.notEqual(wrapMd5(), before, 'wrapper body did not change');

  console.log('After the candidate:');
  for (const [name, expected] of Object.entries(EXPECT)) {
    const now = split(probe(name));
    assert.equal(now.warn, expected, `${name}: warnings`);
    assert.equal(now.stock, old[name].stock, `${name}: stock and ledger must match the old body exactly`);
    assert.equal(now.replaySame, 'true', `${name}: replay must return the same receipt`);
    assert.equal(now.replayWarn, expected.match(/activity=\d+ notices=\d+/)[0], `${name}: replay must write nothing`);
  }

  console.log('Reverse:');
  const back = run(reverse, ['-1']);
  assert.equal(back.status, 0, `${back.stdout}${back.stderr}`);
  assert.equal(wrapMd5(), before, 'reverse must restore the previous body byte for byte');
  assert.equal(scalar(`SELECT has_function_privilege('authenticated', '${WRAP}', 'EXECUTE');`), 'f', 'reverse keeps API roles out');
  assert.match(`${run(reverse, ['-1']).stderr}`, /SINGLE_SHORT_STOCK_REVERSE_DRIFT/, 'reverse must refuse a body that is not the candidate');
  assert.equal(wrapMd5(), before, 'a refused reverse changes nothing');
  const again = run(candidate, ['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /POSTFLIGHT_OK/, 'candidate must re-apply after the reverse');

  console.log('SINGLE_SHORT_STOCK_WARNING_PROOF_PASS');
} finally {
  if (process.env.CRX_PROVER_KEEP_CONTAINER !== '1') removeContainer();
}
