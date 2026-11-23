#!/usr/bin/env node
// Usage: node scripts/restamp-migration.mjs <old-stamp> [--to <new-stamp>]
// One command for a feature branch whose migration stamp went stale while its PR waited for staging
// (2026-11-23: four PRs re-dated by hand in one day). It renames the .sql and its migrations.d record
// to a new stamp (npm run next-migration-stamp unless --to), swaps the old stamp in the files this
// branch already changes, updates the SQL header's link to its record and the record's SQL sha256 pin,
// commits, then runs `write-codex-push-proof.mjs --carry-restamp` so a clean Sol proof carries with no
// model run. The SQL body is never touched. Pushing stays with the caller. Hotfix/release branches
// are refused: their stamps follow next-migration-stamp --hotfix and the live high-water.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexPushProofPath } from "./write-codex-push-proof.mjs";

const BASE = "origin/staging";
const here = path.dirname(fileURLToPath(import.meta.url));
const fail = (message) => { console.error(`Restamp refused: ${message}. Nothing was changed.`); process.exit(1); };
const tryGit = (...args) => spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const git = (...args) => {
  const r = tryGit(...args);
  if (r.status !== 0) fail(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout.trim();
};
const lf = (text) => text.replace(/\r\n/g, "\n");
const sha = (text) => createHash("sha256").update(Buffer.from(lf(text), "latin1")).digest("hex");
const stampsOn = (ref) => git("ls-tree", "-r", "--name-only", ref, "supabase/migrations/").split("\n").map((p) => /\/(\d{14})_[^/]+\.sql$/.exec(p)?.[1]).filter(Boolean);
const realStamp = (s) => {
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)));
  return d.toISOString().replace(/\D/g, "").slice(0, 14) === s;
};

const args = process.argv.slice(2);
const oldStamp = args.shift();
const flags = Object.create(null);
for (let i = 0; i < args.length; i += 2) flags[args[i]] = args[i + 1] ?? "";
if (!/^\d{14}$/.test(oldStamp ?? "") || Object.keys(flags).some((k) => k !== "--to") || (flags["--to"] !== undefined && !/^\d{14}$/.test(flags["--to"]))) {
  console.error("usage: node scripts/restamp-migration.mjs <old-stamp> [--to <new-stamp>]");
  process.exit(2);
}

