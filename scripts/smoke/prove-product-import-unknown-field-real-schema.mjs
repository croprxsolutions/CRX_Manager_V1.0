#!/usr/bin/env node
/**
 * Real-schema proof for 20270224200000_product_import_preview_refuses_unknown_fields.sql (KI-103).
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs), shows the old preview passed (status ok) for a row the save
 * then refused, applies the candidate (autocommit refused, POSTFLIGHT_OK, re-apply refused by the md5 pin), then checks
 * the preview refuses an unknown top-level field by name, still previews good rows, and the save is unchanged.
 * Every probe is rolled back.
 *
 * Run: node scripts/smoke/prove-product-import-unknown-field-real-schema.mjs   (needs Docker; never touches live)
 * Prints PRODUCT_IMPORT_UNKNOWN_FIELD_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, USERS, ROOT, NAME, docker, scalar } from './undo-paths/harness.mjs';

const CANDIDATE = '20270224200000_product_import_preview_refuses_unknown_fields.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
const q = (v) => JSON.stringify(v).replaceAll("'", "''");
const good = { insert: { product_name: '[KI103] Good', sku: 'KI103-1', product_form: 'liquid', inventory_unit: 'Gal' } };
const extra = { insert: { product_name: '[KI103] Extra', sku: 'KI103-2', product_form: 'liquid', inventory_unit: 'Gal' }, notes_typo: 'x', Rates: {} };
const preview = (rows) => `public.preview_product_import('${q(rows)}'::jsonb)`;
const save = (rows, key) => `public.apply_product_setup('${q(rows)}'::jsonb, '${USERS.admin}', '${key}')`;
const statuses = `(SELECT string_agg(e->>'status', ',' ORDER BY (e->>'row')::int) FROM jsonb_array_elements(r->'rows') e)`;
const errors = `(SELECT string_agg(coalesce(e->>'error', ''), ' ; ' ORDER BY (e->>'row')::int) FROM jsonb_array_elements(r->'rows') e)`;
const products = `(SELECT count(*) FROM public.products WHERE product_name LIKE '[KI103]%')`;

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();

  // Before: the preview passes the extra-field row as ok, then the save refuses the whole file.
  const before = attempt(USERS.admin, `${asUser(`r := ${preview([good, extra])};`)} v := ${statuses} || ' / ' || coalesce(${errors}, '');
    ${refuse(`r2 := ${save([good, extra], 'kb')};`)} v := v || '|' || split_part(t, ':', 1);`);
  assert.match(before, /^ok\|[^|]*\|PRODUCT_SETUP_ROW_SHAPE_INVALID$/, `old behavior not reproduced: ${before}`);
  assert.doesNotMatch(before.split('|')[1], /error|refused|invalid/i, `old preview already flagged it: ${before}`);
  console.log(`[before] preview said "${before.split('|')[1]}", save refused the file`);

  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /PREFLIGHT_FAIL: preview_product_import changed/, 're-apply must refuse');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');

  // The live body now carries the KI-103 block.
  assert.equal(scalar("SELECT (prosrc LIKE '%KI-103%')::text FROM pg_proc WHERE oid = 'public.preview_product_import(jsonb)'::regprocedure;"), 'true');

  // After: the preview refuses the file and names each unknown field; nothing saved.
  assert.equal(attempt(USERS.admin, `${refuse(`r := ${preview([good, extra])};`)} v := t || '|' || ${products};`),
    'ok|PRODUCT_SETUP_ROW_SHAPE_INVALID: a row has a field the save does not accept: notes_typo, Rates|0');
  // A good file still previews ok and saves, and the save still accepts rates / expected_prices.
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${preview([good])};`)} v := ${statuses};
    ${asUser(`r2 := ${save([good], 'kg')};`)} v := v || '|' || (r2->>'inserted_count') || '|' || ${products};`), 'ok|ok|1|1');
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${preview([{ ...good, rates: { rate_per_acre: '2', rate_unit: 'oz', suggested_rate: null } }])};`)} v := ${statuses};`), 'ok|ok');
  // expected_prices without rates: the save refuses it, so the preview refuses it too (Taha LOW).
  assert.equal(attempt(USERS.admin, `${refuse(`r := ${preview([{ ...good, expected_prices: null }])};`)} v := t;`),
    'ok|PRODUCT_SETUP_ROW_SHAPE_INVALID: a row has "expected_prices" without "rates"; the save refuses it');
  // rates plus expected_prices (the shape the screen saves) still previews ok.
  assert.equal(attempt(USERS.admin, `${asUser(`r := ${preview([{ ...good, rates: { rate_per_acre: '2', rate_unit: 'oz', suggested_rate: null }, expected_prices: {} }])};`)} v := ${statuses};`), 'ok|ok');
  // Existing shape and permission refusals are unchanged.
  assert.equal(attempt(USERS.admin, `${refuse(`r := ${preview([{ rates: {} }])};`)} v := split_part(t, ':', 1);`), 'ok|PRODUCT_SETUP_ROW_SHAPE_INVALID');
  assert.equal(attempt(USERS.admin, `${refuse(`r := ${preview(['x'])};`)} v := split_part(t, ':', 1);`), 'ok|PRODUCT_SETUP_ROW_SHAPE_INVALID');
  assert.match(attempt(USERS.rep, `${refuse(`r := ${preview([good])};`)} v := t;`), /ADMIN_REQUIRED/);
  assert.match(attempt(USERS.admin, `SET LOCAL ROLE anon; BEGIN r := ${preview([good])}; v := 'NOT REFUSED'; EXCEPTION WHEN OTHERS THEN v := SQLERRM; END; RESET ROLE;`),
    /permission denied/);
  console.log('[after] unknown field refused at preview by name; good rows, rates and old refusals unchanged');

  console.log('\nPRODUCT_IMPORT_UNKNOWN_FIELD_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
