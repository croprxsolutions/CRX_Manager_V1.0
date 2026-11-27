import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildContainer, removeContainer, psql, scalar, seedUsers } from './undo-paths/harness.mjs';

const migration = '20270315110000_liquid_weight_brand_recheck.sql';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const rename = read('./smoke-liquid-weight-brand-recheck.sql');
const core = read('./smoke-liquid-density-review.sql');
const legacy = read('./smoke-product_weights.sql');
const stagedActivation = read('../../supabase/migrations/20270312233100_enable_liquid_density_review.sql');
const openSwitchBody = '\n  SELECT true;\n  ';
const switchOpen = `CREATE OR REPLACE FUNCTION public.liquid_density_review_open() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT true; $$;`;

function expectRollback(sql, expected = /^ERROR:\s+SMOKE_PASS_ROLLBACK\r?$/m) {
  const result = psql(sql, { allowFailure: true });
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr, expected, result.stderr + result.stdout);
}

try {
  buildContainer({ stopBefore: migration });
  seedUsers();
  // Generic replay records #2688 without the staging marker. Its open path is exercised below.
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f');
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES (gen_random_uuid(), 'density-brand-reviewer@example.invalid', '{"full_name":"Density Reviewer","role":"admin"}');`);
  const before = psql(`BEGIN;\n${switchOpen}\n${rename}\nROLLBACK;`, { allowFailure: true });
  assert.equal(before.status, 3, before.stderr + before.stdout);
  assert.match(before.stderr, /SMOKE_FAIL: a substantive rename must return the approved weight to draft/);

  const candidate = read(`../../supabase/migrations/${migration}`);
  const openStaging = `BEGIN;
SET LOCAL crx.liquid_weight_staging_project = 'fsnjredpmakbmhwowjjt';
${stagedActivation}`;
  for (const mismatch of [
    "DELETE FROM supabase_migrations.schema_migrations WHERE name = '20270312233100_enable_liquid_density_review';",
    `CREATE OR REPLACE TRIGGER return_liquid_density_to_draft_for_brand
      AFTER INSERT OR UPDATE OF status, parent_id, epa_registration, manufacturer ON public.product_parent_brands
      FOR EACH ROW EXECUTE FUNCTION public.return_liquid_density_to_draft_for_brand();`,
    'ALTER TABLE public.product_parent_brands DISABLE TRIGGER return_liquid_density_to_draft_for_brand;',
    `SET LOCAL check_function_bodies = off;
    CREATE OR REPLACE FUNCTION public.liquid_density_review_open() RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $language_drift$${openSwitchBody}$language_drift$;
    SET LOCAL check_function_bodies = on;
    DO $fixture$ BEGIN
      IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc
           WHERE oid = 'public.liquid_density_review_open()'::regprocedure)
        IS DISTINCT FROM '21e4ff3b1972203a116eb1f276b0bbc1' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: language drift fixture changed the switch body';
      END IF;
    END $fixture$;`,
    ...['text', 'SETOF boolean'].map((result) => `SET LOCAL check_function_bodies = off;
    DROP FUNCTION public.liquid_density_review_open();
    CREATE FUNCTION public.liquid_density_review_open() RETURNS ${result}
    LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $result_drift$${openSwitchBody}$result_drift$;
    SET LOCAL check_function_bodies = on;
    REVOKE ALL ON FUNCTION public.liquid_density_review_open() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
    GRANT EXECUTE ON FUNCTION public.liquid_density_review_open() TO authenticated;`),
    'GRANT EXECUTE ON FUNCTION public.liquid_density_review_open() TO anon;',
    "CREATE FUNCTION public.approve_weights(jsonb) RETURNS jsonb LANGUAGE sql AS 'SELECT $1';",
  ]) {
    expectRollback(`${openStaging}\n${mismatch}\n${candidate}\nROLLBACK;`, /PREFLIGHT_LIQUID_WEIGHT_BRAND_RECHECK/);
  }
  const staging = `${openStaging}
${candidate}
DO $proof$ BEGIN
  IF public.liquid_density_review_open() IS DISTINCT FROM true THEN RAISE EXCEPTION 'SMOKE_FAIL: preparation must preserve open staging'; END IF;
END $proof$;`;
  expectRollback(`${staging}\n${rename}\nROLLBACK;`);
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f');
  psql(`BEGIN;\n${candidate}\nCOMMIT;`);
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('approve_weights', 'return_liquid_density_to_draft_for_brand')`), '2');
  expectRollback(legacy, /^ERROR:\s+SMOKE_PASS_ROLLBACK: product weights chain passed\r?$/m);
  expectRollback(core);
  expectRollback(`BEGIN;\n${switchOpen}\n${rename}\nROLLBACK;`);
  expectRollback(`BEGIN;\n${switchOpen}\n${core}\nROLLBACK;`);
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f');
  console.log('LIQUID_WEIGHT_BRAND_RECHECK_PROOF_PASS');
} finally {
  removeContainer();
}
