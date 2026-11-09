#!/usr/bin/env node
// Pre-push skips the app type check and build only when no app file changed, and builds on any doubt.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { edgeSourceTests, needsAppBuild, needsFreshnessCheck, needsMapCheck, needsPinCheck, needsRegistryCheck } from './prepush-needs-build.mjs';
import { tempDir } from './lib/test-temp-dir.mjs';

assert.equal(needsAppBuild(['scripts/a.mjs', 'docs/x.md', 'supabase/migrations/1_x.sql']), false);
for (const file of ['src/App.tsx', 'public/sw.js', 'index.html', 'vite.config.ts', 'tsconfig.app.json', 'package-lock.json', 'vercel.json']) {
  assert.equal(needsAppBuild([file]), true, `${file} must trigger the build`);
}

assert.equal(needsMapCheck(['scripts/a.mjs', 'docs/x.md', 'public/sw.js', 'package.json']), false);
for (const file of ['src/pages/Jobs.tsx', 'docs/app-workflow-map.html', 'docs/reference/rpc-functions.md', 'scripts/generate-workflow-map.mjs']) {
  assert.equal(needsMapCheck([file]), true, `${file} must trigger the map check`);
}

assert.equal(needsPinCheck(['src/App.tsx', 'docs/reference/migrations.d/README.txt', 'supabase/migrations/x/y.sql', 'docs/changelog.d/a.md']), false);
for (const file of ['supabase/migrations/20261201000000_x.sql', 'docs/reference/migrations.d/20261201000000_x.md', 'docs/reference/migration-history.md']) {
  assert.equal(needsPinCheck([file]), true, `${file} must trigger the pin check`);
}

assert.equal(needsFreshnessCheck(['src/App.tsx', 'docs/reference/migrations.d/20261201000000_x.md', 'docs/manual/CURRENT_STATE.md', 'supabase/migrations/x/y.sql']), false,
  'only migration SQL triggers the stamp check');
assert.equal(needsFreshnessCheck(['supabase/migrations/20261201000000_x.sql']), true);

assert.equal(needsRegistryCheck(['src/App.tsx', 'supabase/migrations/1_x.sql', '.claude/settings.json', 'docs/reference/migrations.d/x/y.md']), false);
for (const file of ['.claude/schema-registry.json', 'docs/reference/migrations.d/20261204120000_x.md']) {
  assert.equal(needsRegistryCheck([file]), true, `${file} must trigger the contract tests`);
}

// Edge Function source tests: pick tests that name a changed function folder, by path or by join() segments.
const edgeTests = [
  { path: 'src/a.test.ts', text: "readFileSync('supabase/functions/send-email/index.ts')" },
  { path: 'src/b.test.ts', text: "join(root, 'supabase', 'functions', 'send-email', 'index.ts')" },
  { path: 'src/c.test.ts', text: "path.join(root, 'supabase\\\\functions\\\\_shared\\\\x.ts')" },
  { path: 'src/d.test.ts', text: 'supabase/functions/send-email-other/index.ts' },
  { path: 'src/e.test.ts', text: 'unrelated' },
];
assert.deepEqual(edgeSourceTests(['supabase/functions/send-email/index.ts'], edgeTests), ['src/a.test.ts', 'src/b.test.ts']);
assert.deepEqual(edgeSourceTests(['supabase/functions/_shared/x.ts'], edgeTests), ['src/c.test.ts']);
assert.deepEqual(edgeSourceTests(null, edgeTests), ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts']);
assert.deepEqual(edgeSourceTests(['src/App.tsx', 'supabase/migrations/1_x.sql', 'supabase/functions/README.md'], edgeTests), []);

const verdict = (stdin) => spawnSync(process.execPath, ['scripts/prepush-needs-build.mjs'], { input: stdin, encoding: 'utf8' }).stdout.trim();
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const zero = '0'.repeat(40);
const appCommit = git('log', '--format=%H', '-1', 'HEAD', '--', 'src/');
const docsCommit = git('rev-parse', 'da3e82840'); // PR #1338: scripts, provers and docs only

assert.equal(verdict(`refs/heads/x ${appCommit} refs/heads/x ${git('rev-parse', `${appCommit}^`)}\n`), 'build');
assert.equal(verdict(`refs/heads/x ${docsCommit} refs/heads/x ${git('rev-parse', `${docsCommit}^`)}\n`), 'skip');
assert.equal(verdict(`refs/heads/x ${zero} refs/heads/x ${appCommit}\n`), 'skip', 'a branch delete has nothing to build');
assert.equal(verdict(''), 'build', 'no refs: build');
assert.equal(verdict('garbage line here\n'), 'build', 'an unreadable ref line must build');

// A move out of src/ must still build: rename detection would report only the new path.
const repo = tempDir('crx-prepush-move-');
try {
  const inRepo = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  inRepo('init', '-q');
  mkdirSync(path.join(repo, 'src')); mkdirSync(path.join(repo, 'scripts'));
  writeFileSync(path.join(repo, 'src/value.ts'), 'export const value = 1;\n');
  inRepo('add', '.'); inRepo('commit', '-qm', 'base');
  const before = inRepo('rev-parse', 'HEAD');
  inRepo('mv', 'src/value.ts', 'scripts/value.ts'); inRepo('commit', '-qm', 'move');
  const moved = spawnSync(process.execPath, [path.resolve('scripts/prepush-needs-build.mjs')],
    { cwd: repo, input: `refs/heads/x ${inRepo('rev-parse', 'HEAD')} refs/heads/x ${before}\n`, encoding: 'utf8' }).stdout.trim();
  assert.equal(moved, 'build', 'moving a file out of src/ must build');
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log('PASS - pre-push skips the build and the map check only when none of their inputs changed.');
