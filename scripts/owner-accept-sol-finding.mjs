#!/usr/bin/env node
// Ask Mason whether to skip (leave unfixed) Sol BLOCKER/HIGH findings
// (Mason, 2026-11-10; plain-word replies 2026-11-21; .claude/hooks/sol-accept-lib.mjs has the whole flow).
//
//   node scripts/owner-accept-sol-finding.mjs <n> [<n> ...]
//     Findings Mason disagrees with: a business call, or a bug or gap too small to affect the business.
//     From the PR's checkout, at the head Sol reviewed, in the session Mason will reply
//     in. Builds ONE request listing those findings of that Sol run and prints the summary
//     to show him, exactly as printed, as the whole last message of your turn. He replies
//     `skip` (all of them) or `skip 1 3` (only those); owner-approval-prompt.mjs records it.
//     No code, no reason. Never send or relay the reply yourself.
//
//   node scripts/owner-accept-sol-finding.mjs --log
//     Once every BLOCKER/HIGH of that run is skipped: writes the decision-log entry. A PR into staging gets
//     a new file docs/manual/decision-log.d/<date>-pr<n>-sol-skip-<head>.md (Mason, 2026-11-23: parallel PRs
//     never conflict on it); a review against main still writes DECISION_LOG.md. With no reply,
//     when Sol marked EVERY finding the same as one Mason skipped on this staging PR in the last 7 days,
//     writes the carried entry instead (Mason, 2026-11-22; sol-accept-lib.mjs carryForRecord).
//     Commit that one file alone, then: node scripts/write-codex-push-proof.mjs --carry-owner-accepted

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  OWNER_REQUEST_MAX_AGE_MS,
  OWNER_TRUST_ROOT,
  assertOwnerTrustFilesReviewed,
  assertReplyAlone,
  assertSkipShown,
  hooklessSessionRefusal,
  newApprovalCode,
  promptHookSeen,
  writeApprovalRequest,
} from "../.claude/hooks/owner-approval-lib.mjs";
import { readLocalProofs } from "./write-codex-push-proof.mjs";
import { pullRequestUrlFor,
  DECISION_LOG_PATH,
  blockersRecordName,
  blockersRecordProblem,
  buildSolSkipPayload,
  carriedDecisionLogEntry,
  carryForRecord,
  collectAcceptances,
  decisionFragmentText,
  decisionLogEntry,
  gateFilesIn,
  insertDecisionEntry,
  ownerAcceptLogTarget,
  readSkipReceipts,
  skipDeadlineMs,
  solAcceptFileName,
  solSkipSummary,
  stateDirOf,
} from "../.claude/hooks/sol-accept-lib.mjs";

function die(msg) {
  console.error(`owner-accept-sol-finding: ${msg}`);
  process.exit(1);
}

const checkout = process.cwd();
const stateDir = stateDirOf(checkout);
const git = (args) => String(execFileSync("git", args, { cwd: checkout, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] })).trim();
let head;
try { head = git(["rev-parse", "HEAD"]); } catch (err) { die(`could not read this checkout's HEAD (${err?.message || err}).`); }
if (git(["status", "--porcelain", "--untracked-files=no"])) die("the worktree has uncommitted changes; commit or set them aside first.");

const readJson = (name) => { try { return JSON.parse(readFileSync(path.join(stateDir, name), "utf8")); } catch { return null; } };
const record = readJson(blockersRecordName(head));
const problem = blockersRecordProblem(record, { headSha: head });
if (problem) die(`${problem}. Run the full Sol review at this head first: node scripts/write-codex-push-proof.mjs`);
const forkPoint = git(["merge-base", record.base_sha, head]);
const showAt = (sha, p) => {
  try {
    return String(execFileSync("git", ["show", `${sha}:${p}`], { cwd: checkout, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }));
  } catch { return null; }
};
const gates = gateFilesIn(git(["diff", "--name-only", "--no-renames", `${record.base_sha}...${head}`]).split(/\r?\n/).filter(Boolean),
  (p) => [showAt(forkPoint, p), showAt(head, p)]);
if (gates.length) die(`this pull request changes gate or approval files (${gates.slice(0, 5).join(", ")}); a Sol review that was not clean cannot vouch for them, so its findings must be fixed, not accepted.`);

// The pull request the acceptance names: this branch, open against main or (staging-first, #1363) staging,
// at this exact head.
function openPullRequest() {
  const ACCEPT_BASES = new Set(["main", "staging"]);
  let found;
  try {
    found = JSON.parse(String(execFileSync("gh", ["pr", "view", git(["rev-parse", "--abbrev-ref", "HEAD"]), "--json", "number,url,state,headRefOid,baseRefName"], {
      cwd: checkout, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
    })));
  } catch (err) {
    die(`could not find this branch's open pull request (${err?.message || err}).`);
  }
  if (pullRequestUrlFor(found?.url, found?.number) === null) die(`GitHub gave no usable address for pull request #${found?.number ?? "?"}.`);
  if (String(found?.state).toUpperCase() !== "OPEN" || !ACCEPT_BASES.has(found?.baseRefName) || String(found?.headRefOid).toLowerCase() !== head.toLowerCase()) {
    die(`pull request #${found?.number ?? "?"} must be open against main or staging with head ${head.slice(0, 12)}; push first.`);
  }
  return found;
}

