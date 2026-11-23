#!/usr/bin/env node
// Mason's Sol skip carries to the SAME finding on a later version of the same PR (sol-accept-lib.mjs;
// Mason, 2026-11-22). Unit checks of the label parser, the matcher's refusals and the gate's chain
// check, plus an end-to-end run on a real fixture git history: (a) all-SAME carries with no question,
// (b) one NEW refuses (Mason is asked), (c) a PR edit to the file refuses.
//
// Run: node .claude/hooks/sol-skip-carry.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { removeTree, tempDir } from "../../scripts/lib/test-temp-dir.mjs";
import { buildCarryForwardProof } from "../../scripts/write-codex-push-proof.mjs";
import { carriedSolProof, proofValid } from "./codex-push-lib.mjs";
import {
  buildBlockersRecord,
  carriedChainProblem,
  carriedDecisionLogEntry,
  carriedProofEntries,
  carryForRecord,
  carryPromptLines,
  CARRY_ACCEPT_MAX_AGE_MS,
  ownerAcceptedForPr,
  OWNER_ACCEPTED_CARRIED,
  parseSolFindings,
  priorAcceptances,
  trackedNamesIn,
  usesCarriedSkip,
} from "./sol-accept-lib.mjs";

const URL = "https://github.com/croprxsolutions/CRX_Manager_V1.0/pull/77";
const PR = 77;
const NONCE = "d240b31a7419aaaabbbbccccddddeeee";
const DAY = 24 * 60 * 60 * 1000;

// ── label parsing ────────────────────────────────────────────────────────────
{
  const p = parseSolFindings([
    "SOL_FINDING 1 HIGH: src/a.ts:3 - bad SAME_AS_ACCEPTED d240b31a7419/1",
    "SOL_FINDING 2 BLOCKER: x.sql:9 - worse NEW",
    "SOL_FINDING 3 HIGH: y.ts:1 - plain",
    "SOL_FINDING_COUNT 3",
  ].join("\n"), { labels: true });
  assert.deepEqual(p.findings, [
    { n: 1, severity: "HIGH", text: "src/a.ts:3 - bad", same_as: "d240b31a7419/1" },
    { n: 2, severity: "BLOCKER", text: "x.sql:9 - worse", same_as: null },
    { n: 3, severity: "HIGH", text: "y.ts:1 - plain" },
  ]);
  // The label never counts toward the 400-character limit, and never enters the wording.
  const long = `src/a.ts:3 - ${"x".repeat(386)}`;
  assert.equal(long.length, 399);
  const q = parseSolFindings(`SOL_FINDING 1 HIGH: ${long} SAME_AS_ACCEPTED d240b31a7419/1\nSOL_FINDING_COUNT 1`, { labels: true });
  assert.equal(q.findings[0].text, long);
  // No earlier skips shown: nothing is a label, so a finding ending in NEW keeps its wording.
  const plain = parseSolFindings("SOL_FINDING 1 HIGH: src/a.ts:3 - reads unchecked NEW\nSOL_FINDING_COUNT 1");
  assert.deepEqual(plain.findings[0], { n: 1, severity: "HIGH", text: "src/a.ts:3 - reads unchecked NEW" });
  // A malformed label stays in the wording (no carry), and the finding is still there for Mason.
  const r = parseSolFindings("SOL_FINDING 1 HIGH: src/a.ts:3 - bad SAME_AS_ACCEPTED zz\nSOL_FINDING_COUNT 1");
  assert.equal("same_as" in r.findings[0], false);
  assert.deepEqual(carryPromptLines([]), [], "no earlier skips: the prompt is unchanged");
}

