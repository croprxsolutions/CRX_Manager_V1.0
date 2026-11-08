#!/usr/bin/env node

// Machine-checkable reference-doc claims vs repository reality.
// Always-loaded AGENTS.md and CLAUDE.md intentionally contain no volatile counts.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chicagoCalendarStamp,
  freshnessEnforcedFor,
  frozenHistoryProblems,
  manualFreshnessBoundary,
  manualStampProblems,
  migrationIndexProblems,
  recordFileProblems,
  STRICT_INDEX_FROM,
} from "./check-doc-drift-lib.mjs";
import {
  MIGRATION_HISTORY_FILE,
  migrationRecordNames,
  readCombinedMigrationHistory,
} from "../.claude/hooks/migration-records-lib.mjs";
import { validateParkedMigrationCrossReferences } from "../.claude/hooks/worktree-awareness-lib.mjs";

// --pins-only [dir]: only the sha256 pin check, on dir (pre-push passes the pushed commit's files).
// --freshness-only [dir]: only the CURRENT_STATE / KNOWN_ISSUES stamp checks, always enforced;
// pre-push runs it when the push carries migration SQL (PR #1652 found the stale stamp in CI).
const pinsOnly = process.argv.indexOf("--pins-only");
const freshnessOnly = process.argv.indexOf("--freshness-only");
const onlyFlag = Math.max(pinsOnly, freshnessOnly);
const ROOT = onlyFlag >= 0 && process.argv[onlyFlag + 1]
  ? path.resolve(process.argv[onlyFlag + 1])
  : path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const rows = [];
const row = (check, claim, actual, status, note = "") => rows.push({ check, claim: String(claim), actual: String(actual), status, note });
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

const migrations = readdirSync(path.join(ROOT, "supabase", "migrations")).filter((name) => name.endsWith(".sql"));
if (freshnessOnly >= 0) {
  const liveStateDocs = ["CURRENT_STATE.md", "KNOWN_ISSUES.md"];
  manualDocChecks(liveStateDocs);
  liveStateFreshness(liveStateDocs, "FAIL");
  report();
}
const history = readCombinedMigrationHistory(ROOT);

// The CI guard-regression suite's check, run on disk before a push. A Windows checkout holds
// CRLF copies, so hash the LF text git stores; a CRLF hash pin otherwise fails only in CI.
const lfSha256 = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
const pins = validateParkedMigrationCrossReferences(
  migrations.map((name) => `supabase/migrations/${name}`), history, read, lfSha256);
row("candidate records' SQL sha256 pins match the LF migration files", "known", pins.state,
  pins.state === "known" ? "PASS" : "FAIL", pins.reason);
if (pinsOnly >= 0) {
  console.log(`${rows[0].status} ${rows[0].check}${pins.reason ? ` - ${pins.reason}` : ""}`);
  process.exit(pins.state === "known" ? 0 : 1);
}

const routes = read("docs/reference/pages-routes.md");
// Lazy pages are declared in the shared page list; App.tsx keeps the dev gallery's.
const app = read("src/App.tsx") + "\n" + read("src/appPages.tsx");
const databaseSchema = read("docs/reference/database-schema.md");
const schemaRegistry = JSON.parse(read(".claude/schema-registry.json"));

const index = migrationIndexProblems(history,
  migrations.map((name) => name.match(/^(\d{8,14})_/)?.[1]).filter(Boolean));
row(`migration records: exactly one per migration since ${STRICT_INDEX_FROM}`, index.checked,
  index.checked - index.missing.length - index.duplicated.length,
  index.missing.length === 0 && index.duplicated.length === 0 ? "PASS" : "FAIL",
  [index.missing.length ? `no record: ${index.missing.join(", ")}` : "",
    index.duplicated.length ? `more than one record (reconcile into one): ${index.duplicated.join(", ")}` : ""]
    .filter(Boolean).join("; "));

const frozenProblems = frozenHistoryProblems(read(MIGRATION_HISTORY_FILE));
row("migration-history stays frozen", 0, frozenProblems.length,
  frozenProblems.length === 0 ? "PASS" : "FAIL", frozenProblems.join("; "));

const recordFiles = recordFileProblems(migrationRecordNames(ROOT), migrations);
row("migration records match migration files by name", 0, recordFiles.orphans.length + recordFiles.unrecorded.length,
  recordFiles.orphans.length + recordFiles.unrecorded.length === 0 ? "PASS" : "FAIL",
  [recordFiles.orphans.length ? `no matching .sql: ${recordFiles.orphans.join(", ")}` : "",
    recordFiles.unrecorded.length ? `no record file: ${recordFiles.unrecorded.join(", ")}` : ""]
    .filter(Boolean).join("; "));

