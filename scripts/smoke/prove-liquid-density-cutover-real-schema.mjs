import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { wrapperSql } from '../../.github/scripts/db-apply.mjs';
import { buildContainer, removeContainer, psql, scalar, seedUsers, ROOT } from './undo-paths/harness.mjs';

const migration = '20270309050000_enable_liquid_density_review.sql';
const stagingRef = 'fsnjredpmakbmhwowjjt';
const stagingContext = `SET LOCAL crx.liquid_weight_staging_project = '${stagingRef}';`;
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8').replaceAll('\r\n', '\n');
const cutover = read('supabase', 'migrations', migration);
const stem = migration.slice(0, -4);
const wrapped = (text) => wrapperSql({
  stem, text, run: true, targetRef: stagingRef,
  sha: createHash('sha256').update(text).digest('hex'),
});
const stagingSql = wrapped(cutover);
assert.ok(stagingSql.includes(stagingContext), 'The staging runner preparation must be in the base branch');

try {
  buildContainer({ stopBefore: migration });
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f');
  for (const context of ['', "SET LOCAL crx.liquid_weight_staging_project = 'wrong_project';"]) {
    psql(`BEGIN;\n${context}\n${cutover}\nCOMMIT;`);
    assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f');
  }

  function expectPreflightRefusal(change) {
    const result = psql(`BEGIN;\n${stagingContext}\n${change}\n${cutover}\nCOMMIT;`, { allowFailure: true });
    assert.equal(result.status, 3, result.stderr + result.stdout);
    assert.match(result.stderr, /PREFLIGHT_LIQUID_DENSITY_REVIEW/);
    assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f');
  }

  expectPreflightRefusal(`
    CREATE OR REPLACE FUNCTION public.approve_weights(p_items jsonb, p_idempotency_key text DEFAULT NULL)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb /* PRODUCT_WEIGHT_REVIEW_RELOAD */; $$;`);

  expectPreflightRefusal(`
    CREATE OR REPLACE FUNCTION public.submit_liquid_density_draft(
      p_parent_id uuid, p_expected_version bigint, p_value numeric, p_unit text, p_source text,
      p_source_note text, p_reason text, p_evidence text, p_idempotency_key text DEFAULT NULL)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb; $$;`);

  expectPreflightRefusal(`
    CREATE OR REPLACE TRIGGER return_liquid_density_to_draft_for_brand
      AFTER INSERT OR UPDATE OF status, parent_id, epa_registration ON public.product_parent_brands
      FOR EACH ROW WHEN (NEW.manufacturer IS NOT NULL)
      EXECUTE FUNCTION public.return_liquid_density_to_draft_for_brand();`);

  expectPreflightRefusal('ALTER TABLE public.product_parent_brands DISABLE TRIGGER return_liquid_density_to_draft_for_brand;');
  expectPreflightRefusal('ALTER FUNCTION public.approve_weights(jsonb, text) RESET search_path;');
  expectPreflightRefusal('ALTER FUNCTION public.approve_liquid_density_draft(uuid, uuid, bigint, jsonb, boolean, text) STABLE;');
  expectPreflightRefusal('GRANT EXECUTE ON FUNCTION public.liquid_density_review_open() TO anon;');
  expectPreflightRefusal("CREATE FUNCTION public.get_liquid_density_review(text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';");
  expectPreflightRefusal(`
    CREATE OR REPLACE FUNCTION public.get_liquid_density_review(p_parent_id uuid)
    RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp
    AS $$ BEGIN RETURN '{"review_open":false,"brands":[]}'::jsonb; END; $$;`);

  const failedApply = psql(wrapped('SELECT 1;'), { allowFailure: true });
  assert.equal(failedApply.status, 3, failedApply.stderr + failedApply.stdout);
  assert.match(failedApply.stderr, /LIQUID_DENSITY_STAGING_ACTIVATION_DID_NOT_OPEN/);
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${stem}';`), '0');

  const definitionHash = "SELECT md5(pg_get_functiondef('public.liquid_density_review_open()'::regprocedure));";
  const rebuildDefinition = psql(
    `BEGIN;\n${stagingContext}\n${cutover}\n${definitionHash}\nROLLBACK;`,
  ).stdout.match(/\b[0-9a-f]{32}\b/)?.[0];
  assert.ok(rebuildDefinition);
  psql(stagingSql);
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 't');
  assert.equal(scalar(definitionHash), rebuildDefinition);
  assert.equal(scalar(`SELECT encode(sha256(convert_to(statements[1], 'UTF8')), 'hex')
    FROM supabase_migrations.schema_migrations WHERE name = '${stem}';`),
  createHash('sha256').update(cutover).digest('hex'));
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
