import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, psql, scalar, seedUsers, ROOT } from './undo-paths/harness.mjs';

const migration = '20270307120000_liquid_density_review.sql';
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8').replaceAll('\r\n', '\n');

try {
  buildContainer({ stopBefore: migration });
  assert.equal(scalar("SELECT to_regclass('public.brand_document_links')::text;"), 'brand_document_links');
  const candidate = read('supabase', 'migrations', migration);
  const missingDocs = psql(`BEGIN; ALTER TABLE public.brand_document_links RENAME TO proof_hidden_brand_document_links;
    ${candidate} COMMIT;`, { allowFailure: true });
  assert.equal(missingDocs.status, 3, missingDocs.stderr + missingDocs.stdout);
  assert.match(missingDocs.stderr, /PREFLIGHT_LIQUID_DENSITY_DOCUMENTS/);
  psql(`BEGIN;\n${candidate}\nCOMMIT;`);
  assert.equal(scalar('SELECT public.liquid_density_review_open();'), 'f', 'initial migration must leave the legacy behavior active');
  seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES (gen_random_uuid(), 'density-reviewer@example.invalid', '{"full_name":"Density Reviewer","role":"admin"}');`);
  const legacy = psql(read('scripts', 'smoke', 'smoke-product_weights.sql'), { allowFailure: true });
  assert.equal(legacy.status, 3, legacy.stderr + legacy.stdout);
  assert.match(legacy.stderr, /^ERROR:\s+SMOKE_PASS_ROLLBACK: product weights chain passed\r?$/m, legacy.stderr + legacy.stdout);
  const closed = psql(read('scripts', 'smoke', 'smoke-liquid-density-review.sql'), { allowFailure: true });
  assert.equal(closed.status, 3, closed.stderr + closed.stdout);
  assert.match(closed.stderr, /^ERROR:\s+SMOKE_PASS_ROLLBACK\r?$/m, closed.stderr + closed.stdout);
  psql(`CREATE OR REPLACE FUNCTION public.liquid_density_review_open() RETURNS boolean
        LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT true; $$;`);
  const retiredLegacy = psql(read('scripts', 'smoke', 'smoke-product_weights.sql'), { allowFailure: true });
  assert.equal(retiredLegacy.status, 3, retiredLegacy.stderr + retiredLegacy.stdout);
  assert.match(retiredLegacy.stderr, /^ERROR:\s+SMOKE_PASS_ROLLBACK: product weights chain passed\r?$/m,
    retiredLegacy.stderr + retiredLegacy.stdout);
  const result = psql(read('scripts', 'smoke', 'smoke-liquid-density-review.sql'), { allowFailure: true });
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr, /^ERROR:\s+SMOKE_PASS_ROLLBACK\r?$/m, result.stderr + result.stdout);
  console.log('LIQUID_DENSITY_REVIEW_PROOF_PASS');
} finally {
  removeContainer();
}
