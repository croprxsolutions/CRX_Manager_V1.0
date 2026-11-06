#!/usr/bin/env node
// Run: node scripts/lib/owner-approval-pr.test.mjs
import assert from "node:assert/strict";
import { approvalPullRequestProblem } from "./owner-approval-pr.mjs";

const head = "a".repeat(40);
const green = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
const ready = { number: 1, state: "OPEN", baseRefName: "main", headRefOid: head, mergeStateStatus: "CLEAN", statusCheckRollup: [green] };

assert.equal(approvalPullRequestProblem(ready, head), null, "an open, clean, all-green PR at this head may be approved");
assert.match(approvalPullRequestProblem({ ...ready, mergeStateStatus: "BLOCKED" }, head), /not merge-ready/, "checks still running: refused");
assert.match(approvalPullRequestProblem({ ...ready, statusCheckRollup: [{ ...green, status: "IN_PROGRESS", conclusion: "" }] }, head),
  /not merge-ready/, "a pending check: refused");
assert.match(approvalPullRequestProblem({ ...ready, statusCheckRollup: [] }, head), /not merge-ready/, "no checks read: refused");
assert.match(approvalPullRequestProblem({ ...ready, headRefOid: "b".repeat(40) }, head), /Push first/, "a different head: refused");
assert.match(approvalPullRequestProblem({ ...ready, state: "MERGED" }, head), /Push first/, "not open: refused");
assert.match(approvalPullRequestProblem({ ...ready, baseRefName: "staging" }, head), /Push first/, "not into main: refused");
console.log("owner-approval-pr: 7 assertions passed");
