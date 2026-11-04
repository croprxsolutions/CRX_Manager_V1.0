#!/usr/bin/env node
// Networkless checks for run-smoke.mjs --live: which chain files it will send, and how it grades
// Management API responses (token decoding: scripts/lib/supabase-credential.test.mjs).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpretResult } from './interpret-result.mjs';
import { liveResultText, readLiveChain } from './run-smoke.mjs';

const specs = JSON.parse(readFileSync(new URL('./smoke-specs.json', import.meta.url), 'utf8')).specs;

// Allowlist: a registry chain is sent exactly as written; anything else is refused.
const chain = 'smoke-quote-sent-requires-version.sql';
assert.equal(readLiveChain(specs, 'quote_sent_requires_version'), readFileSync(new URL(`./${chain}`, import.meta.url), 'utf8'));
assert.throws(() => readLiveChain(specs, 'no_such_spec'), /not in smoke-specs\.json/);
assert.throws(() => readLiveChain(specs, 'constructor'), /not in smoke-specs\.json/);
assert.throws(() => readLiveChain({ x: { chain: '../db-invariant-sweeps/x.sql' } }, 'x'), /not a \.sql file in scripts\/smoke/);
assert.throws(() => readLiveChain({ x: { chain: 'C:/Windows/x.sql' } }, 'x'), /not a \.sql file in scripts\/smoke/);
assert.throws(() => readLiveChain({ x: { chain: 'run-smoke.mjs' } }, 'x'), /not a \.sql file/);
assert.throws(() => readLiveChain({ x: { chain: 'export-supplier-pricing-phase1a-workbook.sql' } }, 'x'), /never raises SMOKE_PASS_ROLLBACK/);
// Mentioning the token is not raising it (a chain that never raises would commit), and a link
// inside scripts/smoke/ cannot send a file from elsewhere.
const dir = fileURLToPath(new URL('.', import.meta.url));
const outside = mkdtempSync(path.join(tmpdir(), 'smoke-live-'));
const tmpChain = (name, sql) => { writeFileSync(path.join(dir, name), sql); return name; };
const mentionOnly = tmpChain('zz-live-test-mention.sql', "DELETE FROM x; -- SMOKE_PASS_ROLLBACK\n/* RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' */\n");
const raises = tmpChain('zz-live-test-raise.sql', "DO $$ BEGIN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: ok'; END $$;\n");
const link = 'zz-live-test-link.sql';
writeFileSync(path.join(outside, 'x.sql'), "DO $$ BEGIN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;\n");
let linked = false;
try { symlinkSync(path.join(outside, 'x.sql'), path.join(dir, link)); linked = true; } catch { /* no symlink rights (Windows without developer mode) */ }
try {
  assert.throws(() => readLiveChain({ x: { chain: mentionOnly } }, 'x'), /never raises SMOKE_PASS_ROLLBACK/);
  assert.match(readLiveChain({ x: { chain: raises } }, 'x'), /RAISE EXCEPTION/);
  if (linked) assert.throws(() => readLiveChain({ x: { chain: link } }, 'x'), /not a \.sql file in scripts\/smoke/);
  else console.log('note: symlink case skipped (this machine cannot create symlinks)');
} finally {
  for (const name of [mentionOnly, raises, link]) rmSync(path.join(dir, name), { force: true });
  rmSync(outside, { recursive: true, force: true });
}
const psqlOnly =Object.keys(specs).find((k) => specs[k].psql_only);
const containerOnly = Object.keys(specs).find((k) => specs[k].container_only);
assert.ok(psqlOnly && containerOnly, 'registry still has psql-only and container-only chains to refuse');
assert.throws(() => readLiveChain(specs, psqlOnly), /psql-only/);
assert.throws(() => readLiveChain(specs, containerOnly), /container-only/);

// Grading: the API's error envelope reads like psql output, then the shared PASS/SKIP/FAIL rules apply.
const apiError = (text) => liveResultText(400, JSON.stringify({ message: `Failed to run sql query: ERROR:  P0001: ${text}\nCONTEXT:  PL/pgSQL function inline_code_block line 280 at RAISE\n` }));
assert.deepEqual(interpretResult(apiError('SMOKE_PASS_ROLLBACK: chain (A-G) passed')), { pass: true });
assert.deepEqual(interpretResult(apiError('SMOKE_PASS_ROLLBACK')), { pass: true });
assert.equal(interpretResult(apiError('SMOKE_PASS_ROLLBACK_BUT_FAILED')).pass, false);
const prereq = interpretResult(apiError('SMOKE_PREREQ: migration not applied'));
assert.equal(prereq.prereq, true);
const failed = interpretResult(apiError('SMOKE_FAIL: step C let a draft go to sent'));
assert.equal(failed.pass, false);
assert.match(failed.message, /SMOKE_FAIL: step C/);
assert.equal(interpretResult(liveResultText(201, '[]')).pass, false, 'a chain that does not raise is a FAIL');
assert.match(interpretResult(liveResultText(401, '{"message":"Unauthorized"}')).message, /Unauthorized/);
assert.match(interpretResult(liveResultText(502, '<html>bad gateway</html>')).message, /HTTP 502/);
// The colon shape also passes in psql mode; identifier-extending characters still never pass.
assert.deepEqual(interpretResult('psql:smoke-x.sql:12: ERROR:  SMOKE_PASS_ROLLBACK: passed'), { pass: true });
assert.equal(interpretResult('ERROR:  SMOKE_PASS_ROLLBACKé: x').pass, false);
assert.equal(interpretResult('ERROR:  SMOKE_PASS_ROLLBACK$: x').pass, false);
// A pass token that is only quoted in a non-ERROR line is not a pass.
assert.equal(interpretResult(liveResultText(400, JSON.stringify({ message: 'syntax error near SMOKE_PASS_ROLLBACK' }))).pass, false);

console.log('run-smoke --live: allowlist and grading checks passed');
