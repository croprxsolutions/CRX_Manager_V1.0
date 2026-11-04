#!/usr/bin/env node
// Runs the real .husky/pre-commit (and the real verify-deps.mjs) in a throwaway
// repo with no node_modules. A commit that stages package.json must stop at the
// dependency check BEFORE any other step; other commits must not run it at all.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scratchHookEnvironment } from "../.claude/hooks/git-test-env.mjs";
import { tempDir } from "./lib/test-temp-dir.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = tempDir("crx-precommit-deps-");
const env = scratchHookEnvironment(scratch);

function git(...args) {
  return spawnSync("git", args, { cwd: scratch, env, encoding: "utf8" });
}
function ok(...args) {
  const res = git(...args);
  assert.equal(res.status, 0, `git ${args.join(" ")} failed:\n${res.stdout}\n${res.stderr}`);
}

try {
  mkdirSync(path.join(scratch, ".husky"));
  mkdirSync(path.join(scratch, "scripts"));
  copyFileSync(path.join(repoRoot, ".husky/pre-commit"), path.join(scratch, ".husky/pre-commit"));
  chmodSync(path.join(scratch, ".husky/pre-commit"), 0o755);
  copyFileSync(path.join(repoRoot, "scripts/verify-deps.mjs"), path.join(scratch, "scripts/verify-deps.mjs"));
  // Every other step is a stub that only announces it ran.
  for (const name of ["check-ledger-update.mjs", "check-supplier-pricing-phase3-private-artifacts.mjs", "check-agent-workflows.mjs"]) {
    writeFileSync(path.join(scratch, "scripts", name), `console.log("STUB-RAN ${name}");\n`);
  }
  for (const name of ["validate-sql.sh", "validate-frontend.sh"]) {
    writeFileSync(path.join(scratch, "scripts", name), `echo "STUB-RAN ${name}"\n`);
  }
  writeFileSync(path.join(scratch, "package.json"), '{ "name": "scratch", "version": "1.0.0" }\n');
  writeFileSync(
    path.join(scratch, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/vitest": { version: "4.0.0" }, "node_modules/vite": { version: "7.0.0" }, "node_modules/@vitejs/plugin-react": { version: "5.0.0" } } }),
  );

  ok("init", "-q");
  ok("config", "user.name", "Test");
  ok("config", "user.email", "test@example.invalid");
  ok("config", "core.autocrlf", "false");
  ok("add", "-A");
  ok("commit", "-q", "-m", "seed"); // hooks not wired yet
  ok("config", "core.hooksPath", ".husky");

  // 1. package.json staged, no node_modules: blocked at the first step.
  writeFileSync(path.join(scratch, "package.json"), '{ "name": "scratch", "version": "1.0.1" }\n');
  ok("add", "package.json");
  const blocked = git("commit", "-m", "bump");
  const blockedOut = `${blocked.stdout}\n${blocked.stderr}`;
  assert.notEqual(blocked.status, 0, `commit should be blocked:\n${blockedOut}`);
  assert.match(blockedOut, /installed=\(not installed\)/);
  assert.match(blockedOut, /run npm ci/);
  assert.doesNotMatch(blockedOut, /STUB-RAN/, `no other step may run before the dependency check:\n${blockedOut}`);

  // 2. Unrelated change: the dependency check does not run; the other steps do.
  ok("reset", "-q", "--hard");
  writeFileSync(path.join(scratch, "notes.txt"), "hello\n");
  ok("add", "notes.txt");
  const passed = git("commit", "-m", "notes");
  const passedOut = `${passed.stdout}\n${passed.stderr}`;
  assert.equal(passed.status, 0, `unrelated commit should pass:\n${passedOut}`);
  assert.doesNotMatch(passedOut, /verify-deps|Verifying dependency integrity/);
  assert.match(passedOut, /STUB-RAN check-ledger-update\.mjs/);

  console.log("precommit-deps-first: OK");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
