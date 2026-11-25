#!/usr/bin/env node
/**
 * Real-schema proof for 20270304150000_ingredient_cas_fill_passes_epa_gate.sql.
 *
 * Builds the production baseline plus every post-baseline migration before the candidate in a network-disabled
 * PostgreSQL container (scripts/smoke/undo-paths/harness.mjs). Fixture: an EPA-numbered product (gated) whose
 * EPA-sourced row uses an ingredient with no CAS, plus an un-gated product. Before the candidate the CAS fill is
 * refused (CHEMISTRY_FROM_EPA_ONLY); then the candidate is applied (autocommit refused, POSTFLIGHT_OK, re-apply
 * refused) and, as the signed-in admin through preview_active_ingredient_change + save_active_ingredient:
 *   1. filling the missing CAS previews clean and saves; the CAS is stored, the ingredient event and one
 *      'corrected' chemistry event per product are written, the EPA product row is untouched;
 *   2. reason and evidence are still required; an invalid or taken CAS is still refused;
 *   3. a CAS an EPA proposal gives stays gated; the acid flag is still refused on an EPA product;
 *   4. a fill that contradicts the CAS EPA gives for the ingredient is refused (INGREDIENT_CAS_NOT_EPA, Sol 2026-11-24);
 *   5. a typed CAS EPA does not give can be corrected (a mistyped fill is not locked in);
 *   6. a sales rep is refused (ADMIN_REQUIRED).
 * The EPA proposal's items are built by the real _epa_proposal_items, so their shape is the live one.
 *
 * Run: node scripts/smoke/prove-ingredient-cas-fill-epa-gate-real-schema.mjs   (needs Docker; never touches live)
 * Prints INGREDIENT_CAS_FILL_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, seedUsers, attempt, asUser, refuse, id, psql, scalar, USERS, ROOT, NAME, docker } from './undo-paths/harness.mjs';

const CANDIDATE = '20270304150000_ingredient_cas_fill_passes_epa_gate.sql';
const candidate = readFileSync(path.join(ROOT, 'supabase', 'migrations', CANDIDATE), 'utf8').replaceAll('\r\n', '\n');
const PSQL = ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const apply = (flags = []) => docker([...PSQL, ...flags], { input: candidate, allowFailure: true });
const ADMIN = USERS.admin;
const P_EPA = id('b1');
const P_TYPED = id('b2');
const ZETA = id('c1'); // no CAS, used by the EPA product (EPA row) and the typed product
const OTHER = id('c2'); // CAS already set (EPA gives it), used by the EPA product
const TYPED_ING = id('c3'); // no CAS, typed on the EPA product, EPA does not list it
const LOOKUP = id('d1');
const ZETA_CAS = '52315-07-8';
const OTHER_CAS = '1912-24-9'; // atrazine
const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replaceAll("'", "''")}'`);
const J = (o) => `${q(JSON.stringify(o))}::jsonb`;

/** Preview as the admin, then save with the preview's version and fingerprint; returns `ok|<json>` or the refusal. */
const previewThenSave = (iid, fields, reason = 'EPA gave no CAS', evidence = 'CAS registry 52315-07-8', uid = ADMIN, commit = false) =>
  attempt(uid, `${asUser(`r := public.preview_active_ingredient_change('${iid}', ${J(fields)});`)}
    IF r->>'refusal' IS NOT NULL THEN RAISE EXCEPTION 'PREVIEW_REFUSED %', r->>'refusal'; END IF;
    ${asUser(`r2 := public.save_active_ingredient('${iid}', (r->'ingredient'->>'row_version')::int, r->>'usage_fingerprint', ${J(fields)}, ${q(reason)}, ${q(evidence)}, 'cas-fill-${Math.random().toString(36).slice(2)}');`)}
    v := r2::text;`, { commit });

