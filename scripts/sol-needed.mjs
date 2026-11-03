#!/usr/bin/env node
// Usage: npm run sol-needed -- <pr-number>
// Answers "does this PR need a Sol review?" with the merge gate's own classifier
// (solRiskOnGitHub, pinned to the PR's base and head), so nobody judges the Sol list by eye.
import { spawnSync } from "node:child_process";
import { solRiskOnGitHub } from "../.claude/hooks/sol-risk-lib.mjs";

const REPO = "croprxsolutions/CRX_Manager_V1.0";
const pr = process.argv[2];
if (!/^\d+$/.test(pr ?? "")) {
  console.error("usage: npm run sol-needed -- <pr-number>");
  process.exit(2);
}
function gh(args) {
  const run = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0) throw new Error((run.stderr || run.stdout || "gh failed").trim());
  return run.stdout;
}
let base, head;
try {
  ({ baseRefOid: base, headRefOid: head } = JSON.parse(gh(["pr", "view", pr, "--repo", REPO, "--json", "baseRefOid,headRefOid"])));
} catch (error) {
  console.error(`SOL NEEDED: cannot read PR #${pr} (${error.message.split(/\r?\n/)[0]}); treat it as needing Sol`);
  process.exit(1);
}
const risk = solRiskOnGitHub({ baseSha: base, headSha: head, repo: REPO, gh });
console.log(`${risk.risky ? "SOL NEEDED" : "NO SOL NEEDED"}: PR #${pr} at ${String(head).slice(0, 12)}: ${risk.reason}`);
process.exit(risk.risky ? 1 : 0);
