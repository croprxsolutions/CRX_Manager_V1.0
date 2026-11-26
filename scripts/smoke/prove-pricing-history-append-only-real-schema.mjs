#!/usr/bin/env node
/**
 * Focused real-schema proof for the two pricing history tables. Restores the repository baseline
 * and applies the later DDL for those tables before testing the candidate in PostgreSQL 17.
 * Run: node scripts/smoke/prove-pricing-history-append-only-real-schema.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const name = `crx-pricing-history-${process.pid}-${Date.now().toString(36)}`;
const image = 'public.ecr.aws/supabase/postgres:17.6.1.143';

function read(file) {
  return readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function checked(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function psql(input, user = 'postgres') {
  return run('docker', ['exec', '-i', name, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input });
}

function ddl(file, pattern, count = 1) {
  const statements = read(`supabase/migrations/${file}`).match(pattern) ?? [];
  assert.equal(statements.length, count, `history DDL in ${file} changed`);
  return statements.join('\n');
}

function restoreHistorySchema() {
  const baselineFile = (suffix) => read(`supabase/baselines/20260727174805_${suffix}.sql`);
  checked(psql(baselineFile('extensions')));
  checked(psql(checked(run(process.execPath, ['scripts/decompress-schema-baseline.mjs', '--with-live-rows']))));
  const signupTrigger = baselineFile('platform_overlay').match(/^CREATE OR REPLACE TRIGGER "on_auth_user_created".*;$/m);
  assert.ok(signupTrigger, 'the baseline signup trigger is missing');
  checked(psql(signupTrigger[0], 'supabase_admin'));

  const historyDdl = [
    ddl('20261026140000_product_price_history_starting_snapshot.sql', /^ALTER TABLE public\.cost_history\b[^;]+;/gm, 2),
    ddl('20261027050000_price_sheet_warnings_and_approval.sql', /^ALTER TABLE public\.cost_history\b[^;]+;/gm),
    ddl('20261029120000_booking_price_override.sql', /^CREATE TABLE public\.quote_price_changes\b[^;]+;/gm),
    ddl('20261101100000_quote_price_trail_and_expiry_grant.sql', /^ALTER TABLE public\.quote_price_changes\b[^;]+;/gm),
  ];
  checked(psql(historyDdl.join('\n')));
}

const migration = read('supabase/migrations/20270309020000_pricing_history_append_only.sql');
const smoke = read('scripts/smoke/smoke-pricing-history-append-only.sql');

checked(run('docker', ['run', '-d', '--name', name, '--network', 'none', '--tmpfs',
  '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', image]));
try {
  const deadline = Date.now() + 60_000;
  while (true) {
    // Use TCP inside the container so the entrypoint's temporary, socket-only server cannot pass.
    if (run('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) break;
    assert.ok(Date.now() < deadline, 'disposable PostgreSQL did not become ready');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  restoreHistorySchema();
  const before = psql(smoke);
  assert.notEqual(before.status, 0, 'the smoke unexpectedly passed before the migration');
  assert.match(before.stderr, /SMOKE_FAIL: expected COST_HISTORY_APPEND_ONLY, but UPDATE succeeded/);

  checked(psql(`BEGIN;\n${migration}\nCOMMIT;`));
  assert.match(checked(psql(smoke)), /PRICING_HISTORY_APPEND_ONLY_SMOKE_PASS/);
  console.log('PRICING_HISTORY_APPEND_ONLY_PROOF_PASS');
} finally {
  checked(run('docker', ['rm', '-f', name]));
}
