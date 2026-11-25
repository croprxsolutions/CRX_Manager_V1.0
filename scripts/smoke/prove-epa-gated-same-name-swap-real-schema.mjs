#!/usr/bin/env node
/**
 * Real-schema proof for 20270305100000_epa_gated_same_name_swap.sql.
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs). Fixture: an EPA-numbered (gated) product whose
 * EPA-sourced row uses one of two same-name duplicate ingredients, with an EPA-confirmed and a typed mode of action;
 * a third ingredient with a different name; and an un-gated product. Before the candidate the same-name swap is
 * refused (CHEMISTRY_FROM_EPA_ONLY); then the candidate is applied (autocommit refused, POSTFLIGHT_OK, re-apply
 * refused) and, as the signed-in admin through preview_parent_chemistry_correction + correct_parent_chemistry:
 *   1. a different-name swap, a same-name swap that would create a new ingredient, a consolidate and a strength
 *      change on the gated product are still refused; a sales rep is refused (ADMIN_REQUIRED);
 *   2. the same-name swap saves: the old row is retired, the new row carries the old strength, unit, basis, source and
 *      note (the request's strength is ignored), both modes move with their own source, one 'corrected' event;
 *   3. a swap on the un-gated product still uses the request's strength and re-types kept modes, as before.
 *
 * Run: node scripts/smoke/prove-epa-gated-same-name-swap-real-schema.mjs   (needs Docker; never touches live)
 * Prints EPA_SAME_NAME_SWAP_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, id, psql, scalar, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270305100000_epa_gated_same_name_swap.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
const ADMIN = USERS.admin;
const P_EPA = id('b1');
const P_TYPED = id('b2');
const ZETA_A = id('c1'); // on the EPA product
const ZETA_B = id('c2'); // same name_key, different spelling of spacing/case
const OTHER = id('c3'); // different name
const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replaceAll("'", "''")}'`);
const J = (o) => `${q(JSON.stringify(o))}::jsonb`;
const rowOf = (parent, ing) => scalar(`SELECT id FROM public.product_parent_ingredients WHERE parent_id = '${parent}' AND ingredient_id = '${ing}' AND status = 'active';`);
const typedStrength = { strength_value: 1, strength_unit: 'pct_ww', strength_basis: 'active_ingredient', source: 'label', source_note: null };

/** Preview as `uid`, then save with the preview's version and fingerprint; returns `ok|<json>` or the refusal. */
const previewThenSave = (parent, changes, uid = ADMIN, commit = false) =>
  attempt(uid, `${asUser(`r := public.preview_parent_chemistry_correction('${parent}', ${J(changes)});`)}
    IF r->>'refusal' IS NOT NULL THEN RAISE EXCEPTION 'PREVIEW_REFUSED %', r->>'refusal'; END IF;
    ${asUser(`r2 := public.correct_parent_chemistry('${parent}', (r->>'chemistry_version')::bigint, r->>'preview_fingerprint', ${J(changes)}, 'Duplicate ingredient record', 'Same chemical, same name', 'swap-${Math.random().toString(36).slice(2)}');`)}
    v := r2::text;`, { commit });
