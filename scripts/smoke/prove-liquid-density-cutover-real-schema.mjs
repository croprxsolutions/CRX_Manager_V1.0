import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, psql, scalar, seedUsers, ROOT } from './undo-paths/harness.mjs';

const migration = '20270308110000_enable_liquid_density_review.sql';
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8').replaceAll('\r\n', '\n');

try {
  buildContainer({ stopBefore: migration });
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f');
  const cutover = read('supabase', 'migrations', migration);
  const driftedApproval = psql(`BEGIN;
    CREATE OR REPLACE FUNCTION public.approve_weights(p_items jsonb, p_idempotency_key text DEFAULT NULL)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb /* PRODUCT_WEIGHT_REVIEW_RELOAD */; $$;
    ${cutover}
    COMMIT;`, { allowFailure: true });
  assert.equal(driftedApproval.status, 3, driftedApproval.stderr + driftedApproval.stdout);
  assert.match(driftedApproval.stderr, /PREFLIGHT_LIQUID_DENSITY_REVIEW/);

  const driftedSubmit = psql(`BEGIN;
    CREATE OR REPLACE FUNCTION public.submit_liquid_density_draft(
      p_parent_id uuid, p_expected_version bigint, p_value numeric, p_unit text, p_source text,
      p_source_note text, p_reason text, p_evidence text, p_idempotency_key text DEFAULT NULL)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb; $$;
    ${cutover}
    COMMIT;`, { allowFailure: true });
  assert.equal(driftedSubmit.status, 3, driftedSubmit.stderr + driftedSubmit.stdout);
  assert.match(driftedSubmit.stderr, /PREFLIGHT_LIQUID_DENSITY_REVIEW/);

  const driftedTrigger = psql(`BEGIN;
    CREATE OR REPLACE TRIGGER return_liquid_density_to_draft_for_brand
      AFTER INSERT OR UPDATE OF status, parent_id, epa_registration ON public.product_parent_brands
      FOR EACH ROW WHEN (NEW.manufacturer IS NOT NULL)
      EXECUTE FUNCTION public.return_liquid_density_to_draft_for_brand();
    ${cutover}
    COMMIT;`, { allowFailure: true });
  assert.equal(driftedTrigger.status, 3, driftedTrigger.stderr + driftedTrigger.stdout);
  assert.match(driftedTrigger.stderr, /PREFLIGHT_LIQUID_DENSITY_REVIEW/);
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f');

  psql(`BEGIN;\n${cutover}\nCOMMIT;`);
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 't');
  seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES (gen_random_uuid(), 'density-reviewer@example.invalid', '{"full_name":"Density Reviewer","role":"admin"}');`);
  for (const chain of ['smoke-liquid-density-review.sql', 'smoke-reject-liquid-density-draft.sql']) {
    const result = psql(read('scripts', 'smoke', chain), { allowFailure: true });
    assert.equal(result.status, 3, chain + result.stderr + result.stdout);
    assert.match(result.stderr, /^ERROR:\s+SMOKE_PASS_ROLLBACK\r?$/m, chain + result.stderr + result.stdout);
  }
  console.log('LIQUID_DENSITY_CUTOVER_PROOF_PASS');
} finally {
  removeContainer();
}
