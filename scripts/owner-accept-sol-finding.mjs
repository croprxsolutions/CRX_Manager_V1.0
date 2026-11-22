#!/usr/bin/env node
// Ask Mason whether to skip (leave unfixed) Sol BLOCKER/HIGH findings
// (Mason, 2026-11-10; plain-word replies 2026-11-21; .claude/hooks/sol-accept-lib.mjs has the whole flow).
//
//   node scripts/owner-accept-sol-finding.mjs <n> [<n> ...]
//     Only findings Sol labelled JUDGMENT that Mason disagrees with; a BUG is refused (fix it).
//     From the PR's checkout, at the head Sol reviewed, in the session Mason will reply
//     in. Builds ONE request listing those findings of that Sol run and prints the summary
//     to show him, exactly as printed, as the whole last message of your turn. He replies
//     `skip` (all of them) or `skip 1 3` (only those); owner-approval-prompt.mjs records it.
//     No code, no reason. Never send or relay the reply yourself.
//
//   node scripts/owner-accept-sol-finding.mjs --log
//     Once every BLOCKER/HIGH of that run is skipped: writes the DECISION_LOG.md entry.
//     Commit that file alone, then: node scripts/write-codex-push-proof.mjs --carry-owner-accepted

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
import {
  DECISION_LOG_PATH,
  blockersRecordName,
  blockersRecordProblem,
  buildSolSkipPayload,
  collectAcceptances,
  decisionLogEntry,
  findingKind,
  gateFilesIn,
  insertDecisionEntry,
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

const argv = process.argv.slice(2);

if (argv.length === 1 && argv[0] === "--log") {
  const got = collectAcceptances({
    record, readAcceptance: (n) => readJson(solAcceptFileName(head, n)), checkShown: assertSkipShown, readSkips: () => readSkipReceipts(stateDir, head), checkReply: assertReplyAlone,
  });
  if (got.problem) die(`${got.problem}. Every BLOCKER/HIGH of the run needs Mason's own skip reply first.`);
  const file = path.join(checkout, ...DECISION_LOG_PATH.split("/"));
  // Untrimmed: the proof writer rebuilds this file from the committed bytes exactly.
  const committed = String(execFileSync("git", ["show", `HEAD:${DECISION_LOG_PATH}`], {
    cwd: checkout, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  }));
  writeFileSync(file, insertDecisionEntry(committed, decisionLogEntry({ record, accepted: got.accepted })), "utf8");
  console.log(`Wrote the entry to ${DECISION_LOG_PATH}. Commit that file alone, then run:`);
  console.log("  node scripts/write-codex-push-proof.mjs --carry-owner-accepted");
  process.exit(0);
}

const numbers = argv.map(Number);
if (!numbers.length || numbers.some((n) => !Number.isInteger(n) || n < 1 || n > record.findings.length) || new Set(numbers).size !== numbers.length) {
  die(`give the numbers (1 to ${record.findings.length}, each at most once) of the findings Mason disagrees with (or --log).`);
}
numbers.sort((a, b) => a - b);
const bugs = numbers.filter((n) => findingKind(record.findings[n - 1]) !== "JUDGMENT");
if (bugs.length) die(`Sol marked finding ${bugs.join(", ")} as a bug; a bug is fixed, never offered to Mason for skipping.`);

const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
if (!/^[0-9A-Za-z_-]{8,128}$/.test(String(sessionId || ""))) die("run this inside the Claude Code session Mason will reply in (CLAUDE_CODE_SESSION_ID is not set).");
if (!promptHookSeen({ dirs: [stateDir], sessionId })) die(hooklessSessionRefusal({ checkout, sessionId }));

// The pull request the acceptance names: this branch, open against main or (staging-first, #1363) staging,
// at this exact head.
const ACCEPT_BASES = new Set(["main", "staging"]);
let pr;
try {
  pr = JSON.parse(String(execFileSync("gh", ["pr", "view", git(["rev-parse", "--abbrev-ref", "HEAD"]), "--json", "number,state,headRefOid,baseRefName"], {
    cwd: checkout, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  })));
} catch (err) {
  die(`could not find this branch's open pull request (${err?.message || err}).`);
}
if (String(pr?.state).toUpperCase() !== "OPEN" || !ACCEPT_BASES.has(pr?.baseRefName) || String(pr?.headRefOid).toLowerCase() !== head.toLowerCase()) {
  die(`pull request #${pr?.number ?? "?"} must be open against main or staging with head ${head.slice(0, 12)}; push first.`);
}
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
    record, numbers, pullRequest: pr.number,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(deadline).toISOString(),
    nonce: randomBytes(16).toString("hex"), code, sessionId,
  });
  try { writeApprovalRequest(stateDir, payload); saved = JSON.parse(payload); }
  catch (err) { if (err?.code !== "EEXIST") die(`could not save the request (${err?.message || err}).`); }
}
if (!saved) die("could not find a free code; try again.");

console.log("Explain each finding to Mason in plain English BEFORE running this script (list only findings he disagrees with; one you " +
  "confirm is a real defect is fixed, never listed here). Your reply now must be only this, exactly as printed, as the whole last message of your turn:\n");
for (const line of solSkipSummary(saved)) console.log(`  ${line}`);
console.log("\nThen wait for HIS reply (skip, or skip and numbers) in this session; never send or relay it for him.");
