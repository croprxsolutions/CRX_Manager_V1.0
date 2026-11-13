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
import { destructiveMigrationCheck } from "./live-testdata-lib.mjs";

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

const isTestPath = (lower) => /(?:^|\/)__tests__\//.test(lower) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(lower);

// null when `name` needs no Sol, otherwise why it does.
export function solRiskPathProblem(name) {
  if (typeof name !== "string" || !name) return "a changed file has no readable name";
  const lower = name.replace(/\\/g, "/").toLowerCase();
  for (const entry of SOL_REQUIRED_PATHS) {
    const rule = entry.toLowerCase();
    if (rule.endsWith("/") ? lower.startsWith(rule) : lower === rule) return `${show(name)} is in a path that always needs Sol (${entry})`;
  }
  // A test or spec is not money code by its name alone (Mason 2026-11-07); listed paths above still cover their tests.
  if (isMoneyPath(name) && !isTestPath(lower)) return `${show(name)} is money or inventory code`;
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

// GitHub's base...head comparison (the pull request's own changes, also when main
// has moved on: "diverged"): { files } or { problem }. `gh(args)` returns stdout;
// each guard passes its budgeted runner. Never throws.
function compareOnGitHub({ baseSha: rawBase, headSha: rawHead, repo, gh }) {
  const repoPath = ghApiRepoPath(repo);
  if (!repoPath) return { problem: "the pull request's repository could not be read" };
  if (!SHA_RE.test(String(rawBase || "")) || !SHA_RE.test(String(rawHead || ""))) return { problem: "the base or head is not a full commit id" };
  const baseSha = String(rawBase).toLowerCase();
  const headSha = String(rawHead).toLowerCase();
  let answer;
  try {
    answer = JSON.parse(String(gh(["api", `${repoPath}/compare/${baseSha}...${headSha}`, "--jq", SOL_RISK_COMPARE_JQ])));
  } catch (error) {
    return { problem: `GitHub's file list could not be read (${show(String(error?.message || error).split(/\r?\n/)[0])})` };
  }
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return { problem: "GitHub's comparison answer is unreadable" };
  if (!["ahead", "diverged"].includes(answer.status) || !Number.isInteger(answer.ahead_by) || answer.ahead_by < 1) {
    return { problem: `GitHub's comparison shows no changes of this pull request's own (status ${show(answer.status)})` };
  }
  if (String(answer.head || "").toLowerCase() !== headSha) return { problem: "GitHub's comparison does not end at the pull request's head" };
  return { files: answer.files };
}

// Asks GitHub for base...head and classifies it. Never throws: any failure is "risky".
export function solRiskOnGitHub(args) {
  const compared = compareOnGitHub(args);
  if (compared.problem) return { risky: true, reason: compared.problem };
  try {
    return classifySolRisk(compared.files);
  } catch (error) {
    return { risky: true, reason: `GitHub's file list could not be classified (${show(String(error?.message || error))})` };
  }
}

// ── staging (Mason on #1363, 2026-11-04) and the staging-first release flow ──
// A merge into either base is a landing on the way to production, so both merge
// guards give staging every gate main has. The Sol proof stays bound to
// origin/main (write-codex-push-proof.mjs), so a merge into staging needs staging
// to already contain the main that Sol reviewed against.
export const GATED_MERGE_BASES = Object.freeze(["main", "staging"]);

// Staging-first: feature work, migrations included, merges into staging, and the
// staging database job applies a migration after the merge. Only the weekly
// release PR (release/next) and hotfix/<name> PRs go into main, and Taha or Mason
// merges them, never an agent; the same for the back-merge of main into staging.
// A back-merge under another branch name: while main has commits staging lacks, a PR into staging
// whose head holds any of them brings main into staging. Two GitHub comparisons, each listing up to 250
// commits: staging...main (main's commits staging lacks) and head...main (those the head lacks). Any of
// the first not in the second is carried by the PR. null when it carries none; otherwise why the merge
// is refused. Never throws: an unreadable, cut-short or unexpected answer refuses (so a branch more than
// 250 of main's commits behind is refused while a back-merge is pending; merging staging in clears it).
// ponytail: matched by commit id, so main's changes squashed or cherry-picked onto a branch (new ids)
// are not seen; the release guard's tree comparison on release/next is the backstop for main itself.
function mainAheadOf(sha, { repoPath, gh }) {
  let answer;
  try {
    answer = JSON.parse(String(gh(["api", `${repoPath}/compare/${sha}...main`, "--jq", "{status: .status, ahead_by: .ahead_by, commits: [.commits[]?.sha]}"])));
  } catch (error) {
    return { problem: `GitHub's main comparison could not be read (${show(String(error?.message || error).split(/\r?\n/)[0])})` };
  }
  if ((answer?.status === "identical" || answer?.status === "behind") && answer?.ahead_by === 0) return { commits: [] };
  if (!["ahead", "diverged"].includes(answer?.status) || !Array.isArray(answer?.commits) || !Number.isInteger(answer?.ahead_by) || answer.ahead_by < 1 || answer.ahead_by !== answer.commits.length) {
    return { problem: "GitHub's list of main's commits is unreadable, unexpected or cut short, so this can't be shown not to be a back-merge (fail closed)" };
  }
  return { commits: answer.commits.map((c) => String(c).toLowerCase()) };
}
export function mainCommitsInPrOnGitHub({ stagingSha, headSha, repo, gh }) {
  const repoPath = ghApiRepoPath(repo);
  if (!repoPath) return "the pull request's repository could not be read";
  if (!SHA_RE.test(String(stagingSha || "")) || !SHA_RE.test(String(headSha || ""))) return "GitHub reported an unusable base commit or head (not a full commit id)";
  const missingFromStaging = mainAheadOf(String(stagingSha).toLowerCase(), { repoPath, gh });
  if (missingFromStaging.problem) return missingFromStaging.problem;
  if (missingFromStaging.commits.length === 0) return null; // main is inside staging: nothing to bring in
  const missingFromHead = mainAheadOf(String(headSha).toLowerCase(), { repoPath, gh });
  if (missingFromHead.problem) return missingFromHead.problem;
  const lacking = new Set(missingFromHead.commits);
  const carried = missingFromStaging.commits.filter((c) => !lacking.has(c));
  return carried.length
    ? `it carries ${carried.length} commit(s) from main that staging doesn't have yet (${carried[0].slice(0, 9)}…), so it is a back-merge, which is Taha's or Mason's to merge. Branch from staging and merge staging (never main) into your branch, or wait for the back-merge`
    : null;
}

// #1838 HIGH 2 (Mason's agents, 2026-11-12): CODEOWNERS names masonwells1, the account the agents share, so an
// agent's approving review would count as a code owner's on a .github/ change (the release guard included).
// Agents never approve a pull request; Taha or Mason does, by hand. null when the text approves nothing.
export function prApprovalProblem(text) {
  const t = String(text || "");
  const ghReview = /\bpr\s+review\b/i.exec(t);
  const cliApprove = ghReview && /\bgh(?:\.exe)?\b/i.test(t) &&
    t.slice(ghReview.index).split(/\s+/).some((w) => /^--approve(?:=|$)/i.test(w) || /^-[A-Za-z]*a[A-Za-z]*$/.test(w));
  const apiApprove = /\bAPPROVE\b/.test(t) && /review/i.test(t);
  return cliApprove || apiApprove
    ? "an agent never approves a pull request: CODEOWNERS names masonwells1, the account the agents share, so an agent's approval would count as a code owner's review (for example on a change to the release guard). Leave approvals to Taha or Mason, by hand"
    : null;
}

// #1838 MED 2 (Mason's agents): once a release migration is applied live ("Applied live:" on the open release PR),
// a staging merge moves release/next under the remaining applies, so staging merges wait until the release merges.
// null when no release is being applied; otherwise why the merge waits. Never throws; an unreadable answer refuses.
export function releaseFreezeProblem({ repo, gh }) {
  const repoPath = ghApiRepoPath(repo);
  if (!repoPath) return "the pull request's repository could not be read";
  const show = (error) => sanitizeForMessage(String(error?.message || error).split(/\r?\n/)[0]);
  let numbers;
  try {
    numbers = JSON.parse(String(gh(["api", `${repoPath}/pulls?base=main&state=open&per_page=100`, "--jq", '[.[] | select(.head.ref == "release/next") | .number]'])));
  } catch (error) {
    return `the open release PR could not be read (${show(error)}), so a release being applied can't be ruled out (fail closed)`;
  }
  if (!Array.isArray(numbers)) return "GitHub's list of open PRs into main was unexpected (fail closed)";
  for (const n of numbers) {
    let bodies;
    try {
      bodies = String(gh(["api", "--paginate", `${repoPath}/issues/${n}/comments?per_page=100`, "--jq", ".[].body"]));
    } catch (error) {
      return `the release PR #${n}'s comments could not be read (${show(error)}) (fail closed)`;
    }
    if (/^\s*Applied live:/m.test(bodies)) {
      return `the release (#${n}) is being applied live, so merges into staging wait until it merges: a staging merge moves release/next under the remaining applies (ship.md › Staging)`;
    }
  }
  return null;
}

// #1838 MED 3 (Mason's agents): a destructive migration (DELETE/TRUNCATE/DROP of data) is Mason's on live. Into
// staging it would merge unflagged and first meet his approval on release day, holding the whole release; so an
// agent never merges one into staging: Taha or Mason does, having looked. null when the PR has none. Fails closed.
export function stagingDestructiveProblem({ repo, gh, number, headSha }) {
  const repoPath = ghApiRepoPath(repo);
  if (!repoPath) return "the pull request's repository could not be read";
  if (!/^[0-9a-f]{40}$/i.test(String(headSha || "")) || !Number.isInteger(Number(number))) return "GitHub reported an unusable PR number or head (fail closed)";
  const show = (error) => sanitizeForMessage(String(error?.message || error).split(/\r?\n/)[0]);
  let files;
  try {
    files = String(gh(["api", "--paginate", `${repoPath}/pulls/${number}/files?per_page=100`, "--jq", '.[] | select(.status != "removed") | .filename']))
      .split(/\r?\n/).filter((f) => /^supabase\/migrations\/[^/]+\.sql$/.test(f));
  } catch (error) {
    return `the PR's files could not be read (${show(error)}) (fail closed)`;
  }
  const found = [];
  for (const f of files) {
    let sql;
    try {
      sql = Buffer.from(String(gh(["api", `${repoPath}/contents/${f}?ref=${headSha}`, "--jq", ".content"])).replace(/\s+/g, ""), "base64").toString("utf8");
    } catch (error) {
      return `${f} could not be read (${show(error)}) (fail closed)`;
    }
    let verdict;
    try { verdict = destructiveMigrationCheck(sql); } catch { verdict = { destructive: true, reason: "it could not be checked" }; }
    if (verdict?.destructive) found.push(`${f.split("/").pop()} (${verdict.reason})`);
  }
  return found.length
    ? `it carries a destructive migration (${found.join(", ")}), which is Mason's on live, so an agent doesn't merge it into staging: Taha or Mason merges it, and Mason approves that exact file before release day`
    : null;
}

// null when an agent may merge this PR (its other gates still apply).
export function agentMergeProblem(base, headRef) {
  if (base === "main") {
    return "an agent never merges into main: only the weekly release PR (release/next) and hotfix/<name> PRs go there, " +
      "and Taha or Mason merges them. Feature PRs, migrations included, target staging (ship.md › Staging)";
  }
  if (base === "staging" && headRef === "main") {
    return "the back-merge (main into staging) is Taha's or Mason's to merge, with \"Create a merge commit\"";
  }
  if (base === "staging" && (headRef === "release/next" || /^hotfix\//.test(String(headRef || "")))) {
    return "release/next and hotfix/<name> go into main, not staging; a PR from either into staging is a mistake: retarget it to main (Taha or Mason merges it)";
  }
  return null;
}
