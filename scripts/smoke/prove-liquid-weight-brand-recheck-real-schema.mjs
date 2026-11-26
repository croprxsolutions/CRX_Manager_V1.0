import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildContainer, removeContainer, psql, scalar, seedUsers } from './undo-paths/harness.mjs';

const migration = '20270312213037_liquid_weight_brand_recheck.sql';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const rename = read('./smoke-liquid-weight-brand-recheck.sql');
const core = read('./smoke-liquid-density-review.sql');
const switchOpen = `CREATE OR REPLACE FUNCTION public.liquid_density_review_open() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT true; $$;`;

function expectRollback(sql) {
  const result = psql(sql, { allowFailure: true });
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr, /^ERROR:\s+SMOKE_PASS_ROLLBACK\r?$/m, result.stderr + result.stdout);
}

try {
  buildContainer({ stopBefore: migration });
  seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES (gen_random_uuid(), 'density-brand-reviewer@example.invalid', '{"full_name":"Density Reviewer","role":"admin"}');`);
  const before = psql(`BEGIN;\n${switchOpen}\n${rename}\nROLLBACK;`, { allowFailure: true });
  assert.equal(before.status, 3, before.stderr + before.stdout);
  assert.match(before.stderr, /SMOKE_FAIL: a substantive rename must return the approved weight to draft/);

  const candidate = read(`../../supabase/migrations/${migration}`);
  psql(`BEGIN;\n${candidate}\nCOMMIT;`);
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f');
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('approve_weights', 'return_liquid_density_to_draft_for_brand')`), '2');
  expectRollback(core);
  expectRollback(`BEGIN;\n${switchOpen}\n${rename}\nROLLBACK;`);
  expectRollback(`BEGIN;\n${switchOpen}\n${core}\nROLLBACK;`);
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f');
  console.log('LIQUID_WEIGHT_BRAND_RECHECK_PROOF_PASS');
} finally {
  removeContainer();
}
