// End to end on a throwaway repository: scripts/restamp-migration.mjs renames, swaps the stamp and the
// record's SQL sha256 pin, commits, and carries the Sol proof; a stamp inside the SQL body is refused.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexPushProof, codexPushProofPath, restampProblem } from "./write-codex-push-proof.mjs";
import { proofValid } from "../.claude/hooks/codex-push-lib.mjs";
import { gitLocalEnvironmentNames } from "../.claude/hooks/git-test-env.mjs";
import { tempDir } from "./lib/test-temp-dir.mjs";

const script = fileURLToPath(new URL("./restamp-migration.mjs", import.meta.url));
const env = { ...process.env };
for (const name of gitLocalEnvironmentNames()) delete env[name];
const sha = (text) => createHash("sha256").update(text).digest("hex");
const OLD = "20270226100000";
const NEW = "20270227110000";
const STEM = "delivery_driver_checks";
const header = (stamp) => `-- STATUS: NOT APPLIED. Tracked in\n-- docs/reference/migrations.d/${stamp}_${STEM}.md.\n\n`;
const body = "CREATE TABLE t (id bigint);\n";
const record = (stamp, sql) => `**LOCAL CANDIDATE — NOT APPLIED.** \`${stamp}_${STEM}.sql\` (SQL sha256: \`${sha(sql)}\`). Test.\n`;

// restampProblem: the new header and pin rules, unit level.
{
  const entries = [
    { path: `supabase/migrations/${OLD}_${STEM}.sql`, oldMode: "100644", newMode: "000000" },
    { path: `supabase/migrations/${NEW}_${STEM}.sql`, oldMode: "000000", newMode: "100644" },
    { path: `docs/reference/migrations.d/${OLD}_${STEM}.md`, oldMode: "100644", newMode: "000000" },
    { path: `docs/reference/migrations.d/${NEW}_${STEM}.md`, oldMode: "000000", newMode: "100644" },
  ];
  const judge = (newSql, newRecord, oldSql = header(OLD) + body) => restampProblem({
    entries,
    readFile: (side, file) => (file.endsWith(".sql") ? (side === "old" ? oldSql : newSql) : (side === "old" ? record(OLD, oldSql) : newRecord)),
  });
  const good = header(NEW) + body;
  assert.equal(judge(good, record(NEW, good)), null, "restamp: the stamp in the header comment and the matching pin carry");
  assert.match(judge(good, record(NEW, "other")), /changed beyond the timestamp/, "restamp: a pin to any other hash is refused");
  const inBody = (stamp) => `${header(stamp)}SELECT '${stamp}';\n`;
  assert.match(judge(inBody(NEW), record(NEW, inBody(NEW)), inBody(OLD)), /the migration's SQL changed/, "restamp: the stamp below the header is refused");
  assert.match(judge(good + "SELECT 1;\n", record(NEW, good + "SELECT 1;\n")), /the migration's SQL changed/, "restamp: an extra statement is refused");
}

// The command, end to end.
const repo = tempDir("crx-restamp-migration-");
const git = (...args) => execFileSync("git", ["-c", "user.name=Restamp Test", "-c", "user.email=restamp@example.invalid", ...args], { cwd: repo, env, encoding: "utf8" }).trim();
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: repo, env, encoding: "utf8" });
const write = (rel, text) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), text); };
const read = (rel) => readFileSync(path.join(repo, rel), "utf8");
try {
  git("init", "-q", "-b", "staging");
  git("config", "core.autocrlf", "false");
  write(".gitignore", ".claude/session-state/\n");
  write("docs/changelog.d/other.md", `Unrelated history naming ${OLD}.\n`);
  git("add", "-A"); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/staging", base);
  git("update-ref", "refs/remotes/origin/main", base);
  git("switch", "-q", "-c", "feature");
  const sql = header(OLD) + body;
  write(`supabase/migrations/${OLD}_${STEM}.sql`, sql);
  write(`docs/reference/migrations.d/${OLD}_${STEM}.md`, record(OLD, sql));
  write("docs/changelog.d/mine.md", `Adds ${OLD}_${STEM}.\n`);
  git("add", "-A"); git("commit", "-qm", "pr");
  const reviewed = git("rev-parse", "HEAD");
  mkdirSync(path.dirname(codexPushProofPath(repo, reviewed)), { recursive: true });
  writeFileSync(codexPushProofPath(repo, reviewed), JSON.stringify(buildCodexPushProof({ headSha: reviewed, baseSha: base, verdict: "clean" })));

  const ok = run(OLD, "--to", NEW);
  assert.equal(ok.status, 0, `restamp command: succeeds (${ok.stdout}${ok.stderr})`);
  const head = git("rev-parse", "HEAD");
  assert.equal(git("rev-parse", "HEAD~1"), reviewed, "restamp command: exactly one commit");
  const newSql = read(`supabase/migrations/${NEW}_${STEM}.sql`);
  assert.equal(newSql, header(NEW) + body, "restamp command: only the header's stamp changed");
  assert.equal(read(`docs/reference/migrations.d/${NEW}_${STEM}.md`), record(NEW, newSql), "restamp command: record renamed with the new name and pin");
  assert.equal(read("docs/changelog.d/mine.md"), `Adds ${NEW}_${STEM}.\n`, "restamp command: the branch's own note follows");
  assert.equal(read("docs/changelog.d/other.md"), `Unrelated history naming ${OLD}.\n`, "restamp command: files the branch does not change are left alone");
  const proof = JSON.parse(readFileSync(codexPushProofPath(repo, head), "utf8"));
  assert.equal(proof.carry.mode, "restamp", "restamp command: the Sol proof carried");
  assert.equal(proofValid(proof, head, Date.now(), base), true, "restamp command: the gates accept the carried proof");

  // A stamp inside the SQL body: refused before any change.
  git("reset", "-q", "--hard", reviewed);
  write(`supabase/migrations/${OLD}_${STEM}.sql`, `${sql}SELECT '${OLD}';\n`);
  git("add", "-A"); git("commit", "-qm", "body names stamp");
  const before = git("rev-parse", "HEAD");
  const refused = run(OLD, "--to", NEW);
  assert.equal(refused.status, 1, "restamp command: a stamp in the SQL body is refused");
  assert.match(refused.stderr, /below the leading comment header/, "restamp command: says why");
  assert.equal(git("rev-parse", "HEAD"), before, "restamp command: nothing committed");
  assert.equal(existsSync(path.join(repo, "supabase/migrations", `${NEW}_${STEM}.sql`)), false, "restamp command: nothing renamed");
} finally {
  rmSync(repo, { recursive: true, force: true });
}
console.log("restamp-migration tests passed");
