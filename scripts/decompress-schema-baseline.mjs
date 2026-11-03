#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineDir = path.join(repoRoot, 'supabase', 'baselines');
const manifest = JSON.parse(readFileSync(path.join(baselineDir, 'manifest.json'), 'utf8'));
const artifactName = `${manifest.migrations_high_water}_public_schema.sql.br`;
const expected = manifest.artifacts?.[artifactName];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex').toUpperCase();
const invalid = (message) => {
  throw new Error(`SCHEMA_BASELINE_INVALID: ${message}`);
};

if (path.basename(artifactName) !== artifactName || expected?.encoding !== 'brotli') {
  invalid('manifest does not name the expected Brotli public-schema artifact');
}

const stored = readFileSync(path.join(baselineDir, artifactName));
if (stored.length !== expected.bytes || sha256(stored) !== expected.sha256) {
  invalid('stored public-schema artifact hash or byte length drifted');
}

const decoded = brotliDecompressSync(stored);
if (decoded.length !== expected.decoded_bytes || sha256(decoded) !== expected.decoded_sha256) {
  invalid('decoded public-schema SQL hash or byte length drifted');
}

process.stdout.write(decoded);

// --with-live-rows: disposable test databases only, never a real restore (the data restore brings these back).
// Live rows that later migrations' postconditions require and the schema-only baseline lacks.
if (process.argv.includes('--with-live-rows')) {
  process.stdout.write(`
-- Live's only warehouse since 20260213160000; KI-85 (20261102220000) requires it active.
INSERT INTO public.warehouses (id, name, code, state, is_active, is_default, created_at)
VALUES ('19f7ca09-310d-4d40-8c2f-ba46f333f065', 'Main Warehouse', 'MW', 'IL', true, true, '2026-02-13 05:56:31.323738+00');
`);
}
