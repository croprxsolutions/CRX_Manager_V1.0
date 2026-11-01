// migration-history.md froze on 2026-11-01. Every PR edited rows in that one file, GitHub
// reported conflicts its union merge setting cannot see, and merges stalled. Each newer
// migration now keeps its record in its own file (docs/reference/migrations.d/README.md).
//
// Every gate still parses table rows, so a record is turned back into one row here and
// joined to the frozen text. No parser or gate has to know the two sources exist. Anything
// here that cannot be read throws: the callers already treat unreadable history as UNKNOWN.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { normRepoPath } from "./worktree-awareness-lib.mjs";

export const MIGRATION_HISTORY_FILE = "docs/reference/migration-history.md";
export const MIGRATION_RECORDS_DIR = "docs/reference/migrations.d";
export const MIGRATION_RECORDS_README = "README.md";

const RECORD_NAME_RE = /^(\d{14})_[a-z0-9_]+\.md$/;
// Anchored on purpose: a status buried in prose or in the notes could hide a pending
// migration from the parked scan. PENDING APPLY is absent because that scan cannot see it.
const RECORD_STATUS_RE = /^\*\*(?:LOCAL\s+CANDIDATE\b[^*]*\bNOT\s+APPLIED\b|APPLIED\s+LIVE\b|RETIRED\s+CODE-ONLY\s+ARTIFACT\b|SUPERSEDED\b|STATUS\s+UNKNOWN\b)/i;

// The first paragraph is the row; later paragraphs are free notes such as live captures,
// so a note naming another migration's file cannot trip the one-filename candidate rule.
export function migrationRecordRow(name, text) {
  const version = String(name).match(RECORD_NAME_RE)?.[1];
  if (!version) throw new Error(`${MIGRATION_RECORDS_DIR}/${name} must be named after its migration: <14-digit version>_<name>.md`);
  if (typeof text !== "string") throw new Error(`${MIGRATION_RECORDS_DIR}/${name} is unreadable`);
  const detail = text.trim().split(/\r?\n[ \t]*\r?\n/)[0].split(/\r?\n/).map((line) => line.trim()).join(" ");
  if (!detail) throw new Error(`${MIGRATION_RECORDS_DIR}/${name} is empty`);
  if (!RECORD_STATUS_RE.test(detail)) throw new Error(`${MIGRATION_RECORDS_DIR}/${name} must start with its status; see the folder's README`);
  const sqlName = `\`${name.replace(/\.md$/, ".sql")}\``;
  if (!detail.includes(sqlName)) throw new Error(`${MIGRATION_RECORDS_DIR}/${name} must name ${sqlName} in its first paragraph`);
  // Row 0: new records are referred to by version; row numbers were a collision of their own.
  return `| 0 | ${version} | ${detail} |`;
}

// `records` is [{ name, text }], from whichever source the caller trusts.
export function combineMigrationHistory(frozenText, records) {
  const rows = records
    .filter(({ name }) => name !== MIGRATION_RECORDS_README)
    .map(({ name, text }) => migrationRecordRow(name, text))
    .sort();
  return [frozenText.replace(/\s+$/, ""), "", ...rows, ""].join("\n");
}

export function migrationRecordNames(root) {
  try {
    return readdirSync(path.join(root, ...MIGRATION_RECORDS_DIR.split("/"))).filter((name) => name !== MIGRATION_RECORDS_README);
  } catch (error) {
    // A branch cut before the folder existed simply has no records.
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function readCombinedMigrationHistory(root) {
  const frozen = readFileSync(path.join(root, ...MIGRATION_HISTORY_FILE.split("/")), "utf8");
  const dir = path.join(root, ...MIGRATION_RECORDS_DIR.split("/"));
  return combineMigrationHistory(frozen, migrationRecordNames(root)
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), "utf8") })));
}

// One immutable commit: the frozen file and every record come from the same `rev`.
// `readBlobs(paths)` is the fail-closed batch reader in worktree-awareness-lib.mjs. The
// frozen file goes through it too: at 1.4 MB it overflows a plain `git show` capture.
export function combinedMigrationHistoryAtRev(git, rev, readBlobs) {
  // Not recursive: a subfolder is refused here exactly as it is on disk.
  const paths = git(["ls-tree", "--name-only", rev, "--", `${MIGRATION_RECORDS_DIR}/`])
    .split("\n").map((line) => line.trim()).filter(Boolean);
  const blobs = readBlobs([MIGRATION_HISTORY_FILE, ...paths]);
  const frozen = blobs?.get(normRepoPath(MIGRATION_HISTORY_FILE));
  if (typeof frozen !== "string") throw new Error("migration history is unreadable");
  return combineMigrationHistory(frozen, paths.map((p) => ({ name: p.slice(p.lastIndexOf("/") + 1), text: blobs.get(normRepoPath(p)) })));
}
