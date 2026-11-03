#!/usr/bin/env node
// Usage: npm run next-migration-stamp -- [--live <14-digit version>] [--gap-minutes <n>]
// Prints a migration version stamp (YYYYMMDDHHMMSS, UTC) above every stamp in
// origin/main, every local worktree and every open PR, plus the live high-water when
// passed. A run on 2026-11-02 re-stamped five times because picked stamps collided with
// these; each re-stamp after Sol cost a new Sol review. Live access stays with the caller:
//   SELECT max(version) FROM supabase_migrations.schema_migrations;
// Two sessions picking in the same minute get the same stamp; the pre-commit check
// (check-migration-stamp-collision.mjs) refuses the second once the first file exists, before any Sol.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorktreePorcelain } from "../.claude/hooks/worktree-awareness-lib.mjs";

const DIR = "supabase/migrations";
const STAMP = /^(\d{14})_.*\.sql$/;

export function stampOf(path) {
  return path.split("/").pop().match(STAMP)?.[1] ?? null;
}

const toDate = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)));
const toStamp = (d) => d.toISOString().replace(/\D/g, "").slice(0, 14);

// seen: [{ stamp, source }]. Returns the later of now and (highest + gap), on a whole minute.
export function nextStamp(seen, { gapMinutes = 60, now = new Date() } = {}) {
  const top = seen.reduce((a, b) => (b.stamp > a.stamp ? b : a), { stamp: "00000000000000", source: "none" });
  const floor = top.source === "none" ? 0 : toDate(top.stamp).getTime() + gapMinutes * 60_000;
  const next = new Date(Math.ceil(Math.max(floor, now.getTime()) / 60_000) * 60_000);
  const stamp = toStamp(next);
  // Out-of-range digits (e.g. minute 99) roll over in Date.UTC; never return a stamp at or below the max.
  if (stamp <= top.stamp) throw new Error(`computed ${stamp} is not above ${top.stamp}`);
  return { stamp, top };
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
  return r.stdout;
}

function collect() {
  const seen = [];
  const add = (path, source) => { const stamp = stampOf(path); if (stamp) seen.push({ stamp, source }); };

  run("git", ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  for (const p of run("git", ["ls-tree", "-r", "--name-only", "origin/main", `${DIR}/`]).split("\n")) add(p.trim(), "origin/main");

  for (const wt of parseWorktreePorcelain(run("git", ["worktree", "list", "--porcelain"]))) {
    const dir = join(wt.path, DIR);
    if (existsSync(dir)) for (const f of readdirSync(dir)) add(f, `worktree ${wt.path}`);
  }

  const LIMIT = 500;
  const prs = JSON.parse(run("gh", ["pr", "list", "--state", "open", "--limit", String(LIMIT), "--json", "number,files"]));
  if (prs.length >= LIMIT) throw new Error(`${prs.length} open PRs reached the ${LIMIT} listing cap; some may be unseen`);
  for (const pr of prs) {
    // gh lists at most 100 files per PR; read the full list for any PR at that cap.
    const paths = (pr.files ?? []).length >= 100
      ? run("gh", ["pr", "diff", String(pr.number), "--name-only"]).split("\n").map((p) => p.trim())
      : (pr.files ?? []).map((f) => f.path);
    for (const p of paths) if (p.startsWith(`${DIR}/`)) add(p, `open PR #${pr.number}`);
  }
  return { seen, prCount: prs.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Every argument must be a known flag followed by its value, so a typo like --lve is refused, not ignored.
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i += 2) flags[args[i]] = args[i + 1] ?? "";
  const live = flags["--live"];
  const gap = flags["--gap-minutes"] ?? "60";
  const known = Object.keys(flags).every((k) => k === "--live" || k === "--gap-minutes");
  if (!known || (live !== undefined && !/^\d{14}$/.test(live)) || !/^[1-9]\d*$/.test(gap)) {
    console.error("usage: npm run next-migration-stamp -- [--live <14-digit version>] [--gap-minutes <n>]");
    process.exit(2);
  }
  try {
    const { seen, prCount } = collect();
    if (live) seen.push({ stamp: live, source: "live high-water (--live)" });
    const { stamp, top } = nextStamp(seen, { gapMinutes: Number(gap) });
    console.error(`checked ${seen.length} stamps (origin/main, local worktrees, ${prCount} open PRs${live ? ", live" : ""}); highest ${top.stamp} from ${top.source}`);
    if (!live) console.error("note: live high-water not checked; pass --live <version> when the migration will be applied");
    console.log(stamp);
  } catch (error) {
    console.error(`NO STAMP: ${error.message}`);
    process.exit(1);
  }
}