const swap = (rowId, target, extra = {}) => [{ kind: 'ingredient', action: 'swap', row_id: rowId, modes_of_action: [], ...target, ...typedStrength, ...extra }];

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    INSERT INTO public.product_parents (id, name, product_form, formulation_type, category, generic_epa_registration, is_active, created_by, updated_by) VALUES
      ('${P_EPA}', '[PROVER] Gated', 'liquid', 'EC', 'Insecticide', '91234-259', true, '${ADMIN}', '${ADMIN}'),
      ('${P_TYPED}', '[PROVER] Typed', 'liquid', 'EC', 'Insecticide', NULL, true, '${ADMIN}', '${ADMIN}');
    INSERT INTO public.active_ingredients (id, name, cas, created_by, updated_by) VALUES
      ('${ZETA_A}', 'Prover Zeta-Cypermethrin', NULL, '${ADMIN}', '${ADMIN}'),
      ('${ZETA_B}', 'prover  zeta-cypermethrin', NULL, '${ADMIN}', '${ADMIN}'),
      ('${OTHER}', 'Prover Bifenthrin', NULL, '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_ingredients (parent_id, ingredient_id, strength_value, strength_unit, strength_basis, source, source_note, created_by, updated_by) VALUES
      ('${P_EPA}', '${ZETA_A}', 9.15, 'pct_ww', 'active_ingredient', 'epa_lookup', 'EPA lookup of 91234-259', '${ADMIN}', '${ADMIN}'),
      ('${P_TYPED}', '${ZETA_A}', 1.5, 'lb_per_gal', 'active_ingredient', 'label', NULL, '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_modes_of_action (parent_id, ingredient_id, scheme, group_code, source, created_by, updated_by) VALUES
      ('${P_EPA}', '${ZETA_A}', 'IRAC', '3A', 'epa_lookup', '${ADMIN}', '${ADMIN}'),
      ('${P_EPA}', '${ZETA_A}', 'FRAC', '99', 'typed', '${ADMIN}', '${ADMIN}'),
      ('${P_TYPED}', '${ZETA_A}', 'IRAC', '3A', 'epa_lookup', '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_chemistry_state (parent_id, chemistry_version, updated_by) VALUES
      ('${P_EPA}', 1, '${ADMIN}'), ('${P_TYPED}', 1, '${ADMIN}');`);
  assert.match(scalar(`SELECT public._parent_chemistry_epa_refusal('${P_EPA}');`), /CHEMISTRY_FROM_EPA_ONLY.*91234-259/, 'fixture product is EPA-gated');
  assert.equal(scalar(`SELECT coalesce(public._parent_chemistry_epa_refusal('${P_TYPED}'), 'none');`), 'none', 'typed product is not gated');
  assert.equal(scalar(`SELECT count(DISTINCT name_key) FROM public.active_ingredients WHERE id IN ('${ZETA_A}', '${ZETA_B}');`), '1', 'duplicates share a name_key');
  const epaRow = rowOf(P_EPA, ZETA_A);

  // Before: the bug.
  assert.match(previewThenSave(P_EPA, swap(epaRow, { ingredient_id: ZETA_B })), /PREVIEW_REFUSED CHEMISTRY_FROM_EPA_ONLY/);
  console.log('[before] same-name swap on an EPA product -> CHEMISTRY_FROM_EPA_ONLY');

  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /EPA_SAME_NAME_SWAP_BASELINE_DRIFT/, 're-apply must refuse');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');

  // Still refused on the gated product.
  assert.match(previewThenSave(P_EPA, swap(epaRow, { ingredient_id: OTHER })), /PREVIEW_REFUSED CHEMISTRY_FROM_EPA_ONLY/, 'different name');
  assert.match(previewThenSave(P_EPA, swap(epaRow, { name: 'Prover Zeta-Cypermethrin ', cas: null })), /PREVIEW_REFUSED CHEMISTRY_FROM_EPA_ONLY/, 'same name, new ingredient');
  assert.match(previewThenSave(P_EPA, [{ kind: 'ingredient', action: 'change', row_id: epaRow, ...typedStrength }]), /PREVIEW_REFUSED CHEMISTRY_FROM_EPA_ONLY/, 'strength change');
  assert.match(previewThenSave(P_EPA, [{ kind: 'mode_of_action', action: 'retire', row_id: scalar(`SELECT id FROM public.product_parent_modes_of_action WHERE parent_id = '${P_EPA}' AND group_code = '3A';`) }]), /PREVIEW_REFUSED CHEMISTRY_FROM_EPA_ONLY/, 'mode retire');
  assert.match(previewThenSave(P_EPA, swap(epaRow, { ingredient_id: ZETA_B }), USERS.rep), /ADMIN_REQUIRED/, 'sales rep');
  assert.match(attempt(USERS.rep, `${refuse(`r := public.correct_parent_chemistry('${P_EPA}', 1, 'x', ${J(swap(epaRow, { ingredient_id: ZETA_B }))}, 'r', 'e', 'k');`)} v := t;`), /ADMIN_REQUIRED/);
  console.log('[refuse] different name, same-name new ingredient, strength change, mode retire, sales rep -> all still refused');

  // The fix: request strength (1 % label) and an empty mode list are ignored on the gated product.
  const saved = previewThenSave(P_EPA, swap(epaRow, { ingredient_id: ZETA_B }), ADMIN, true);
  assert.match(saved, /^ok\|/, `same-name swap must save: ${saved}`);
  assert.equal(scalar(`SELECT status FROM public.product_parent_ingredients WHERE id = '${epaRow}';`), 'retired');
  assert.equal(scalar(`SELECT strength_value || '|' || strength_unknown || '|' || strength_unit || '|' || strength_basis || '|' || source || '|' || source_note
                         FROM public.product_parent_ingredients WHERE parent_id = '${P_EPA}' AND ingredient_id = '${ZETA_B}' AND status = 'active';`),
    '9.15|false|pct_ww|active_ingredient|epa_lookup|EPA lookup of 91234-259', 'strength, source and note carried over');
  assert.equal(scalar(`SELECT string_agg(scheme || ' ' || group_code || ' ' || source, ', ' ORDER BY scheme) FROM public.product_parent_modes_of_action
                        WHERE parent_id = '${P_EPA}' AND ingredient_id = '${ZETA_B}' AND status = 'active';`), 'FRAC 99 typed, IRAC 3A epa_lookup', 'modes moved with their source');
  assert.equal(scalar(`SELECT count(*) FROM public.product_parent_modes_of_action WHERE parent_id = '${P_EPA}' AND ingredient_id = '${ZETA_A}' AND status = 'active';`), '0');
  assert.equal(scalar(`SELECT count(*) FROM public.product_chemistry_events WHERE parent_id = '${P_EPA}' AND event_type = 'corrected' AND reason = 'Duplicate ingredient record';`), '1', 'event');
  assert.equal(scalar(`SELECT chemistry_version FROM public.product_parent_chemistry_state WHERE parent_id = '${P_EPA}';`), '2');
  console.log('[fix] admin repointed the EPA product at its same-name duplicate; 9.15 % epa_lookup, IRAC 3A epa_lookup and FRAC 99 typed carried over; one corrected event');

  // Un-gated product: the old swap behaviour is unchanged.
  const typedRow = rowOf(P_TYPED, ZETA_A);
  const typedSaved = previewThenSave(P_TYPED, swap(typedRow, { ingredient_id: OTHER }, { modes_of_action: [{ scheme: 'IRAC', group_code: '3A' }] }), ADMIN, true);
  assert.match(typedSaved, /^ok\|/, `un-gated swap must save: ${typedSaved}`);
  assert.equal(scalar(`SELECT strength_value || '|' || strength_unit || '|' || source FROM public.product_parent_ingredients WHERE parent_id = '${P_TYPED}' AND ingredient_id = '${OTHER}' AND status = 'active';`), '1|pct_ww|label');
  assert.equal(scalar(`SELECT source FROM public.product_parent_modes_of_action WHERE parent_id = '${P_TYPED}' AND ingredient_id = '${OTHER}' AND status = 'active';`), 'typed');
  console.log('[un-gated] a swap still takes the stated strength and re-types kept modes');

  console.log('\nEPA_SAME_NAME_SWAP_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
