import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function schemaFingerprint(root, migrations) {
  const baseline = JSON.parse(readFileSync(path.join(root, 'supabase/baselines/manifest.json'), 'utf8'));
  const files = [
    ...migrations,
    ...baseline.restore_order.map((name) => path.join('supabase', 'baselines', name)),
    'supabase/baselines/manifest.json',
    'supabase/baselines/one-shot-migrations.json',
    'scripts/decompress-schema-baseline.mjs',
    'scripts/local-app/walkthrough-reference-fixtures.sql',
    'scripts/verify-schema-baseline.mjs',
    'scripts/list-post-baseline-migrations.mjs',
    'scripts/local-app/app.mjs',
    'scripts/local-app/walkthrough.mjs',
    'scripts/local-app/target.mjs',
    'scripts/local-app/schema-fingerprint.mjs',
    'scripts/local-app/compose.yaml',
    'scripts/local-app/kong.yml',
    'scripts/local-app/seed.sql',
  ];
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
}