process.chdir(git("rev-parse", "--show-toplevel"));
const branch = tryGit("symbolic-ref", "--quiet", "--short", "HEAD").stdout.trim();
if (!branch || /^(main|staging|release\/|hotfix\/)/.test(branch)) fail(`"${branch || "detached HEAD"}" is not a feature branch into staging`);
if (git("status", "--porcelain")) fail("the worktree is not clean; commit or set aside your changes first");
// Offline, the local copies of the bases are used; the PR's stamp check still runs against the real base.
const fetched = spawnSync("git", ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main", "+refs/heads/staging:refs/remotes/origin/staging"], { stdio: "ignore" });
if (fetched.status !== 0) console.error(`WARNING: could not fetch origin; checking against the local ${BASE} and origin/main, which may be behind.`);

const sqls = git("ls-files", "supabase/migrations").split("\n").filter((f) => f.startsWith(`supabase/migrations/${oldStamp}_`) && f.endsWith(".sql"));
if (sqls.length !== 1) fail(`expected one supabase/migrations/${oldStamp}_*.sql, found ${sqls.length}`);
const [oldSql] = sqls;
const nameAfterStamp = oldSql.slice(`supabase/migrations/${oldStamp}`.length);
for (const ref of [BASE, "origin/main"]) {
  // The same name under any stamp: already landed (an applied migration keeps its bytes), or a copy that would run twice.
  const same = git("ls-tree", "-r", "--name-only", ref, "supabase/migrations/").split("\n").find((p) => /^supabase\/migrations\/\d{14}_/.test(p) && p.endsWith(nameAfterStamp) && p.length === oldSql.length);
  if (same) fail(`${ref} already has ${same}; check whether this migration already landed under that name`);
}
const owned = git("diff", "--name-only", "--no-renames", `${BASE}...HEAD`).split("\n").filter(Boolean);
if (!owned.includes(oldSql)) fail(`${oldSql} is not a migration this branch adds against ${BASE}`);

let newStamp = flags["--to"];
if (!newStamp) {
  const r = spawnSync(process.execPath, [path.join(here, "next-migration-stamp.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  newStamp = r.stdout.trim();
  if (r.status !== 0 || !/^\d{14}$/.test(newStamp)) fail("next-migration-stamp gave no stamp");
}
if (!realStamp(newStamp)) fail(`${newStamp} is not a real date and time`);
const top = [...stampsOn(BASE), ...stampsOn("origin/main")].sort().at(-1) ?? "";
if (newStamp <= top) fail(`${newStamp} is not newer than ${top}, the newest migration on ${BASE} or main`);
const branchStamps = owned.map((p) => /^supabase\/migrations\/(\d{14})_[^/]+\.sql$/.exec(p)?.[1]).filter((s) => s && s !== oldStamp);
if (branchStamps.includes(newStamp)) fail(`${newStamp} is already used on this branch`);
const between = branchStamps.find((s) => s > oldStamp && s < newStamp);
if (between) fail(`this branch's migration ${between} sits between ${oldStamp} and ${newStamp}; restamping one would change the apply order, so restamp them by hand and run a full Sol review`);

const swap = (text) => text.split(oldStamp).join(newStamp);
const oldStem = path.basename(oldSql, ".sql");
const newStem = swap(oldStem);
const newSql = `supabase/migrations/${newStem}.sql`;
const oldRecord = `docs/reference/migrations.d/${oldStem}.md`;
const newRecord = `docs/reference/migrations.d/${newStem}.md`;
if (!existsSync(oldRecord)) fail(`${oldRecord} is missing; every migration needs its record (docs/reference/migrations.d/README.md)`);
for (const dest of [newSql, newRecord]) if (existsSync(dest)) fail(`${dest} already exists`);
const reviewed = git("rev-parse", "HEAD");
if (!existsSync(codexPushProofPath(process.cwd(), reviewed))) console.error(`note: no Sol proof for ${reviewed.slice(0, 12)} in this worktree; the restamp commits, but nothing will carry.`);

// The SQL: only its leading comment header's link to its own record changes; the body keeps every byte.
const sqlText = readFileSync(oldSql, "latin1");
const sqlLines = sqlText.split("\n");
const bodyStart = sqlLines.findIndex((line) => line.trim() !== "" && !line.trimStart().startsWith("--"));
const newSqlText = sqlLines.map((line, i) => (bodyStart === -1 || i < bodyStart ? line.split(`migrations.d/${oldStem}.md`).join(`migrations.d/${newStem}.md`) : line)).join("\n");
const pin = (hash) => `SQL sha256: \`${hash}\``;
const [oldPin, newPin] = [pin(sha(sqlText)), pin(sha(newSqlText))];

git("mv", oldSql, newSql);
writeFileSync(newSql, newSqlText, "latin1");
const edits = [newSql];
git("mv", oldRecord, newRecord);
writeFileSync(newRecord, swap(readFileSync(newRecord, "latin1")).split(oldPin).join(newPin), "latin1");
edits.push(newRecord);
for (const file of owned) {
  // Other database files are not this command's to change; the carry would refuse them anyway.
  if (file.startsWith("supabase/") || file === oldRecord || !existsSync(file)) continue;
  const before = readFileSync(file, "latin1");
  if (swap(before) !== before) { writeFileSync(file, swap(before), "latin1"); edits.push(file); }
}
git("add", "--", ...edits); // the renames are already staged by git mv
git("commit", "-q", "-m", `chore(migrations): restamp ${oldStem} to ${newStamp}`);
const head = git("rev-parse", "HEAD");
console.log(`Restamped ${oldStamp} -> ${newStamp} in commit ${head}: ${edits.join(", ")}`);
const leftover = tryGit("grep", "-l", oldStem, "HEAD", "--").stdout.trim();
if (leftover) console.error(`note: these files still name ${oldStem}; check them:\n${leftover}`);

const carry = spawnSync(process.execPath, [path.join(here, "write-codex-push-proof.mjs"), "--carry-restamp"], { stdio: "inherit" });
if (carry.status !== 0) {
  console.error(`The restamp is committed (${head}), but its Sol proof did not carry (reason above). Either fix and amend, or run the full review: node scripts/write-codex-push-proof.mjs`);
  process.exit(1);
}
console.log("Sol proof carried. Push the branch.");
