#!/usr/bin/env node
/**
 * Real-schema proof for 20270301130000_product_rate_unit_invoice_guard (#2367; contract
 * docs/plans/2026-11-24-product-rate-unit-guard-CONTRACT.md, cases R1 to R8).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container, replays
 * every post-baseline migration before the candidate (the shared undo-paths harness), creates invented groups through
 * the real parent RPCs while rates are unlocked, plants products already in the bad state, applies the candidate (a
 * second run refuses), then checks each case through the real RPCs as a signed-in admin. Refusal probes run in
 * rolled-back transactions.
 *
 * Run: node scripts/smoke/prove-product-rate-unit-guard-real-schema.mjs   (needs Docker)
 * Prints PRODUCT_RATE_UNIT_GUARD_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

process.env.UNDO_PATHS_CONTAINER ||= `crx-rug-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, scalar, psql, attempt, asUser, USERS, ROOT, NAME, docker } =
  await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270301130000_product_rate_unit_invoice_guard.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const ADMIN = USERS.admin;
const sq = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replaceAll("'", "''")}'`);
const raw = (sql) => psql(`BEGIN; SET LOCAL session_replication_role = replica; ${sql} COMMIT;`, { user: 'supabase_admin' });
const runCandidate = () => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
  { input: candidate, allowFailure: true });

// name, form, stock unit, rate set before the candidate [rate, unit] or null.
// MG (milligrams) converts in unit_conversions, so the rate-unit check accepts lb on it, but field-app invoices
// cannot price lb in MG: the gap #2367 closes.
const GROUPS = [
  ['DryLb', 'dry', 'Lb', [2, 'Lb']],
  ['MgHome', 'dry', 'MG', null],
  ['Mg', 'dry', 'MG', null],
  ['Planted', 'dry', 'MG', [2, 'Lb']],  // already bad before the guard
  ['OldBad', 'dry', 'MG', [2, 'Lb']],   // bad old rate, then switched to a blank approved rate
  ['NoDef', 'dry', 'Lb', [2, 'Lb']],    // switched to a blank approved rate
  ['Appr', 'liquid', 'Gal', [48, 'oz']],  // switched to an approved 40 fl oz/acre
];

const MK = `
CREATE SCHEMA IF NOT EXISTS rug_proof;
CREATE TABLE IF NOT EXISTS rug_proof.ids (name text PRIMARY KEY, parent uuid NOT NULL, product uuid NOT NULL);
CREATE OR REPLACE FUNCTION rug_proof.mk(p_name text, p_form text, p_unit text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  r := public.create_product_with_parent(jsonb_build_object('name', '[RUG] ' || p_name, 'product_form', p_form),
    jsonb_build_object('product_name', '[RUG] ' || p_name || ' 1', 'sku', 'RUG-' || left(md5(p_name), 10), 'inventory_unit', p_unit), 'rug-mk-' || p_name);
  INSERT INTO rug_proof.ids VALUES (p_name, (r->>'parent_id')::uuid, (r->>'product_id')::uuid);
END $$;
CREATE OR REPLACE FUNCTION rug_proof.rates(p_parent uuid, p_rate numeric, p_unit text, p_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_prev jsonb;
BEGIN
  v_prev := public.preview_parent_rates(p_parent, p_rate, p_unit, NULL);
  RETURN public.set_parent_rates(jsonb_build_array(jsonb_build_object('parent_id', p_parent,
    'expected_parent_version', (v_prev->>'parent_version')::bigint, 'rate_per_acre', p_rate::text, 'rate_unit', p_unit,
    'suggested_rate', NULL, 'sizes', v_prev->'sizes')), p_key);
END $$;
CREATE OR REPLACE FUNCTION rug_proof.add(p_parent uuid, p_unit text, p_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.add_product_size(p_parent, (SELECT parent_version FROM public.product_parents WHERE id = p_parent),
    jsonb_build_object('product_name', '[RUG] ' || p_key, 'sku', 'RUG-' || left(md5(p_key), 12), 'inventory_unit', p_unit), p_key);
END $$;
CREATE OR REPLACE FUNCTION rug_proof.move(p_product uuid, p_to uuid, p_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb := public.preview_move_product_size(p_product, p_to);
BEGIN
  IF v->>'refusal' IS NOT NULL THEN RAISE EXCEPTION 'MOVE_PREVIEW_REFUSED: %', v->>'refusal'; END IF;
  RETURN public.move_product_size(p_product, p_to, (v->>'from_parent_version')::bigint, (v->>'to_parent_version')::bigint,
    v->>'size_fingerprint', 'RUG move', 'RUG evidence', v->'prices', p_key);
END $$;
GRANT USAGE ON SCHEMA rug_proof TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rug_proof TO authenticated;`;

const P = {};
const ok = (out) => { assert.match(out, /^ok\|/, out); return out.slice(3); };
const refused = (out, pattern) => { assert.doesNotMatch(out, /^ok\|/, `expected a refusal, got ${out}`); assert.match(out, pattern, out); };
const row = (sql) => scalar(sql);
const md5Of = (table) => scalar(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) FROM public.${table} t;`);
const asAdmin = (sql, opts) => attempt(ADMIN, `${asUser(sql)} v := coalesce(r::text, '');`, opts);
const rates = (parent, rate, unit, key, opts) => asAdmin(`r := rug_proof.rates('${parent}', ${rate === null ? 'NULL' : rate}, ${sq(unit)}, ${sq(key)});`, opts);
const add = (parent, unit, key, opts) => asAdmin(`r := rug_proof.add('${parent}', ${sq(unit)}, ${sq(key)});`, opts);
const sizeUnits = (parent) => row(`SELECT string_agg(p.inventory_unit || ':' || coalesce(p.rate_per_acre::text, '-') || ' ' || coalesce(p.rate_unit, '-'), ',' ORDER BY p.product_name)
  FROM public.product_parent_members m JOIN public.products p ON p.id = m.product_id WHERE m.parent_id = '${parent}';`);
const cutover = (parent, dir, key, opts = {}) => asAdmin(`r := public.preview_parent_rate_cutover('${parent}', ${sq(dir)});
  IF NOT (r->>'eligible')::boolean THEN RAISE EXCEPTION 'NOT_ELIGIBLE: %', r->>'refusal'; END IF;
  r := public.commit_parent_rate_cutover('${parent}', ${sq(dir)}, r->'expected', 'RUG test', ${sq(key)});`, opts);
const NOT_INVOICEABLE = /PRODUCT_RATE_UNIT_NOT_INVOICEABLE/;
const NOT_RESTORABLE = /PRODUCT_PARENT_SIZE_NOT_RESTORABLE/;

function seedFixtures() {
  seedUsers();
  raw('UPDATE public.product_rate_lock SET is_locked = false WHERE id;');
  psql(MK);
  for (const [name, form, unit] of GROUPS) ok(attempt(ADMIN, `PERFORM rug_proof.mk(${sq(name)}, ${sq(form)}, ${sq(unit)});`, { commit: true }));
  for (const line of row("SELECT string_agg(name || '=' || parent || '=' || product, ';') FROM rug_proof.ids;").split(';')) {
    const [name, parent, product] = line.split('=');
    P[name] = parent; P[`${name}Size`] = product;
  }
  raw(GROUPS.map(([name]) => `UPDATE public.products SET tier1_price = 30, tier2_price = 30, tier3_price = 30 WHERE id = '${P[`${name}Size`]}';`).join('\n'));
  for (const [name, , , r] of GROUPS) if (r) ok(rates(P[name], r[0], r[1], `rug-rates-${name}`, { commit: true }));
  // RT-3 decisions for the groups switched later: blank approved rates (no per-acre default), and an approved 40 fl oz.
  raw(`INSERT INTO public.product_rates (parent_id, basis, source, recommended, unit, is_quoting_default, basis_confirmed, status, approved_by, approved_at, origin, created_by, updated_by)
      VALUES ('${P.Appr}', 'per_acre', 'house_standard', 40, 'fl_oz', true, true, 'approved', '${ADMIN}', now(), 'manual', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_rate_outcomes (parent_id, outcome, decided_by, decided_at) VALUES
      ('${P.OldBad}', 'no_per_acre_default', '${ADMIN}', now()), ('${P.NoDef}', 'no_per_acre_default', '${ADMIN}', now()),
      ('${P.Appr}', 'approved_default', '${ADMIN}', now());`);
}

function main() {
  buildContainer({ stopBefore: CANDIDATE });
  seedFixtures();
  // Before the candidate, the gap is open: a size sold in MG takes a lb rate (rolled back).
  ok(add(P.DryLb, 'MG', 'rug-before'));
  assert.equal(row(`SELECT rate_unit FROM public.products WHERE id = '${P.PlantedSize}';`), 'Lb', 'Planted should hold its bad unit');

  // R8: the migration changes no row; a second run refuses; no API role can call the guard functions.
  const tables = ['products', 'product_parents', 'product_parent_members', 'product_rates'];
  const before = tables.map(md5Of);
  const applied = runCandidate();
  assert.equal(applied.status, 0, `candidate failed:\n${applied.stderr}`);
  assert.notEqual(runCandidate().status, 0, 'a second run must refuse');
  assert.deepEqual(tables.map(md5Of), before, 'the migration must not change rows');
  for (const fn of ['_product_rate_unit_invoiceable(text,text,text)', '_product_size_restore_problem(uuid,text,text,text,text)',
    'guard_product_field_app_unit()', 'guard_product_parent_member_restorable()']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(row(`SELECT has_function_privilege('${role}', 'public.${fn}', 'EXECUTE');`), 'f', `${role} can execute ${fn}`);
    }
  }

  // R1: Add a size sold in a unit the group's rate unit cannot reach: refused, nothing saved.
  const membersBefore = md5Of('product_parent_members');
  refused(add(P.DryLb, 'MG', 'rug-r1'), /PRODUCT_RATE_UNIT_NOT_INVOICEABLE: field-app invoices could not convert the rate unit "Lb" of "\[RUG\] rug-r1" to its sold unit "MG" \(dry\)/);
  assert.equal(md5Of('product_parent_members'), membersBefore);
  // R2: the same group with a sold unit invoices can convert: added, with the group's rate.
  ok(add(P.DryLb, 'Dry oz', 'rug-r2', { commit: true }));
  assert.equal(sizeUnits(P.DryLb), 'Lb:2 Lb,Dry oz:2 Lb');

  // R3: a new standalone product (the import path) with a rate unit invoices cannot convert: refused; blank: saved.
  const setup = (unit, key, opts) => asAdmin(`r := public.apply_product_setup(jsonb_build_array(jsonb_build_object(
      'insert', jsonb_build_object('product_name', '[RUG] ' || ${sq(key)}, 'sku', 'RUG-' || left(md5(${sq(key)}), 12), 'product_form', 'dry', 'inventory_unit', 'MG'),
      'rates', jsonb_build_object('rate_per_acre', ${unit ? "'2'" : 'NULL'}, 'rate_unit', ${sq(unit)}, 'suggested_rate', NULL),
      'expected_prices', '{"tier1_price_per_acre": null, "tier2_price_per_acre": null, "tier3_price_per_acre": null}'::jsonb)),
    auth.uid(), ${sq(key)});`, opts);
  refused(setup('Lb', 'rug-r3-bad'), NOT_INVOICEABLE);
  ok(setup(null, 'rug-r3-blank'));
  // A direct INSERT carrying the bad unit is refused by the same rule.
  refused(attempt(ADMIN, `INSERT INTO public.products (product_name, sku, product_form, inventory_unit, unit_size, rate_unit)
    VALUES ('[RUG] r3-direct', 'RUG-R3-DIRECT', 'dry', 'MG', 'MG', 'Lb'); v := 'x';`), NOT_INVOICEABLE);
  // Direct table writes run as the database owner on purpose: the browser role cannot write products at all
  // (permission denied), so these show the trigger refuses any writer, e.g. a migration or a service job.
  // A rate unit of only spaces is not blank to the field app (it copies it), so it is refused too (Sol r1 HIGH),
  // directly and through the app's group rates save.
  // (the group rates save already refuses it as an unknown unit before this guard)
  refused(rates(P.Mg, 3, '   ', 'rug-r3-spaces-rates'), /PRODUCT_RATE_UNIT_INVALID|PRODUCT_RATE_UNIT_NOT_INVOICEABLE/);
  refused(attempt(ADMIN, `INSERT INTO public.products (product_name, sku, product_form, inventory_unit, unit_size, rate_unit)
    VALUES ('[RUG] r3-spaces', 'RUG-R3-SPACES', 'liquid', 'Gal', 'Gal', '   '); v := 'x';`), NOT_INVOICEABLE);

  // R4: a blank rate that keeps a unit invoices cannot convert is refused; blank rate and unit saves; a converting
  // unit saves.
  refused(rates(P.Mg, null, 'Lb', 'rug-r4-bad'), NOT_INVOICEABLE);
  ok(rates(P.Mg, 3, 'MG', 'rug-r4-good'));
  ok(rates(P.Planted, null, null, 'rug-r4-clear'));

  // R5: Move an MG size into a group whose rate unit cannot reach it: refused.
  refused(asAdmin(`r := rug_proof.move('${P.MgHomeSize}', '${P.DryLb}', 'rug-r5');`), NOT_INVOICEABLE);

  // R6: a product already in that state stays editable; a change to another bad unit is refused; a fix saves.
  ok(attempt(ADMIN, `UPDATE public.products SET quoting_notes = 'RUG note' WHERE id = '${P.PlantedSize}'; v := 'x';`));
  refused(rates(P.Planted, 2, 'Dry oz', 'rug-r6-bad'), NOT_INVOICEABLE);
  ok(rates(P.Planted, 2, 'MG', 'rug-r6-fix'));

  // R7: groups on their approved rate. Lock rates, switch three groups to their approved rates.
  raw('UPDATE public.product_rate_lock SET is_locked = true WHERE id;');
  for (const name of ['OldBad', 'NoDef', 'Appr']) ok(cutover(P[name], 'promote', `rug-promote-${name}`, { commit: true }));
  assert.equal(sizeUnits(P.NoDef), 'Lb:- -');
  // A size the old unit could not be invoiced on cannot join (its copied rate is blank, so only this check sees it).
  refused(add(P.NoDef, 'MG', 'rug-r7-join'), /PRODUCT_PARENT_SIZE_NOT_RESTORABLE: "\[RUG\] NoDef" could not be switched back to its old rate with "\[RUG\] rug-r7-join" in it: field-app invoices could not convert its old rate unit "Lb" to this size's sold unit "MG"/);
  // Changing a saved size's sold unit is refused today by the earlier sold-unit freeze, before this guard runs;
  // this guard's sold-unit leg is a backstop for when that freeze is lifted.
  refused(attempt(ADMIN, `UPDATE public.products SET inventory_unit = 'MG' WHERE id = '${P.NoDefSize}'; v := 'x';`),
    /waits for the reviewed unit change/);
  // A good size joins; switching back then restores the old rate on both sizes.
  ok(add(P.NoDef, 'Dry oz', 'rug-r7-good', { commit: true }));
  ok(cutover(P.NoDef, 'restore', 'rug-restore-NoDef', { commit: true }));
  assert.equal(sizeUnits(P.NoDef), 'Lb:2 Lb,Dry oz:2 Lb');
  // A size added to the approved 40 fl oz group copies it, and switching back restores the old 48 oz.
  ok(add(P.Appr, 'qt', 'rug-r7-appr', { commit: true }));
  ok(cutover(P.Appr, 'restore', 'rug-restore-Appr', { commit: true }));
  assert.equal(sizeUnits(P.Appr), 'Gal:48 oz,qt:48 oz');
  // A size that already could not switch back (lb on MG) stays editable: a unit size fix saves (Sol r1 MED).
  ok(attempt(ADMIN, `UPDATE public.products SET unit_size = '1 MG' WHERE id = '${P.OldBadSize}'; v := 'x';`));
  // Rule 4: switching back puts a pre-guard bad unit back (lb on MG), which rule 1 would refuse elsewhere.
  ok(cutover(P.OldBad, 'restore', 'rug-restore-OldBad', { commit: true }));
  assert.equal(sizeUnits(P.OldBad), 'MG:2 Lb');

  console.log('PRODUCT_RATE_UNIT_GUARD_PROOF_PASS');
}

try {
  main();
} finally {
  if (!KEEP) removeContainer();
}
