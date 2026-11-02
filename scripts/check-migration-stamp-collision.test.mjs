#!/usr/bin/env node
// Tests the cross-worktree migration stamp check through the real pre-commit
// entry point (scripts/validate-sql.sh), in a scratch repo with two worktrees.
// Run: node scripts/check-migration-stamp-collision.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchHookEnvironment } from "../.claude/hooks/git-test-env.mjs";

const VALIDATOR = fileURLToPath(new URL("./validate-sql.sh", import.meta.url));
let pass = 0;

const root = mkdtempSync(join(tmpdir(), "stamp-collision-"));
const env = scratchHookEnvironment(root);
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
const write = (dir, name, body) => {
  mkdirSync(join(dir, "supabase/migrations"), { recursive: true });
  writeFileSync(join(dir, "supabase/migrations", name), body);
};
const validate = (cwd) => spawnSync("bash", [VALIDATOR], { cwd, env, encoding: "utf8" });

try {
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "t@example.test");
  git(main, "config", "user.name", "t");
  write(main, "20260101000000_base.sql", "select 1;\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "base");
  const a = join(root, "wt-a");
  const b = join(root, "wt-b");
  git(main, "worktree", "add", "-q", "-b", "a", a);
  git(main, "worktree", "add", "-q", "-b", "b", b);

  // Today's real collision: two sessions pick the same stamp, different names.
  write(a, "20261102220000_fix_1a.sql", "select 'a';\n");
  write(b, "20261102220000_fix_2.sql", "select 'b';\n");
  git(b, "add", "supabase/migrations/20261102220000_fix_2.sql");
  let r = validate(b);
  assert.notEqual(r.status, 0, "reused stamp in another worktree must block the commit\n" + r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /20261102220000_fix_1a\.sql/, "refusal names the other file");
  assert.match((r.stdout + r.stderr).replace(/\\/g, "/"), /wt-a/, "refusal names the other worktree");
  pass++;

  // Same stamp, same name, different content is still a collision.
  write(a, "20261102230000_same.sql", "select 'a';\n");
  write(b, "20261102230000_same.sql", "select 'b';\n");
  git(b, "reset", "-q");
  git(b, "add", "supabase/migrations/20261102230000_same.sql");
  r = validate(b);
  assert.notEqual(r.status, 0, "same name with different content must block\n" + r.stdout);
  pass++;

  // A unique stamp passes.
  git(b, "reset", "-q");
  write(b, "20261102233000_unique.sql", "select 'u';\n");
  git(b, "add", "supabase/migrations/20261102233000_unique.sql");
  r = validate(b);
  assert.equal(r.status, 0, "unique stamp must pass\n" + r.stdout + r.stderr);
  pass++;

  // The identical file (same name, same content, e.g. one from main) in both worktrees passes.
  git(b, "reset", "-q");
  write(a, "20261102240000_shared.sql", "select 'shared';\r\n");
  write(b, "20261102240000_shared.sql", "select 'shared';\n");
  git(b, "add", "supabase/migrations/20261102240000_shared.sql");
  r = validate(b);
  assert.equal(r.status, 0, "identical file in both worktrees must pass\n" + r.stdout + r.stderr);
  pass++;

  // A modified (not newly added) migration is not stamp-checked.
  git(b, "reset", "-q");
  write(a, "20260101000000_other.sql", "select 'x';\n");
  write(b, "20260101000000_base.sql", "select 2;\n");
  git(b, "add", "supabase/migrations/20260101000000_base.sql");
  r = validate(b);
  assert.equal(r.status, 0, "edited existing migration is not stamp-checked\n" + r.stdout + r.stderr);
  pass++;
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`check-migration-stamp-collision: ${pass} passed`);
