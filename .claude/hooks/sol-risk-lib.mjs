// SOL ON EVERY CODE CHANGE; NOTES SKIP IT (Mason, 2026-10-29).
//
// Both merge guards (.claude/hooks/pr-merge-guard.mjs and
// .codex/hooks/production-action-guard.mjs) ask this module only after the Sol
// proof is missing AND the documentation-only exemption (sol-exempt-lib.mjs) did
// not apply. A pull request may skip Sol only when every changed file is a notes
// file (`.md`) outside the agent rule documents and review machinery (the lists
// below), and it changes at most SOL_LARGE_PR_LINES lines. Guessing which code is
// "safe" from names or content kept missing real risks (Sol, four rounds on
// 2026-10-29), so any code, configuration or asset change needs Sol.
//
// FAIL CLOSED, like sol-exempt-lib.mjs: any GitHub failure, a comparison that is
// not exactly base..head, a list that may be truncated, an unknown change status
// or an unreadable line count answers "Sol required". A low-risk answer also needs
// every changed file to be a plain file (sol-exempt-lib's tree lookup): a symlink
// or submodule at a harmless path can redirect code (Luna, 2026-10-29).

import { ghApiRepoPath, sanitizeForMessage } from "./codex-push-lib.mjs";
import { SOL_NEVER_EXEMPT_NAMES, SOL_NEVER_EXEMPT_PATHS, treeProblem } from "./sol-exempt-lib.mjs";

const show = (value) => sanitizeForMessage(value, 160);

export const SOL_LARGE_PR_LINES = 500;

// Notes under these folders, and notes with these names, are agent rules or review
// machinery: a change there can loosen the very gates that decide whether Sol is
// needed. The documentation exemption's never lists; folders end in "/", compared
// case-insensitively (Windows checks out either spelling).
export const SOL_ALWAYS_PATHS = SOL_NEVER_EXEMPT_PATHS;
export const SOL_ALWAYS_NAMES = SOL_NEVER_EXEMPT_NAMES;

// Same limit as the documentation exemption: GitHub's compare lists at most 300
// files and says nothing when it stops.
export const SOL_RISK_MAX_FILES = 250;

const STATUSES = Object.freeze(["added", "modified", "removed", "renamed", "copied"]);
const SHA_RE = /^[0-9a-f]{40}$/i;

// null when `name` is low risk, otherwise why it needs Sol.
export function solRiskPathProblem(name) {
  if (typeof name !== "string" || !name) return "a changed file has no readable name";
  const lower = name.replace(/\\/g, "/").toLowerCase();
  for (const entry of SOL_ALWAYS_PATHS) {
    const rule = entry.toLowerCase();
    if (rule.endsWith("/") ? lower.startsWith(rule) : lower === rule) return `${show(name)} is in a path that always needs Sol (${entry})`;
  }
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (SOL_ALWAYS_NAMES.some((entry) => entry.toLowerCase() === base)) return `${show(name)} is agent instructions or dependencies`;
  if (!lower.endsWith(".md")) return `${show(name)} is code, configuration or an asset, not a notes file`;
  return null;
}

// Classify GitHub compare `files` entries ({filename, previous_filename, status, changes}).
export function classifySolRisk(files) {
  if (!Array.isArray(files) || files.length === 0) return { risky: true, reason: "GitHub did not return a readable list of changed files" };
  if (files.length >= SOL_RISK_MAX_FILES) return { risky: true, reason: `${files.length} changed files may be a truncated list` };
  let lines = 0;
  for (const entry of files) {
    if (entry === null || typeof entry !== "object") return { risky: true, reason: "a changed-file entry is unreadable" };
    const status = String(entry.status || "").toLowerCase();
    if (!STATUSES.includes(status)) return { risky: true, reason: `${show(entry.filename || "a file")} has change status ${show(entry.status)}` };
    if (!Number.isInteger(entry.changes) || entry.changes < 0) return { risky: true, reason: `GitHub gave no line count for ${show(entry.filename || "a file")}` };
    lines += entry.changes;
    const names = [entry.filename];
    if (entry.previous_filename !== undefined && entry.previous_filename !== null) names.push(entry.previous_filename);
    else if (status === "renamed" || status === "copied") return { risky: true, reason: `${show(entry.filename || "a file")} was moved but GitHub did not say from where` };
    for (const name of names) {
      const problem = solRiskPathProblem(name);
      if (problem) return { risky: true, reason: problem };
    }
  }
  if (lines > SOL_LARGE_PR_LINES) return { risky: true, reason: `it changes ${lines} lines, over the ${SOL_LARGE_PR_LINES}-line limit` };
  return { risky: false, reason: `${files.length} file(s), ${lines} changed line(s), notes only` };
}

export const SOL_RISK_COMPARE_JQ =
  "{status: .status, ahead_by: .ahead_by, behind_by: .behind_by, merge_base: .merge_base_commit.sha, " +
  "head: (if (.commits | type) == \"array\" and (.commits | length) > 0 then .commits[-1].sha else null end), " +
  "files: (if (.files | type) == \"array\" then [.files[] | {filename, previous_filename, status, changes}] else null end)}";

// Asks GitHub for exactly base...head and classifies it. `gh(args)` returns stdout;
// each guard passes its budgeted runner. Never throws: any failure is "risky".
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
  if (answer.status !== "ahead" || answer.behind_by !== 0 || !Number.isInteger(answer.ahead_by) || answer.ahead_by < 1) {
    return { risky: true, reason: `GitHub's comparison is not a clean base..head diff (status ${show(answer.status)})` };
  }
  if (String(answer.merge_base || "").toLowerCase() !== baseSha) return { risky: true, reason: "GitHub's comparison does not start at the pull request's base" };
  if (String(answer.head || "").toLowerCase() !== headSha) return { risky: true, reason: "GitHub's comparison does not end at the pull request's head" };
  try {
    const verdict = classifySolRisk(answer.files);
    if (verdict.risky) return verdict;
    const problem = treeProblem({ files: answer.files, baseSha, headSha, repoPath, gh });
    return problem ? { risky: true, reason: problem } : verdict;
  } catch (error) {
    return { risky: true, reason: `GitHub's file list could not be classified (${show(String(error?.message || error))})` };
  }
}