// Sol marked every finding the same as one Mason already skipped on this PR (Mason, 2026-11-22): such a run
// is never put to him, so no reply of his can be misread; it carries, or it is asked like any other run.
const allSame = record.findings.every((f) => typeof f.same_as === "string");
function carryNow(pr) {
  if (!allSame || pr.baseRefName !== "staging") return null;
  const c = carryForRecord({ record, proofs: readLocalProofs(checkout), git, prNumber: pr.number, prUrl: pr.url });
  return c.problem ? null : c;
}
const NO_QUESTION = "Sol marked every finding a repeat of a skip Mason already gave on this pull request, so it carries: do not ask him. Run node scripts/owner-accept-sol-finding.mjs --log, commit the one file it writes alone, then node scripts/write-codex-push-proof.mjs --carry-owner-accepted";

const argv = process.argv.slice(2).filter((a) => a !== "--show-elsewhere");

if (argv.length === 1 && argv[0] === "--log") {
  const got = collectAcceptances({
    record, readAcceptance: (n) => readJson(solAcceptFileName(head, n)), checkShown: assertSkipShown, readSkips: () => readSkipReceipts(stateDir, head), checkReply: assertReplyAlone,
  });
  let entry;
  const carried = allSame ? carryNow(openPullRequest()) : null;
  if (carried) entry = carriedDecisionLogEntry({ record, accepted: carried.accepted });
  else if (!got.problem) entry = decisionLogEntry({ record, accepted: got.accepted });
  else die(`${got.problem}. Every BLOCKER/HIGH of the run needs Mason's own skip reply first.`);
  const target = ownerAcceptLogTarget(record, entry);
  const file = path.join(checkout, ...target.path.split("/"));
  if (target.fragment) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, decisionFragmentText(entry), "utf8");
  } else {
    // Untrimmed: the proof writer rebuilds this file from the committed bytes exactly.
    const committed = String(execFileSync("git", ["show", `HEAD:${DECISION_LOG_PATH}`], {
      cwd: checkout, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    }));
    writeFileSync(file, insertDecisionEntry(committed, entry), "utf8");
  }
  console.log(`Wrote the entry to ${target.path}. Commit that one file alone, then run:`);
  console.log("  node scripts/write-codex-push-proof.mjs --carry-owner-accepted");
  process.exit(0);
}

const numbers = argv.map(Number);
if (!numbers.length || numbers.some((n) => !Number.isInteger(n) || n < 1 || n > record.findings.length) || new Set(numbers).size !== numbers.length) {
  die(`give the numbers (1 to ${record.findings.length}, each at most once) of the findings Mason disagrees with (or --log).`);
}
numbers.sort((a, b) => a - b);

const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
if (!/^[0-9A-Za-z_-]{8,128}$/.test(String(sessionId || ""))) die("run this inside the Claude Code session Mason will reply in (CLAUDE_CODE_SESSION_ID is not set).");
// Hookless here: his reply in THIS chat would be lost, so refuse unless the agent says it will
// show the summary in a conversation he does talk to (--show-elsewhere; security review MED).
const showElsewhere = process.argv.includes("--show-elsewhere");
if (!promptHookSeen({ dirs: [stateDir], sessionId })) {
  if (!showElsewhere) die(`${hooklessSessionRefusal({ checkout, sessionId })}
Then run this again with --show-elsewhere.`);
  console.error(hooklessSessionRefusal({ checkout, sessionId }));
}

const pr = openPullRequest();
if (carryNow(pr)) die(NO_QUESTION);
// The code running now must be the bytes committed at this head (in this checkout).
try {
  assertOwnerTrustFilesReviewed({
    head, root: checkout,
    readOnDisk: (rel) => readFileSync(path.join(OWNER_TRUST_ROOT, ...rel.split("/")), "utf8"),
  });
} catch (err) { die(`${err?.message || err}. Refusing.`); }

const now = Date.now();
const deadline = skipDeadlineMs(record, now, OWNER_REQUEST_MAX_AGE_MS);
if (!(deadline > now + 5 * 60 * 1000)) die("the Sol review expires within 5 minutes; run it again first: node scripts/write-codex-push-proof.mjs");
let saved = null;
for (let attempt = 0; attempt < 5 && !saved; attempt++) {
  const code = newApprovalCode();
  const payload = buildSolSkipPayload({
    record, numbers, pullRequest: pr.number, pullRequestUrl: pr.url,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(deadline).toISOString(),
    nonce: randomBytes(16).toString("hex"), code, sessionId,
  });
  try { writeApprovalRequest(stateDir, payload); saved = JSON.parse(payload); }
  catch (err) { if (err?.code !== "EEXIST") die(`could not save the request (${err?.message || err}).`); }
}
if (!saved) die("could not find a free code; try again.");

console.log("Explain each finding to Mason in plain English BEFORE running this script (say plainly when one is a real money, stock, data " +
  "or security bug; list only findings he disagrees with). Your reply now must be only this, exactly as printed, as the whole last message of your turn:\n");
for (const line of solSkipSummary(saved)) console.log(`  ${line}`);
console.log("\nThen wait for HIS reply (skip, or skip and numbers) in this session; never send or relay it for him.");