try {
  buildContainer({ stopBefore: CANDIDATE });
  seedUsers();
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    INSERT INTO public.product_parents (id, name, product_form, formulation_type, category, generic_epa_registration, is_active, created_by, updated_by) VALUES
      ('${P_EPA}', '[PROVER] Mustang-like', 'liquid', 'EC', 'Insecticide', '91234-259', true, '${ADMIN}', '${ADMIN}'),
      ('${P_TYPED}', '[PROVER] Typed', 'liquid', 'EC', 'Insecticide', NULL, true, '${ADMIN}', '${ADMIN}');
    INSERT INTO public.active_ingredients (id, name, cas, created_by, updated_by) VALUES
      ('${ZETA}', 'Prover Zeta-Cypermethrin', NULL, '${ADMIN}', '${ADMIN}'),
      ('${OTHER}', 'Prover Atrazine', '${OTHER_CAS}', '${ADMIN}', '${ADMIN}'),
      ('${TYPED_ING}', 'Prover Typed Ingredient', NULL, '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_ingredients (parent_id, ingredient_id, strength_value, strength_unit, strength_basis, source, source_note, created_by, updated_by) VALUES
      ('${P_EPA}', '${ZETA}', 9.15, 'pct_ww', 'active_ingredient', 'epa_lookup', 'EPA lookup of 91234-259', '${ADMIN}', '${ADMIN}'),
      ('${P_EPA}', '${OTHER}', 10, 'pct_ww', 'active_ingredient', 'epa_lookup', 'EPA lookup of 91234-259', '${ADMIN}', '${ADMIN}'),
      ('${P_EPA}', '${TYPED_ING}', 1, 'pct_ww', 'active_ingredient', 'label', NULL, '${ADMIN}', '${ADMIN}'),
      ('${P_TYPED}', '${ZETA}', 1.5, 'lb_per_gal', 'active_ingredient', 'label', NULL, '${ADMIN}', '${ADMIN}');
    INSERT INTO public.product_parent_chemistry_state (parent_id, chemistry_version, updated_by) VALUES
      ('${P_EPA}', 1, '${ADMIN}'), ('${P_TYPED}', 1, '${ADMIN}');`);
  // An EPA proposal for the EPA product: zeta with CAS 52315-07-8 (the parent's row has none: differs_identity) and
  // atrazine by CAS. Items come from the real sorter.
  psql(`SET session_replication_role = replica;
    INSERT INTO public.epa_registrations (epa_registration, created_by, updated_by) VALUES ('91234-259', '${ADMIN}', '${ADMIN}') ON CONFLICT DO NOTHING;
    INSERT INTO public.epa_lookups (id, parent_id, epa_registration, link_kind, link_id, registration_version, chemistry_version, status, requested_by, recorded_at)
      VALUES ('${LOOKUP}', '${P_EPA}', '91234-259', 'parent', '${P_EPA}', 1, 1, 'recorded', '${ADMIN}', now());
    INSERT INTO public.epa_chemistry_proposals (lookup_id, parent_id, epa_registration, link_kind, link_id, registration_version, chemistry_version, epa_input, items, epa_summary, created_by)
      SELECT '${LOOKUP}', '${P_EPA}', '91234-259', 'parent', '${P_EPA}', 1, 1, x.inp, public._epa_proposal_items('${P_EPA}', '91234-259', x.inp), '{}'::jsonb, '${ADMIN}'
        FROM (SELECT ${J({ ingredients: [
          { key: '1', name: 'prover zeta-cypermethrin', cas: ZETA_CAS, strength: 9.15 },
          { key: '2', name: 'prover atrazine', cas: OTHER_CAS, strength: 10 }], label: {} })} AS inp) x;`);
  assert.equal(scalar(`SELECT string_agg((i->>'class') || ':' || coalesce(i->'current'->>'ingredient_id', '-'), ',' ORDER BY i->>'item_id')
    FROM public.epa_chemistry_proposals p, jsonb_array_elements(p.items) i WHERE p.lookup_id = '${LOOKUP}' AND i->>'kind' = 'ingredient';`).split(',')[0],
    `differs_identity:${ZETA}`, 'the proposal names zeta (no CAS) as differs_identity with its row');
  assert.match(scalar(`SELECT public._parent_chemistry_epa_refusal('${P_EPA}');`), /CHEMISTRY_FROM_EPA_ONLY.*91234-259/, 'fixture product is EPA-gated');
  assert.equal(scalar(`SELECT coalesce(public._parent_chemistry_epa_refusal('${P_TYPED}'), 'none');`), 'none', 'typed product is not gated');

  // Before: the bug.
  assert.match(previewThenSave(ZETA, { cas: ZETA_CAS }), /PREVIEW_REFUSED CHEMISTRY_FROM_EPA_ONLY.*DM-4 will update it/);
  console.log('[before] filling the missing CAS on an EPA product -> CHEMISTRY_FROM_EPA_ONLY');

  assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public._edit_active_ingredient(uuid,jsonb,text,text,boolean)');`),
    'e920183a75ba3d2f259b18a82f031e0c', 'baseline body is the one the preflight pins');
  const auto = apply();
  assert.match(`${auto.stdout}${auto.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit apply must refuse');
  const once = apply(['-1']);
  assert.equal(once.status, 0, `apply failed: ${once.stderr}`);
  assert.match(once.stderr, /POSTFLIGHT_OK/);
  const again = apply(['-1']);
  assert.match(`${again.stdout}${again.stderr}`, /INGREDIENT_CAS_FILL_BASELINE_DRIFT/, 're-apply must refuse');
  console.log('[apply] autocommit refused, applied once with POSTFLIGHT_OK, re-apply refused');

  // Still refused after the change.
  assert.match(previewThenSave(ZETA, { cas: ZETA_CAS }, null, null), /REASON_REQUIRED/, 'reason still required');
  assert.match(previewThenSave(ZETA, { cas: ZETA_CAS }, 'EPA gave no CAS', null), /EVIDENCE_REQUIRED/, 'evidence still required');
  assert.match(previewThenSave(ZETA, { cas: '52315-07-9' }), /INGREDIENT_CAS_INVALID/, 'bad check digit');
  assert.match(previewThenSave(ZETA, { cas: OTHER_CAS }), /INGREDIENT_CAS_TAKEN/, 'CAS of another ingredient');
  assert.match(previewThenSave(ZETA, { cas: '50-00-0' }), /PREVIEW_REFUSED INGREDIENT_CAS_NOT_EPA: EPA gives 52315-07-8/, 'a fill contradicting EPA');
  assert.match(previewThenSave(OTHER, { cas: '50-00-0' }), /PREVIEW_REFUSED CHEMISTRY_FROM_EPA_ONLY/, 'changing an EPA-given CAS stays gated');
  assert.match(previewThenSave(OTHER, { cas: null }), /PREVIEW_REFUSED CHEMISTRY_FROM_EPA_ONLY/, 'clearing an EPA-given CAS stays gated');
  assert.match(previewThenSave(ZETA, { cas: ZETA_CAS, is_parent_form: true }), /PREVIEW_REFUSED CHEMISTRY_FROM_EPA_ONLY/, 'CAS plus another field stays gated');
  assert.match(previewThenSave(ZETA, { is_parent_form: true }), /PREVIEW_REFUSED CHEMISTRY_FROM_EPA_ONLY/, 'acid flag stays gated');
  assert.match(attempt(USERS.rep, `${refuse(`r := public.preview_active_ingredient_change('${ZETA}', ${J({ cas: ZETA_CAS })});`)} v := t;`), /ADMIN_REQUIRED/);
  assert.match(attempt(USERS.rep, `${refuse(`r := public.save_active_ingredient('${ZETA}', 1, 'x', ${J({ cas: ZETA_CAS })}, 'r', 'e', 'k');`)} v := t;`), /ADMIN_REQUIRED/);
  console.log('[refuse] no reason, no evidence, bad check digit, taken CAS, CAS contradicting EPA, changing/clearing an EPA-given CAS, CAS+acid, acid alone, sales rep -> all refused');

  // The fix.
  const epaRowBefore = scalar(`SELECT row_version || ':' || strength_value || ':' || source FROM public.product_parent_ingredients WHERE parent_id = '${P_EPA}' AND ingredient_id = '${ZETA}';`);
  const saved = previewThenSave(ZETA, { cas: ZETA_CAS }, 'EPA gave no CAS', 'CAS registry 52315-07-8', ADMIN, true);
  assert.match(saved, /^ok\|/, `fill must save: ${saved}`);
  const res = JSON.parse(saved.slice(3));
  assert.deepEqual(res.changed_fields, ['cas']);
  assert.equal(res.ingredient.cas, ZETA_CAS);
  assert.equal(scalar(`SELECT cas FROM public.active_ingredients WHERE id = '${ZETA}';`), ZETA_CAS);
  assert.equal(scalar(`SELECT count(*) FROM public.active_ingredient_events WHERE ingredient_id = '${ZETA}' AND event_type = 'updated' AND reason = 'EPA gave no CAS';`), '1', 'ingredient event');
  assert.equal(scalar(`SELECT count(*) FROM public.product_chemistry_events WHERE event_type = 'corrected' AND after_values->>'source_path' = 'ingredient_edit' AND after_values->>'ingredient_id' = '${ZETA}';`), '2', 'one chemistry event per product');
  assert.equal(scalar(`SELECT string_agg(chemistry_version::text, ',' ORDER BY parent_id) FROM public.product_parent_chemistry_state WHERE parent_id IN ('${P_EPA}', '${P_TYPED}');`), '2,2', 'chemistry versions bumped');
  assert.equal(scalar(`SELECT row_version || ':' || strength_value || ':' || source FROM public.product_parent_ingredients WHERE parent_id = '${P_EPA}' AND ingredient_id = '${ZETA}';`), epaRowBefore, 'EPA row untouched');
  console.log(`[fill] admin filled CAS ${ZETA_CAS} on an EPA-sourced ingredient; events written; EPA product row unchanged`);

  // A typed CAS EPA does not give: a mistyped fill can be corrected.
  assert.match(previewThenSave(TYPED_ING, { cas: '50-00-0' }, 'typed', 'SDS', ADMIN, true), /^ok\|/, 'typed fill');
  assert.match(previewThenSave(TYPED_ING, { cas: '64-17-5' }, 'wrong SDS', 'right SDS', ADMIN, true), /^ok\|/, 'typed CAS corrected');
  assert.equal(scalar(`SELECT cas FROM public.active_ingredients WHERE id = '${TYPED_ING}';`), '64-17-5');
  console.log('[correct] a typed CAS on the EPA product (not one EPA gives) was filled, then corrected');

  // Now set, the CAS is established: changing it again on the EPA product stays gated.
  assert.match(previewThenSave(ZETA, { cas: '50-00-0' }), /PREVIEW_REFUSED CHEMISTRY_FROM_EPA_ONLY/, 'a filled CAS EPA gives is then gated');
  console.log('[after] changing the now-set CAS stays gated');

  console.log('\nINGREDIENT_CAS_FILL_PROOF_PASS');
} finally {
  if (process.env.KEEP_CONTAINER !== '1') removeContainer();
}
