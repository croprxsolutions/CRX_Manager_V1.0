#!/usr/bin/env node
// Pre-commit: a staged live smoke chain must still read as a rollback-only batch
// to the live-SQL guard, or it fails guards.test.mjs only in CI (PR #1989: a
// loop with CASE values inside the DO body). Same spec filter as that test.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifySql } from "../.claude/hooks/live-testdata-lib.mjs";

export function liveChainPaths(specsJson) {
  const specs = JSON.parse(specsJson).specs || {};
  return new Set(
    Object.values(specs)
      .filter((spec) => spec?.chain && !spec.container_only && !spec.psql_only)
      .map((spec) => `scripts/smoke/${spec.chain}`),
  );
}

// null when the guard accepts the chain as a rolled-back smoke; else the reason.
export function smokeChainProblem(sql) {
  const verdict = classifySql(sql);
  if (!verdict.block && verdict.kind === "rolled-back-smoke") return null;
  return verdict.reason || `classified as ${verdict.kind || "an ordinary query"}, not a rolled-back smoke`;
}

const SPECS = "scripts/smoke/smoke-specs.json";

function staged(file) {
  return execFileSync("git", ["show", `:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const stagedPaths = execFileSync("git", ["diff", "--cached", "--no-renames", "--name-only", "-z", "--diff-filter=ACMR"], { encoding: "utf8" })
    .split("\0");
  const specsChanged = stagedPaths.includes(SPECS);
  const files = stagedPaths.filter((file) => /^scripts\/smoke\/[^/]+\.sql$/.test(file));
  if (files.length === 0 && !specsChanged) return 0;
  const live = liveChainPaths(staged(SPECS));
  // A spec change can promote an existing chain to live, so then every live chain is judged.
  const toCheck = specsChanged ? [...live] : files.filter((f) => live.has(f));
  let failed = 0;
  for (const file of toCheck) {
    const problem = smokeChainProblem(staged(file));
    if (!problem) continue;
    failed++;
    console.error(`❌ ${file}: the live-SQL guard no longer sees this smoke chain as rollback-only.`);
    console.error(`   Reason: ${problem}`);
  }
  // PR #1989: `CASE … END, 'x', CASE …` in one statement reads as END CASE to the guard.
  if (failed) console.error("   Hint: unroll loops/CASE in the DO body (one literal statement per step, no two CASE expressions in one statement), then re-stage.");
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
