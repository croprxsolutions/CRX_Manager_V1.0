#!/usr/bin/env node
// Usage: npm run next-migration-stamp -- [--live <14-digit version>] [--gap-minutes <n>]
// Prints a migration version stamp (YYYYMMDDHHMMSS, UTC) above every stamp in
// origin/main, every local worktree and every open PR, plus the live high-water when
// passed. A run on 2026-11-02 re-stamped five times because picked stamps collided with
// these; each re-stamp after Sol cost a new Sol review. Live access stays with the caller:
//   SELECT max(version) FROM supabase_migrations.schema_migrations;
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

  run("git", ["fetch", "--quiet", "origin", "main"]);
  for (const p of run("git", ["ls-tree", "--name-only", "origin/main", `${DIR}/`]).split("\n")) add(p.trim(), "origin/main");

  for (const wt of parseWorktreePorcelain(run("git", ["worktree", "list", "--porcelain"]))) {
    const dir = join(wt.path, DIR);
    if (existsSync(dir)) for (const f of readdirSync(dir)) add(f, `worktree ${wt.path}`);
  }

  // shortcut: gh lists at most 100 files per PR; a PR with more may hide a stamp. Upgrade to `gh pr diff --name-only` per PR if that ever bites.
  const prs = JSON.parse(run("gh", ["pr", "list", "--state", "open", "--limit", "500", "--json", "number,files"]));
  for (const pr of prs) for (const f of pr.files ?? []) if (f.path.startsWith(`${DIR}/`)) add(f.path, `open PR #${pr.number}`);
  return { seen, prCount: prs.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
  const live = opt("--live");
  const gap = opt("--gap-minutes") ?? "60";
  if ((live !== undefined && !/^\d{14}$/.test(live)) || !/^\d+$/.test(gap)) {
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