const missingMigrations = migrations.filter((filename) => {
  const base = filename.replace(/\.sql$/, "");
  const match = base.match(/^(\d{8,14})_(.+)$/);
  return match ? !history.includes(match[1]) && !history.includes(match[2]) : !history.includes(base);
});
row("all migrations indexed", migrations.length, migrations.length - missingMigrations.length,
  missingMigrations.length === 0 ? "PASS" : "FAIL",
  missingMigrations.length ? `missing: ${missingMigrations.slice(0, 15).join(", ")}` : "");

const routeHeader = routes.match(/^#\s*Pages & Routes Reference\s*\((\d+)\s+pages,\s*(\d+)\s+routes\)/im);
const pageClaim = routeHeader?.[1];
const routeClaim = routeHeader?.[2];
const lazyCount = (app.match(/\blazy\s*\(/g) || []).length;
const routeRows = routes.split(/\r?\n/).filter((line) => /^\| `\//.test(line)).length;
row("pages-routes page count", pageClaim ?? "missing", lazyCount,
  Number(pageClaim) === lazyCount ? "PASS" : "FAIL");
row("pages-routes route count", routeClaim ?? "missing", routeRows,
  Number(routeClaim) === routeRows ? "PASS" : "FAIL");

row("live DB migration count", "live", "skipped", "SKIP",
  "plain Node check is local-only; verify via the read-only Supabase connector when current live state matters");

// Returns is a high-risk money/inventory lifecycle row. Keep its concise doc
// entry tied to the live-generated registry so stale invented fields or a
// missing terminal status cannot survive an ordinary docs check.
const returnsDocLine = databaseSchema.split(/\r?\n/).find((line) => line.startsWith("- `returns` -")) || "";
const returnsColumns = new Set(schemaRegistry.columns?.returns || []);
const returnsStatuses = schemaRegistry.status_enums?.["returns.status"];
const hasReturnsStatuses = Array.isArray(returnsStatuses) && returnsStatuses.length > 0;
const documentedStatuses = (returnsDocLine.match(/\bstatus:\s*([^,]+)/)?.[1] || "")
  .split("/")
  .map((status) => status.trim())
  .filter(Boolean);
const statusMatches = hasReturnsStatuses
  && documentedStatuses.length === returnsStatuses.length
  && documentedStatuses.every((status, index) => status === returnsStatuses[index]);
const documentedStatus = hasReturnsStatuses
  ? `status: ${returnsStatuses.join("/")}`
  : "status: <missing from schema registry>";
const requiredReturnsColumns = [
  "reason", "reason_notes", "total_credit_cents", "credit_invoice_id",
  "cancelled_at", "cancelled_by", "cancellation_reason", "credited_by",
];
const missingReturnsColumns = requiredReturnsColumns.filter(
  (column) => !returnsColumns.has(column) || !new RegExp(`\\b${column}\\b`).test(returnsDocLine),
);
const staleReturnsColumns = ["return_type", "reason_category"].filter(
  (column) => !returnsColumns.has(column) && new RegExp(`\\b${column}\\b`).test(returnsDocLine),
);
row("Returns schema reference", documentedStatus, returnsDocLine || "missing",
  statusMatches && missingReturnsColumns.length === 0 && staleReturnsColumns.length === 0 ? "PASS" : "FAIL",
  [
    !hasReturnsStatuses ? "missing live status enum: returns.status" : "",
    hasReturnsStatuses && !statusMatches ? "documented status values do not exactly match live returns.status" : "",
    missingReturnsColumns.length ? `missing live columns: ${missingReturnsColumns.join(", ")}` : "",
    staleReturnsColumns.length ? `stale non-columns: ${staleReturnsColumns.join(", ")}` : "",
  ].filter(Boolean).join("; "));

// Every hook wired in settings.json must be documented in agent-guardrails.md,
// so the doc future agents are routed to can never silently fall behind the guard net.
// Read only the `hooks` block: since 2026-09-26 `permissions.ask` also names hook
// files and libraries (Mason is asked before a production gate is edited), and a
// permission rule is not wiring. Falls back to the raw text if it does not parse.
const settingsRaw = read(".claude/settings.json");
let settingsHooksText = settingsRaw;
try { settingsHooksText = JSON.stringify(JSON.parse(settingsRaw).hooks ?? JSON.parse(settingsRaw)); } catch { /* raw */ }
const guardrails = read("docs/reference/agent-guardrails.md");
const wiredHooks = [...new Set(
  [...settingsHooksText.matchAll(/\.claude[\\/]hooks[\\/]([\w.-]+\.mjs)/g)].map((m) => m[1])
)];
const undocumentedHooks = wiredHooks.filter((name) => !guardrails.includes(name));
row("wired hooks documented in agent-guardrails.md", wiredHooks.length, wiredHooks.length - undocumentedHooks.length,
  undocumentedHooks.length === 0 ? "PASS" : "FAIL",
  undocumentedHooks.length ? `undocumented: ${undocumentedHooks.join(", ")}` : "");

// Operating-manual docs must exist and carry a "Last verified:" stamp so staleness is visible.
manualDocChecks([
  "ARCHITECTURE.md", "DECISION_LOG.md", "KNOWN_ISSUES.md",
  "CURRENT_STATE.md", "OWNER_PLAYBOOK.md", "AGENT_ONBOARDING.md",
]);
function manualDocChecks(manualDocs) {
  for (const doc of manualDocs) {
    const rel = `docs/manual/${doc}`;
    if (!existsSync(path.join(ROOT, rel))) {
      row(`manual doc ${doc}`, "exists", "missing", "FAIL");
      continue;
    }
    const stamped = /^\*{0,2}Last verified:?\*{0,2}\s*\d{4}-\d{2}-\d{2}/m.test(read(rel));
    row(`manual doc ${doc}`, "Last verified stamp", stamped ? "present" : "missing",
      stamped ? "PASS" : "FAIL");
    const stampProblems = manualStampProblems(read(rel));
    row(`manual doc ${doc} stamp line`, `one line, at most 200 characters`, stampProblems.length ? "no" : "yes",
      stampProblems.length ? "FAIL" : "PASS", stampProblems.join("; "));
}
}

// HARD freshness gate (2026-07-16 scaffolding review): the two docs that describe
// LIVE state must not claim a "Last verified" date OLDER than the newest migration
// on disk, capped at today's America/Chicago calendar date. A future stamp cannot
// truthfully force a future verification claim before that business date arrives;
// on and after that date the normal freshness rule applies. A migration dated after
// the stamp means the schema/behavior changed
// after the doc was last checked — so its freshness promise is stale. This is the
// forcing function the manual layer lacked: within 48h of shipping, KNOWN_ISSUES
// listed an applied-live fix as "parked" while claiming same-day re-verification.
// Bump the stamp ONLY after actually re-reading the doc against live state.
// Files changed since the base (CI passes the PR base or push-before sha). An
// unreadable base enforces, so a broken diff can never silence the gate.
const freshnessBase = process.env.DOCS_FRESHNESS_BASE || "origin/main";
let staleStatus = "FAIL";
try {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  const changed = git("diff", "--name-only", "--no-renames", git("merge-base", freshnessBase, "HEAD"), "HEAD").split(/\r?\n/).filter(Boolean);
  if (!freshnessEnforcedFor(changed)) staleStatus = "WARN";
} catch { /* keep FAIL */ }
liveStateFreshness(["CURRENT_STATE.md", "KNOWN_ISSUES.md"], staleStatus);
function liveStateFreshness(docs, staleStatus) {
  const newestMigDate = migrations
    .map((name) => name.match(/^(\d{8})/)?.[1])
    .filter(Boolean)
    .sort()
    .at(-1); // YYYYMMDD of the newest migration
  const todayChicago = chicagoCalendarStamp();
  const freshnessDate = manualFreshnessBoundary(newestMigDate, todayChicago);
  for (const doc of docs) {
    const rel = `docs/manual/${doc}`;
    if (!existsSync(path.join(ROOT, rel))) continue; // the "stamp present" check above already failed this
    const m = read(rel).match(/Last verified:?\*{0,2}\s*(\d{4})-(\d{2})-(\d{2})/);
    if (!m) continue; // no parseable stamp — already a FAIL above
    const stampDate = `${m[1]}${m[2]}${m[3]}`; // YYYYMMDD
    const fresh = !freshnessDate || stampDate >= freshnessDate;
    row(`manual freshness ${doc}`, `stamp >= freshness boundary (${freshnessDate ?? "none"})`, `stamp ${stampDate}`,
      fresh ? "PASS" : staleStatus,
      fresh ? "" : `migration ${newestMigDate} requires freshness through ${freshnessDate} (America/Chicago today ${todayChicago}) but this doc is older — re-verify it against live state (list_migrations / the live schema), correct anything stale, THEN bump the stamp. Do not bump the date without re-reading.${staleStatus === "WARN" ? " (warning only: this change adds no migration and leaves both docs alone)" : ""}`);
}

}

report();
function report() {
  console.log("check-doc-drift");
  for (const item of rows) {
    console.log(`${item.status.padEnd(4)} ${item.check}: claim=${item.claim} actual=${item.actual}${item.note ? ` - ${item.note}` : ""}`);
}
const failed = rows.filter((item) => item.status === "FAIL" || item.status === "ERROR");
if (failed.length > 0) {
  console.log(`FAIL - ${failed.length} reference-doc drift check(s) failed.`);
  process.exit(1);
}
console.log("PASS - reference documentation matches repository reality.");
process.exit(0);
}
