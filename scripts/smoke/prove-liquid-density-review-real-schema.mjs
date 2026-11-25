import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, psql, scalar, seedUsers, ROOT } from './undo-paths/harness.mjs';

const migration = '20270305160000_liquid_density_review.sql';
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8').replaceAll('\r\n', '\n');

try {
  buildContainer({ stopBefore: migration });
  assert.equal(scalar("SELECT to_regclass('public.brand_document_links')::text;"), 'brand_document_links');
  psql(`BEGIN;\n${read('supabase', 'migrations', migration)}\nCOMMIT;`);
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f', 'initial migration must leave the legacy behavior active');
  seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES (gen_random_uuid(), 'density-reviewer@example.invalid', '{"full_name":"Density Reviewer","role":"admin"}');`);
  psql(`CREATE OR REPLACE FUNCTION public.liquid_density_review_open() RETURNS boolean
        LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT true; $$;`);
  const result = psql(read('scripts', 'smoke', 'smoke-liquid-density-review.sql'), { allowFailure: true });
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr, /^ERROR:\s+SMOKE_PASS_ROLLBACK\r?$/m, result.stderr + result.stdout);
  console.log('LIQUID_DENSITY_REVIEW_PROOF_PASS');
} finally {
  removeContainer();
}
