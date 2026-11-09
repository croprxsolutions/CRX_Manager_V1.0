#!/usr/bin/env node
// Self-test for pr-readiness's pure helpers with fixture PR views.
// Run: node scripts/pr-readiness.test.mjs
import assert from "node:assert/strict";
import { checkCounts, codexReviewedHead, formatBlock, openThreads, teammateLines } from "./pr-readiness.mjs";

const HEAD = "282ae54fa945a6a5f9a7030c7f643cf784ec69a8";
const OLD = "ad4718cbd6d8d8833aeb486a55ade591ab8b8169";
const stateComment = (sha) => ({ author: { login: "chatgpt-codex-connector" },
  body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","has_any_findings":false,"status":"completed"}} -->` });
const review = (sha, login = "chatgpt-codex-connector") => ({ author: { login }, commit: { oid: sha }, state: "COMMENTED" });

// The state comment on the head counts; one on an older commit does not.
assert.equal(codexReviewedHead({ headRefOid: HEAD, comments: [stateComment(HEAD)] }), true);
assert.equal(codexReviewedHead({ headRefOid: HEAD, comments: [stateComment(OLD)] }), false);
// A formal review on the exact head counts with no matching comment (the gap this script fixes).
assert.equal(codexReviewedHead({ headRefOid: HEAD, comments: [stateComment(OLD)], reviews: [review(HEAD)] }), true);
assert.equal(codexReviewedHead({ headRefOid: HEAD, reviews: [review(OLD)] }), false);
assert.equal(codexReviewedHead({ headRefOid: HEAD, reviews: [review(HEAD, "taha")] }), false);
assert.equal(codexReviewedHead({ headRefOid: HEAD, reviews: [{ ...review(HEAD), state: "PENDING" }] }), false);
// An unknown head never matches an unknown review commit.
assert.equal(codexReviewedHead({ headRefOid: "", reviews: [{ author: { login: "chatgpt-codex-connector" }, commit: { oid: "" } }] }), false);

const counts = checkCounts([
  { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "CheckRun", name: "skip", status: "COMPLETED", conclusion: "SKIPPED" },
  { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
  { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: "" },
  { __typename: "StatusContext", context: "Vercel", state: "PENDING" },
  { __typename: "StatusContext", context: "CodeRabbit", state: "ERROR" },
]);
assert.deepEqual(counts, { total: 6, pending: 2, bad: ["lint", "CodeRabbit"] });

const thread = (isResolved, isOutdated, login, path) => ({ isResolved, isOutdated, comments: { nodes: [{ author: { login }, path }] } });
assert.deepEqual(openThreads({ nodes: [
  thread(false, false, "chatgpt-codex-connector", "src/a.ts"),
  thread(true, false, "coderabbitai", "src/b.ts"),
  thread(false, true, "taha", "src/c.ts"),
] }), ["chatgpt-codex-connector src/a.ts"]);

// Teammate comments: shown early, never a silent 0 when the read failed or was cut off.
const URL1 = "https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/1650#issuecomment-6728662906";
assert.equal(teammateLines(7, { comments: [], truncated: false }), "  unanswered teammate comments: 0");
const one = teammateLines(7, { comments: [{ login: "tahakhanabdalli", url: URL1 }], truncated: false });
assert.match(one, /: 1 - NOT READY: /);
assert.match(one, /\n    - @tahakhanabdalli https:\/\/github\.com\/.*#issuecomment-6728662906$/);
assert.match(teammateLines(7, null), /: UNREADABLE - NOT READY: .*gh pr view 7 --comments/);
const cut = teammateLines(7, { comments: [], truncated: true });
assert.match(cut, /: 0 seen, list TRUNCATED - NOT READY/);
assert.doesNotMatch(cut, /^  unanswered teammate comments: 0$/);
// The line sits right after the head line, before checks and threads.
const block = formatBlock(7, { title: "t", statusCheckRollup: [] }, { nodes: [] }, "NO SOL NEEDED: x", null).split("\n");
assert.match(block[2], /^  unanswered teammate comments: UNREADABLE/);
assert.doesNotMatch(block.join("\n"), /READY: yes/);

console.log("pr-readiness.test: all assertions passed");
