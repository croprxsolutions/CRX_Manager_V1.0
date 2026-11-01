// SOL WHERE A MISTAKE COSTS MOST (Mason, 2026-10-30; cut to three areas 2026-11-01).
//
// Both merge guards (.claude/hooks/pr-merge-guard.mjs and
// .codex/hooks/production-action-guard.mjs) ask this module when no Sol proof was
// found. A pull request needs Sol when it touches the database, logins and
// permissions, or money and inventory code (the list below; readable copy with the
// reasons: docs/reference/sol-required-paths.md). Everything else, dependencies,
// deployment files and the guards themselves included, relies on CI.
//
// FAIL CLOSED: any GitHub failure, a comparison that does not end at the head, a
// list that may be truncated or an unknown change status answers "Sol required".

import { isMoneyPath } from "./codex-bot-review-lib.mjs";
import { ghApiRepoPath, sanitizeForMessage } from "./codex-push-lib.mjs";

const show = (value) => sanitizeForMessage(value, 160);

// Folders end in "/". All compared case-insensitively from the repository root
// (Windows checks out either spelling).
export const SOL_REQUIRED_PATHS = Object.freeze([
  "supabase/",
  "src/components/auth/",
  "src/contexts/AuthContext.tsx",
  "src/lib/db.ts",
  "src/lib/pagePermissions.ts",
  "src/App.tsx",
  "src/appPages.tsx",
  "src/routeBaseline.json",
  "src/pages/SettingsPage.tsx",
  "src/pages/MonthEndClose.tsx",
  "src/pages/Rebates.tsx",
  "src/pages/Receiving.tsx",
  "src/pages/Integrity.tsx",
  "src/pages/LotTrace.tsx",
  "src/pages/CustomerTransactionReview.tsx",
  "src/pages/OfflineWorkReview.tsx",
  "src/pages/JobDetail.tsx",
  "src/pages/ProductDetail.tsx",
  "src/pages/Products.tsx",
  "src/pages/OfficeCockpit.tsx",
  "src/pages/Reports.tsx",
  "src/pages/ApplicationServiceDetail.tsx",
  "src/pages/CustomerDetail.tsx",
  "src/lib/offlineSync.ts",
  "src/lib/offlineQueue.ts",
  "src/lib/jobChemicalPayload.ts",
  "src/lib/recipeHelpers.ts",
  "src/hooks/useGuardrails.ts",
  "src/components/products/BulkProductImport.tsx",
  "src/components/products/bulkProductImportSafety.ts",
  "src/components/receiving/",
  "src/components/integrity/",
  "src/components/field-app/",
]);

// GitHub's compare lists at most 300 files and says nothing when it stops.
export const SOL_RISK_MAX_FILES = 250;

const STATUSES = Object.freeze(["added", "modified", "removed", "renamed", "copied"]);
const SHA_RE = /^[0-9a-f]{40}$/i;

// null when `name` needs no Sol, otherwise why it does.
export function solRiskPathProblem(name) {
  if (typeof name !== "string" || !name) return "a changed file has no readable name";
  const lower = name.replace(/\\/g, "/").toLowerCase();
  for (const entry of SOL_REQUIRED_PATHS) {
    const rule = entry.toLowerCase();
    if (rule.endsWith("/") ? lower.startsWith(rule) : lower === rule) return `${show(name)} is in a path that always needs Sol (${entry})`;
  }
  if (isMoneyPath(name)) return `${show(name)} is money or inventory code`;
  return null;
}

// Classify GitHub compare `files` entries ({filename, previous_filename, status}).
export function classifySolRisk(files) {
  if (!Array.isArray(files) || files.length === 0) return { risky: true, reason: "GitHub did not return a readable list of changed files" };
  if (files.length >= SOL_RISK_MAX_FILES) return { risky: true, reason: `${files.length} changed files may be a truncated list` };
  for (const entry of files) {
    if (entry === null || typeof entry !== "object") return { risky: true, reason: "a changed-file entry is unreadable" };
    const status = String(entry.status || "").toLowerCase();
    if (!STATUSES.includes(status)) return { risky: true, reason: `${show(entry.filename || "a file")} has change status ${show(entry.status)}` };
    const names = [entry.filename];
    if (entry.previous_filename !== undefined && entry.previous_filename !== null) names.push(entry.previous_filename);
    else if (status === "renamed" || status === "copied") return { risky: true, reason: `${show(entry.filename || "a file")} was moved but GitHub did not say from where` };
    for (const name of names) {
      const problem = solRiskPathProblem(name);
      if (problem) return { risky: true, reason: problem };
    }
  }
  return { risky: false, reason: `${files.length} file(s), none on the Sol list` };
}

export const SOL_RISK_COMPARE_JQ =
  "{status: .status, ahead_by: .ahead_by, " +
  "head: (if (.commits | type) == \"array\" and (.commits | length) > 0 then .commits[-1].sha else null end), " +
  "files: (if (.files | type) == \"array\" then [.files[] | {filename, previous_filename, status}] else null end)}";

// Asks GitHub for base...head (the pull request's own changes, also when main has
// moved on: "diverged") and classifies it. `gh(args)` returns stdout; each guard
// passes its budgeted runner. Never throws: any failure is "risky".
export function solRiskOnGitHub({ baseSha: rawBase, headSha: rawHead, repo, gh }) {
  const repoPath = ghApiRepoPath(repo);
  if (!repoPath) return { risky: true, reason: "the pull request's repository could not be read" };
  if (!SHA_RE.test(String(rawBase || "")) || !SHA_RE.test(String(rawHead || ""))) return { risky: true, reason: "the base or head is not a full commit id" };
  const baseSha = String(rawBase).toLowerCase();
  const headSha = String(rawHead).toLowerCase();
  let answer;
  try {
    answer = JSON.parse(String(gh(["api", `${repoPath}/compare/${baseSha}...${headSha}`, "--jq", SOL_RISK_COMPARE_JQ])));
  } catch (error) {
    return { risky: true, reason: `GitHub's file list could not be read (${show(String(error?.message || error).split(/\r?\n/)[0])})` };
  }
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return { risky: true, reason: "GitHub's comparison answer is unreadable" };
  if (!["ahead", "diverged"].includes(answer.status) || !Number.isInteger(answer.ahead_by) || answer.ahead_by < 1) {
    return { risky: true, reason: `GitHub's comparison shows no changes of this pull request's own (status ${show(answer.status)})` };
  }
  if (String(answer.head || "").toLowerCase() !== headSha) return { risky: true, reason: "GitHub's comparison does not end at the pull request's head" };
  try {
    return classifySolRisk(answer.files);
  } catch (error) {
    return { risky: true, reason: `GitHub's file list could not be classified (${show(String(error?.message || error))})` };
  }
}
