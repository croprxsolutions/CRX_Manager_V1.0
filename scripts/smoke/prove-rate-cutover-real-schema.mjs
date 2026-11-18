#!/usr/bin/env node
/**
 * Real-schema proof for 20270125100000_product_rate_cutover (RT-4a; contract
 * docs/plans/2026-11-17-product-RT4-cutover-CONTRACT.md, proof cases P1 to P9).
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17 container,
 * replays every post-baseline migration before the candidate (the shared undo-paths harness), creates invented
 * parents through the real parent RPCs while rates are unlocked, puts RT-3's approved rows and outcomes in place,
 * turns the rate lock on, applies the candidate (a renamed held parent and a second run both refuse), then checks
 * each case through the real RPCs as a signed-in admin, a sales rep, an inactive admin and anon, plus direct table
 * writes. Refusal probes run in rolled-back transactions.
 *
 * Run: node scripts/smoke/prove-rate-cutover-real-schema.mjs   (needs Docker)
 * Prints RATE_CUTOVER_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

process.env.UNDO_PATHS_CONTAINER ||= `crx-rt4-${process.pid}-${Date.now().toString(36)}`;
const { buildContainer, removeContainer, seedUsers, scalar, psql, attempt, asUser, USERS, ROOT, NAME, docker } =
  await import('./undo-paths/harness.mjs');

const CANDIDATE = '20270125100000_product_rate_cutover.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const ADMIN = USERS.admin;
const REP = USERS.rep;
const OLD_ADMIN = '7c7a0000-0000-4000-8000-0000000000a9';
const PIKSI = 'afdae5f9-3410-4f17-975b-07a1650089ae';
const PIKSI_SIZE = '7c7a0000-0000-4000-8000-0000000000f1';
const INFURROW = 'c9933638-612a-407a-a4a8-6422b5e38c9c';
const INFURROW_SIZE = '7c7a0000-0000-4000-8000-0000000000f2';
const sq = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replaceAll("'", "''")}'`);
const num = (n) => (n === null || n === undefined ? 'NULL' : `${n}::numeric`);
const asAdmin = (sql) => psql(sql, { user: 'supabase_admin' });
const raw = (sql) => asAdmin(`BEGIN; SET LOCAL session_replication_role = replica; ${sql} COMMIT;`);
const runCandidate = (prefix = '') => docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1'],
  { input: `${prefix}${candidate}`, allowFailure: true });

// name, form, stock units, parent rate, rate unit, suggested text, tier price per size.
const FIXTURES = [
  ['MSO', 'liquid', ['Gal'], 9.6, 'oz', '2 qt/100 Gal', [30]],
  ['Smart', 'dry', ['Lb', 'Lb'], 1.8, 'Dry oz', null, [19.65, 20]],
  ['NoDefault', 'liquid', ['Gal'], 2, 'Pt', null, [40]],
  ['SeedOne', 'seed', ['Unit'], 1, null, null, [300]],
  ['Drafts', 'liquid', ['Gal'], 1, 'qt', null, [10]],
  ['Needs', 'liquid', ['Gal'], 1, 'qt', null, [10]],
  ['Undecided', 'liquid', ['Gal'], 1, 'qt', null, [10]],
  ['Blend', 'dry', ['Lb'], 1, 'Dry oz', null, [5]],
  ['Differs', 'liquid', ['Gal', 'Gal'], 1, 'qt', null, [10, 10]],
  ['Inactive', 'liquid', ['Gal'], 1, 'qt', null, [10]],
];
// RT-3's state: rows [basis, source, recommended, unit code, default, status] and the outcome.
const REVIEW = {
  MSO: [[['per_acre', 'house_standard', 9.6, 'fl_oz', true, 'approved']], 'approved_default'],
  Smart: [[['per_acre', 'house_standard', 1.8, 'lb', true, 'approved']], 'approved_default'],
  NoDefault: [[['per_100_gal', 'label', 1, 'qt', false, 'approved']], 'no_per_acre_default'],
  SeedOne: [[], 'no_per_acre_default'],
  Drafts: [[['per_acre', 'house_standard', 1, 'qt', true, 'approved'], ['per_acre', 'label', 2, 'qt', false, 'draft']], 'approved_default'],
  Needs: [[], 'needs_label_data'],
  Undecided: [[], null],
  Blend: [[['per_acre', 'house_standard', 1, 'lb', true, 'approved']], 'approved_default'],
  Differs: [[['per_acre', 'house_standard', 1, 'qt', true, 'approved']], 'approved_default'],
  Inactive: [[['per_acre', 'house_standard', 1, 'qt', true, 'approved']], 'approved_default'],
  Piksi: [[['per_acre', 'house_standard', 18, 'mg', true, 'approved']], 'approved_default'],
  // Held too; given an approved default here so only the hold can refuse it.
  Infurrow: [[['per_acre', 'house_standard', 18, 'mg', true, 'approved']], 'approved_default'],
};

const MK = `
CREATE SCHEMA IF NOT EXISTS rt4_proof;
CREATE TABLE IF NOT EXISTS rt4_proof.ids (name text PRIMARY KEY, parent uuid NOT NULL, products uuid[] NOT NULL);
CREATE OR REPLACE FUNCTION rt4_proof.mk(p_name text, p_form text, p_units text[]) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb; v_parent uuid; i int; v_products uuid[] := '{}';
BEGIN
  r := public.create_product_with_parent(jsonb_build_object('name', '[RT4] ' || p_name, 'product_form', p_form),
    jsonb_build_object('product_name', '[RT4] ' || p_name || ' 1', 'sku', 'RT4-' || left(md5(p_name), 10) || '-1', 'inventory_unit', p_units[1]), 'rt4-mk-' || p_name);
  v_parent := (r->>'parent_id')::uuid; v_products := v_products || (r->>'product_id')::uuid;
  FOR i IN 2..cardinality(p_units) LOOP
    r := public.add_product_size(v_parent, (SELECT parent_version FROM public.product_parents WHERE id = v_parent),
      jsonb_build_object('product_name', '[RT4] ' || p_name || ' ' || i, 'sku', 'RT4-' || left(md5(p_name), 10) || '-' || i, 'inventory_unit', p_units[i]),
      'rt4-add-' || p_name || '-' || i);
    v_products := v_products || (r->>'product_id')::uuid;
  END LOOP;
  INSERT INTO rt4_proof.ids VALUES (p_name, v_parent, v_products);
  RETURN v_parent;
END $$;
CREATE OR REPLACE FUNCTION rt4_proof.rates(p_name text, p_rate numeric, p_unit text, p_text text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_parent uuid := (SELECT parent FROM rt4_proof.ids WHERE name = p_name); v_prev jsonb;
BEGIN
  v_prev := public.preview_parent_rates(v_parent, p_rate, p_unit, p_text);
  PERFORM public.set_parent_rates(jsonb_build_array(jsonb_build_object('parent_id', v_parent,
    'expected_parent_version', (v_prev->>'parent_version')::bigint, 'rate_per_acre', p_rate::text, 'rate_unit', p_unit,
    'suggested_rate', p_text, 'sizes', v_prev->'sizes')), 'rt4-rates-' || p_name);
END $$;`;

const P = {};      // fixture name -> parent id
const SIZES = {};  // fixture name -> size ids, in creation order
const ok = (out) => { assert.match(out, /^ok\|/, out); return out.slice(3); };
const okJson = (out) => JSON.parse(ok(out));
const refused = (out, pattern) => { assert.doesNotMatch(out, /^ok\|/, `expected a refusal, got ${out}`); assert.match(out, pattern, out); };
const preview = (parent, dir, uid = ADMIN) => attempt(uid, `${asUser(`r := public.preview_parent_rate_cutover('${parent}', ${sq(dir)});`)} v := r::text;`);
const ineligible = (parent, dir, pattern) => {
  const r = okJson(preview(parent, dir));
  assert.equal(r.eligible, false, `${parent} ${dir} should be refused: ${JSON.stringify(r)}`);
  assert.match(r.refusal, pattern, r.refusal);
};
// Preview then commit, in one transaction; `tamper` edits the expected object (SQL on r->'expected').
const cutover = (parent, dir, key, { uid = ADMIN, reason = 'RT-4 pilot', commit = false, expected = "r->'expected'" } = {}) => attempt(uid,
  `${asUser(`r := public.preview_parent_rate_cutover('${parent}', ${sq(dir)});
     r2 := public.commit_parent_rate_cutover('${parent}', ${sq(dir)}, ${expected}, ${sq(reason)}, ${sq(key)});`)}
  v := jsonb_build_object('receipt', r2, 'expected', (r->'expected')::text)::text;`, { commit });
// A committed switch's receipt (and, as .expected on it, the exact text of the expected object it was sent).
const go = (...args) => { const o = okJson(cutover(...args)); return Object.assign(o.receipt, { expected: o.expected }); };
const md5Of = (table) => scalar(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) FROM public.${table} t;`);
const parentsSansSource = () => scalar(`SELECT md5(string_agg((to_jsonb(p) - 'rate_source' - 'rate_source_event_id')::text, '|' ORDER BY p.id)) FROM public.product_parents p;`);
const row = (sql) => scalar(sql);
const LINE_TABLES = ['quote_items', 'invoice_items', 'job_chemicals', 'order_items', 'blend_recipe_items', 'blend_ticket_products'];

function seedFixtures() {
  seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${OLD_ADMIN}', 'rt4-old-admin@example.invalid', '{"full_name":"[RT4] Old Admin","role":"admin"}'::jsonb);`);
  raw(`UPDATE public.profiles SET is_active = false WHERE id = '${OLD_ADMIN}';`);
  psql(`INSERT INTO public.product_form_units (product_form, unit) SELECT * FROM (VALUES ('each', 'Ea'), ('each', 'Unit'), ('seed', 'Lb'), ('seed', 'Unit')) v(f, u)
    WHERE NOT EXISTS (SELECT 1 FROM public.product_form_units x WHERE x.product_form = v.f AND x.unit = v.u);`);
  raw('UPDATE public.product_rate_lock SET is_locked = false WHERE id;');
  psql(MK);
  for (const [name, form, units] of FIXTURES) {
    ok(attempt(ADMIN, `PERFORM rt4_proof.mk(${sq(name)}, ${sq(form)}, ARRAY[${units.map(sq).join(',')}]::text[]);`, { commit: true }));
  }
  for (const line of row("SELECT string_agg(name || '=' || parent || '=' || array_to_string(products, ','), ';') FROM rt4_proof.ids;").split(';')) {
    const [name, parent, products] = line.split('=');
    P[name] = parent; SIZES[name] = products.split(',');
  }
  // Tier prices first, so the rate step below writes real per-acre prices.
  raw(FIXTURES.map(([name, , , , , , prices]) => prices.map((price, i) =>
    `UPDATE public.products SET tier1_price = ${price}, tier2_price = ${price}, tier3_price = ${price} WHERE id = '${SIZES[name][i]}';`).join('\n')).join('\n'));
  for (const [name, , , rate, unit, text] of FIXTURES) {
    ok(attempt(ADMIN, `PERFORM rt4_proof.rates(${sq(name)}, ${num(rate)}, ${sq(unit)}, ${sq(text)});`, { commit: true }));
  }
  // Held parent (Mason, 2026-11-17), at its live ID; a size whose category differs; an inactive parent; a blend recipe.
  P.Piksi = PIKSI; P.Infurrow = INFURROW;
  raw(`INSERT INTO public.product_parents (id, name, product_form, rate_per_acre, rate_unit, suggested_rate, created_by, updated_by)
      VALUES ('${PIKSI}', 'Piksi Dust Plus', 'dry', 18, 'MG', '18 grams per Acre', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, rate_per_acre, suggested_rate,
        tier1_price, tier2_price, tier3_price, pricing_version, is_active)
      VALUES ('${PIKSI_SIZE}', 'Piksi Dust Plus - 1800G Jar', 'RT4-PIKSI', 'dry', 'MG', 'MG', 'MG', 18, '18 grams per Acre', 0.2, 0.2, 0.2, 1, true);
    INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by) VALUES ('${PIKSI_SIZE}', '${PIKSI}', 'package', '${ADMIN}');
    INSERT INTO public.product_parents (id, name, product_form, rate_per_acre, rate_unit, suggested_rate, created_by, updated_by)
      VALUES ('${INFURROW}', 'Piksi Dust Infurrow', 'dry', 18, 'MG', '18 grams per Acre', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.products (id, product_name, sku, product_form, inventory_unit, unit_size, rate_unit, rate_per_acre, suggested_rate,
        tier1_price, tier2_price, tier3_price, pricing_version, is_active)
      VALUES ('${INFURROW_SIZE}', 'Piksi Dust Infurrow - Jar', 'RT4-INFURROW', 'dry', 'MG', 'MG', 'MG', 18, '18 grams per Acre', 0.2, 0.2, 0.2, 1, true);
    INSERT INTO public.product_parent_members (product_id, parent_id, size_role, added_by) VALUES ('${INFURROW_SIZE}', '${INFURROW}', 'package', '${ADMIN}');
    UPDATE public.products SET category = 'Herbicide' WHERE id = '${SIZES.Differs[1]}';
    UPDATE public.product_parents SET is_active = false WHERE id = '${P.Inactive}';
    INSERT INTO public.blend_recipes (id, name, recipe_type, created_by) VALUES ('7c7a0000-0000-4000-8000-0000000000b1', '[RT4] Recipe', 'generic', '${ADMIN}');
    INSERT INTO public.blend_recipe_items (recipe_id, product_id) VALUES ('7c7a0000-0000-4000-8000-0000000000b1', '${SIZES.Blend[0]}');`);
  const rates = []; const outcomes = [];
  for (const [name, [rows, outcome]] of Object.entries(REVIEW)) {
    for (const [basis, source, rec, unit, dflt, status] of rows) {
      const approved = status === 'approved' ? `'${ADMIN}', now()` : 'NULL, NULL';
      rates.push(`('${P[name]}', '${basis}', '${source}', ${rec}, '${unit}', ${dflt}, '${status}', ${approved}, 'manual', '${ADMIN}', '${ADMIN}')`);
    }
    if (outcome) outcomes.push(`('${P[name]}', '${outcome}', '${ADMIN}', now())`);
  }
  raw(`INSERT INTO public.product_rates (parent_id, basis, source, recommended, unit, is_quoting_default, status, approved_by, approved_at, origin, created_by, updated_by)
      VALUES ${rates.join(',\n')};
    INSERT INTO public.product_parent_rate_outcomes (parent_id, outcome, decided_by, decided_at) VALUES ${outcomes.join(',\n')};
    UPDATE public.product_rate_lock SET is_locked = true WHERE id;`);
}

function main() {
  buildContainer({ stopBefore: CANDIDATE });
  seedFixtures();
  // Smart's per-acre price at today's 1.8 Dry oz: 19.65 x 1.8 / 16 = 2.21.
  assert.equal(row(`SELECT tier1_price_per_acre FROM public.products WHERE id = '${SIZES.Smart[0]}';`), '2.21');
  const lines = Object.fromEntries(LINE_TABLES.map((t) => [t, md5Of(t)]));
  const productsBefore = md5Of('products'); const parentsBefore = parentsSansSource();

  // P1: a renamed or missing held parent refuses the whole file; then the real apply; then a second run refuses.
  const renamed = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
    { input: `BEGIN; SET LOCAL session_replication_role = replica; UPDATE public.product_parents SET name = 'Piksi' WHERE id = '${PIKSI}';
      SET LOCAL session_replication_role = origin;\n${candidate}\nROLLBACK;`, allowFailure: true });
  assert.notEqual(renamed.status, 0); assert.match(renamed.stderr, /PREFLIGHT_RATE_CUTOVER_HOLD_LIST_CHANGED/, renamed.stderr);
  const applied = runCandidate();
  assert.equal(applied.status, 0, `candidate failed:\n${applied.stderr}`);
  const again = runCandidate();
  assert.notEqual(again.status, 0, 'a second run must refuse');
  assert.equal(md5Of('products'), productsBefore, 'the migration itself changed products');
  assert.equal(parentsSansSource(), parentsBefore, 'the migration itself changed parents');
  assert.equal(row("SELECT count(*) FROM public.product_parents WHERE rate_source <> 'legacy' OR rate_source_event_id IS NOT NULL;"), '0');

  // P2: refusals in the plan.
  ineligible(P.Piksi, 'promote', /PRODUCT_PARENT_CUTOVER_HELD/);
  ineligible(P.Infurrow, 'promote', /PRODUCT_PARENT_CUTOVER_HELD/);
  ineligible(P.Drafts, 'promote', /PRODUCT_PARENT_CUTOVER_DRAFTS/);
  ineligible(P.Needs, 'promote', /PRODUCT_PARENT_CUTOVER_NOT_DECIDED.*needs_label_data/);
  ineligible(P.Undecided, 'promote', /PRODUCT_PARENT_CUTOVER_NOT_DECIDED.*undecided/);
  ineligible(P.Blend, 'promote', /PRODUCT_PARENT_CUTOVER_BLEND_UNIT/);
  ineligible(P.Differs, 'promote', /PRODUCT_PARENT_CUTOVER_SIZES_DIFFER/);
  ineligible(P.Inactive, 'promote', /PRODUCT_PARENT_CUTOVER_INACTIVE/);
  ineligible(P.MSO, 'restore', /PRODUCT_PARENT_CUTOVER_ALREADY_LEGACY/);
  ineligible(P.MSO, 'swap', /PRODUCT_PARENT_CUTOVER_DIRECTION/);
  refused(cutover(P.Piksi, 'promote', 'rt4-piksi'), /PRODUCT_PARENT_CUTOVER_HELD/);
  // Lock off (rolled back): nothing switches.
  refused(attempt(ADMIN, asUser(`PERFORM public.set_product_rate_lock(false, 'test', '${ADMIN}', 'rt4-unlock-a');
    r := public.commit_parent_rate_cutover('${P.MSO}', 'promote', '{}'::jsonb, 'x', 'rt4-lockoff');`)), /PRODUCT_PARENT_CUTOVER_LOCK_OFF/);

  // P3: who may switch.
  refused(preview(P.Smart, 'promote', REP), /ADMIN_REQUIRED/);
  refused(preview(P.Smart, 'promote', OLD_ADMIN), /ADMIN_REQUIRED|AUTH_REQUIRED|inactive/i);
  refused(cutover(P.Smart, 'promote', 'rt4-rep', { uid: REP }), /ADMIN_REQUIRED/);
  refused(attempt(ADMIN, `SET LOCAL ROLE anon; r := public.preview_parent_rate_cutover('${P.Smart}', 'promote'); RESET ROLE;`), /permission denied/);
  refused(attempt(ADMIN, `SET LOCAL ROLE anon; r := public.commit_parent_rate_cutover('${P.Smart}', 'promote', '{}'::jsonb, 'x', 'k'); RESET ROLE;`), /permission denied/);
  refused(attempt(ADMIN, asUser('PERFORM 1 FROM public.product_rate_cutover_passes;')), /permission denied/);

  // P4: stale or incomplete requests.
  refused(cutover(P.Smart, 'promote', 'rt4-stale-a', { expected: "jsonb_set(r->'expected', '{parent_version}', to_jsonb((r->'expected'->>'parent_version')::bigint - 1))" }), /PRODUCT_PARENT_CUTOVER_STALE/);
  refused(cutover(P.Smart, 'promote', 'rt4-stale-b', { expected: "(r->'expected') || '{\"extra\": 1}'" }), /PRODUCT_PARENT_CUTOVER_STALE/);
  refused(cutover(P.Smart, 'promote', 'rt4-stale-c', { expected: "(r->'expected') - 'sizes'" }), /PRODUCT_PARENT_CUTOVER_STALE/);
  refused(cutover(P.Smart, 'promote', 'rt4-stale-d', { expected: 'NULL' }), /PRODUCT_PARENT_CUTOVER_STALE/);
  refused(cutover(P.Smart, 'promote', 'rt4-blank', { reason: '  ' }), /REASON_REQUIRED/);
  refused(cutover(P.Smart, 'promote', null), /IDEMPOTENCY_KEY_REQUIRED/);

  // P5: promote Smart (1.8 Dry oz -> 1.8 Lb): the parent and both sizes move, prices recompute, the snapshot holds the old values.
  const promoted = go(P.Smart, 'promote', 'rt4-smart-1', { commit: true });
  assert.equal(promoted.rate_source, 'approved'); assert.equal(promoted.changed, true);
  assert.equal(promoted.rate_per_acre, '1.8'); assert.equal(promoted.rate_unit, 'Lb');
  assert.equal(row(`SELECT rate_source || '|' || (rate_source_event_id = ${promoted.event_id}) FROM public.product_parents WHERE id = '${P.Smart}';`), 'approved|true');
  assert.equal(row(`SELECT string_agg(rate_per_acre || ' ' || rate_unit || ' ' || tier1_price_per_acre, ';' ORDER BY tier1_price) FROM public.products WHERE id = ANY('{${SIZES.Smart}}');`),
    '1.8 Lb 35.37;1.8 Lb 36.00');
  assert.equal(row(`SELECT after_values->'legacy'->>'rate_unit' || '|' || (after_values->'legacy'->>'rate_per_acre') || '|' || jsonb_array_length(after_values->'sizes')
    || '|' || (after_values->'approved'->>'written_unit') FROM public.product_parent_events WHERE id = ${promoted.event_id} AND event_type = 'rates_promoted';`), 'Dry oz|1.8|2|Lb');
  // P7: the same key returns the same receipt and writes nothing; the same key with another reason refuses.
  const sent = `${sq(promoted.expected)}::jsonb`;
  const replayed = okJson(attempt(ADMIN, `${asUser(`r := public.commit_parent_rate_cutover('${P.Smart}', 'promote', ${sent}, 'RT-4 pilot', 'rt4-smart-1');`)} v := r::text;`));
  assert.equal(replayed.event_id, promoted.event_id);
  assert.equal(row(`SELECT count(*) FROM public.product_parent_events WHERE parent_id = '${P.Smart}' AND event_type = 'rates_promoted';`), '1');
  refused(attempt(ADMIN, asUser(`r := public.commit_parent_rate_cutover('${P.Smart}', 'promote', ${sent}, 'other', 'rt4-smart-1');`)),
    /IDEMPOTENCY_PAYLOAD_MISMATCH/);
  ineligible(P.Smart, 'promote', /PRODUCT_PARENT_CUTOVER_ALREADY_APPROVED/);

  // P6: an approved parent's rates are frozen everywhere (rolled back).
  const frozen = /PRODUCT_PARENT_RATE_APPROVED/;
  const ver = (name) => row(`SELECT outcome_version FROM public.product_parent_rate_outcomes WHERE parent_id = '${P[name]}';`);
  refused(attempt(ADMIN, asUser(`r := public.save_draft_product_rate('${P.Smart}', NULL, NULL, 'per_acre', 'label', NULL, 1, NULL, 'lb', false, NULL, 'rt4-draft');`)), /PRODUCT_PARENT_RATE_APPROVED|PRODUCT_RATES_LOCKED/);
  refused(attempt(ADMIN, asUser(`r := public.commit_rate_review('[]'::jsonb, '[{"parent_id": "${P.Smart}", "expected_outcome_version": ${ver('Smart')}, "outcome": "needs_label_data", "note": null}]'::jsonb, 'rt4-review');`)), /PRODUCT_PARENT_RATE_APPROVED|PRODUCT_RATES_LOCKED/);
  refused(attempt(ADMIN, `UPDATE public.product_rates SET row_version = row_version + 1 WHERE parent_id = '${P.Smart}';`), /PRODUCT_(PARENT_)?RATE_APPROVED/); // RT-3's own guard on approved rows fires first
  refused(attempt(ADMIN, `DELETE FROM public.product_parent_rate_outcomes WHERE parent_id = '${P.Smart}';`), frozen);
  refused(attempt(ADMIN, `INSERT INTO public.product_rates (parent_id, basis, source, recommended, unit, origin, created_by, updated_by)
    VALUES ('${P.Smart}', 'per_100_gal', 'label', 1, 'lb', 'manual', '${ADMIN}', '${ADMIN}');`), frozen);
  refused(attempt(ADMIN, asUser(`r := public.preview_parent_rates('${P.Smart}', 2, 'Lb', NULL);
    r2 := public.correct_parent_rates('${P.Smart}', 2, 'Lb', NULL, (r->>'parent_version')::bigint, r->'sizes', 'fix', 'rt4-correct');`)), frozen);
  refused(attempt(ADMIN, asUser(`PERFORM public.set_product_rate_lock(false, 'test', '${ADMIN}', 'rt4-unlock-b');`)), /PRODUCT_RATES_APPROVED_PARENTS: 1 parents/);
  refused(attempt(ADMIN, `UPDATE public.product_parents SET rate_per_acre = 2 WHERE id = '${P.Smart}';`), frozen);
  refused(attempt(ADMIN, `UPDATE public.product_parents SET rate_source = 'approved', rate_source_event_id = ${promoted.event_id} WHERE id = '${P.MSO}';`), frozen);
  refused(attempt(ADMIN, `UPDATE public.product_parents SET rate_source = 'legacy', rate_source_event_id = NULL WHERE id = '${P.Smart}';`), frozen);
  refused(attempt(ADMIN, `UPDATE public.products SET rate_per_acre = 2 WHERE id = '${SIZES.Smart[0]}';`), /PRODUCT_|locked/i);
  // The rate lock covers moves: a size whose live rate differs from the destination's cannot move (shown on the preview).
  // Sizes cannot leave or join an approved parent, even where the rates match (the move RPC writes this row).
  refused(attempt(ADMIN, `UPDATE public.product_parent_members SET parent_id = '${P.MSO}' WHERE product_id = '${SIZES.Smart[0]}';`), frozen);
  refused(attempt(ADMIN, `UPDATE public.product_parent_members SET parent_id = '${P.Smart}' WHERE product_id = '${SIZES.MSO[0]}';`), frozen);
  refused(attempt(ADMIN, `DELETE FROM public.product_parent_members WHERE product_id = '${SIZES.Smart[0]}';`), frozen);
  assert.match(attempt(ADMIN, asUser(`v := public.preview_move_product_size('${SIZES.Smart[1]}', '${P.Blend}')->>'refusal';`)), /^ok\|PRODUCT_RATES_LOCKED: the move would change/);

  // P8: a size added to an approved parent takes the approved rate.
  const added = okJson(attempt(ADMIN, `${asUser(`r := public.add_product_size('${P.Smart}', (SELECT parent_version FROM public.product_parents WHERE id = '${P.Smart}'),
    '{"product_name": "[RT4] Smart 3", "sku": "RT4-SMART-3", "inventory_unit": "Lb"}'::jsonb, 'rt4-add-smart-3');`)} v := r::text;`, { commit: true }));
  SIZES.Smart.push(added.product_id);
  assert.equal(row(`SELECT rate_per_acre || ' ' || rate_unit FROM public.products WHERE id = '${added.product_id}';`), '1.8 Lb');

  // P5 back: a price change since the switch; restore brings back 1.8 Dry oz on all three sizes at today's prices.
  raw(`UPDATE public.products SET tier1_price = 21 WHERE id = '${SIZES.Smart[0]}';`);
  const restored = go(P.Smart, 'restore', 'rt4-smart-2', { commit: true, reason: 'switch back' });
  assert.equal(restored.rate_source, 'legacy'); assert.equal(restored.rate_unit, 'Dry oz'); assert.equal(restored.rate_per_acre, '1.8');
  assert.equal(row(`SELECT rate_source || '|' || (rate_source_event_id IS NULL) FROM public.product_parents WHERE id = '${P.Smart}';`), 'legacy|true');
  assert.equal(row(`SELECT string_agg(rate_per_acre || ' ' || rate_unit, ';') FROM public.products WHERE id = ANY('{${SIZES.Smart}}');`), '1.8 Dry oz;1.8 Dry oz;1.8 Dry oz');
  assert.equal(row(`SELECT tier1_price_per_acre FROM public.products WHERE id = '${SIZES.Smart[0]}';`), '2.36');
  assert.equal(row(`SELECT (after_values->>'promoted_event_id') = '${promoted.event_id}' FROM public.product_parent_events WHERE id = ${restored.event_id} AND event_type = 'rates_restored';`), 't');
  ineligible(P.Smart, 'restore', /PRODUCT_PARENT_CUTOVER_ALREADY_LEGACY/);

  // No change: MSO's approved 9.6 fl_oz keeps its own "oz" spelling; only the source and version move.
  const msoSizes = md5Rows(SIZES.MSO);
  const msoVersion = Number(row(`SELECT parent_version FROM public.product_parents WHERE id = '${P.MSO}';`));
  const mso = go(P.MSO, 'promote', 'rt4-mso-1', { commit: true });
  assert.equal(mso.changed, false); assert.equal(mso.rate_unit, 'oz'); assert.equal(mso.parent_version, msoVersion + 1);
  assert.equal(md5Rows(SIZES.MSO), msoSizes, 'a no-change switch wrote a size');
  // No per-acre default: the rate is blanked, then restored.
  go(P.NoDefault, 'promote', 'rt4-nodefault-1', { commit: true });
  assert.equal(row(`SELECT coalesce(rate_per_acre::text, 'null') || '|' || coalesce(rate_unit, 'null') FROM public.product_parents WHERE id = '${P.NoDefault}';`), 'null|null');
  assert.equal(row(`SELECT coalesce(rate_per_acre::text, 'null') || '|' || coalesce(tier1_price_per_acre::text, 'null') FROM public.products WHERE id = '${SIZES.NoDefault[0]}';`), 'null|null');
  go(P.NoDefault, 'restore', 'rt4-nodefault-2', { commit: true });
  assert.equal(row(`SELECT rate_per_acre || ' ' || rate_unit FROM public.products WHERE id = '${SIZES.NoDefault[0]}';`), '2 Pt');
  // Seed: the stock unit stays the rate unit.
  go(P.SeedOne, 'promote', 'rt4-seed-1', { commit: true });
  assert.equal(row(`SELECT coalesce(rate_per_acre::text, 'null') || '|' || rate_unit FROM public.products WHERE id = '${SIZES.SeedOne[0]}';`), 'null|Unit');
  go(P.SeedOne, 'restore', 'rt4-seed-2', { commit: true });
  assert.equal(row(`SELECT rate_per_acre || '|' || rate_unit FROM public.products WHERE id = '${SIZES.SeedOne[0]}';`), '1|Unit');

  // An old unit that no longer prices: restore refuses and the parent stays approved (rolled back).
  go(P.Smart, 'promote', 'rt4-smart-3', { commit: true });
  const gone = docker(['exec', '-i', NAME, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
    { input: `BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM public.unit_conversions WHERE unit = 'Dry oz';
      SET LOCAL session_replication_role = origin; SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
      SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true); SET LOCAL ROLE authenticated;
      SELECT public.preview_parent_rate_cutover('${P.Smart}', 'restore')->>'refusal'; ROLLBACK;`, allowFailure: true });
  assert.equal(gone.status, 0, gone.stderr); assert.match(gone.stdout, /PRODUCT_RATE_UNIT_INVALID/, gone.stdout);
  assert.equal(row(`SELECT rate_source FROM public.product_parents WHERE id = '${P.Smart}';`), 'approved');
  go(P.Smart, 'restore', 'rt4-smart-4', { commit: true });
  go(P.MSO, 'restore', 'rt4-mso-2', { commit: true });

  // All back on the old rate: the lock may be turned off again (rolled back); no line anywhere changed (P9).
  ok(attempt(ADMIN, asUser(`PERFORM public.set_product_rate_lock(false, 'test', '${ADMIN}', 'rt4-unlock-c');`)));
  assert.equal(row("SELECT count(*) FROM public.product_parents WHERE rate_source <> 'legacy';"), '0');
  for (const t of LINE_TABLES) assert.equal(md5Of(t), lines[t], `${t} changed`);
  console.log('RATE_CUTOVER_PROOF_PASS');

}
function md5Rows(ids) { return row(`SELECT md5(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id)) FROM public.products p WHERE p.id = ANY('{${ids}}');`); }

try { main(); } finally { if (!KEEP) removeContainer(); else console.log(`[rt4] kept ${NAME}`); }
