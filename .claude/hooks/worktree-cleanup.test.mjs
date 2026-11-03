#!/usr/bin/env node
// End-to-end test of worktree-cleanup.mjs: builds a throwaway repo with real
// worktrees and left-over folders, runs the hook with --write, and checks what
// was removed and what survived. Guards the two bugs that made the hook remove
// nothing until 2026-11-03 (PR #1380): `git cherry` calling squash-merged
// branches unmerged, and the git index (rewritten by any `git status`) making
// every worktree look recently active.
// Run: node .claude/hooks/worktree-cleanup.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lutimesSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../scripts/lib/test-temp-dir.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "worktree-cleanup.mjs");
const S = tempDir("crx-wt-cleanup-e2e-");
const R = path.join(S, "repo");
const W = path.join(R, ".claude", "worktrees");
// Isolate from the machine's git config (identity, hooksPath, autocrlf).
const emptyConfig = path.join(S, "gitconfig");
writeFileSync(emptyConfig, "[user]\n\tname = t\n\temail = t@t\n");
const env = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1", CLAUDE_PROJECT_DIR: R };
const g = (...args) => execFileSync("git", ["-C", R, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

execFileSync("git", ["init", "-q", "--bare", "-b", "main", path.join(S, "origin.git")], { env });
execFileSync("git", ["clone", "-q", path.join(S, "origin.git"), R], { env, stdio: "ignore" });
writeFileSync(path.join(R, ".gitignore"), ".env\nnode_modules\n.claude/worktrees/\n");
writeFileSync(path.join(R, "a.txt"), "a\n");
g("add", "."); g("commit", "-qm", "init"); g("branch", "-M", "main"); g("push", "-q", "origin", "main");

// A two-commit branch landed by squash merge as PR #7: `git cherry` calls it unmerged.
g("switch", "-qc", "feat/squashed");
writeFileSync(path.join(R, "b.txt"), "b\n"); g("add", "b.txt"); g("commit", "-qm", "b1");
writeFileSync(path.join(R, "b.txt"), "b\nb2\n"); g("commit", "-qam", "b2");
const squashedHead = g("rev-parse", "HEAD");
g("switch", "-q", "main"); g("merge", "-q", "--squash", "feat/squashed"); g("commit", "-qm", "squash (#7)"); g("push", "-q", "origin", "main");
g("switch", "-qc", "feat/open");
writeFileSync(path.join(R, "c.txt"), "c\n"); g("add", "c.txt"); g("commit", "-qm", "c");
g("switch", "-q", "main");
g("branch", "-q", "feat/wt", squashedHead); g("branch", "-q", "feat/env", squashedHead);
g("worktree", "add", "-q", path.join(W, "wt-clean"), "feat/wt");
g("worktree", "add", "-q", path.join(W, "wt-env"), "feat/env");
writeFileSync(path.join(W, "wt-env", ".env"), "SECRET\n");
g("worktree", "add", "-q", "--detach", path.join(W, "wt-detached"), "main");

// Husks: one empty but for a junction to a folder outside, one holding a file, one brand new.
mkdirSync(path.join(W, "husk-empty", "node_modules"), { recursive: true });
mkdirSync(path.join(W, "husk-files"), { recursive: true });
mkdirSync(path.join(S, "outside"), { recursive: true });
writeFileSync(path.join(S, "outside", "keep.txt"), "keep\n");
writeFileSync(path.join(W, "husk-files", "notes.md"), "work\n");
symlinkSync(path.join(S, "outside"), path.join(W, "husk-empty", "node_modules", "link"), "junction");
g("fetch", "-q", "origin");
writeFileSync(path.join(R, ".git", "crx-merged-pr-heads.json"), JSON.stringify({ fetchedAt: Date.now(), prs: [{ number: 7, headRefOid: squashedHead }] }));

// Age everything past the 3h activity window, then make one husk brand new.
const old = new Date(Date.now() - 5 * 60 * 60 * 1000);
function age(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) { try { lutimesSync(p, old, old); } catch { /* not supported: links carry no activity */ } return; }
  if (st.isDirectory()) for (const n of readdirSync(p)) age(path.join(p, n));
  utimesSync(p, old, old);
}
age(W); age(path.join(R, ".git", "worktrees"));
mkdirSync(path.join(W, "husk-new"));
// What worktree-awareness does at every session start: `git status` in each
// worktree. The aged file times make git rewrite each index now.
for (const wt of ["wt-clean", "wt-env", "wt-detached"]) execFileSync("git", ["-C", path.join(W, wt), "status", "--porcelain"], { env, stdio: "ignore" });

const out = execFileSync(process.execPath, [HOOK, "--write"], { cwd: R, env, encoding: "utf8" });

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, `${msg}\n--- hook output ---\n${out}`); pass++; };
const branches = g("branch", "--format=%(refname:short)").split(/\r?\n/);

ok(!existsSync(path.join(W, "wt-clean")), "clean worktree on a squash-merged PR head is removed");
ok(!existsSync(path.join(W, "wt-detached")), "clean detached worktree inside origin/main is removed");
ok(!branches.includes("feat/squashed"), "orphan branch at a merged PR head is deleted");
ok(!existsSync(path.join(W, "husk-empty")), "old husk with no real files is removed");
ok(readFileSync(path.join(S, "outside", "keep.txt"), "utf8") === "keep\n", "a husk's junction target is never entered");
ok(readFileSync(path.join(W, "wt-env", ".env"), "utf8") === "SECRET\n", "worktree holding an ignored .env is kept intact");
ok(existsSync(path.join(W, "husk-files", "notes.md")), "husk holding a file is kept");
ok(existsSync(path.join(W, "husk-new")), "brand-new husk is kept");
ok(branches.includes("feat/open"), "unmerged branch is kept");
ok(branches.includes("main"), "main is kept");

console.log(`worktree-cleanup (end to end): ${pass} assertions passed`);
