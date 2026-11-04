#!/usr/bin/env node
// Self-test for pr-readiness's pure helpers with fixture PR views.
// Run: node scripts/pr-readiness.test.mjs
import assert from "node:assert/strict";
import { checkCounts, codexReviewedHead, openThreads } from "./pr-readiness.mjs";

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

console.log("pr-readiness.test: all assertions passed");
