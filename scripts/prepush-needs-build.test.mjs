#!/usr/bin/env node
// Pre-push skips the app type check and build only when no app file changed, and builds on any doubt.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { needsAppBuild } from './prepush-needs-build.mjs';

assert.equal(needsAppBuild(['scripts/a.mjs', 'docs/x.md', 'supabase/migrations/1_x.sql']), false);
for (const file of ['src/App.tsx', 'public/sw.js', 'index.html', 'vite.config.ts', 'tsconfig.app.json', 'package-lock.json', 'vercel.json']) {
  assert.equal(needsAppBuild([file]), true, `${file} must trigger the build`);
}

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

console.log('PASS - pre-push skips the type check and build only when no app file changed.');
