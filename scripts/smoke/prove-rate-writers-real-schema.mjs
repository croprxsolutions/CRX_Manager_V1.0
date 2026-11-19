#!/usr/bin/env node
/**
 * Real-schema proof for 20270126100000_product_rate_direct_writes_revoked (RT-4b; contract
 * docs/plans/2026-11-18-product-RT4b-writers-CONTRACT.md, proof cases W1 to W5).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (the shared undo-paths harness), shows an admin
 * can still write a rate column directly, applies the candidate, then checks as a signed-in admin, a sales rep
 * and anon that direct rate writes are refused while every rate RPC still writes rates.
 *
 * Run: node scripts/smoke/prove-rate-writers-real-schema.mjs   (needs Docker)
 * Prints RATE_WRITERS_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

process.env.UNDO_PATHS_CONTAINER ||= `crx-rt4b-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, scalar, psql, claims, USERS, ROOT, NAME, docker } =
  await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270126100000_product_rate_direct_writes_revoked.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const ADMIN = USERS.admin;
const REP = USERS.rep;
const U = '7c7a0000-0000-4000-8000-0000000000d1';
const RATE_COLS = ['rate_per_acre', 'rate_unit', 'suggested_rate'];
const J = (o) => `'${JSON.stringify(o).replaceAll("'", "''")}'::jsonb`;

// One statement as `role`, signed in as `uid`; the last output line is the answer.
function run(uid, sql, { role = 'authenticated', commit = true } = {}) {
  const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
    { input: `BEGIN;\n${claims(uid)}\nSET LOCAL ROLE ${role};\n${sql}\n${commit ? 'COMMIT' : 'ROLLBACK'};`, allowFailure: true });
  return { status: r.status, out: r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '', err: r.stderr };
}
const ok = (uid, sql, opts) => { const r = run(uid, sql, opts); assert.equal(r.status, 0, `${sql}\n${r.err}`); return r.out; };
const okJson = (uid, sql) => JSON.parse(ok(uid, sql));
const refused = (uid, sql, pattern, opts = {}) => {
  const r = run(uid, sql, { ...opts, commit: false });
  assert.notEqual(r.status, 0, `expected a refusal:\n${sql}`); assert.match(r.err, pattern, r.err);
};
const rates = (id) => scalar(`SELECT concat_ws('|', rate_per_acre, rate_unit, suggested_rate) FROM public.products WHERE id = '${id}';`);
const rateEvents = () => Number(scalar('SELECT count(*) FROM public.product_rate_events;'));
const count = (sql) => `WITH w AS (${sql} RETURNING 1) SELECT count(*) FROM w;`;
const version = (parent) => scalar(`SELECT parent_version FROM public.product_parents WHERE id = '${parent}';`);
const previewParent = (parent, rate, unit) => okJson(ADMIN, `SELECT public.preview_parent_rates('${parent}', ${rate}, '${unit}', NULL);`);

function seed() {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  psql(`INSERT INTO public.product_form_units (product_form, unit) SELECT * FROM (VALUES ('seed', 'Lb'), ('seed', 'Unit')) v(f, u)
    WHERE NOT EXISTS (SELECT 1 FROM public.product_form_units x WHERE x.product_form = v.f AND x.unit = v.u);`);
  // Fixture prices go in past the pricing guard, as the other rate provers seed them.
  psql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, tier1_price, tier2_price, tier3_price, pricing_version, is_active)
      VALUES ('${U}', '[RT4B] Loose Liquid', 'RT4B-U', 'liquid', 'Gal', 'Gal', 40, 36, 32, 1, true);
    UPDATE public.product_rate_lock SET is_locked = false WHERE id; COMMIT;`, { user: 'supabase_admin' });
}

function main() {
  // CRX_PROVER_REUSE=1 with UNDO_PATHS_CONTAINER: rerun the checks on a kept, seeded container before the candidate.
  if (process.env.CRX_PROVER_REUSE !== '1') seed();
  // Before: the hole is real (an admin can write a rate column directly; rolled back).
  assert.equal(ok(ADMIN, count(`UPDATE public.products SET rate_per_acre = 5, rate_unit = 'oz' WHERE id = '${U}'`), { commit: false }), '1');
  // The helper postflight really checks: an API role able to run a rate helper refuses the whole file (rolled back).
  const leaked = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
    { input: `BEGIN; DO $g$ DECLARE f regprocedure; BEGIN FOR f IN SELECT oid::regprocedure FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname = '_write_product_rates' LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f); END LOOP; END $g$;
      
${candidate}
ROLLBACK;`, allowFailure: true });
  assert.notEqual(leaked.status, 0); assert.match(leaked.stderr, /POSTFLIGHT_RATE_HELPER_EXECUTABLE: authenticated _write_product_rates/, leaked.stderr);
  const applied = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
    { input: candidate, allowFailure: true });
  assert.equal(applied.status, 0, `candidate failed:\n${applied.stderr}`);
  console.log('[rt4b] candidate applied; its postflight passed (W5: every other products privilege kept)');

  // W1: each rate column alone, to a new value and to its same value, is refused; the name still saves.
  const before = rates(U);
  for (const col of RATE_COLS) {
    const value = col === 'rate_per_acre' ? '5' : "'x'";
    refused(ADMIN, `UPDATE public.products SET ${col} = ${value} WHERE id = '${U}';`, /permission denied/);
    refused(ADMIN, `UPDATE public.products SET ${col} = ${col} WHERE id = '${U}';`, /permission denied/);
  }
  assert.equal(rates(U), before, 'a refused write changed a rate');
  assert.equal(ok(ADMIN, count(`UPDATE public.products SET product_name = '[RT4B] Loose Liquid 2' WHERE id = '${U}'`)), '1');

  // W2: inserts naming a rate column are refused; a plain seed insert takes its stock unit as rate unit.
  for (const col of RATE_COLS) {
    refused(ADMIN, `INSERT INTO public.products (product_name, sku, ${col}) VALUES ('[RT4B] X', 'RT4B-X', ${col === 'rate_per_acre' ? '1' : "'oz'"});`, /permission denied/);
  }
  assert.equal(ok(ADMIN, `INSERT INTO public.products (product_name, sku, product_form, inventory_unit)
    VALUES ('[RT4B] Seed', 'RT4B-S', 'seed', 'Lb') RETURNING rate_unit;`), 'Lb');
  assert.equal(ok(REP, count(`UPDATE public.products SET product_name = 'rep' WHERE id = '${U}'`), { commit: false }), '0');
  refused(ADMIN, `UPDATE public.products SET product_name = 'anon' WHERE id = '${U}';`, /permission denied/, { role: 'anon' });
  console.log('[rt4b] W1/W2: direct rate writes refused for admin; name edits, seed inserts, rep and anon unchanged');

  // W3 (lock off): each RPC writer still writes rates, with its event.
  okJson(ADMIN, `SELECT public.set_product_rates(jsonb_build_array(jsonb_build_object('product_id', id, 'rate_per_acre', '13',
      'rate_unit', 'oz', 'suggested_rate', '13 oz/A', 'expected', jsonb_build_object('rate_per_acre', rate_per_acre::text,
      'rate_unit', rate_unit, 'suggested_rate', suggested_rate, 'pricing_version', pricing_version, 'unit_size', unit_size,
      'inventory_unit', inventory_unit, 'product_form', product_form,
      'prices', public.preview_product_rate_correction(id, 13, 'oz')->'after'))), '${ADMIN}', 'rt4b-set')
    FROM public.products WHERE id = '${U}';`);
  assert.equal(rates(U), '13|oz|13 oz/A');
  // While rates are open, a rate set is logged per field in the product's change history.
  assert.equal(scalar(`SELECT count(DISTINCT field_name) FROM public.product_change_history WHERE product_id = '${U}' AND field_name IN ('rate_per_acre', 'rate_unit', 'suggested_rate');`), '3');

  const imported = [{ insert: { product_name: '[RT4B] Imported', sku: 'RT4B-I', product_form: 'liquid', inventory_unit: 'Gal' },
    rates: { rate_per_acre: '4', rate_unit: 'oz', suggested_rate: '4 oz/A' } }];
  const p = okJson(ADMIN, `SELECT public.preview_product_import(${J(imported)});`);
  ok(ADMIN, `SELECT public.apply_product_setup(${J([{ ...imported[0], expected_prices: p.rows[0].expected_prices }])}, '${ADMIN}', 'rt4b-import');`);
  assert.equal(scalar("SELECT concat_ws('|', rate_per_acre, rate_unit, suggested_rate) FROM public.products WHERE sku = 'RT4B-I';"), '4|oz|4 oz/A');

  const A = okJson(ADMIN, `SELECT public.create_product_with_parent(${J({ name: '[RT4B] Alpha', product_form: 'liquid', category: 'Herbicide' })},
    ${J({ product_name: '[RT4B] Alpha 2.5', sku: 'RT4B-A1', inventory_unit: 'Gal' })}, 'rt4b-a');`);
  let pv = previewParent(A.parent_id, 4, 'oz');
  ok(ADMIN, `SELECT public.set_parent_rates(${J([{ parent_id: A.parent_id, expected_parent_version: pv.parent_version, rate_per_acre: '4',
    rate_unit: 'oz', suggested_rate: null, sizes: pv.sizes }])}, 'rt4b-a-rates');`);
  assert.equal(rates(A.product_id), '4|oz');
  const A2 = okJson(ADMIN, `SELECT public.add_product_size('${A.parent_id}', ${version(A.parent_id)},
    ${J({ product_name: '[RT4B] Alpha 1', sku: 'RT4B-A2', inventory_unit: 'Gal' })}, 'rt4b-a2');`);
  assert.equal(rates(A2.product_id), '4|oz', 'add_product_size did not copy the parent rate');
  const C = okJson(ADMIN, `SELECT public.create_product_with_parent(${J({ name: '[RT4B] Gamma', product_form: 'liquid', category: 'Herbicide' })},
    ${J({ product_name: '[RT4B] Gamma 1', sku: 'RT4B-C1', inventory_unit: 'Gal' })}, 'rt4b-c');`);
  const m = okJson(ADMIN, `SELECT public.preview_move_product_size('${C.product_id}', '${A.parent_id}');`);
  assert.equal(m.refusal, null, JSON.stringify(m));
  ok(ADMIN, `SELECT public.move_product_size('${C.product_id}', '${A.parent_id}', ${m.from_parent_version}, ${m.to_parent_version},
    '${m.size_fingerprint}', 'wrong group', 'label photo', ${J(m.prices)}, 'rt4b-move');`);
  assert.equal(rates(C.product_id), '4|oz', 'move_product_size did not copy the target rate');

  // W3 (lock on): the corrections still write.
  ok(ADMIN, `SELECT public.set_product_rate_lock(true, 'season set', '${ADMIN}', 'rt4b-lock');`);
  const events = rateEvents();
  ok(ADMIN, `SELECT public.correct_product_rates(id, 14, 'oz', '14 oz/A', pricing_version,
      jsonb_build_object('rate_per_acre', rate_per_acre::text, 'rate_unit', rate_unit, 'suggested_rate', suggested_rate,
        'prices', public.preview_product_rate_correction(id, 14, 'oz')->'after'), 'label says 14', '${ADMIN}', 'rt4b-correct')
    FROM public.products WHERE id = '${U}';`);
  assert.equal(rates(U), '14|oz|14 oz/A'); assert.ok(rateEvents() > events, 'correct_product_rates logged no event');
  pv = previewParent(A.parent_id, 5, 'oz');
  assert.equal(pv.sizes.length, 3);
  ok(ADMIN, `SELECT public.correct_parent_rates('${A.parent_id}', 5, 'oz', NULL, ${pv.parent_version}, ${J(pv.sizes)}, 'label says 5', 'rt4b-pcorrect');`);
  for (const id of [A.product_id, A2.product_id, C.product_id]) assert.equal(rates(id), '5|oz');
  assert.equal(scalar("SELECT count(*) FROM public.product_rate_events WHERE event_type = 'corrected' AND reason = 'label says 5';"), '3');
  console.log('[rt4b] W3: set, import, parent rates, add size, move size, product and parent corrections all still write rates');

  // W4: RT-4a's RPCs: authenticated may call them, metabase_ro and anon may not.
  for (const fn of ['public.preview_parent_rate_cutover(uuid,text)', 'public.commit_parent_rate_cutover(uuid,text,jsonb,text,text)']) {
    assert.equal(scalar(`SELECT has_function_privilege('metabase_ro', '${fn}', 'EXECUTE')::text || has_function_privilege('anon', '${fn}', 'EXECUTE')::text
      || has_function_privilege('authenticated', '${fn}', 'EXECUTE')::text;`), 'falsefalsetrue', fn);
  }
  console.log('RATE_WRITERS_PROOF_PASS');
}

try { main(); } finally { if (!KEEP && process.env.CRX_PROVER_REUSE !== '1') removeContainer(); else console.log(`[rt4b] kept ${NAME}`); }
