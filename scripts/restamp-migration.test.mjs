// scripts/restamp-migration.mjs and the 2026-11-23 restamp-carry rule (restampProblem), on a throwaway
// repository: only the SQL header's link to its own record, a header line that is only its name, and that
// record's SQL sha256 pin may change
// beyond the stamp; an extra branch migration between the stamps, a stale or foreign pin, and an SQL body
// change all refuse.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexPushProof, codexPushProofPath, ONE_SHOT_LIST, restampHeaderLine, restampProblem } from "./write-codex-push-proof.mjs";
import { proofValid } from "../.claude/hooks/codex-push-lib.mjs";
import { gitLocalEnvironmentNames } from "../.claude/hooks/git-test-env.mjs";
import { tempDir } from "./lib/test-temp-dir.mjs";

const script = fileURLToPath(new URL("./restamp-migration.mjs", import.meta.url));
const env = { ...process.env };
for (const name of gitLocalEnvironmentNames()) delete env[name];
const sha = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const OLD = "20270226100000";
const NEW = "20270227110000";
const STEM = "delivery_driver_checks";
// Non-ASCII on purpose: the pin is the hash of the bytes, and the writer reads blobs as latin1.
// The first line is only the migration's own name: a restamp moves it too (#2524 needed that by hand).
const header = (stamp) => `-- ${stamp}_${STEM}\n-- Written 2026-11-23 — not applied. Tracked in\n-- docs/reference/migrations.d/${stamp}_${STEM}.md.\n\n`;
const body = `CREATE TABLE t (id bigint); -- first written as ${OLD}\n`;
const record = (stamp, sql) => `**LOCAL CANDIDATE — NOT APPLIED.** \`${stamp}_${STEM}.sql\` (SQL sha256: \`${sha(sql)}\`). Test.\n`;
const latin1 = (text) => Buffer.from(text, "utf8").toString("latin1");

