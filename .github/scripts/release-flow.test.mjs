// Run: node --test .github/scripts/release-flow.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReleaseOrHotfixHead, flowEnabled, foreignReleaseCommits, proofLink, heldOffNote, isBackMerge, labelProblem,
} from './release-flow.mjs';

test('only release/next and hotfix/<name> may open a PR into main', () => {
  for (const ok of ['release/next', 'hotfix/fix-x', 'hotfix/2026-11-10-cents']) assert.equal(isReleaseOrHotfixHead(ok), true, ok);
  for (const bad of ['hotfix/', 'release/v1.0.0', 'release/next/x', 'hotfix/fix/extra', 'main', 'staging', 'taha/x', 'claude/hotfix/x', '', undefined]) {
    assert.equal(isReleaseOrHotfixHead(bad), false, String(bad));
  }
});

test('the flow is enforced only when RELEASE_FLOW is exactly "on"', () => {
  assert.equal(flowEnabled({ RELEASE_FLOW: 'on' }), true);
  for (const v of [undefined, '', 'On', 'true', 'off']) assert.equal(flowEnabled({ RELEASE_FLOW: v }), false, String(v));
});

test('release/next may carry only staging work and the bot\'s version commit', () => {
  assert.deepEqual(foreignReleaseCommits(['crx-release-bot[bot]\tchore(release): v0.2.0']), []);
  assert.deepEqual(foreignReleaseCommits(['Mason Wells\tchore(release): v0.2.0']), ['Mason Wells\tchore(release): v0.2.0']);
  assert.deepEqual(foreignReleaseCommits(['crx-release-bot[bot]\tfeat: sneaky']), ['crx-release-bot[bot]\tfeat: sneaky']);
});

test('proofLink finds the first https "Staging proof:" line in the body or any comment', () => {
  assert.equal(proofLink(['Summary\nStaging proof: https://a.example/1']), 'https://a.example/1');
  assert.equal(proofLink(['no proof here', 'later comment\n  staging proof:https://b.example/x?y=1  ']), 'https://b.example/x?y=1');
  assert.equal(proofLink(['Staging proof: http://insecure.example']), null);
  assert.equal(proofLink(['Staging proof: <link>']), null);
  assert.equal(proofLink(['Staging proof: soon']), null);
  assert.equal(proofLink([null, undefined, '']), null);
});

test('heldOffNote needs some text after "Held off:"', () => {
  assert.equal(heldOffNote(['Held off: #1712 reverts it']), '#1712 reverts it');
  assert.equal(heldOffNote(['held off:   flag bill_split_v2 off']), 'flag bill_split_v2 off');
  assert.equal(heldOffNote(['Held off:', 'Held off:   ']), null);
});

test('a back-merge PR has main as its head', () => {
  assert.equal(isBackMerge('main'), true);
  for (const ref of ['staging', 'taha/main', 'release/next', undefined]) assert.equal(isBackMerge(ref), false, String(ref));
});

test('labelProblem explains what is missing, or returns null', () => {
  const merged = { merged: true, baseRef: 'staging' };
  assert.equal(labelProblem({ ...merged, label: 'verified-on-staging', texts: ['Staging proof: https://x.example'] }), null);
  assert.match(labelProblem({ ...merged, label: 'verified-on-staging', texts: ['looks good'] }), /Staging proof: <link>/);
  assert.match(labelProblem({ merged: false, baseRef: 'staging', label: 'verified-on-staging', texts: ['Staging proof: https://x.example'] }), /after the PR is merged into staging/);
  assert.match(labelProblem({ merged: true, baseRef: 'main', label: 'held-off', texts: ['Held off: flag'] }), /after the PR is merged into staging/);
  assert.equal(labelProblem({ ...merged, label: 'held-off', texts: ['Held off: #1712'] }), null);
  assert.match(labelProblem({ ...merged, label: 'held-off', texts: [] }), /Held off: <revert PR or flag name>/);
  assert.equal(labelProblem({ ...merged, label: 'on-staging', texts: [] }), null);
});
