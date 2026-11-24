#!/usr/bin/env node
/**
 * Fast, Docker-free guard that binds the shipped save_field migration body to
 * the standing live-sweep fingerprint. The disposable PostgreSQL proof still
 * exercises database behavior; this guard makes body drift fail in ordinary
 * correction-guard CI even when Docker is unavailable.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20261107140000_save_field_refuses_missing_field.sql');
const PREDICATE = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'save-field-actor-binding.sql');
const SIGNATURE = 'CREATE OR REPLACE FUNCTION public.save_field(';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const migration = readFileSync(MIGRATION, 'utf8');
const predicate = readFileSync(PREDICATE, 'utf8');
const start = migration.indexOf(SIGNATURE);
assert.notEqual(start, -1, 'save_field definition is missing from the migration');

const bodyMatch = migration.slice(start).match(/AS \$\$([\s\S]*?)\$\$;/);
assert.ok(bodyMatch, 'save_field dollar-quoted body is missing from the migration');
const body = bodyMatch[1];

// KI-10 batch 4d renamed that body unchanged behind a reviewed wrapper; the predicate pins both.
const BATCH4D = path.join(ROOT, 'supabase', 'migrations', '20261114200000_bind_records_replay_receipts_batch4d.sql');
const batch4d = readFileSync(BATCH4D, 'utf8').replace(/\r\n/g, '\n');
const wrapperStart = batch4d.indexOf('CREATE FUNCTION public.save_field(p_field_id');
assert.notEqual(wrapperStart, -1, 'batch 4d save_field wrapper is missing from its migration');
const wrapperMatch = batch4d.slice(wrapperStart).match(/AS \$function\$([\s\S]*?)\$function\$;/);
assert.ok(wrapperMatch, 'batch 4d save_field wrapper body is missing');

// Field application FP-1 replaced the impl body behind the same wrapper; the predicate accepts it too.
const FP1 = path.join(ROOT, 'supabase', 'migrations', '20270303120000_field_split_versions.sql');
const fp1 = readFileSync(FP1, 'utf8').replace(/\r\n/g, '\n');
const fp1Start = fp1.indexOf('CREATE OR REPLACE FUNCTION public._save_field_replay_impl_20261015(');
assert.notEqual(fp1Start, -1, 'FP-1 save_field impl is missing from its migration');
const fp1Match = fp1.slice(fp1Start).match(/AS \$function\$([\s\S]*?)\$function\$;/);
assert.ok(fp1Match, 'FP-1 save_field impl body is missing');

const fingerprints = predicate.match(/\b[0-9a-f]{64}\b/g) ?? [];
assert.equal(fingerprints.length, 3, 'predicate must embed the reviewed body, the batch 4d wrapper and the FP-1 impl fingerprints');
assert.equal(
  sha256(body),
  fingerprints[0],
  'checked-in save_field body drifted from the standing live-sweep fingerprint',
);
assert.equal(
  sha256(wrapperMatch[1]),
  fingerprints[1],
  'checked-in batch 4d save_field wrapper drifted from the standing live-sweep fingerprint',
);

assert.equal(
  sha256(fp1Match[1]),
  fingerprints[2],
  'checked-in FP-1 save_field impl drifted from the standing live-sweep fingerprint',
);

const alteredBody = body.replace('RETURN v_field_id;', 'RETURN v_field_id ;');
assert.notEqual(alteredBody, body, 'drift fixture must alter the function body');
assert.notEqual(sha256(alteredBody), fingerprints[0], 'cosmetic function-body drift must fail closed');

console.log('SAVE_FIELD_ACTOR_BINDING_STATIC_TEST_PASS');
