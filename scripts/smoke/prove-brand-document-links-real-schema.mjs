import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildContainer, removeContainer, psql, seedUsers, ROOT } from './undo-paths/harness.mjs';

const migration = '20270303160000_brand_document_links.sql';
const read = (...pieces) => readFileSync(path.join(ROOT, ...pieces), 'utf8').replaceAll('\r\n', '\n');

try {
  buildContainer({ stopBefore: migration });
  psql(`BEGIN;\n${read('supabase', 'migrations', migration)}\nCOMMIT;`);
  seedUsers();
  const result = psql(read('scripts', 'smoke', 'smoke-brand-document-links.sql'), { allowFailure: true });
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr, /^ERROR:\s+SMOKE_PASS_ROLLBACK\r?$/m, result.stderr + result.stdout);
  console.log('BRAND_DOCUMENT_LINKS_PROOF_PASS');
} finally {
  removeContainer();
}
