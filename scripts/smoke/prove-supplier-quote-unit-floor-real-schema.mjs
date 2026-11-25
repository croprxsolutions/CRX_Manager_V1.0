#!/usr/bin/env node
/**
 * Real-schema proof for 20270304140000_supplier_quote_unit_floor.sql.
 * Contract: docs/plans/2026-11-24-supplier-quote-unit-floor-CONTRACT.md
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), shows a 0.0001 factor saves BEFORE the candidate,
 * applies it (autocommit refused, POSTFLIGHT_OK, re-apply refused), then as the signed-in admin checks:
 *   1. link factor 0.0001 refused by product_supplier_links_conversion_floor; 0.001 saves;
 *   2. quote rows: package quantity 0.0001 -> invalid PACKAGE_QUANTITY_INVALID, 0.001 -> new;
 *      cost $10,000,000.01 -> invalid COST_TOO_LARGE, $10,000,000.00 -> new;
 *   3. a row at every bound approves and the market-evidence and workspace reads return 1e15 cents without error;
 *      a normal quote ($45.00 for 2 cases, 2.5 gal per case) still converts to 900 cents;
 *   2b. an out-of-bound row awaiting approval (as an older call could save) is refused by supplier_price_import_rows_pending_bounds;
 *   4. correcting an observation to $10,000,000.01 is refused (its import row hits supplier_price_import_rows_pending_bounds).
 *
 * Run: node scripts/smoke/prove-supplier-quote-unit-floor-real-schema.mjs   (needs Docker; never touches live)
 * Prints SUPPLIER_QUOTE_UNIT_FLOOR_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, id, psql, scalar, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270304140000_supplier_quote_unit_floor.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
const ADMIN = USERS.admin;
const VENDOR = id('b1');
const PRODUCT = id('c1');
let keyN = 0;
const key = (label) => `floor-${label}-${++keyN}`;

const upsertLink = (sku, units, preferred, k = key('link')) =>
  `public.upsert_product_supplier_link('${PRODUCT}', '${VENDOR}', '${sku}', 'Floor ${sku}', 'case', '2 x 2.5 gal',
    '${units}', 'gal', 'comparable', NULL, ${preferred}, '${ADMIN}', '${k}')`;
const quoteRow = (linkId, cost, qty, date) =>
  ({ product_supplier_link_id: linkId, new_cost: cost, package_quantity: qty, effective_date: date, price_kind: 'quote' });
const stage = (rows, k = key('stage')) =>
  `public.stage_supplier_price_import('${VENDOR}', '2026-11-24', 'quick_quote', 'crx-supplier-quick-quote-phase1b-v1',
    NULL, NULL, NULL, '${JSON.stringify(rows)}'::jsonb, '${ADMIN}', '${k}')`;
const rowStatuses = `(SELECT string_agg(row_status || ':' || array_to_string(validation_errors, ','), ';' ORDER BY row_number)
    FROM public.supplier_price_import_rows WHERE import_id = (r->>'id')::uuid)`;

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  psql(`SET session_replication_role = replica;
    INSERT INTO public.vendors (id, name) VALUES ('${VENDOR}', '[PROVER] Floor Supply');
    INSERT INTO public.products (id, product_name, sku, vendor, product_form, inventory_unit, is_active)
      VALUES ('${PRODUCT}', '[PROVER] Floor Product', 'FLOOR-1', '[PROVER] Floor Supply', 'liquid', 'gal', true);
    SET session_replication_role = origin;`);

  // Before the candidate: the tiny factor the known issue describes is accepted.
  assert.match(attempt(ADMIN, asUser(`r := ${upsertLink('PRE-1', '0.0001', true)};`) + ` v := r->>'inventory_units_per_supplier_unit';`),
    /^ok\|0?\.0001/, 'before the fix a 0.0001 factor saves');
  console.log('[before] a link with factor 0.0001 saves (the bug)');

  // A stored row outside a bound (a staging test row) stops the whole apply, naming the count; nothing changes.
  const legacy = docker(PSQL, { input: `BEGIN;
    INSERT INTO public.product_supplier_links (product_id, vendor_id, supplier_product_name, inventory_units_per_supplier_unit, created_by)
      VALUES ('${PRODUCT}', '${VENDOR}', 'Legacy tiny', 0.0001, '${ADMIN}');
    ${candidate}
    ROLLBACK;`, allowFailure: true });
  assert.notEqual(legacy.status, 0, 'a stored tiny-factor link must stop the apply');
  assert.match(legacy.stderr, /SUPPLIER_QUOTE_UNIT_FLOOR_LEGACY_ROWS: links=1, observations=0, approvable import rows=0/);
  assert.equal(scalar(`SELECT count(*) FROM pg_constraint WHERE conname = 'product_supplier_links_conversion_floor'`), '0');
  console.log('[legacy] a stored 0.0001 link stops the apply with SUPPLIER_QUOTE_UNIT_FLOOR_LEGACY_ROWS; nothing applied');

  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /SUPPLIER_QUOTE_UNIT_FLOOR_BASELINE_DRIFT/, 're-apply must refuse');
  assert.equal(scalar(`SELECT string_agg(conname || '=' || convalidated, ',' ORDER BY conname) FROM pg_constraint
    WHERE conname IN ('product_supplier_links_conversion_floor', 'supplier_price_observations_package_quantity_floor',
      'supplier_price_observations_cost_ceiling', 'supplier_price_import_rows_pending_bounds')`),
    'product_supplier_links_conversion_floor=true,supplier_price_import_rows_pending_bounds=true,'
    + 'supplier_price_observations_cost_ceiling=true,supplier_price_observations_package_quantity_floor=true');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK and all four checks validated, re-apply refused');

  // 1. Link factor floor.
  assert.match(attempt(ADMIN, `${refuse(`r := ${upsertLink('TINY-1', '0.0001', true)};`)} v := t;`),
    /^ok\|.*violates check constraint "product_supplier_links_conversion_floor"/, 'factor 0.0001 refused');
  assert.equal(attempt(ADMIN, `${refuse(`r := ${upsertLink('TINY-2', '0.00099999', true)};`)} v := (t LIKE '%conversion_floor%')::text;`),
    'ok|true', 'factor just under 0.001 refused');
  const nanLink = attempt(ADMIN, `${refuse(`r := ${upsertLink('NAN-1', 'NaN', true)};`)} v := t;`);
  assert.match(nanLink, /^ok\|.*(conversion_floor|SUPPLIER_CONVERSION_INVALID)/, `factor NaN refused: ${nanLink}`);
  const boundLink = attempt(ADMIN, asUser(`r := ${upsertLink('BOUND-1', '0.001', true)};`) + ` v := r->>'id';`, { commit: true });
  assert.match(boundLink, /^ok\|[0-9a-f-]{36}$/, `factor 0.001 saves: ${boundLink}`);
  const normalLink = attempt(ADMIN, asUser(`r := ${upsertLink('NORM-1', '2.5', false)};`) + ` v := r->>'id';`, { commit: true });
  assert.match(normalLink, /^ok\|[0-9a-f-]{36}$/, `factor 2.5 saves: ${normalLink}`);
  const BOUND = boundLink.slice(3);
  const NORMAL = normalLink.slice(3);
  console.log('[link] 0.0001, 0.00099999 and NaN refused; 0.001 and 2.5 save');

  // 2. Row-level codes; the rest of the sheet still stages.
  const staged = attempt(ADMIN, asUser(`r := ${stage([
    quoteRow(BOUND, '10', '0.0001', '2026-11-01'),
    quoteRow(BOUND, '10', '0.001', '2026-11-02'),
    quoteRow(BOUND, '10000000.01', '1', '2026-11-03'),
    quoteRow(BOUND, '10000000.00', '1', '2026-11-04'),
    quoteRow(BOUND, '10', 'NaN', '2026-11-05'),
    quoteRow(BOUND, '10', '0.000999999', '2026-11-06'),
  ])};`) + ` v := ${rowStatuses};
    -- An oversized cost is not kept on the invalid row (the screen must still read the import).
    v := v || '|' || (SELECT (cost_cents IS NULL)::text FROM public.supplier_price_import_rows
      WHERE import_id = (r->>'id')::uuid AND row_number = 3);
    -- A row saved by an older call (out of bound yet awaiting approval) is refused by the pending-row check:
    -- each bound on its own row, so one guard cannot hide another.
    BEGIN
      UPDATE public.supplier_price_import_rows SET row_status = 'new', validation_errors = '{}'
        WHERE import_id = (r->>'id')::uuid AND row_number = 1;
      t := 'NOT REFUSED';
    EXCEPTION WHEN OTHERS THEN t := SQLERRM; END;
    v := v || '|' || (t LIKE '%supplier_price_import_rows_pending_bounds%')::text;
    BEGIN
      UPDATE public.supplier_price_import_rows SET row_status = 'new', validation_errors = '{}', cost_cents = 1000000001
        WHERE import_id = (r->>'id')::uuid AND row_number = 4;
      t := 'NOT REFUSED';
    EXCEPTION WHEN OTHERS THEN t := SQLERRM; END;
    v := v || '|' || (t LIKE '%supplier_price_import_rows_pending_bounds%')::text;`);
  assert.equal(staged, 'ok|invalid:PACKAGE_QUANTITY_INVALID;new:;invalid:COST_TOO_LARGE;new:;invalid:PACKAGE_QUANTITY_INVALID;new:|true|true|true');
  console.log('[stage] qty 0.0001 and NaN -> PACKAGE_QUANTITY_INVALID; qty 0.001 (and 0.000999999, stored as 0.001) -> new;'
    + ' $10,000,000.01 -> COST_TOO_LARGE (amount not kept); $10,000,000.00 -> new; a pending row below the quantity floor or above the cost ceiling is refused');

  // 3. Bounds and a normal quote approve, and both reads still work.
  const approved = attempt(ADMIN, asUser(`r := ${stage([
    quoteRow(BOUND, '10000000.00', '0.001', '2026-11-10'),
    quoteRow(NORMAL, '45.00', '2', '2026-11-10'),
  ])};`) + ` u := (r->>'id')::uuid;
    r3 := (SELECT jsonb_agg(id ORDER BY row_number) FROM public.supplier_price_import_rows WHERE import_id = u);`
    + asUser(`r2 := public.approve_supplier_price_import(u,
      ARRAY(SELECT jsonb_array_elements_text(r3)::uuid), '${ADMIN}', '${key('approve')}');`)
    + ` v := ${rowStatuses};`, { commit: true });
  assert.equal(approved, 'ok|approved:;approved:', `approve: ${approved}`);
  const costs = attempt(ADMIN, asUser(`r := public.get_supplier_market_evidence(ARRAY['${PRODUCT}'::uuid]);`) + `
    v := (SELECT string_agg(s->>'product_supplier_link_id' || '=' || (s->>'normalized_cost_cents'), ',' ORDER BY s->>'normalized_cost_cents')
          FROM jsonb_array_elements(r->0->'suppliers') s);`);
  assert.equal(costs, `ok|${BOUND}=1000000000000000,${NORMAL}=900`, `market evidence: ${costs}`);
  assert.equal(attempt(ADMIN, asUser(`r := public.get_supplier_pricing_workspace(NULL, NULL);`) + ` v := (r ? 'evidence')::text;`),
    'ok|true', 'workspace read succeeds');
  console.log('[read] bound row -> 1,000,000,000,000,000 cents; $45.00 for 2 cases at 2.5 gal/case -> 900 cents; workspace read ok');

  // 4. Correction ceiling.
  const OBS = scalar(`SELECT id FROM public.supplier_price_observations WHERE product_supplier_link_id = '${NORMAL}';`);
  assert.match(attempt(ADMIN, `${refuse(`r := public.correct_supplier_price_observation('${OBS}', '10000000.01', 'typo', '${ADMIN}', '${key('fix')}');`)} v := t;`),
    // The correction writes its import row before the observation, so the pending-row check refuses it first.
    /^ok\|.*violates check constraint "supplier_price_import_rows_pending_bounds"/, 'correction above the ceiling refused');
  assert.match(attempt(ADMIN, asUser(`r := public.correct_supplier_price_observation('${OBS}', '50.00', 'typo', '${ADMIN}', '${key('fix')}');`) + ` v := 'saved';`),
    /^ok\|saved$/, 'a normal correction saves');
  console.log('[correct] $10,000,000.01 refused by the pending-row check; $50.00 saves');

  console.log('\nSUPPLIER_QUOTE_UNIT_FLOOR_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
