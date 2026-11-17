#!/usr/bin/env node
// List or release landing claims (.claude/hooks/pr-claim-lib.mjs).
//   node scripts/pr-claim.mjs list
//   node scripts/pr-claim.mjs release <branch>
// Releasing lets another session take the PR over; its next push, Sol run or
// merge claims it.

import { claimIsFresh, claimsFileFor, readClaims, releaseClaim } from "../.claude/hooks/pr-claim-lib.mjs";

const [command, branch] = process.argv.slice(2);
const file = claimsFileFor(process.cwd());
if (!file) {
  console.error("pr-claim: not inside a git checkout.");
  process.exit(1);
}
if (command === "release" && branch) {
  console.log(releaseClaim(file, branch) ? `Released the claim on ${branch}.` : `No claim on ${branch}.`);
} else if (command === "list" || !command) {
  const now = Date.now();
  const claims = Object.entries(readClaims(file));
  if (claims.length === 0) console.log("No landing claims.");
  for (const [name, claim] of claims) { // readClaims drops malformed entries
    const age = Math.round((now - Date.parse(claim.at)) / 60000);
    const state = claimIsFresh(claim, now) ? "held" : "not enforced (expired or bad time)";
    const when = Number.isFinite(age) ? `${age} min ago` : `at ${claim.at}`;
    console.log(`${name}: ${state}, session ${claim.session}, last ${claim.action} ${when}${claim.cwd ? `, ${claim.cwd}` : ""}`);
  }
} else {
  console.error("Usage: node scripts/pr-claim.mjs list | release <branch>");
  process.exit(1);
}
