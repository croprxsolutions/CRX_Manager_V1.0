#!/usr/bin/env node
// Usage: npm run next-migration-stamp -- [--live <14-digit version>] [--gap-minutes <n>]
//        node scripts/next-migration-stamp.mjs --hotfix [--live <14-digit version>]   (a hotfix/<name> migration)
//        node scripts/next-migration-stamp.mjs --later-than <14-digit stamp>   (lists stamps above it)
// Prints a migration version stamp (YYYYMMDDHHMMSS, UTC) above every stamp in
// origin/main, every local worktree and every open PR, plus the live high-water when
// passed. A run on 2026-11-02 re-stamped five times because picked stamps collided with
// these; each re-stamp after Sol cost a new Sol review. Live access stays with the caller:
//   select greatest(max(version), (select max(m[1]) from supabase_migrations.schema_migrations s2, regexp_matches(s2.name, '([0-9]{14})', 'g') m)) from supabase_migrations.schema_migrations;
// (a row's name stamp can sit above every version; see migration-ordering-lib.mjs)
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

// A hotfix migration goes live before the migrations waiting on staging for the release, so its stamp sits just
// above main's newest (and live's) and below the oldest waiting one stamped above main; otherwise live refuses that
// one on release day (#1838 HIGH 1). taken: every stamp seen anywhere, so the pick collides with none.
export function hotfixStamp({ mainTop, live = "", ceiling = "", taken = new Set() }) {
  const floor = [mainTop, live].filter(Boolean).sort().pop() || "00000000000000";
  let d = new Date(Math.floor(toDate(floor).getTime() / 60_000) * 60_000 + 60_000);
  while (taken.has(toStamp(d))) d = new Date(d.getTime() + 60_000);
  const stamp = toStamp(d);
  if (stamp <= floor) throw new Error(`computed ${stamp} is not above ${floor}`);
  if (ceiling && stamp >= ceiling) throw new Error(`no free stamp between ${floor} and ${ceiling} (the oldest migration waiting on staging); ask Taha or Mason`);
  return stamp;
}

// Stamps above `stamp`, lowest first, one line each: origin/main and open PRs first, then a worktree.
export function laterStamps(seen, stamp) {
  const by = new Map();
  for (const s of seen) if (s.stamp > stamp) by.set(s.stamp, new Set([...(by.get(s.stamp) ?? []), s.source]));
  const rank = (src) => (src === "origin/main" ? 0 : src.startsWith("open PR") ? 1 : 2);
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([s, set]) => {
    const src = [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const shown = src.filter((x) => rank(x) < 2);
    if (!shown.length) shown.push(src[0]);
    const more = src.length - shown.length;
    return `${s} (${shown.join(", ")}${more ? `, +${more} more` : ""})`;
  });
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
  return r.stdout;
}

function collect() {
  const seen = [];
  const add = (path, source) => { const stamp = stampOf(path); if (stamp) seen.push({ stamp, source }); };

  run("git", ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main", "+refs/heads/staging:refs/remotes/origin/staging"]);
  const mainFiles = run("git", ["ls-tree", "-r", "--name-only", "origin/main", `${DIR}/`]).split("\n").map((p) => p.trim()).filter(Boolean);
  for (const p of mainFiles) add(p, "origin/main");
  const onMain = new Set(mainFiles);
  const waiting = [];
  for (const p of run("git", ["ls-tree", "-r", "--name-only", "origin/staging", `${DIR}/`]).split("\n").map((x) => x.trim())) {
    if (p && !onMain.has(p)) { add(p, "origin/staging"); const st = stampOf(p); if (st) waiting.push(st); }
  }

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
  const mainTop = mainFiles.map(stampOf).filter(Boolean).sort().pop() ?? "";
  return { seen, prCount: prs.length, mainTop, waiting };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Every argument must be a known flag followed by its value, so a typo like --lve is refused, not ignored.
  const args = process.argv.slice(2);
  if (args[0] === "--later-than") {
    if (args.length !== 2 || !/^\d{14}$/.test(args[1])) {
      console.error("usage: node scripts/next-migration-stamp.mjs --later-than <14-digit stamp>");
      process.exit(2);
    }
    try {
      for (const line of laterStamps(collect().seen, args[1])) console.log(line);
    } catch (error) {
      console.error(`NO LIST: ${error.message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  const hotfix = args[0] === "--hotfix";
  if (hotfix) args.shift();
  const flags = Object.create(null);
  for (let i = 0; i < args.length; i += 2) flags[args[i]] = args[i + 1] ?? "";
  const live = flags["--live"];
  const gap = flags["--gap-minutes"] ?? "60";
  const known = Object.keys(flags).every((k) => k === "--live" || k === "--gap-minutes");
  if (!known || (live !== undefined && !/^\d{14}$/.test(live)) || !/^[1-9]\d*$/.test(gap)) {
    console.error("usage: npm run next-migration-stamp -- [--hotfix] [--live <14-digit version>] [--gap-minutes <n>]");
    process.exit(2);
  }
  try {
    const { seen, prCount, mainTop, waiting } = collect();
    if (hotfix) {
      const ceiling = waiting.filter((w) => w > mainTop).sort()[0] ?? "";
      const stamp = hotfixStamp({ mainTop, live, ceiling, taken: new Set(seen.map((x) => x.stamp)) });
      console.error(`hotfix: above main's newest ${mainTop}${live ? ` and live ${live}` : ""}${ceiling ? `, below ${ceiling} (waiting on staging)` : ""}`);
      if (!live) console.error("note: live high-water not checked; pass --live <version> when the migration will be applied");
      console.log(stamp);
      process.exit(0);
    }
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