// restampProblem, unit level.
{
  const entries = [
    { path: `supabase/migrations/${OLD}_${STEM}.sql`, oldMode: "100644", newMode: "000000" },
    { path: `supabase/migrations/${NEW}_${STEM}.sql`, oldMode: "000000", newMode: "100644" },
    { path: `docs/reference/migrations.d/${OLD}_${STEM}.md`, oldMode: "100644", newMode: "000000" },
    { path: `docs/reference/migrations.d/${NEW}_${STEM}.md`, oldMode: "000000", newMode: "100644" },
    { path: "scripts/smoke/prove.mjs", oldMode: "100644", newMode: "100644" },
  ];
  const oldSql = header(OLD) + body;
  const goodSql = header(NEW) + body;
  const judge = ({ newSql = goodSql, newRecord = record(NEW, newSql), smoke = `run ${NEW}_${STEM}.sql\n`, branchAdded = [], oldRecord = record(OLD, oldSql) } = {}) => restampProblem({
    branchAdded,
    entries,
    readFile: (side, file) => latin1(file.endsWith(".sql") ? (side === "old" ? oldSql : newSql)
      : file.endsWith(".md") ? (side === "old" ? oldRecord : newRecord)
        : (side === "old" ? `run ${OLD}_${STEM}.sql\n` : smoke)),
  });
  assert.equal(judge(), null, "restamp rule: the header's self-link and the matching pin carry; the body's own stamp literal stays");
  assert.match(judge({ newRecord: record(NEW, oldSql) }), /pin is not the new SQL's hash/, "restamp rule: a pin left on the old SQL's hash is refused");
  const unpinned = (stamp) => `**LOCAL CANDIDATE — NOT APPLIED.** \`${stamp}_${STEM}.sql\`. Test.\n`;
  assert.match(judge({ oldRecord: unpinned(OLD), newRecord: unpinned(NEW) }), /must be renamed and pin it/, "restamp rule: a changed SQL needs its record's pin");
  assert.match(judge({ newRecord: record(NEW, "other") }), /changed beyond the timestamp and its SQL sha256 pin/, "restamp rule: a pin to any other hash is refused");
  assert.match(judge({ smoke: `run ${NEW}_${STEM}.sql\n${sha(goodSql)}\n` }), /prove\.mjs changed beyond the timestamp/, "restamp rule: a hash in any other file is refused");
  assert.match(judge({ newSql: goodSql.replace(`as ${OLD}`, `as ${NEW}`) }), /the migration's SQL changed/, "restamp rule: the stamp swapped in the body is refused");
  assert.match(judge({ newSql: header(NEW).replace("Written", `Written ${NEW}`) + body }), /the migration's SQL changed/, "restamp rule: any other header edit is refused");
  assert.match(judge({ branchAdded: [`supabase/migrations/20270227000000_other.sql`] }), /sits between the old and new stamps/, "restamp rule: a branch migration between the stamps is refused");
  assert.equal(judge({ branchAdded: [`supabase/migrations/20270101000000_other.sql`, `supabase/migrations/${OLD}_${STEM}.sql`] }), null, "restamp rule: a branch migration below both stamps is fine");
  assert.match(judge({ branchAdded: [`supabase/migrations/${OLD}_zz.sql`] }), /sits between/, "restamp rule: another branch migration sharing the old stamp is refused");
  assert.match(judge({ branchAdded: [`supabase/migrations/${NEW}_zz.sql`] }), /sits between/, "restamp rule: another branch migration on the new stamp is refused");
  const note = {};
  restampProblem({ entries, branchAdded: [], note, readFile: (side, file) => latin1(file.endsWith(".sql") ? (side === "old" ? oldSql : goodSql) : file.endsWith(".md") ? (side === "old" ? record(OLD, oldSql) : record(NEW, goodSql)) : (side === "old" ? `run ${OLD}_${STEM}.sql\n` : `run ${NEW}_${STEM}.sql\n`)) });
  assert.deepEqual(note.sqlSha256, { from: sha(oldSql), to: sha(goodSql) }, "restamp rule: a header self-link change reports the SQL hash move");
  const applied = (stamp, sql) => record(stamp, sql).replace("**LOCAL CANDIDATE — NOT APPLIED.**", `**APPLIED LIVE 2026-11-23**, ledger version \`20261123000000\` carrying name \`${stamp}_${STEM}\`.`);
  assert.match(judge({ oldRecord: applied(OLD, oldSql), newRecord: applied(NEW, goodSql) }), /not a LOCAL CANDIDATE record/, "restamp rule: an applied record is refused");
  // The body's own self-link (e.g. a COMMENT ON string) stays; only the header's changes (Taha LOW 1).
  const linkBody = `COMMENT ON TABLE t IS 'docs/reference/migrations.d/${OLD}_${STEM}.md';\n`;
  const withBody = (stamp) => header(stamp) + linkBody;
  const judgeSql = (before, after) => restampProblem({ entries, branchAdded: [], readFile: (side, file) => latin1(file.endsWith(".sql") ? (side === "old" ? before : after) : file.endsWith(".md") ? (side === "old" ? record(OLD, before) : record(NEW, after)) : (side === "old" ? `run ${OLD}_${STEM}.sql\n` : `run ${NEW}_${STEM}.sql\n`)) });
  assert.equal(judgeSql(withBody(OLD), withBody(NEW)), null, "restamp rule: header link moves, body link stays, carries");
  assert.match(judgeSql(withBody(OLD), header(NEW) + linkBody.split(`${OLD}_`).join(`${NEW}_`)), /the migration's SQL changed/, "restamp rule: the body's self-link swapped is refused");
  const crHeader = (stamp) => `-- note\rSELECT 1; -- docs/reference/migrations.d/${stamp}_${STEM}.md\n\n`;
  assert.match(judgeSql(crHeader(OLD) + body, crHeader(NEW) + body), /the migration's SQL changed/, "restamp rule: a lone carriage return in the header is refused");
  // Only a header line that is just the name moves; the same line in the body, or the name inside other header text, stays.
  const nameBody = `SELECT 1;\n-- ${OLD}_${STEM}\n`;
  assert.match(judgeSql(header(OLD) + nameBody, header(NEW) + nameBody.split(`${OLD}_`).join(`${NEW}_`)), /the migration's SQL changed/, "restamp rule: the name line swapped in the body is refused");
  const seeLine = (stamp) => `-- see ${stamp}_${STEM} first\n` + header(stamp);
  assert.match(judgeSql(seeLine(OLD) + body, seeLine(NEW) + body), /the migration's SQL changed/, "restamp rule: the name inside a longer header line is refused");
  // Edge cases (Taha on #2551, LOW 2/3): the .sql form and every exact name line move; other lines stay.
  const lines = (...xs) => xs.map((x) => `${x}\n`).join("");
  assert.equal(judgeSql(lines(`-- ${OLD}_${STEM}.sql`) + body, lines(`-- ${NEW}_${STEM}.sql`) + body), null, "restamp rule: a `-- <name>.sql` line moves and carries");
  assert.equal(judgeSql(lines(`-- ${OLD}_${STEM}`, `  -- ${OLD}_${STEM}`) + body, lines(`-- ${NEW}_${STEM}`, `  -- ${NEW}_${STEM}`) + body), null, "restamp rule: two name lines both move and carry");
  const kept = lines(`-- ${OLD}_${STEM} note`, `-- 20270101000000_${STEM}`);
  assert.equal(judgeSql(kept + body, kept + body), null, "restamp rule: trailing text or another stamp stays put and carries");
  assert.match(judgeSql(kept + body, lines(`-- ${NEW}_${STEM} note`, `-- 20270101000000_${STEM}`) + body), /the migration's SQL changed/, "restamp rule: moving a name line with trailing text is refused");
  assert.equal(restampHeaderLine(`-- ${OLD}_${STEM}\r`, `${OLD}_${STEM}`, `${NEW}_${STEM}`), `-- ${NEW}_${STEM}\r`, "restamp rule: a CRLF name line moves and keeps its carriage return");
  // The one-shot list: exactly its key renamed old stamp -> new stamp, nothing else (2026-11-24, #2267).
  const oneShot = (key, why = "why") => `{\n  "_comment": ["x"],\n  "one_shot": {\n    "20260101000000_a": "a",\n    "${key}": "${why}"\n  }\n}\n`;
  const withList = [...entries, { path: ONE_SHOT_LIST, oldMode: "100644", newMode: "100644" }];
  const judgeList = (before, after, list = withList) => restampProblem({ entries: list, branchAdded: [], readFile: (side, file) => latin1(file === ONE_SHOT_LIST ? (side === "old" ? before : after)
    : file.endsWith(".sql") ? (side === "old" ? oldSql : goodSql) : file.endsWith(".md") ? (side === "old" ? record(OLD, oldSql) : record(NEW, goodSql)) : (side === "old" ? `run ${OLD}_${STEM}.sql\n` : `run ${NEW}_${STEM}.sql\n`)) });
  assert.equal(judgeList(oneShot(`${OLD}_${STEM}`), oneShot(`${NEW}_${STEM}`)), null, "restamp rule: the one-shot key rename carries");
  assert.match(judgeList(oneShot(`${OLD}_${STEM}`), oneShot(`${NEW}_${STEM}`, "edited")), /changed beyond renaming the key/, "restamp rule: a one-shot value edit is refused");
  assert.match(judgeList(oneShot(`${OLD}_${STEM}`), oneShot(`${NEW}_other`)), /changed beyond renaming the key/, "restamp rule: a one-shot key renamed to another name is refused");
  assert.match(judgeList(oneShot("20260202000000_b"), oneShot("20260202000000_c")), /changed beyond renaming the key/, "restamp rule: another one-shot key change is refused");
  assert.match(judgeList(oneShot(`${OLD}_${STEM}`), oneShot(`${OLD}_${STEM}`), entries), /still lists/, "restamp rule: a one-shot key left on the old stamp is refused");
  assert.match(judgeList("", "", [...entries, { path: "supabase/baselines/other.json", oldMode: "100644", newMode: "100644" }]), /another database file/, "restamp rule: any other supabase file still refuses");
}

// The command, end to end.
const repo = tempDir("crx-restamp-migration-");
const git = (...args) => execFileSync("git", ["-c", "user.name=Restamp Test", "-c", "user.email=restamp@example.invalid", ...args], { cwd: repo, env, encoding: "utf8" }).trim();
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: repo, env, encoding: "utf8" });
const write = (rel, text) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), text); };
const read = (rel) => readFileSync(path.join(repo, rel), "utf8");
const commit = (message) => { git("add", "-A"); git("commit", "-qm", message); return git("rev-parse", "HEAD"); };
const refused = (label, setup, why) => {
  git("reset", "-q", "--hard", reviewed);
  git("clean", "-qfd");
  const before = setup();
  const result = run(OLD, "--to", NEW);
  assert.equal(result.status, 1, `restamp command: ${label} is refused (${result.stdout}${result.stderr})`);
  assert.match(result.stderr, why, `restamp command: ${label} says why`);
  assert.equal(git("rev-parse", "HEAD"), before, `restamp command: ${label} commits nothing`);
  assert.equal(git("status", "--porcelain"), "", `restamp command: ${label} leaves the tree clean`);
};
let reviewed;
try {
  git("init", "-q", "-b", "staging");
  git("config", "core.autocrlf", "false");
  // The command commits on its own; CI runners have no global git identity.
  git("config", "user.name", "Restamp Test");
  git("config", "user.email", "restamp@example.invalid");
  write(".gitignore", ".claude/session-state/\n");
  write("supabase/migrations/20270101000000_base.sql", "SELECT 1;\n");
  write("docs/changelog.d/other.md", `Unrelated history naming ${OLD}.\n`);
  const base = commit("base");
  git("branch", "main", base);
  git("remote", "add", "origin", repo); // the command fetches main and staging from origin
  git("switch", "-q", "-c", "feature");
  const sql = header(OLD) + body;
  write(`supabase/migrations/${OLD}_${STEM}.sql`, sql);
  write(`docs/reference/migrations.d/${OLD}_${STEM}.md`, record(OLD, sql));
  write("docs/changelog.d/mine.md", `Adds ${OLD}_${STEM}.\n`);
  write(ONE_SHOT_LIST, `{\n  "one_shot": {\n    "${OLD}_${STEM}": "one-shot data fix"\n  }\n}\n`);
  reviewed = commit("pr");
  mkdirSync(path.dirname(codexPushProofPath(repo, reviewed)), { recursive: true });
  writeFileSync(codexPushProofPath(repo, reviewed), JSON.stringify(buildCodexPushProof({ headSha: reviewed, baseSha: base, verdict: "clean" })));

  const ok = run(OLD, "--to", NEW);
  assert.equal(ok.status, 0, `restamp command: succeeds (${ok.stdout}${ok.stderr})`);
  const head = git("rev-parse", "HEAD");
  assert.equal(git("rev-parse", "HEAD~1"), reviewed, "restamp command: exactly one commit");
  const newSql = read(`supabase/migrations/${NEW}_${STEM}.sql`);
  assert.equal(newSql, header(NEW) + body, "restamp command: only the header's self-link changed; the body keeps its bytes");
  assert.equal(read(`docs/reference/migrations.d/${NEW}_${STEM}.md`), record(NEW, newSql), "restamp command: record renamed, new name and pin");
  assert.equal(read("docs/changelog.d/mine.md"), `Adds ${NEW}_${STEM}.\n`, "restamp command: the branch's own note follows");
  assert.equal(read(ONE_SHOT_LIST), `{\n  "one_shot": {\n    "${NEW}_${STEM}": "one-shot data fix"\n  }\n}\n`, "restamp command: the one-shot list's key follows");
  assert.equal(read("docs/changelog.d/other.md"), `Unrelated history naming ${OLD}.\n`, "restamp command: files the branch does not change are left alone");
  const proof = JSON.parse(readFileSync(codexPushProofPath(repo, head), "utf8"));
  assert.equal(proof.carry.mode, "restamp", "restamp command: the Sol proof carried");
  assert.equal(proofValid(proof, head, Date.now(), base), true, "restamp command: the gates accept the carried proof");

  refused("a branch migration between the stamps", () => {
    write("supabase/migrations/20270227000000_other.sql", "SELECT 2;\n");
    return commit("second migration");
  }, /sits between/);
  refused("a stamp not above the base's newest", () => {
    git("switch", "-q", "staging");
    write("supabase/migrations/20270228000000_later.sql", "SELECT 3;\n");
    commit("later on staging");
    git("switch", "-q", "feature");
    return reviewed;
  }, /is not newer than 20270228000000/);
  git("branch", "-f", "staging", base);
  refused("a migration already on staging", () => {
    git("branch", "-f", "staging", reviewed);
    return reviewed;
  }, /origin\/staging already has supabase\/migrations\/20270226100000_/);
  git("branch", "-f", "staging", base);
  refused("the same migration landed under another stamp", () => {
    git("switch", "-q", "staging");
    write(`supabase/migrations/20270225000000_${STEM}.sql`, "SELECT 4;\n");
    commit("same name, other stamp");
    git("switch", "-q", "feature");
    return reviewed;
  }, /already has supabase\/migrations\/20270225000000_/);
  git("branch", "-f", "staging", base);
  refused("a missing record", () => {
    rmSync(path.join(repo, "docs", "reference", "migrations.d", `${OLD}_${STEM}.md`));
    return commit("drop record");
  }, /is missing; every migration needs its record/);
  const bareTo = run(OLD, "--to");
  assert.equal(bareTo.status, 2, "restamp command: --to with no value is a usage error, not a generated stamp");
  git("branch", "-f", "staging", base);
  refused("staging itself", () => { git("switch", "-q", "staging"); return git("rev-parse", "HEAD"); }, /not a feature branch/);
} finally {
  rmSync(repo, { recursive: true, force: true });
}
console.log("restamp-migration tests passed");
