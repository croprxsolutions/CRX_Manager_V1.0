import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, psql, seedUsers, ROOT } from './undo-paths/harness.mjs';

const migration = '20270306200000_reject_liquid_density_draft.sql';
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8').replaceAll('\r\n', '\n');

try {
  buildContainer({ stopBefore: migration });
  psql(`BEGIN;\n${read('supabase', 'migrations', migration)}\nCOMMIT;`);
  seedUsers();
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES (gen_random_uuid(), 'density-reviewer@example.invalid', '{"full_name":"Density Reviewer","role":"admin"}');`);
  const result = psql(read('scripts', 'smoke', 'smoke-reject-liquid-density-draft.sql'), { allowFailure: true });
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr, /^ERROR:\s+SMOKE_PASS_ROLLBACK\r?$/m, result.stderr + result.stdout);
  console.log('REJECT_LIQUID_DENSITY_DRAFT_PROOF_PASS');
} finally {
  removeContainer();
}
