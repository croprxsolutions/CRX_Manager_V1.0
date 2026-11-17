#!/usr/bin/env node
// List or release landing claims (.claude/hooks/pr-claim-lib.mjs).
//   node scripts/pr-claim.mjs list
//   node scripts/pr-claim.mjs release <branch>
// Releasing lets another session take the PR over; its next push, Sol run or
// merge claims it.

import { CLAIM_TTL_MS, claimsFileFor, readClaims, releaseClaim } from "../.claude/hooks/pr-claim-lib.mjs";

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
  for (const [name, claim] of claims) {
    const age = Math.round((now - Date.parse(claim.at)) / 60000);
    const state = now - Date.parse(claim.at) < CLAIM_TTL_MS ? "held" : "expired";
    console.log(`${name}: ${state}, session ${claim.session}, last ${claim.action} ${age} min ago${claim.cwd ? `, ${claim.cwd}` : ""}`);
  }
} else {
  console.error("Usage: node scripts/pr-claim.mjs list | release <branch>");
  process.exit(1);
}
