#!/usr/bin/env node
// Pre-commit (via scripts/validate-sql.sh): refuse a newly ADDED migration whose
// 14-digit version stamp is already used by a different file in this or any
// other local worktree of this repo. Parallel sessions picked the same stamp twice on
// 2026-11-02; the apply-time ordering re-check catches it far later.
// An identical file (same name, same content) elsewhere is fine — that is the
// same migration checked out twice, e.g. one already on main.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorktreePorcelain, normPath } from "../.claude/hooks/worktree-awareness-lib.mjs";

const DIR = "supabase/migrations";
const STAMP = /^(\d{14})_.*\.sql$/;
const lf = (s) => s.replace(/\r\n/g, "\n");

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

const added = git(["diff", "--cached", "--no-renames", "--name-only", "--diff-filter=A", "--", DIR]);
const top = git(["rev-parse", "--show-toplevel"]);
const porcelain = git(["worktree", "list", "--porcelain"]);
if (added === null || top === null || porcelain === null) {
  // Fail-open only when git itself cannot answer; the apply-time ordering check still runs.
  console.log("WARNING: migration stamp check skipped — git unavailable.");
  process.exit(0);
}

const mine = added.split("\n").map((p) => p.trim())
  .filter((p) => STAMP.test(p.slice(DIR.length + 1)))
  // An unreadable staged blob stays null, so it never matches and is refused.
  .map((p) => ({ name: p.slice(DIR.length + 1), content: git(["show", `:${p}`])?.replace(/\r\n/g, "\n") ?? null }));
if (mine.length === 0) process.exit(0);

const self = normPath(top.trim());
let collisions = 0;
for (const wt of parseWorktreePorcelain(porcelain)) {
  const isSelf = normPath(wt.path) === self;
  const dir = join(wt.path, DIR);
  if (!existsSync(dir)) continue; // pruned/missing worktree
  const files = readdirSync(dir);
  for (const m of mine) {
    const stamp = m.name.slice(0, 14);
    for (const f of files) {
      if (!f.startsWith(stamp + "_") || !f.endsWith(".sql")) continue;
      // Own copy on disk may differ from the index (partial staging), so skip it by name.
      if (f === m.name && (isSelf || lf(readFileSync(join(dir, f), "utf8")) === m.content)) continue;
      console.log(`BLOCKED: ${DIR}/${m.name}`);
      console.log(`  Version stamp ${stamp} is already used by ${f} in worktree ${wt.path}`);
      console.log("  Pick a new, later stamp (rename the file) before committing.");
      collisions++;
    }
  }
}
process.exit(collisions > 0 ? 1 : 0);
