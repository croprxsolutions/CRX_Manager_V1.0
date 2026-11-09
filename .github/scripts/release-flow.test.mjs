// Run: node --test .github/scripts/release-flow.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReleaseOrHotfixHead, flowEnabled } from './release-flow.mjs';

test('only release/next and hotfix/<name> may open a PR into main', () => {
  for (const ok of ['release/next', 'hotfix/fix-x', 'hotfix/2026-11-10-cents']) assert.equal(isReleaseOrHotfixHead(ok), true, ok);
  for (const bad of ['hotfix/', 'release/v1.0.0', 'release/next/x', 'main', 'staging', 'taha/x', 'claude/hotfix/x', '', undefined]) {
    assert.equal(isReleaseOrHotfixHead(bad), false, String(bad));
  }
});

test('the flow is enforced only when RELEASE_FLOW is exactly "on"', () => {
  assert.equal(flowEnabled({ RELEASE_FLOW: 'on' }), true);
  for (const v of [undefined, '', 'On', 'true', 'off']) assert.equal(flowEnabled({ RELEASE_FLOW: v }), false, String(v));
});