// ── fixture repository: a PR branch off staging, Mason's skip, then a catch-up merge ──
const root = tempDir("crx-sol-carry-");
const git = (...args) => String(execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
const gitFn = (args) => git(...args);
const write = (rel, text) => writeFileSync(path.join(root, rel), text, "utf8");
const commit = (msg) => { git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
try {
  git("init", "-q", "-b", "staging");
  write("src.ts", "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n");
  write("other.ts", "a\n");
  const base1 = commit("base");
  // A proof file git tracks is repository content, never evidence of Mason's skip.
  assert.equal(trackedNamesIn(root).has("other.ts"), true);
  assert.equal(trackedNamesIn(path.join(root, "no-such-dir")), null, "git cannot say: callers count no proof");
  git("checkout", "-q", "-b", "feature");
  write("src.ts", "line1\nline2\nline3\nline4\nCHANGED\nline6\nline7\nline8\nline9\nline10\n");
  const reviewed = commit("pr change");                // R: the head Sol reviewed and Mason skipped at
  write("DECISION_LOG.md", "log\n");
  const logged = commit("log");                        // L: the log-only commit the root proof is bound to
  git("checkout", "-q", "staging");
  write("other.ts", "a\nb\n");
  const base2 = commit("staging moves on");
  git("checkout", "-q", "feature");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "merge", "-q", "--no-edit", "staging");
  const newHead = git("rev-parse", "HEAD");            // the catch-up merge

  const now = Date.now();
  const acceptedAt = new Date(now - 2 * DAY).toISOString();
  const rootProof = {
    ...buildCarryForwardProof({
      headSha: logged, baseSha: base1, mode: "owner_accepted",
      source: { head_sha: reviewed, base_sha: base1, timestamp: new Date(now - 2 * DAY - 60_000).toISOString(), review_ref: "origin/staging", release_rules: false },
    }),
    owner_accepted: [{ n: 1, severity: "HIGH", text: "src.ts:5 - stale screen saves MG", reason: "chose to leave it unfixed", pull_request: PR, pull_request_url: URL, accepted_at: acceptedAt, ref: NONCE }],
  };
  const proofs = [rootProof];
  const candidates = priorAcceptances(proofs, { prNumber: PR, prUrl: URL, nowMs: now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].key, "d240b31a7419/1");
  assert.equal(candidates[0].from_head, reviewed, "the code comparison uses the reviewed head, not the log commit");
  assert.ok(carryPromptLines(candidates).some((l) => l.includes("d240b31a7419/1 (HIGH): \"src.ts:5")));
  assert.deepEqual(priorAcceptances(proofs, { prNumber: 78, prUrl: URL.replace("77", "78"), nowMs: now }), [], "another PR sees nothing");
  assert.deepEqual(priorAcceptances(proofs, { prNumber: PR, prUrl: URL, nowMs: now + 6 * DAY }), [], "older than 7 days: nothing");

  const recordOf = (lines, head = newHead, base = base2) => ({
    ...buildBlockersRecord({ headSha: head, baseSha: base, findings: parseSolFindings(lines.join("\n"), { labels: true }).findings, carryCandidates: candidates }),
    review_ref: "origin/staging", release_rules: false,
  });
  const carry = (record, extra = {}) => carryForRecord({ record, proofs, git: gitFn, prNumber: PR, prUrl: URL, nowMs: now, ...extra });

  // (a) every finding SAME, same file, line moved, catch-up merge only moved base code → carries.
  const same = recordOf(["SOL_FINDING 1 HIGH: src.ts:6 - stale screen still saves MG SAME_AS_ACCEPTED d240b31a7419/1", "SOL_FINDING_COUNT 1"]);
  const ok = carry(same);
  assert.equal(ok.problem, undefined, ok.problem);
  const entry = carriedDecisionLogEntry({ record: same, accepted: ok.accepted });
  assert.match(entry, /carried from ref d240b31a7419 at `[0-9a-f]{12}` to `[0-9a-f]{12}`; Sol marked it the same/);
  assert.ok(!entry.includes("stale screen"), "the finding's wording stays out of the public log");
  const proof = {
    ...buildCarryForwardProof({
      headSha: "f".repeat(40), baseSha: base2, mode: OWNER_ACCEPTED_CARRIED,
      source: { head_sha: newHead, base_sha: base2, timestamp: same.timestamp, review_ref: "origin/staging", release_rules: false },
    }),
    owner_accepted: carriedProofEntries(ok.accepted),
  };
  assert.equal(proof.carry.root_review.timestamp, same.timestamp, "the 24-hour clock is the fresh Sol run");
  assert.equal(proof.owner_accepted[0].accepted_at, acceptedAt, "Mason's 7-day clock is never refreshed");
  assert.ok(carriedSolProof(proof));
  assert.ok(proofValid(proof, proof.head_sha, Date.now(), base2));
  assert.ok(ownerAcceptedForPr(proof, { number: PR, url: URL, exactHead: true, proofs, nowMs: now }), "the staging merge gate's PR check accepts it");
  // The live-apply gate refuses any proof leaning on a carried skip, whatever its outer mode (a restamp keeps the entries).
  assert.equal(usesCarriedSkip(proof), true);
  assert.equal(usesCarriedSkip({ ...proof, carry: { ...proof.carry, mode: "restamp" } }), true, "a restamped carried proof still counts as carried");
  assert.equal(usesCarriedSkip(rootProof), false, "Mason's own skip proof is not a carried one");
  // The gates refuse it when Mason's own acceptance is not on this machine, is too old, or the proof is altered.
  assert.equal(ownerAcceptedForPr(proof, { number: PR, url: URL, exactHead: true, proofs: [], nowMs: now }), false);
  assert.equal(ownerAcceptedForPr(proof, { number: PR, url: URL, exactHead: true, nowMs: now }), false);
  assert.equal(ownerAcceptedForPr(proof, { number: PR, url: URL, exactHead: true, proofs, nowMs: Date.parse(acceptedAt) + CARRY_ACCEPT_MAX_AGE_MS + 1 }), false);
  assert.equal(ownerAcceptedForPr(proof, { number: PR, url: URL, exactHead: false, proofs, nowMs: now }), false, "exact head only");
  assert.match(carriedChainProblem({ ...proof, owner_accepted: [{ ...proof.owner_accepted[0], severity: "BLOCKER" }] }, proofs, now), /more severe/);
  assert.match(carriedChainProblem({ ...proof, owner_accepted: [{ ...proof.owner_accepted[0], n: 2 }] }, proofs, now), /1\.\.k/);
  assert.match(carriedChainProblem({ ...proof, owner_accepted: [proof.owner_accepted[0], { ...proof.owner_accepted[0], n: 2 }] }, proofs, now), /same skipped finding/);
  assert.match(carriedChainProblem({ ...proof, owner_accepted: [{ ...proof.owner_accepted[0], carried_from: { ...proof.owner_accepted[0].carried_from, ref: "0".repeat(32) } }] }, proofs, now), /holds Mason's skip/);
  // A carried proof is never itself a root.
  assert.match(carriedChainProblem(proof, [proof], now), /holds Mason's skip/);
  // A later restamp of a carried proof keeps the check (its entries still carry carried_from).
  assert.match(carriedChainProblem({ ...proof, carry: { ...proof.carry, mode: "restamp" } }, [], now), /holds Mason's skip/);
  // A second repeat (carried → carried) still traces to Mason's own acceptance.
  const chain = priorAcceptances([rootProof, { ...proof, carry: { ...proof.carry, from_head: newHead } }], { prNumber: PR, prUrl: URL, nowMs: now });
  assert.equal(chain.length, 1);
  assert.equal(chain[0].root.head_sha, logged);

  // (b) one NEW finding → refused: Mason is asked as before.
  const mixed = recordOf([
    "SOL_FINDING 1 HIGH: src.ts:6 - stale screen still saves MG SAME_AS_ACCEPTED d240b31a7419/1",
    "SOL_FINDING 2 HIGH: other.ts:2 - something new NEW",
    "SOL_FINDING_COUNT 2",
  ]);
  assert.match(carry(mixed).problem, /finding 2 NEW/);

  // Other refusals.
  assert.match(carry(recordOf(["SOL_FINDING 1 HIGH: src.ts:6 - x", "SOL_FINDING_COUNT 1"])).problem, /no SAME_AS_ACCEPTED or NEW label/);
  assert.match(carry(recordOf(["SOL_FINDING 1 HIGH: other.ts:1 - x SAME_AS_ACCEPTED d240b31a7419/1", "SOL_FINDING_COUNT 1"])).problem, /same file/);
  assert.match(carry(recordOf(["SOL_FINDING 1 BLOCKER: src.ts:6 - x SAME_AS_ACCEPTED d240b31a7419/1", "SOL_FINDING_COUNT 1"])).problem, /rose from HIGH to BLOCKER/);
  assert.match(carry(recordOf(["SOL_FINDING 1 HIGH: src.ts:6 - x SAME_AS_ACCEPTED 0123456789ab/1", "SOL_FINDING_COUNT 1"])).problem, /was not shown/);
  assert.match(carry(recordOf([
    "SOL_FINDING 1 HIGH: src.ts:6 - x SAME_AS_ACCEPTED d240b31a7419/1", "SOL_FINDING 2 HIGH: src.ts:7 - y SAME_AS_ACCEPTED d240b31a7419/1", "SOL_FINDING_COUNT 2",
  ])).problem, /same skipped finding/);
  assert.match(carry(same, { prNumber: 78, prUrl: URL.replace("77", "78") }).problem, /another pull request/);
  assert.match(carry(same, { nowMs: Date.parse(acceptedAt) + CARRY_ACCEPT_MAX_AGE_MS + 1 }).problem, /more than 7 days old/);
  assert.match(carry(same, { proofs: [] }).problem, /not among this machine's Sol proofs/);
  assert.match(carryForRecord({ record: { ...same, review_ref: "origin/main" }, proofs, git: gitFn, prNumber: PR, prUrl: URL, nowMs: now }).problem, /only a pull request into staging/);
  assert.match(carryForRecord({ record: { ...same, release_rules: true }, proofs, git: gitFn, prNumber: PR, prUrl: URL, nowMs: now }).problem, /only a pull request into staging/);

  // (c) the PR edits that file after Mason's skip → refused.
  write("src.ts", "line1\nline2\nline3\nline4\nCHANGED\nline6\nline7\nline8\nALSO\nline10\n");
  const edited = commit("pr edits the file again");
  const editedRecord = recordOf(["SOL_FINDING 1 HIGH: src.ts:6 - stale screen SAME_AS_ACCEPTED d240b31a7419/1", "SOL_FINDING_COUNT 1"], edited);
  assert.match(carry(editedRecord).problem, /own change to src\.ts is not the one Mason skipped/);
  // A finding naming a file that does not exist never compares equal.
  const ghost = { ...rootProof, owner_accepted: [{ ...rootProof.owner_accepted[0], text: "nofile.ts:1 - x" }] };
  const ghostRecord = { ...recordOf(["SOL_FINDING 1 HIGH: nofile.ts:1 - x SAME_AS_ACCEPTED d240b31a7419/1", "SOL_FINDING_COUNT 1"]),
    carry_candidates: priorAcceptances([ghost], { prNumber: PR, prUrl: URL, nowMs: now }) };
  assert.match(carryForRecord({ record: ghostRecord, proofs: [ghost], git: gitFn, prNumber: PR, prUrl: URL, nowMs: now }).problem, /own change to nofile\.ts/);
} finally {
  removeTree(root);
}

console.log("sol-skip-carry.test.mjs: all assertions passed");
