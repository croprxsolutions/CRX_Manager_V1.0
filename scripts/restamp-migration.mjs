#!/usr/bin/env node
// Usage: node scripts/restamp-migration.mjs <old-stamp> [--to <new-stamp>] [--base <ref>]
// One command for a migration whose stamp went stale while its PR waited (2026-11-23: four PRs
// restamped by hand in one day). It renames the .sql and its migrations.d record to a new stamp
// (npm run next-migration-stamp unless --to), swaps the old stamp, and the record's SQL sha256 pin,
// in the files this branch already changes against --base (default origin/staging), commits, then
// runs `write-codex-push-proof.mjs --carry-restamp` so a clean Sol proof carries with no model run.
// The stamp may change in the SQL's leading comment header only; anywhere else it refuses, because
// that changes what runs and needs a full Sol review. Pushing stays with the caller.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fail = (message) => { console.error(`Restamp refused: ${message}. Nothing was changed.`); process.exit(1); };
const git = (...args) => {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout.trim();
};
const lf = (text) => text.replace(/\r\n/g, "\n");
const sha = (text) => createHash("sha256").update(Buffer.from(lf(text), "latin1")).digest("hex");

const args = process.argv.slice(2);
const oldStamp = args.shift();
const flags = Object.create(null);
for (let i = 0; i < args.length; i += 2) flags[args[i]] = args[i + 1];
if (!/^\d{14}$/.test(oldStamp ?? "") || Object.keys(flags).some((k) => k !== "--to" && k !== "--base") || (flags["--to"] !== undefined && !/^\d{14}$/.test(flags["--to"]))) {
  console.error("usage: node scripts/restamp-migration.mjs <old-stamp> [--to <new-stamp>] [--base <ref>]");
  process.exit(2);
}
const base = flags["--base"] ?? "origin/staging";

process.chdir(git("rev-parse", "--show-toplevel"));
if (git("status", "--porcelain")) fail("the worktree is not clean; commit or set aside your changes first");
const sqls = git("ls-files", "supabase/migrations").split("\n").filter((f) => f.startsWith(`supabase/migrations/${oldStamp}_`) && f.endsWith(".sql"));
if (sqls.length !== 1) fail(`expected one supabase/migrations/${oldStamp}_*.sql, found ${sqls.length}`);
const [oldSql] = sqls;
const oldRecord = `docs/reference/migrations.d/${path.basename(oldSql, ".sql")}.md`;

const sqlText = readFileSync(oldSql, "latin1");
const lines = lf(sqlText).split("\n");
const bodyStart = lines.findIndex((line) => line.trim() !== "" && !line.trimStart().startsWith("--"));
if (lines.some((line, i) => bodyStart !== -1 && i >= bodyStart && line.includes(oldStamp))) {
  fail(`${oldSql} names its stamp below the leading comment header, so a restamp changes what runs; restamp it by hand and run a full Sol review`);
}

let newStamp = flags["--to"];
if (!newStamp) {
  const r = spawnSync(process.execPath, [path.join(here, "next-migration-stamp.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  newStamp = r.stdout.trim();
  if (r.status !== 0 || !/^\d{14}$/.test(newStamp)) fail("next-migration-stamp gave no stamp");
}
if (newStamp <= oldStamp) fail(`${newStamp} is not newer than ${oldStamp}`);
const swap = (text) => text.split(oldStamp).join(newStamp);
const newSql = swap(oldSql);

// Best effort: offline, the local copy of the base still names the branch's own files.
spawnSync("git", ["fetch", "--quiet", "origin"], { stdio: "ignore" });
const owned = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
git("mv", oldSql, newSql);
writeFileSync(newSql, swap(sqlText), "latin1");
const [oldSha, newSha] = [sha(sqlText), sha(swap(sqlText))];
const edits = [newSql];
if (existsSync(oldRecord)) { git("mv", oldRecord, swap(oldRecord)); owned.push(swap(oldRecord)); }
for (const file of owned) {
  // Another database file is not this PR's to restamp; the carry would refuse it anyway.
  if (file.startsWith("supabase/") || file === oldSql || file === oldRecord || !existsSync(file)) continue;
  const before = readFileSync(file, "latin1");
  const after = swap(before).split(oldSha).join(newSha);
  if (after !== before) { writeFileSync(file, after, "latin1"); edits.push(file); }
}
git("add", "-A");
git("commit", "-q", "-m", `chore(migrations): restamp ${path.basename(oldSql, ".sql")} to ${newStamp}`);
console.log(`Restamped ${oldStamp} -> ${newStamp} in ${git("rev-parse", "--short=12", "HEAD")}: ${edits.join(", ")}`);

const carry = spawnSync(process.execPath, [path.join(here, "write-codex-push-proof.mjs"), "--carry-restamp"], { stdio: "inherit" });
if (carry.status !== 0) {
  console.error("The restamp is committed, but its Sol proof did not carry (above). Run the full review: node scripts/write-codex-push-proof.mjs");
  process.exit(1);
}
console.log("Sol proof carried. Push the branch.");
