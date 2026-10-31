#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  contentIsRisky,
  createHardGateBudget,
  expandNestedCommands,
  extractPatchDestinations,
  ghApiMergeRequest,
  ghApiIsResolveReviewThreadOnly,
  ghApiIsReviewThreadReply,
  ghApiMutates,
  hardGateBudgetDenial,
  mentionsMergePullRequest,
  nestedTooDeepDenial,
  rawMergeEndpointCount,
  hookDeadlineMs,
  splitCommandSegments,
  ghMergeRequest,
  gitPushCwd,
  isGitPush,
  mainPushSource,
  mcpMergeRequest,
  mergeRequestKey,
  nativePatchEnvelope,
  parseNativePatch,
  ENFORCEMENT_SURFACE_PATH_RE,
  proofValid,
  proofValidForMerge,
  pullRequestReviewBlocked,
  pushContextIsAmbiguous,
  pushIsForced,
  pushUsesBulkMode,
  pullRequestChecksGreen as sharedPullRequestChecksGreen,
  reviewProofPathMentioned,
  reviewStateDirectoryMentioned,
  riskyFiles,
  pushParseCostExceeded,
  PUSH_PARSE_COST_BUDGET,
  MAX_INSPECTABLE_COMMAND_LENGTH,
  MAX_HOOK_INPUT_LENGTH,
  readHookInputBounded,
} from "../../.claude/hooks/codex-push-lib.mjs";
import { isKnownSweepQuery, stripCommentsQuoteAware } from "../../.claude/hooks/live-testdata-lib.mjs";
import {
  CODEX_THREADS_QUERY,
  CODEX_THREAD_PAGE_SIZE,
  codexBotFindingsDenial,
  coderabbitFindingsDenial,
  coderabbitRequirementUnreadableDenial,
  coderabbitReviewMissingDenial,
  coderabbitThreadCount,
  coderabbitUnreadableDenial,
  collectCodexThreads,
  evaluateCodexBotReview,
  readCodeRabbitRequirement,
} from "../../.claude/hooks/codex-bot-review-lib.mjs";
import {
  readTeammateComments,
  teammateCommentsDenial,
  teammateCommentsTruncatedDenial,
  teammateCommentsUnreadableDenial,
} from "../../.claude/hooks/teammate-comments-lib.mjs";
import { solRiskOnGitHub } from "../../.claude/hooks/sol-risk-lib.mjs";
import { coderabbitSkipNotice, findCodeRabbitSkip, skipPullRequestFor, skipStateDirs } from "../../.claude/hooks/coderabbit-skip-lib.mjs";
import { literalReadOnlySearch } from "../../.claude/hooks/read-only-search-lib.mjs";

// Sol HIGH finding (2026-08-14, write-scope review): with the Supabase connector
// write-enabled, ANY mutating Supabase tool Codex can reach is a route to
// production schema/data changes that bypasses the migration gates. Supabase
// tools are therefore governed by an EXACT read-only allowlist — a tool this
// guard has never heard of fails closed instead of failing open. execute_sql is
// the one deliberate exception: it passes through to the content gate below,
// which only admits clearly read-only SQL.
// CodeRabbit follow-up: the app connector's MCP prefix is a UUID, not the
// literal `supabase` server name, so the allowlist matches that known UUID
// too. If the connector is ever re-created under a new UUID, its known
// leaves stay covered by the suffix blocklist and the execute_sql content
// gate below; add the new UUID here so unknown leaves fail closed again.
// Codex-review follow-up: the built-in codex_apps/supabase channel (the one
// actually serving Codex traffic per docs/manual/KNOWN_ISSUES.md) normalizes
// to app-style names with a SINGLE underscore (mcp__codex_apps__supabase_<leaf>),
// so `_{1,2}` accepts both naming forms — same dual-form handling as
// GITHUB_TOOL below.
const SUPABASE_TOOL_RE = /(?:^|__)(?:supabase|50e15046-cf2c-49da-b8df-ceef27768f63)_{1,2}([a-z0-9_]+)$/i;
const SUPABASE_READ_ONLY_TOOLS = new Set([
  "generate_typescript_types", "get_advisors", "get_cost", "get_edge_function",
  "get_logs", "get_organization", "get_project", "get_project_url",
  "get_publishable_keys", "list_branches", "list_edge_functions",
  "list_extensions", "list_migrations", "list_organizations", "list_projects",
  "list_tables", "query_logs", "search_docs",
]);
// Defense-in-depth for connectors whose MCP prefix is NOT the literal
// `supabase` server name (e.g. UUID-named app connectors): the known mutating
// lifecycle leaves stay blocked by suffix regardless of prefix. Mirrors the
// branch/project lifecycle deny set in .claude/hooks/autopilot-lib.mjs.
const LIVE_TOOL_ACTIONS = /(?:apply_migration|deploy_edge_function|delete_branch|merge_branch|reset_branch|rebase_branch|create_branch|create_project|pause_project|restore_project|confirm_cost)$/i;
const GITHUB_MERGE_TOOL = /merge_pull_request$/i;
// Both MCP naming (mcp__github__create_file) and app naming
// (mcp__codex_apps__github_create_file) — Codex round-5.
const GITHUB_TOOL = /(?:^|__)github_{1,2}/i;
const NODE_REPL_TOOL = /(?:^|__)node[_-]?repl(?:__|$)/i;
// `codex-bot-review-lib` joined this list 2026-09-02 (PR #563, Codex HIGH on
// that PR's own exact-head review). Both merge guards IMPORT it at startup, so
// it is in the same trust class as codex-push-lib: code that runs before the
// guard sees a single byte of input. Leaving it off the list meant an
// apply_patch at that path returned blocked:false while the identical patch
// against production-action-guard.mjs returned blocked:true — and because the
// module executes at import time, an allowed edit could keep its exports intact
// while terminating or subverting the hook at startup. Silent completion means
// ALLOW, so that would bypass every production-action restriction, not merely
// the Codex App review check this PR added.
// `coderabbit-skip-lib` joined 2026-10-22 likewise: imported at startup, and it
// decides whether Mason waived a money PR's CodeRabbit review (Codex App P1, #1035).
// `read-only-search-lib` joined 2026-10-27: imported at startup, and it decides
// which shell commands skip the checks below as plain searches.
// `sol-risk-lib` joined 2026-10-29: imported at startup, and it decides whether a
// merge needs Sol at all.
// `session-context-reminder` joined 2026-10-30: not imported, but its output is the
// rules every later Codex session starts from.
const PROTECTED_HARNESS_SOURCE = String.raw`(?:\.claude[\\/]hooks[\\/](?:codex-push-(?:guard|lib)|codex-bot-review-lib|review-proof-guard|live-testdata-lib|sol-risk-lib|coderabbit-skip-lib|teammate-comments-lib|read-only-search-lib|app-repo-identity|session-context-reminder)\.mjs|\.codex[\\/]hooks[\\/](?:production-action-guard|codex-hook-adapter)\.mjs|scripts[\\/](?:run-claude-review|write-codex-push-proof|write-apply-proofs|overnight-codex-gate|apply-live-testdata-maintenance-20260812)\.mjs|package\.json|\.claude[\\/]settings\.json|\.codex[\\/]hooks\.json)`;
const PROTECTED_HARNESS_PATH_RE = new RegExp(String.raw`(?:^|[\\/])${PROTECTED_HARNESS_SOURCE}$`, "i");
const PROTECTED_HARNESS_FRAGMENT_RE = new RegExp(`(?<![\\w.-])${PROTECTED_HARNESS_SOURCE}(?![\\w.-])`, "i");
// The same set, spelled out, for the glob matcher below: a wildcard token has
// to be tested against concrete names, and a regex cannot be enumerated. The
// test file pins that every entry matches PROTECTED_HARNESS_PATH_RE and that the
// count equals the alternatives in PROTECTED_HARNESS_SOURCE, so the two cannot
// drift apart silently.
export const PROTECTED_HARNESS_FILES = Object.freeze([
  ".claude/hooks/codex-push-guard.mjs",
  ".claude/hooks/codex-push-lib.mjs",
  ".claude/hooks/codex-bot-review-lib.mjs",
  ".claude/hooks/review-proof-guard.mjs",
  ".claude/hooks/live-testdata-lib.mjs",
  ".claude/hooks/sol-risk-lib.mjs",
  ".claude/hooks/coderabbit-skip-lib.mjs",
  ".claude/hooks/teammate-comments-lib.mjs",
  ".claude/hooks/read-only-search-lib.mjs",
  // Imported by codex-push-lib and coderabbit-skip-lib, so it loads at guard
  // startup too (Codex App P1 on #1149).
  ".claude/hooks/app-repo-identity.mjs",
  ".claude/hooks/session-context-reminder.mjs",
  ".codex/hooks/production-action-guard.mjs",
  ".codex/hooks/codex-hook-adapter.mjs",
  "scripts/run-claude-review.mjs",
  "scripts/write-codex-push-proof.mjs",
  "scripts/write-apply-proofs.mjs",
  "scripts/overnight-codex-gate.mjs",
  "scripts/apply-live-testdata-maintenance-20260812.mjs",
  "package.json",
  ".claude/settings.json",
  ".codex/hooks.json",
]);
const MAINTENANCE_PRODUCER = "scripts/apply-live-testdata-maintenance-20260812.mjs";
export function maintenanceProducerCommandMentioned(command) {
  const compact = String(command || "")
    .toLowerCase()
    .replace(/[\s\\/"'`^]/g, "");
  return compact.includes("apply-live-testdata-maintenance-20260812.mjs");
}

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

// Resolve `.` and `..` segments and unify separators WITHOUT touching disk, so
// a protected path cannot be spelled around.
//
// Codex HIGH, PR #563 round 2: `.claude/hooks/codex-bot-review-lib.mjs` was
// blocked while `.claude/hooks/../hooks/codex-bot-review-lib.mjs` — the same
// file, confirmed with Resolve-Path — was ALLOWED, through Write, a realistic
// apply_patch payload, and PowerShell. The matcher compared raw strings, so any
// dot-segment detour defeated it. This was never specific to the module that
// review was about: every entry in PROTECTED_HARNESS_SOURCE had the same hole.
//
// Purely textual on purpose. The guard must reach the same verdict whether or
// not the path exists yet, and a filesystem resolve would also follow symlinks
// into a different answer than the one the tool will actually write to.
export function canonicalizeGuardPath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  // A Windows drive prefix is DROPPED, not preserved. `C:.claude/hooks/x.mjs`
  // is drive-relative — no slash after the colon — so keeping the prefix left
  // `.claude` preceded by `:`, which the protected-path anchor (`^` or a
  // separator) never matches. Codex round 3 wrote to exactly that spelling and
  // was allowed. Dropping the drive is deliberately over-inclusive: a path on
  // another drive that happens to end in a protected suffix is refused. For a
  // deny-guard that is the safe direction, and no legitimate workflow needs to
  // write a harness file through a drive-qualified alias.
  const driveMatch = /^([A-Za-z]:)(\/?)/.exec(raw);
  const rooted = driveMatch ? driveMatch[2] === "/" : raw.startsWith("/");
  const body = driveMatch ? raw.slice(driveMatch[0].length) : raw;
  const segments = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Above a rooted path there is nowhere to go, so drop it. In a relative
      // path a leading `..` is meaningful and is kept.
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!rooted) segments.push("..");
      continue;
    }
    // Windows IGNORES trailing periods and spaces in a path segment: the Win32
    // path normalizer strips them before the file system sees the name, so
    // `.claude./hooks/x.mjs`, `.claude/hooks./x.mjs` and `.claude/hooks/x.mjs.`
    // all open `.claude/hooks/x.mjs` (probe-confirmed with Get-Item on every
    // spelling, 2026-09-03). Codex round 7 wrote through exactly those aliases
    // and was allowed, because this canonicalizer only knew about `.`/`..` and
    // drive prefixes. Windows trims only ONE trailing period from an interior
    // segment but every trailing period and space from the last; stripping all
    // of them from every segment is deliberately over-inclusive, which is the
    // safe direction for a deny-guard. A segment that is NOTHING but periods
    // and spaces (`...`, `.. `, `. .`) is dropped outright: Windows refuses to
    // resolve those at all (probe-confirmed), and on POSIX they are literal
    // names, never a parent hop — so dropping one can only shorten the path
    // toward a protected suffix, again the deny direction. The exact `.`/`..`
    // spellings are handled ABOVE this line and never reach the strip.
    const trimmed = segment.replace(/[. ]+$/, "");
    if (trimmed === "") continue;
    segments.push(trimmed);
  }
  return (rooted ? "/" : "") + segments.join("/");
}

function protectedHarnessPathMentioned(value) {
  const raw = String(value || "").trim();
  // Test the raw spelling first so behaviour is unchanged for ordinary paths,
  // then the canonical one so detours cannot buy a different answer.
  return PROTECTED_HARNESS_PATH_RE.test(raw) || PROTECTED_HARNESS_PATH_RE.test(canonicalizeGuardPath(raw));
}

// A candidate path as the file system will see it: joined onto the working
// directory the tool will run in, unless it is already rooted. Codex round 11
// (HIGH): a `workdir` of `.claude/hooks` turned a bare `codex-bot-review-lib.mjs`
// into the protected module while every matcher saw only the basename.
// Purely textual, like canonicalizeGuardPath — the join never touches disk.
export function joinedWithWorkdir(candidate, workdir) {
  const raw = String(candidate || "").trim();
  const base = String(workdir || "").trim().replace(/\\/g, "/");
  if (!raw || !base) return raw;
  if (/^(?:[A-Za-z]:)?[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw)) return raw; // rooted or drive-qualified already
  return `${base.replace(/\/+$/, "")}/${raw}`;
}

export const CHANGES_DIRECTORY_RE = /(?:^|[;&|\r\n()]|\s)(?:cd(?:\s+\/d)?|chdir|pushd|set-location)\s+/i;
// The mutating verbs the shell-mutation gate recognises. Kept as one source so
// its checks cannot drift apart.
// cmd.exe's own verbs (copy, move, xcopy, robocopy, mklink) joined the list in
// Codex round 10: the list knew PowerShell's and POSIX's spellings of "write a
// file" but not cmd's, so `copy evil.mjs <protected>` was not a mutation at all.
const SHELL_MUTATION_RE = /(?:>|\b(?:set-content|add-content|out-file|new-item|set-item|clear-item|clear-content|set-itemproperty|new-itemproperty|remove-itemproperty|rename-itemproperty|clear-itemproperty|set-acl|remove-item|move-item|copy-item|rename-item|ac|clc|cli|clp|cpi|mi|ni|ri|ren|rni|sc|si|sp|sac|rm|mv|cp|del|erase|copy|move|xcopy|robocopy|mklink|sed\s+-i|perl\s+-pi|apply_patch)\b)/i;
// scripts/apply-migration-file.mjs mutates the LIVE database. It was added
// 2026-08-24 as a gated door for migrations too large to transmit through
// apply_migration, and Codex's review of that PR caught that the new spelling
// reached production while every OTHER migration path was blocked here (P1).
// Blocked outright rather than only on `--confirm`: matching a flag invites
// quoting games, and Codex has no need for even the dry run.
// Matched across quote-stripped and backslash-dropped views so `apply"-"migration-file`
// and `apply\-migration-file` — which the shell runs identically — cannot slip past.
const LIVE_APPLY_SCRIPT_RE = /apply-migration-file(?:\.mjs)?\b/i;
function liveApplyScriptMentioned(command) {
  const base = String(command || "").replace(/[\\`]\r?\n/g, "");
  const views = [
    base,
    base.replace(/["']/g, ""),
    base.replace(/\\(.)/g, "$1"),
    base.replace(/["']/g, "").replace(/\\(.)/g, "$1"),
  ];
  return views.some((v) => LIVE_APPLY_SCRIPT_RE.test(v));
}

// What a blocked harness change should do instead. (The old text pointed at a
// maintenance script that was retired on 2026-09-05.)
export const HARNESS_REPAIR_PATH =
  "Codex cannot change these files, because they are how the review and merge gates are enforced. " +
  "To repair one, hand the change to a Claude session: it edits the file on a feature branch and ships it " +
  "through the normal reviewed pull request in .claude/commands/ship.md (Luna rounds, then a fresh Sol " +
  "review of the exact head before merge).";

function denied(reason) {
  return { blocked: true, reason };
}

export function isClearlyReadOnlySql(sql) {
  // Comment stripping MUST be quote-aware (Codex round-4): naive comment
  // removal first lets `SELECT '--'; DELETE …` hide the mutation inside what
  // looks like a comment. stripCommentsQuoteAware (shared, 5 adversarial
  // rounds on the migration guard) removes comments while leaving '…', "…",
  // and $tag$…$tag$ contents intact; string literals are then blanked.
  const withoutComments = stripCommentsQuoteAware(String(sql || ""));
  const value = normalize(
    withoutComments
      .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''")
      .replace(/'(?:''|[^'])*'/g, "''")
  );
  const statement = value.replace(/;+\s*$/, "");
  if (statement.includes(";")) return false;
  if (!/^(?:select|with|explain|show)\b/i.test(value)) return false;
  // `into` covers PostgreSQL's `SELECT ... INTO new_table`, which CREATES and
  // populates a table from inside a statement that begins with SELECT — the
  // one write form the leading-keyword check alone cannot see (Codex P1,
  // 2026-08-14). String literals are blanked before this test, and bare
  // `into` is a reserved word, so it cannot appear in read-only SELECTs.
  if (/\b(?:insert|update|delete|merge|truncate|alter|drop|create|grant|revoke|comment|vacuum|reindex|cluster|refresh|call|copy|set|reset|notify|listen|unlisten|lock|discard|execute|perform|into)\b/i.test(value)) {
    return false;
  }

  // SELECT can invoke mutating SECURITY DEFINER RPCs. Allow only a narrow set
  // of known read-only PostgreSQL built-ins; every application/custom function
  // call fails closed and must use a purpose-built read-only connector/tool.
  const readOnlyFunctions = new Set([
    "abs", "age", "array_agg", "array_length", "avg", "cardinality", "ceil", "ceiling",
    "char_length", "coalesce", "col_description", "concat", "concat_ws", "count",
    "current_setting", "date_part", "date_trunc", "extract", "floor", "format", "greatest",
    "json_agg", "json_array_length", "json_build_object", "json_object_agg", "json_typeof",
    "jsonb_agg", "jsonb_array_length", "jsonb_build_object", "jsonb_object_agg", "jsonb_typeof",
    "least", "length", "lower", "ltrim", "max", "min", "now", "nullif", "obj_description",
    "pg_get_constraintdef", "pg_get_expr", "pg_get_functiondef", "pg_get_indexdef", "pg_get_viewdef",
    "pg_typeof", "quote_ident", "quote_literal", "regexp_match", "regexp_matches", "regexp_replace",
    "round", "rtrim", "split_part", "sqrt", "string_agg", "substring", "sum", "to_char", "to_date",
    "to_json", "to_jsonb", "to_regclass", "to_regprocedure", "trim", "upper", "version",
  ]);
  const structuralWords = new Set([
    "and", "as", "by", "case", "else", "exists", "filter", "from", "group",
    "having", "in", "join", "not", "on", "or", "order", "over", "select",
    "then", "values", "when", "where",
  ]);
  if (/"(?:[^"]|"")+"\s*\(/.test(value)) return false;
  const functionRe = /\b(?:([a-z_][\w$]*)\.)?([a-z_][\w$]*)\s*\(/gi;
  let match;
  while ((match = functionRe.exec(value)) !== null) {
    const schema = String(match[1] || "").toLowerCase();
    const name = String(match[2] || "").toLowerCase();
    if (structuralWords.has(name)) continue;
    if (schema === "auth" && name === "uid") continue;
    if (!readOnlyFunctions.has(name)) return false;
  }
  return true;
}

function defaultRunGit(args, cwd) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function defaultRunGh(args, cwd) {
  const candidates = process.platform === "win32"
    ? ["gh", "C:\\Program Files\\GitHub CLI\\gh.exe"]
    : ["gh"];
  let lastError;
  for (const executable of candidates) {
    try {
      return execFileSync(executable, args, {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      // Only a MISSING executable moves on to the next candidate. A timed-out or
      // failed `gh` is thrown as-is: retrying it would let one admitted call run
      // two 5-second timeouts, which the hard-gate budget counts as one
      // (Codex sol, 2026-09-14).
      if (error?.code !== "ENOENT") throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("GitHub CLI is unavailable");
}

function proofRequirement(headSha, riskDescription, detail, baseSha) {
  // State the EXACT expected base. On a PR merge that base is GitHub's baseRefOid,
  // not local origin/main, so generic "<origin/main at review time>" guidance would
  // send the operator round a fetch-then-review loop, producing a proof this gate
  // rejects without ever saying which base it wanted.
  const expectedBase = baseSha || "<origin/main at review time>";
  // write-codex-push-proof.mjs derives base_sha from LOCAL origin/main and never
  // fetches. If that ref is stale, the wrapper mints a proof naming the old base
  // while this gate expects `expectedBase` — so following the guidance would loop
  // forever, rejected every time. Require the fetch first (Codex P2, 2026-07-25).
  const fetchFirst = baseSha
    ? `FIRST run \`git fetch origin main\` so local origin/main equals ${baseSha} — ` +
      `the review wrapper reads its base from that ref and will otherwise mint a proof bound to a stale base. Then `
    : "";
  const verdict = denied(
    `CODEX PRODUCTION GATE: ${riskDescription}\n\n` +
    `${detail}\n\n` +
    `${fetchFirst}run the exact-SHA adversarial gate with ` +
    `node scripts/write-codex-push-proof.mjs. It invokes gpt-6-sol at high reasoning in a read-only, ephemeral session. ` +
    `Only an unambiguous terminal CODEX_PROOF_VERDICT: CLEAN writes .claude/session-state/codex-review-<SHA>.json. ` +
    `Required JSON: ` +
    `{\"codex_ran\":true,\"verdict\":\"clean\",\"model\":\"gpt-6-sol\",\"reasoning_effort\":\"high\",` +
    `\"head_sha\":\"${headSha || "<exact pushed SHA>"}\",\"base_sha\":\"${expectedBase}\",` +
    `\"timestamp\":\"<ISO-8601, 0-24 hours old>\"}. ` +
    `The proof is bound to both the exact pushed SHA and that exact base; future-dated, stale, base-moved, malformed, or BOM-corrupted proof is refused. ` +
    `If this head only merged a newer main into a branch Sol already reviewed clean, ` +
    `\`node scripts/write-codex-push-proof.mjs --carry-forward\` keeps that review instead.`
  );
  // `solProofMissing` marks the ONE denial a documentation-only PR merge may be
  // excused from (gatePullRequestMerge, Mason 2026-10-07). Every other denial
  // stays a denial.
  return { ...verdict, solProofMissing: true };
}

// `requireProof` (PR merges into main, Mason's autonomous-landing rule of
// 2026-09-26): every merge needs the exact-SHA Sol proof, whether or not the diff
// is classified risky. The classification still runs so the denial can say what
// is risky, but it no longer opens an allow path of its own.
function gateMainChange({ repoDir, sourceRef, sourceSha, nowMs, runGit, authoritativeBaseSha, requireProof = false, laterChangesLowRisk = null }) {
  let headSha = sourceSha || "";
  let baseSha = "";
  try {
    // Resolve the exact base this change is gated against so the Sol proof can
    // be required to match the SAME base it was reviewed on; a moved base (e.g. a
    // sibling merge) forces a fresh review.
    //
    // For a PR merge the caller supplies GitHub's CURRENT baseRefOid. Local
    // origin/main is NOT authoritative there: on a stale checkout it can be behind
    // GitHub's real main, which would gate a risky merge on a proof — and on a
    // risk diff — computed against a base the change will never land on. Claude's
    // pr-merge-guard.mjs binds to baseRefOid for exactly this reason (Codex P1,
    // 2026-07-25; docs/research/2026-07-25-opus5-harness-review.md §1.1a).
    baseSha = authoritativeBaseSha
      ? String(authoritativeBaseSha).trim()
      : runGit(["rev-parse", "--verify", "--quiet", "origin/main"], repoDir);
    if (!baseSha) throw new Error("empty base SHA");
    if (authoritativeBaseSha) {
      // `rev-parse --verify <value>^{commit}` also resolves REF NAMES, so an
      // abbreviated or symbolic value from a changed `gh` output shape would
      // silently resolve to something local instead of failing closed — quietly
      // defeating the point of binding to GitHub's base. Require a full commit id.
      if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
        return denied(
          `CODEX PRODUCTION GATE: GitHub reported an unusable base commit ` +
          `(${baseSha.slice(0, 20)}); the merge cannot be bound to a real base commit ` +
          `and is denied (fail closed).`
        );
      }
      // The object must exist locally or every diff below is meaningless. Fail
      // closed with actionable guidance rather than an opaque git error.
      try {
        baseSha = runGit(["rev-parse", "--verify", `${baseSha}^{commit}`], repoDir);
      } catch {
        return denied(
          `CODEX PRODUCTION GATE: GitHub's current base commit ${String(authoritativeBaseSha).slice(0, 12)} ` +
          `is not present in this checkout, so the main-bound diff cannot be inspected against the base the ` +
          `merge will actually land on (fail closed). Run \`git fetch origin main\` and retry.`
        );
      }
    }
    if (!headSha) {
      const ref = sourceRef === "HEAD" ? "HEAD" : sourceRef;
      headSha = runGit(["rev-parse", "--verify", `${ref}^{commit}`], repoDir);
    } else {
      headSha = runGit(["rev-parse", "--verify", `${headSha}^{commit}`], repoDir);
    }
  } catch (error) {
    return denied(
      `CODEX PRODUCTION GATE: could not resolve the base branch or the exact ref being sent to main, so the operation is denied (fail closed). ${error?.message || error}`
    );
  }

  let changedFiles;
  try {
    // Diff against the resolved baseSha, never the literal `origin/main` ref:
    // on a PR merge that ref may be stale, which would misclassify a risky diff
    // as ordinary and skip the proof requirement entirely.
    //
    // NOTE the three-dot semantics: `A...B` is merge-base(A,B)..B, so this only
    // genuinely diffs "against baseSha" when baseSha is an ancestor of headSha.
    // For a head BEHIND the real base it is the PR's own changes since the merge
    // base; changes living only on the base stay out of it, which is the accepted
    // risk of merging a behind head (Mason, 2026-10-26; proofValidForMerge below).
    changedFiles = runGit(["diff", "--name-only", `${baseSha}...${headSha}`], repoDir)
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);
  } catch (error) {
    return denied(
      `CODEX PRODUCTION GATE: could not inspect ${baseSha}...${headSha}, so the operation is denied (fail closed). ${error?.message || error}`
    );
  }

  const risky = riskyFiles(changedFiles);
  let contentFlagged = false;
  if (risky.length === 0) {
    try {
      contentFlagged = contentIsRisky(runGit(["diff", `${baseSha}...${headSha}`], repoDir));
    } catch (error) {
      return denied(
        `CODEX PRODUCTION GATE: could not inspect the full diff for money/security risk, so the operation is denied (fail closed). ${error?.message || error}`
      );
    }
  }

  if (risky.length === 0 && !contentFlagged && !requireProof) return { blocked: false };

  const riskDescription = risky.length > 0
    ? `the main-bound diff changes ${risky.length} risky file(s): ${risky.slice(0, 6).join(", ")}${risky.length > 6 ? ", ..." : ""}`
    : contentFlagged
      ? "the main-bound diff contains money or financial-audit identifiers even though its paths look ordinary"
      : "every merge into main needs an exact-SHA Sol proof (Mason's autonomous-landing rule, 2026-09-26)";
  const isAncestorLocally = (ancestor, descendant) => {
    try {
      runGit(["merge-base", "--is-ancestor", ancestor, descendant], repoDir);
      return true;
    } catch (error) {
      // Exit 1 is git's "no"; any other failure is "cannot tell" (Luna, 2026-10-29).
      if (error?.status !== 1) return null;
      // A shallow clone can say "no" for history it cut off, so its "no" cannot tell either.
      try {
        return String(runGit(["rev-parse", "--is-shallow-repository"], repoDir)).trim() === "false" ? false : null;
      } catch {
        return null;
      }
    }
  };
  const stateDir = path.join(repoDir, ".claude", "session-state");
  let proofPath = path.join(stateDir, `codex-review-${headSha}.json`);
  // Sol runs once before the PR opens (Mason, 2026-10-29): with no proof of this
  // head, a proof of an earlier commit on this PR's branch may count.
  if (!existsSync(proofPath) && authoritativeBaseSha) {
    try {
      const earlier = readdirSync(stateDir)
        .filter((f) => /^codex-review-[0-9a-f]{40}\.json$/i.test(f))
        .map((f) => path.join(stateDir, f))
        .find((p) => {
          try {
            const data = JSON.parse(readFileSync(p, "utf8"));
            // The commits after the reviewed one must be notes only (Sol, 2026-10-29).
            return proofValidForMerge({ data, headSha, nowMs, baseSha, isAncestor: isAncestorLocally })
              && typeof laterChangesLowRisk === "function" && laterChangesLowRisk(String(data.head_sha).toLowerCase(), headSha) === true;
          } catch {
            return false;
          }
        });
      if (earlier) proofPath = earlier;
    } catch { /* no state directory: the exact-head path stays and is reported missing */ }
  }
  if (!existsSync(proofPath)) {
    return proofRequirement(headSha, riskDescription, `Missing required Sol high-effort proof: ${proofPath}`, baseSha);
  }

  let proof;
  try {
    proof = JSON.parse(readFileSync(proofPath, "utf8"));
  } catch (error) {
    return proofRequirement(headSha, riskDescription, `Sol proof could not be parsed: ${error?.message || error}`, baseSha);
  }
  // A PR merge may land a head that is behind main (Mason, 2026-10-26;
  // proofValidForMerge): the proof's own base must be in the head and behind
  // GitHub's base. A direct push to main keeps the exact-base binding.
  const proven = authoritativeBaseSha
    ? proofValidForMerge({ data: proof, headSha, nowMs, baseSha, isAncestor: isAncestorLocally })
    : proofValid(proof, headSha, nowMs, baseSha);
  if (!proven) {
    return proofRequirement(
      headSha,
      riskDescription,
      authoritativeBaseSha
        ? `Sol proof is stale, future-dated, bound to a different HEAD, bound to a base the head does not contain or that is not an ancestor of ${baseSha}, lacks the required gpt-6-sol/high identity, has the wrong verdict/ran key, or is otherwise invalid. A head that does not contain main needs origin/main merged in before Sol can review it.`
        : `Sol proof is stale, future-dated, bound to a different HEAD or to a base other than ${baseSha}, lacks the required gpt-6-sol/high identity, has the wrong verdict/ran key, or is otherwise invalid.`,
      baseSha
    );
  }

  return { blocked: false };
}

function gateMaintenanceProducerExecution({ command, repoDir, nowMs, runGit }) {
  if (!maintenanceProducerCommandMentioned(command)) return { blocked: false };

  let headSha;
  let baseSha;
  let headBlob;
  let worktreeBlob;
  let status;
  try {
    headSha = runGit(["rev-parse", "HEAD"], repoDir);
    baseSha = runGit(["rev-parse", "origin/main"], repoDir);
    status = runGit(["status", "--porcelain", "--untracked-files=all", "--", MAINTENANCE_PRODUCER], repoDir);
    headBlob = runGit(["rev-parse", `HEAD:${MAINTENANCE_PRODUCER}`], repoDir);
    worktreeBlob = runGit(["hash-object", `--path=${MAINTENANCE_PRODUCER}`, MAINTENANCE_PRODUCER], repoDir);
  } catch (error) {
    return denied(`CODEX PRODUCTION GATE: cannot bind the maintenance producer to the current committed HEAD: ${error?.message || error}`);
  }
  if (status || headBlob !== worktreeBlob) {
    return denied("CODEX PRODUCTION GATE: the maintenance producer differs from its exact committed HEAD blob. Commit it, obtain a fresh exact-head review, and retry.");
  }

  const proofPath = path.join(repoDir, ".claude", "session-state", `codex-review-${headSha}.json`);
  let proof;
  try {
    proof = JSON.parse(readFileSync(proofPath, "utf8"));
  } catch (error) {
    return proofRequirement(headSha, "execution of the protected maintenance producer", `Missing or unreadable exact-head proof: ${proofPath}`, baseSha);
  }
  if (!proofValid(proof, headSha, nowMs, baseSha)) {
    return proofRequirement(headSha, "execution of the protected maintenance producer", "The exact-head Sol-high proof is stale or does not match the current HEAD/base.", baseSha);
  }
  return { blocked: false };
}

// The gh command parsers (ghMergeRequest, ghApiMergeRequest, ghApiMutates) and
// mcpMergeRequest are IMPORTED from .claude/hooks/codex-push-lib.mjs above.
// Until 2026-09-07 this file carried its own copies, and codex-push-lib.mjs
// recorded the follow-up in its own header: "production-action-guard should
// import these instead of carrying its own copies." That duplication was not
// cosmetic — it was a live merge-gate bypass. Each copy spelled the binary as a
// one-item extension list, `gh(?:\.exe)?`, so `gh.cmd pr merge 625 --squash`,
// `gh.ps1 …`, `gh.bat …` and `C:\Tools\gh.cmd pr merge 625` returned
// `blocked: false` from evaluateProductionAction — measured, not read off the
// pattern — while the plain and `.exe` spellings were gated. `.cmd` is what
// Windows resolves `gh` to when the CLI ships a shim, and PATHEXT is
// user-configurable, so those are ordinary invocations. There is now ONE
// definition of what a gh command is (BIN_TAIL in codex-push-lib.mjs), which is
// what AGENTS.md means by ".claude/hooks/ is the single source of truth for
// shared guard logic": a fourth copy of the grammar would have inherited the
// next list's omissions the same way.

function githubToolIsReadOnly(toolName) {
  // App-style names keep a `github_` prefix on the leaf
  // (mcp__codex_apps__github_get_file) — strip it before classifying
  // (Codex round-5).
  const leaf = (String(toolName || "").split("__").pop() || "").replace(/^github_/i, "");
  return /^(?:get|list|search|read|resolve|download|check)_/i.test(leaf) ||
    /_(?:read|get|list|search)$/i.test(leaf);
}

function resolvePullRequest({ request, repoDir, runGh }) {
  const args = ["pr", "view"];
  if (request.selector) args.push(request.selector);
  // baseRefOid is GitHub's CURRENT tip of the base branch — the commit the merge
  // will actually land on. Without it the gate falls back to local origin/main,
  // which can be stale (Codex P1, 2026-07-25).
  args.push("--json", "baseRefName,baseRefOid,headRefName,headRefOid,mergeStateStatus,reviewDecision,reviews,statusCheckRollup,autoMergeRequest");
  if (request.repo) args.push("--repo", request.repo);
  const data = JSON.parse(runGh(args, repoDir));
  // baseRefOid is required only for main-bound merges; gatePullRequestMerge
  // enforces it after the base check so a PR onto another branch is not
  // needlessly failed closed.
  if (!data?.baseRefName || !data?.headRefOid) throw new Error("GitHub did not return baseRefName and headRefOid");
  return data;
}

// GitHub's own review verdict, from `gh pr view --json reviewDecision`. Until
// 2026-09-01 nothing could merge into main without an approval, so a CLEAN
// mergeStateStatus stood in for "somebody approved this". Mason's manual
// override — branch protection's "Include administrators" turned OFF so he can
// clear a stuck review by hand — removed that floor for anyone with admin
// rights, which is the token Codex runs on. So the approval is read directly.
//
// APPROVED is head-bound only because main's protection sets
// dismiss_stale_reviews AND require_last_push_approval (verified live
// 2026-09-01): a new commit dismisses every approval, so APPROVED cannot be
// describing an older head. If stale-review dismissal is ever turned off, this
// check must be joined by one that an APPROVED review's commit_id equals
// headRefOid. Mirrors pullRequestApproved() in .claude/hooks/codex-push-lib.mjs.
export function pullRequestApproved(pullRequest) {
  return String(pullRequest?.reviewDecision || "").toUpperCase() === "APPROVED";
}

// One definition, shared with pr-merge-guard: the newest run of every reported
// check must be green (2026-09-26). This copy used to judge every run ever
// reported at the head, so one failed lifecycle run blocked a merge forever.
export function pullRequestChecksGreen(pullRequest) {
  return sharedPullRequestChecksGreen(pullRequest);
}

function gatePullRequestMerge({ request, repoDir, nowMs, runGit, runGh }) {
  let pullRequest;
  try {
    pullRequest = resolvePullRequest({ request, repoDir, runGh });
  } catch (error) {
    return denied(
      `CODEX PRODUCTION GATE: could not determine the pull request's base branch and exact head SHA, so the merge is denied (fail closed). ${error?.message || error}`
    );
  }
  const base = normalize(pullRequest.baseRefName).toLowerCase();
  if (base === "master" || base === "production") {
    return denied(`CODEX PRODUCTION GATE: merges to protected branch ${base} remain blocked.`);
  }
  if (base !== "main") return { blocked: false };
  if (!pullRequest.baseRefOid) {
    return denied(
      "CODEX PRODUCTION GATE: GitHub did not report this pull request's current base commit (baseRefOid), " +
      "so the merge cannot be bound to the base it will actually land on and is denied (fail closed)."
    );
  }
  // The Codex GitHub App's review is read at the ALLOW point below, not here.
  // It is advisory, fail-open, and costs up to four gh calls against a
  // 15-SECOND hook budget (.codex/hooks.json) — four capped-at-10s calls can
  // outlive the hook on their own. A PreToolUse hook killed mid-call emits
  // nothing, and emitting nothing does NOT deny, so running it here would let a
  // slow GitHub starve every hard denial below it: CHANGES_REQUESTED, the green
  // pipeline, the risky-diff classification and the exact-SHA proof. Codex round
  // 6 found this; PR #502 established the class. See codexAppAdvisory().

  // Main's PR #560 migrated this gate from "no approval" to "an active
  // objection", matching the Claude side. Taking main's predicate: the denial
  // text below already describes CHANGES_REQUESTED, so keeping !approved here
  // would guard a message that does not match its condition.
  if (pullRequestReviewBlocked(pullRequest)) {
    return denied(
      "CODEX PRODUCTION GATE: GitHub reports reviewDecision=CHANGES_REQUESTED — a reviewer has open " +
      "objections on this pull request. Mason removed main's required-approval rule on 2026-09-02, which " +
      "did not authorize merging over a review that asked for changes. Fix every real finding and push it; " +
      "a genuine nitpick may be dismissed with a one-line reason in the thread. Merge only after that."
    );
  }
  // Mason's autonomous-landing rule (2026-09-26) — mirror of pr-merge-guard.mjs.
  // An agent merges into main only when the newest run of every check is green
  // and a fresh exact-SHA Sol proof exists (or the diff is documentation-only).
  // CodeRabbit's approval is no longer required (Mason, 2026-10-19): it is
  // advisory, and a CHANGES_REQUESTED review from anyone still denies above.
  // `--auto` would land commits pushed after this gate ran, so it is refused.
  // An immediate merge has the same race, closed by `--match-head-commit` equal
  // to the head checked here, which makes GitHub refuse a moved head (Sol HIGH,
  // 2026-09-26). Routes that cannot carry it — REST and connector merges — deny.
  if (String(request.matchHeadCommit || "").toLowerCase() !== String(pullRequest.headRefOid || "").toLowerCase()) {
    return denied(
      `CODEX PRODUCTION GATE: an agent merge into main must pin the exact head this gate checked — add ` +
      `\`--match-head-commit ${pullRequest.headRefOid}\` to \`gh pr merge\`. Without it, a commit pushed between ` +
      "this check and GitHub's merge would land unreviewed. The REST merge endpoint and connector merge tools " +
      "cannot carry the pin; use `gh pr merge`."
    );
  }
  if (request.auto) {
    return denied(
      "CODEX PRODUCTION GATE: `--auto` is not allowed into main — auto-merge lands the PR after this gate has " +
      "run, so commits pushed in the meantime would merge without an exact-head Sol proof. Wait for the " +
      "checks, then merge immediately."
    );
  }
  if (!pullRequestChecksGreen(pullRequest)) {
    return denied(
      "CODEX PRODUCTION GATE: this pull request is not merge-ready with a fully green GitHub pipeline. Wait until mergeStateStatus is CLEAN and the newest run of every reported check is completed successfully, neutral, or skipped."
    );
  }
  const mainVerdict = gateMainChange({
    repoDir,
    sourceSha: pullRequest.headRefOid,
    // Bind the proof AND the risk diff to GitHub's real base, not local origin/main.
    authoritativeBaseSha: pullRequest.baseRefOid,
    nowMs,
    runGit,
    requireProof: true,
    laterChangesLowRisk: (proofHead, head) =>
      !solRiskOnGitHub({ baseSha: proofHead, headSha: head, repo: request.repo, gh: (args) => runGh(args, repoDir) }).risky,
  });
  // Sol covers the listed files only (Mason, 2026-10-30) — mirror of pr-merge-guard.mjs.
  // Excuses ONLY the missing-or-invalid Sol proof, after every gate above and
  // gateMainChange's head-contains-base check have passed.
  if (mainVerdict.blocked && mainVerdict.solProofMissing) {
    const risk = solRiskOnGitHub({
      baseSha: pullRequest.baseRefOid,
      headSha: pullRequest.headRefOid,
      repo: request.repo,
      gh: (args) => runGh(args, repoDir),
    });
    if (!risk.risky) return { blocked: false, advisoryRequest: request };
    return denied(`${mainVerdict.reason}\n\nSol is required because ${risk.reason} (docs/reference/sol-required-paths.md; Mason, 2026-10-30).`);
  }
  if (mainVerdict.blocked) return mainVerdict;

  // ALLOW point for THIS merge. Every hard denial above — objection, green
  // pipeline, risky-diff classification and the exact-SHA proof — has had its
  // chance. The advisory lookup is NOT run here (Codex round 8, SEC-001): a
  // command can carry several merges, and an advisory for the first one that
  // ran before the second one's hard checks could exhaust the hook budget
  // before those checks did — a killed hook denies nothing, so the second
  // merge would proceed with failed CI, an objection, or no proof. The caller
  // collects this request and runs every advisory only after EVERY merge in
  // the command has cleared its hard gates, under one shared deadline.
  return { blocked: false, advisoryRequest: request };
}

// The Codex GitHub App's own review — mirror of pr-merge-guard.mjs.
//
// Wiring it on only one side would mean a merge driven from Codex skips a gate a
// merge driven from Claude gets, which is exactly the asymmetry AGENTS.md forbids
// leaving undeclared.
//
// Returns a denial verdict, or null when nothing blocks. Fails OPEN on any
// error: see the header of codex-bot-review-lib.mjs for why this one predicate
// does not fail closed like its neighbours here. The 7s budget stays under half
// of the hook's 15s so the notices below can still be written. The hard-gate
// deadline still caps it.
const CODEX_ADVISORY_BUDGET_MS = 7_000;

// The hard gates' share of this hook (see createHardGateBudget). The timeout
// mirrors this hook's entry in .codex/hooks.json and the per-call cap mirrors
// defaultRunGit/defaultRunGh; if either changes, change it here too. The reserve
// covers the PowerShell launcher, which process.uptime() cannot see, plus
// writing the verdict.
const CODEX_HOOK_TIMEOUT_MS = 15_000;
const CODEX_HOOK_RESERVE_MS = 2_500;
const CODEX_CALL_TIMEOUT_MS = 5_000;

// `deadlineMs` is SHARED across every merge in one command (Codex round 8,
// SEC-001): the caller computes it once and passes the same value to each
// deferred lookup, so N chained merges spend one budget between them rather
// than N budgets in series.
function codexAppAdvisory({ request, repoDir, runGh, clock = () => Date.now(), deadlineMs = clock() + CODEX_ADVISORY_BUDGET_MS, findSkip = () => null }) {
  let codexVerdict = null;
  let coderabbitOpen = null; // null = not read completely → fail closed below
  let coderabbitReview = null; // null = not read → fail closed below
  let reviewedPr = null; // the PR number GitHub answered for, which a skip waiver must name
  let teammates = null; // null = not read → fail closed below
  try {
    const metaArgs = ["pr", "view"];
    if (request.selector) metaArgs.push(String(request.selector));
    metaArgs.push("--json", "number,url");
    if (request.repo) metaArgs.push("--repo", request.repo);
    const meta = JSON.parse(runGh(metaArgs, repoDir));
    const slug = String(meta?.url || "").match(/[/]([^/]+)[/]([^/]+)[/]pull[/]/);
    if (slug && Number.isInteger(meta?.number)) {
      // Money PRs need a completed CodeRabbit review of the head — mirror of
      // pr-merge-guard.mjs: read the completion status BEFORE the threads (Codex
      // App P1 on #1009), inside the same budget; a throw leaves it null → refuse.
      // Each call also passes the hard-gate budget's admit() inside runGh, which
      // refuses a call that could outlive the hook.
      const verdict = readCodeRabbitRequirement((args) => runGh(args, repoDir), {
        owner: slug[1], name: slug[2], number: meta.number, deadlineMs, now: clock,
      });
      const node = collectCodexThreads((cursor) => {
        const args = [
          "api", "graphql",
          "-f", `query=${CODEX_THREADS_QUERY}`,
          "-F", `owner=${slug[1]}`,
          "-F", `name=${slug[2]}`,
          "-F", `number=${meta.number}`,
          "-F", `first=${CODEX_THREAD_PAGE_SIZE}`,
        ];
        // Omit `after` on the first page — see the Claude-side note.
        if (cursor) args.push("-F", `after=${cursor}`);
        return JSON.parse(runGh(args, repoDir))?.data?.repository?.pullRequest;
      }, { deadlineMs, now: clock });
      if (node.headRefOid) codexVerdict = evaluateCodexBotReview(node);
      coderabbitOpen = coderabbitThreadCount(node);
      if (verdict.headOid && verdict.headOid === String(node.headRefOid || "").trim().toLowerCase()) {
        coderabbitReview = verdict;
        // A waiver covers this repository's PRs only (Codex App P2 on #1035).
        reviewedPr = skipPullRequestFor(meta.url, meta.number);
      }
      teammates = readTeammateComments((args) => runGh(args, repoDir), {
        owner: slug[1], name: slug[2], number: meta.number, deadlineMs, now: clock,
      });
    }
  } catch {
    codexVerdict = null; // never a deny
  }
  // CodeRabbit is advisory (2026-10-19): its unanswered threads, on any commit,
  // still block — mirror of pr-merge-guard.mjs, including the fail-closed read.
  if (coderabbitOpen === null) {
    return denied(coderabbitUnreadableDenial("CODEX PRODUCTION GATE", request.selector));
  }
  if (coderabbitOpen > 0) {
    return denied(coderabbitFindingsDenial("CODEX PRODUCTION GATE", request.selector, coderabbitOpen));
  }
  if (!teammates) return denied(teammateCommentsUnreadableDenial("CODEX PRODUCTION GATE", request.selector));
  if (teammates.comments.length > 0) {
    return denied(teammateCommentsDenial("CODEX PRODUCTION GATE", request.selector, teammates.comments));
  }
  if (teammates.truncated) return denied(teammateCommentsTruncatedDenial("CODEX PRODUCTION GATE", request.selector));
  if (!coderabbitReview || coderabbitReview.status === "unreadable") {
    return denied(coderabbitRequirementUnreadableDenial("CODEX PRODUCTION GATE", request.selector, coderabbitReview?.why));
  }
  if (coderabbitReview.status === "missing") {
    // Mason's "skip coderabbit #<this PR>" in THIS session waives only the missing
    // review of this PR — mirror of pr-merge-guard.mjs (coderabbit-skip-lib.mjs, 2026-10-22).
    let skip = null;
    // Its git lookups stay inside this advisory's deadline (Codex App P2 on #1035).
    try { skip = findSkip(reviewedPr, { deadlineMs, now: clock }); } catch { skip = null; }
    if (!skip) {
      return denied(coderabbitReviewMissingDenial("CODEX PRODUCTION GATE", request.selector, coderabbitReview.why, coderabbitReview.headOid));
    }
    process.stderr.write(coderabbitSkipNotice("CODEX PRODUCTION GATE", request.selector, skip));
  }
  if (codexVerdict?.status === "findings-at-head") {
    return denied(codexBotFindingsDenial("CODEX PRODUCTION GATE", request.selector, codexVerdict.unresolvedAtHead));
  }
  // Say what happened on every non-blocking path. Failing open SILENTLY is
  // indistinguishable from "the reviewer had nothing to say" (CRX-REV-003 on
  // this PR's own Codex review) — the Claude guard already prints these, and a
  // one-sided silence is exactly the drift AGENTS.md forbids.
  if (!codexVerdict) {
    process.stderr.write(
      "CODEX REVIEW NOTICE: could not read the Codex GitHub App's review threads for this PR, so its " +
      "findings were NOT checked. Merging anyway (this gate fails open by design). Read them by hand: " +
      `gh pr view ${request.selector || "<number>"} --comments\n`,
    );
  } else if (codexVerdict.status === "stale") {
    process.stderr.write(
      `CODEX REVIEW NOTICE: the Codex GitHub App has ${codexVerdict.codexThreads} comment thread(s) on this ` +
      "PR, none of them unresolved against the exact commit being merged. Nothing blocks, but if you have " +
      "not read them, do: " +
      `gh pr view ${request.selector || "<number>"} --comments\n`,
    );
  } else if (codexVerdict.status === "none") {
    process.stderr.write(
      "CODEX REVIEW NOTICE: the Codex GitHub App has left no review comments on this PR. If it never ran, " +
      "comment `@codex review` and read the result before merging anything non-trivial.\n",
    );
  } else if (codexVerdict.status === "incomplete") {
    process.stderr.write(
      `CODEX REVIEW NOTICE: the Codex GitHub App's review threads could only be PARTLY read (${codexVerdict.codexThreads} ` +
      "seen; a later page failed, the cursor was unusable, or the page cap was reached). Nothing standing was seen " +
      "in what was read, but an unread page could still hold one, so this is NOT a clean reading. Merging anyway " +
      `(this gate fails open by design). Read them by hand: gh pr view ${request.selector || "<number>"} --comments\n`,
    );
  }
  return null;
}

// The native patch tool's `command`/`cmd` payload is parsed by the shared
// parseNativePatch / nativePatchEnvelope in codex-push-lib.mjs (see there for the
// rules); the test suite imports them through here.
export { nativePatchEnvelope, parseNativePatch };

// Is `child` the same as, or below, `root`? Lexical, with the host's case rules
// (Windows paths are case-insensitive).
export function pathIsInside(child, root) {
  const fold = (value) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
  const relative = path.relative(fold(root), fold(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathSegmentsInclude(value, segment) {
  return path.resolve(value).split(/[\\/]/).some((part) => part.toLowerCase() === segment);
}

// The checkout this guard belongs to: the folder two levels above
// `.codex/hooks/`. The hook command runs the copy inside the session's own
// checkout (`$(git rev-parse --show-toplevel)/.codex/hooks/…`), so this is the
// repository a native patch may edit. It is NOT taken from the event's working
// directory, which would let a session started in an unrelated folder widen it.
export function guardCheckoutRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

// Every working tree of the repository that checkout belongs to, itself first.
// A session started in one worktree may legitimately edit another worktree of
// the SAME repository (Codex reproduced the refusal 2026-10-27); the list comes
// from `git worktree list`, never from the event, so an unrelated folder still
// cannot widen it. If git cannot answer, only the checkout itself is allowed.
export function repositoryWorktreeRoots(checkoutRoot, runGit = defaultRunGit) {
  const own = path.resolve(checkoutRoot);
  let listing;
  try {
    listing = runGit(["worktree", "list", "--porcelain"], own);
  } catch {
    return [own];
  }
  const roots = [own];
  for (const block of String(listing).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const head = lines.find((line) => line.startsWith("worktree "));
    if (!head || lines.includes("bare") || lines.some((line) => line.startsWith("prunable"))) continue;
    const root = path.resolve(head.slice("worktree ".length));
    if (existsSync(root) && !roots.some((known) => pathIsInside(root, known) && pathIsInside(known, root))) roots.push(root);
  }
  return roots;
}

// Where a patch destination really lands once symlinks and junctions on its
// existing part are followed, or `null` when that cannot be determined (a link
// that does not resolve, an unreadable directory) so the caller refuses. The
// part of the path that does not exist yet is appended unchanged.
export function realPathThroughLinks(candidate, baseDir, deadlineMs = Infinity, clock = () => Date.now()) {
  const absolute = path.resolve(baseDir, String(candidate));
  const missing = [];
  let probe = absolute;
  for (;;) {
    // Checked between lookups, so one slow path cannot keep the walk going past
    // the hook's limit: out of time is "cannot resolve", which the caller refuses.
    if (clock() >= deadlineMs) return null;
    let present = true;
    try {
      lstatSync(probe);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return null;
      present = false;
    }
    if (present) {
      // Present but unresolvable (a dangling link) is NOT "missing": a write
      // through it would create the file at the link's target.
      try {
        return path.join(realpathSync.native(probe), ...missing);
      } catch {
        return null;
      }
    }
    const parent = path.dirname(probe);
    if (parent === probe) return absolute;
    missing.unshift(path.basename(probe));
    probe = parent;
  }
}

export function evaluateProductionAction({
  toolName = "",
  toolInput = {},
  eventCwd = "",
  branch = "",
  repoDir = process.cwd(),
  // The one folder a native patch may edit; main() passes the checkout this
  // guard file lives in. A direct caller that omits it gets `repoDir`.
  patchRoot = "",
  // (root) => every folder a native patch may edit, given that root; main()
  // passes repositoryWorktreeRoots. A direct caller gets the root alone.
  patchWorktrees = (root) => [root],
  nowMs = Date.now(),
  runGit = defaultRunGit,
  runGh = defaultRunGh,
  // When the network-bound merge gates stop admitting calls. main() passes the
  // real hook deadline, measured from process start; a direct caller (the test
  // suite) gets a fresh budget per evaluation. See createHardGateBudget.
  hardGateDeadlineMs = Date.now() + CODEX_HOOK_TIMEOUT_MS - CODEX_HOOK_RESERVE_MS,
  clock = () => Date.now(),
  // Internal: > 0 when this call inspects a command found INSIDE another
  // command (see expandNestedCommands). Not part of the hook's input.
  nestingDepth = 0,
  // (pullRequest) => Mason's live "skip coderabbit" waiver for that PR in this
  // session, or null. main() binds it to the hook's session id; a direct caller
  // gets no waiver.
  findCodeRabbitSkip: findSkip = () => null,
} = {}) {
  const name = String(toolName);
  const baseRepoDir = path.resolve(repoDir);
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  // Native apply_patch carries a raw string, so it has no nested workdir/cwd.
  // Its event-level cwd is still the directory where the patch resolves. A
  // nested relative workdir/cwd is relative to that event directory; without
  // an event cwd, the repository root remains the established fallback.
  const eventRepoDir = eventCwd ? path.resolve(baseRepoDir, String(eventCwd)) : baseRepoDir;
  const requestedWorkingDir = input.workdir ?? input.cwd ?? "";
  const actionRepoDir = requestedWorkingDir
    ? path.resolve(eventRepoDir, String(requestedWorkingDir))
    : eventRepoDir;

  const pathCandidates = [
    input.file_path,
    input.filePath,
    input.path,
    input.target,
    input.source,
    input.destination,
  ];
  // Classify patch payloads by their DESTINATION headers, not the whole body —
  // documentation patches legitimately mention guard/proof paths in prose
  // (Codex round-5 false positive).
  const rawPatchBody = typeof toolInput === "string" ? toolInput : undefined;
  // The native patch tool's `command`/`cmd` payload (see nativePatchEnvelope):
  // a malformed or conflicting envelope is refused before any path check, and a
  // fully parsed one contributes every path it touches (the grammar admits no
  // other destination), then skips the shell inspection further down.
  const nativePatch = nativePatchEnvelope(name, toolInput);
  if (nativePatch?.denial) return denied(`CODEX PRODUCTION GATE: ${nativePatch.denial}`);
  const patchDestinations = [rawPatchBody, input.patch, input.diff, input.input, input.changes]
    .flatMap((payloadText) => extractPatchDestinations(payloadText))
    .concat(nativePatch?.paths ?? []);
  if ([...pathCandidates, ...patchDestinations].some((candidate) => reviewProofPathMentioned(candidate))) {
    return denied("CODEX PRODUCTION GATE: review proof files are wrapper-owned and cannot be written, edited, moved, or deleted directly.");
  }
  const mutatingFileTool = /(?:write|edit|delete|move|rename|patch|replace|create|update)/i.test(name);
  // A relative path is relative to the tool's WORKING DIRECTORY, not to the
  // repo root (Codex round 11, HIGH): `workdir: ".claude/hooks"` plus
  // `file_path: "codex-bot-review-lib.mjs"` is the protected module, and the
  // raw candidate — a bare basename — matched nothing. Every candidate is
  // therefore tested both as spelled and as joined onto the resolved working
  // directory; the protected matcher is suffix-anchored, so the absolute form
  // still matches. Over-inclusive for a protected-looking suffix under an
  // unrelated working directory, which is the deny direction.
  if (mutatingFileTool && (
    [...pathCandidates, ...patchDestinations].some((candidate) =>
      protectedHarnessPathMentioned(candidate) || protectedHarnessPathMentioned(joinedWithWorkdir(candidate, actionRepoDir)))
  )) {
    return denied(`CODEX PRODUCTION GATE: the production/review harness is a security boundary and cannot be changed through a direct file-write tool. ${HARNESS_REPAIR_PATH}`);
  }
  // The spelled path is not where the write lands when it passes through a
  // symlink or junction (`src/notes.ts` linked to a guard file). Only this
  // route follows links, because only this route's destinations are all known.
  const patchRoots = nativePatch ? patchWorktrees(patchRoot ? path.resolve(patchRoot) : baseRepoDir) : [];
  const patchRootsReal = patchRoots.map((root) => {
    try { return realpathSync.native(root); } catch { return root; }
  });
  for (const destination of nativePatch?.paths ?? []) {
    // A patch edits this repository. A destination outside it (an absolute path
    // elsewhere on the machine, a workdir that points at another folder) is
    // refused before any filesystem lookup, so nothing outside is ever touched.
    const spelled = path.resolve(actionRepoDir, destination);
    if (!patchRoots.some((root) => pathIsInside(spelled, root))) {
      return denied(`CODEX PRODUCTION GATE: the patch destination ${destination} is outside the repository (${patchRoots[0] ?? "unknown"}) and its other worktrees, so it is refused. A native patch may only edit files in this repository's worktrees.`);
    }
    // Git's own folder holds the hooks and the config (core.hooksPath, aliases)
    // that decide whether Husky runs at all. Widening the roots to every worktree
    // puts the main checkout's `.git` inside one, so it is refused by name.
    if (pathSegmentsInclude(spelled, ".git")) {
      return denied(`CODEX PRODUCTION GATE: the patch destination ${destination} is inside a .git folder, which holds git's hooks and configuration; it cannot be changed through a patch.`);
    }
    // The caps above bound the work; this is the backstop: a hook killed at its
    // time limit allows the action, so past the deadline the answer is no.
    if (clock() >= hardGateDeadlineMs) return denied(hardGateBudgetDenial("CODEX PRODUCTION GATE"));
    const landed = realPathThroughLinks(destination, actionRepoDir, hardGateDeadlineMs, clock);
    if (landed === null) {
      return denied(`CODEX PRODUCTION GATE: the patch destination ${destination} could not be resolved to the file it would really write (a link that does not resolve, or an unreadable directory), so it is refused (fail closed).`);
    }
    // A link inside the repository that leads out of it moves the write outside too.
    if (!patchRootsReal.some((root) => pathIsInside(landed, root))) {
      return denied(`CODEX PRODUCTION GATE: the patch destination ${destination} resolves through a link to ${landed}, outside the repository, so it is refused. A native patch may only edit files in this repository's worktrees.`);
    }
    if (pathSegmentsInclude(landed, ".git")) {
      return denied(`CODEX PRODUCTION GATE: the patch destination ${destination} resolves through a link into a .git folder (${landed}), which holds git's hooks and configuration; it cannot be changed through a patch.`);
    }
    // The review state directory holds the proofs AND Mason's CodeRabbit waivers
    // (coderabbit-skip-*.json), whose filenames no basename list covers. A path
    // spelled outside it that lands inside it is a link into it: refused. (A path
    // spelled inside it is judged by review-proof-guard, which keeps its single
    // acknowledgment-file exception.) Codex App P1, PR #1083.
    if (reviewStateDirectoryMentioned(landed) && !reviewStateDirectoryMentioned(spelled)) {
      return denied(`CODEX PRODUCTION GATE: the patch destination ${destination} resolves through a link into the wrapper-owned review state directory (${landed}), which holds the review proofs and Mason's waivers; it cannot be changed through a patch.`);
    }
    // The gate-deciding files beyond the short protected list (.husky, workflows,
    // every other hook, the proof/validator scripts): a path-field writer aimed
    // at one is refused, spelled or reached through a link (Sol, PR #1083).
    const onEnforcementSurface = (value) => ENFORCEMENT_SURFACE_PATH_RE.test(`/${String(value).replace(/\\/g, "/")}`);
    if (onEnforcementSurface(path.resolve(actionRepoDir, destination)) || onEnforcementSurface(landed)) {
      return denied(`CODEX PRODUCTION GATE: the patch destination ${destination} is one of the files that decide whether the commit, push, CI and review gates run (.husky, .github/workflows, .claude/hooks, .codex/hooks, .coderabbit.yaml, the proof and validator scripts). It cannot be changed through a patch. ${HARNESS_REPAIR_PATH}`);
    }
    if (reviewProofPathMentioned(landed) || protectedHarnessPathMentioned(landed)) {
      return denied(`CODEX PRODUCTION GATE: the patch destination ${destination} is a link to, or inside a link to, a protected harness or review-proof file (${landed}); it cannot be changed through a direct file-write tool.`);
    }
    // A hard link is the same file under a second name that no path walk can
    // see through, so an existing file with another name is refused.
    try {
      const stat = lstatSync(landed);
      if (stat.isFile() && stat.nlink > 1) {
        return denied(`CODEX PRODUCTION GATE: the patch destination ${destination} is an existing file with more than one hard link, so it may be another name for a protected file; it is refused (fail closed).`);
      }
    } catch { /* the destination does not exist yet: nothing to alias */ }
  }

  if (NODE_REPL_TOOL.test(name)) {
    return denied("CODEX PRODUCTION GATE: node_repl is disabled in this repository because it can launch uninspected git/GitHub write processes outside the production guard.");
  }

  if (LIVE_TOOL_ACTIONS.test(name)) {
    return denied("Live migrations, edge-function deployments, and Supabase branch/project lifecycle mutations remain outside Codex's standing authorization.");
  }

  const supabaseTool = SUPABASE_TOOL_RE.exec(name);
  if (supabaseTool) {
    const leaf = supabaseTool[1].toLowerCase();
    if (leaf !== "execute_sql" && !SUPABASE_READ_ONLY_TOOLS.has(leaf)) {
      return denied(
        `CODEX PRODUCTION GATE: Supabase tool "${leaf}" is not on the exact read-only allowlist and is denied (fail closed). ` +
        "With the connector write-enabled, every mutating or unrecognized Supabase tool is blocked so production schema and data " +
        "changes can only travel the reviewed migration path."
      );
    }
  }

  if (/execute_sql$/i.test(name)) {
    // Every SQL field present is judged, and each must be a plain string, so
    // the text approved here is the text the connector receives (Luna,
    // 2026-10-28).
    const sqlFields = ["query", "sql"].filter((field) => toolInput[field] !== undefined && toolInput[field] !== null);
    if (sqlFields.some((field) => typeof toolInput[field] !== "string")) {
      return denied("Codex only permits execute_sql with its SQL given as plain text.");
    }
    const statements = sqlFields.length ? sqlFields.map((field) => toolInput[field]) : [""];
    // A db-invariant sweep packet reads catalog built-ins the generic check does
    // not know, so it is admitted only when isKnownSweepQuery (the Claude SQL
    // guard's recognizer) matches it exactly: the generated envelope, a
    // predicate whose fingerprint is pinned in that protected file under the
    // same name, and plain contract keys. Any edit to the body, name or keys
    // falls back to the generic check.
    if (!statements.every((sql) => isClearlyReadOnlySql(sql) || isKnownSweepQuery(sql))) {
      return denied("Codex only permits clearly read-only SQL. Live data and schema changes remain blocked.");
    }
  }

  // Every git/gh call a merge's HARD gates make goes through this budget; the
  // advisory lookups keep the raw runners and their own deadline (they fail
  // open by design). A refused call throws, which the gate turns into a denial.
  const hardGateBudget = createHardGateBudget({
    deadlineMs: hardGateDeadlineMs,
    callTimeoutMs: CODEX_CALL_TIMEOUT_MS,
    clock,
  });
  const budgeted = (run) => (...args) => {
    if (!hardGateBudget.admit()) throw new Error("hard-gate time budget exhausted");
    return run(...args);
  };
  const gateRunGit = budgeted(runGit);
  const gateRunGh = budgeted(runGh);

  if (GITHUB_MERGE_TOOL.test(name)) {
    const request = mcpMergeRequest(toolInput);
    if (!request.selector) {
      return denied(
        "CODEX PRODUCTION GATE: could not determine WHICH pull request this merge tool targets from its inputs, so the merge is denied (fail closed) — the guard must never verify one PR while the tool merges another."
      );
    }
    const result = gatePullRequestMerge({
      request,
      repoDir: actionRepoDir,
      nowMs,
      runGit: gateRunGit,
      runGh: gateRunGh,
    });
    // Checked before `blocked`: a gate that swallowed the refusal must not allow.
    if (hardGateBudget.exhausted) return denied(hardGateBudgetDenial("CODEX PRODUCTION GATE"));
    if (result.blocked) return result;
    // The connector merges exactly ONE pull request per call, so there is no
    // later segment for the advisory to starve: this IS the command's allow
    // point, and the deferred lookup runs here. Codex round 9 found this path
    // returning the deferred request untouched after round 8 moved the lookup
    // out of the per-merge gate — a merge driven through the connector skipped
    // the check a shell merge got, the asymmetry AGENTS.md forbids.
    if (result.advisoryRequest) {
      // The lookup now carries a fail-closed CodeRabbit check, so it runs on the
      // HARD-gate budget (Codex App P1 on #973): a call that could not finish
      // before the hook is killed is refused, which leaves the count unread and
      // denies, instead of a killed hook that says nothing and so allows.
      const advisory = codexAppAdvisory({ request: result.advisoryRequest, repoDir: actionRepoDir, runGh: gateRunGh, clock,
        deadlineMs: Math.min(clock() + CODEX_ADVISORY_BUDGET_MS, hardGateDeadlineMs), findSkip });
      if (hardGateBudget.exhausted) return denied(hardGateBudgetDenial("CODEX PRODUCTION GATE"));
      if (advisory) return advisory;
    }
    return { blocked: false };
  }

  if (GITHUB_TOOL.test(name) && !githubToolIsReadOnly(name)) {
    return denied("CODEX PRODUCTION GATE: direct GitHub write tools are blocked because they bypass the reviewed git push and Husky pipeline. Use a normal feature-branch commit/push workflow.");
  }

  // Measured BEFORE the trim, so the trim never runs over unbounded input.
  // A native patch that parsed completely is not a shell command: its paths were
  // gated above, and reading its text as shell is what refused every source edit.
  const untrimmedCommand = nativePatch ? "" : String(toolInput.command ?? toolInput.cmd ?? "");
  const command = untrimmedCommand.length > MAX_INSPECTABLE_COMMAND_LENGTH ? untrimmedCommand : untrimmedCommand.trim();
  if (!command) return { blocked: false };

  // First, before any parser (the nested-shell expansion below included): a
  // hook killed at its time limit allows the command.
  if (pushParseCostExceeded(command)) {
    return denied(
      "CODEX PRODUCTION GATE: this command is too large to inspect safely (it is over " +
      `${MAX_INSPECTABLE_COMMAND_LENGTH.toLocaleString("en-US")} characters, or its \`git\` count times its length is ` +
      `over ${PUSH_PARSE_COST_BUDGET.toLocaleString("en-US")}). A guard that runs out of time lets the command ` +
      "through, so it is refused instead. Split it into smaller commands, or move long text into a file."
    );
  }
  // A plain search (`rg -n 'git push' AGENTS.md`) reads files and runs nothing,
  // but the text checks below read its quoted pattern as the command it names
  // (Codex reproduced three such refusals 2026-10-27). Recognised searches keep
  // only the reading checks: review-proof files and the review state directory.
  if (literalReadOnlySearch(command)) {
    if (reviewProofPathMentioned(command)) {
      return denied("CODEX PRODUCTION GATE: direct shell access to review proof files is blocked. Run the real review wrapper instead.");
    }
    if (reviewStateDirectoryMentioned(actionRepoDir)) {
      return denied("CODEX PRODUCTION GATE: the wrapper-owned review state directory cannot be used as an interactive shell working directory.");
    }
    return { blocked: false };
  }
  // A command handed to another program as one argument — `bash -c "…"`,
  // `cmd /c "…"`, `pwsh -Command "…"`, `pwsh -EncodedCommand …`, `eval`,
  // `Invoke-Expression`, `Start-Process`, a `&{ … }` block — is one word to every
  // check below, so an administrator merge inside it was allowed (measured on
  // PR #630's head, 2026-09-24). Each such inner command is evaluated here by
  // this same function, on the same hard-gate deadline. Its advisory lookups are
  // carried out to THIS call's allow point, after every hard gate has run.
  const nestedAdvisories = [];
  if (nestingDepth === 0) {
    const nested = expandNestedCommands(command);
    if (nested.tooDeep) return denied(nestedTooDeepDenial("CODEX PRODUCTION GATE"));
    for (const inner of nested.commands) {
      const verdict = evaluateProductionAction({
        toolName,
        toolInput: { ...input, command: inner, cmd: undefined },
        eventCwd,
        branch,
        repoDir,
        nowMs,
        runGit,
        runGh,
        hardGateDeadlineMs,
        clock,
        nestingDepth: 1,
      });
      if (verdict.blocked) {
        return { ...verdict, reason: `${verdict.reason} [Found in a command run by a nested shell: ${inner.slice(0, 160)}]` };
      }
      nestedAdvisories.push(...(verdict.deferredAdvisories || []));
    }
  }

  if (reviewProofPathMentioned(command)) {
    return denied("CODEX PRODUCTION GATE: direct shell access to review proof files is blocked. Run the real review wrapper instead.");
  }
  const changesDirectory = CHANGES_DIRECTORY_RE.test(command);
  if ((changesDirectory && reviewStateDirectoryMentioned(command)) || reviewStateDirectoryMentioned(actionRepoDir)) {
    return denied("CODEX PRODUCTION GATE: the wrapper-owned review state directory cannot be used as an interactive shell working directory.");
  }
  if (liveApplyScriptMentioned(command)) {
    return denied(
      "CODEX PRODUCTION GATE: scripts/apply-migration-file.mjs applies a migration to the LIVE database and is " +
      "blocked, exactly like the MCP apply_migration and Supabase CLI migration paths. Its internal gate checks " +
      "review evidence but cannot verify Mason's required in-chat approval, so it is not an alternative spelling " +
      "for the reviewed migration path. Live migrations remain outside Codex's standing authorization.");
  }
  const maintenanceProducerGate = gateMaintenanceProducerExecution({ command, repoDir: actionRepoDir, nowMs, runGit });
  if (maintenanceProducerGate.blocked) return maintenanceProducerGate;

  if (SHELL_MUTATION_RE.test(command) && PROTECTED_HARNESS_FRAGMENT_RE.test(command)) {
    return denied(`CODEX PRODUCTION GATE: direct shell mutation of the production/review harness is blocked. ${HARNESS_REPAIR_PATH}`);
  }
  if (isGitPush(command) && pushContextIsAmbiguous(command)) {
    return denied("CODEX PRODUCTION GATE: directory-changing or GIT_DIR/GIT_WORK_TREE-prefixed pushes cannot be bound safely to the inspected worktree. Use `git -C <repo> push`.");
  }
  const suppliedEnv = toolInput.env && typeof toolInput.env === "object" ? toolInput.env : {};
  if (isGitPush(command) && Object.keys(suppliedEnv).some((key) => /^(?:GIT_DIR|GIT_WORK_TREE)$/i.test(key))) {
    return denied("CODEX PRODUCTION GATE: pushes with GIT_DIR/GIT_WORK_TREE tool environment overrides are denied. Use `git -C <repo> push`.");
  }

  // Split on single `|` too (Codex round-4): `git push a | git push b` runs
  // BOTH pushes in a shell pipeline, so every pipeline stage is a segment.
  //
  // A single `&` is a separator as well, and was missing: POSIX runs the left
  // side in the BACKGROUND and cmd.exe runs it first, so both sides execute
  // either way. `gh api -X POST … & gh api -X GET user` reported a plain GET,
  // because one rolling method was carried across the unsplit text and the later
  // GET overwrote the POST; `git push origin HEAD:feature & git push origin
  // HEAD:main` gated only the first push (Codex sol, 2026-09-08, finding 4 —
  // both measured blocked:false end to end). The split is QUOTE-AWARE: a bare
  // regex splits inside `--body 'note&more'` and hands this loop a merge whose
  // `--admin` has been carried off into a segment with no `gh` in it (Codex sol,
  // 2026-09-08, SEC-001).
  const commandSegments = splitCommandSegments(command);
  // Merge requests that cleared every hard gate; their advisory lookups run
  // together at the very end, after the push segments too (Codex round 8).
  const deferredAdvisories = [];
  // Merge requests already gated in this command. The union splitter returns two
  // readings of any command carrying a quote or an escape, and both resolve to
  // the SAME request — gating it twice spends a `gh pr view` and an advisory
  // lookup for a verdict already known. This hook is bounded and a hook killed
  // mid-call emits nothing, which ALLOWS, so the waste is fail-open, not merely
  // slow (CodeRabbit, 2026-09-09). Keyed on the COMPLETE parse — see
  // mergeRequestKey for why selector+repo would erase an `--admin` reading.
  const gatedRequests = new Set();
  for (const segment of commandSegments) {
    const ghRequest = ghMergeRequest(segment) || ghApiMergeRequest(segment);
    // ── raw merge transports (Codex proof on PR #541, 2026-09-01) ───────────
    // Every gh-shaped route below requires the `gh` binary in the command text.
    // That was survivable while GitHub itself refused an unapproved merge — a
    // raw REST call simply got a 405 — but Mason's admin override removed that
    // backstop, so an agent holding his admin credential can now merge through
    // any transport. Denied by DESTINATION rather than by tool: enumerating
    // curl, wget, Invoke-RestMethod, and fetch is the losing half of that trade.
    //
    // Scanned BEFORE the gh routes dispatch, because a recognized outer
    // `gh pr merge` used to reach `continue` first and shield a raw merge hidden
    // in a command substitution (Codex bot P1 on PR #541). Counting occurrences
    // keeps the ONE endpoint a `gh api ... /merge` request legitimately names
    // from denying its own gated route.
    // Counted with the segment's shell quoting consumed too, so `mer\ge` or
    // `mer^ge` inside a nested shell still counts.
    if (rawMergeEndpointCount(segment) > (ghApiMergeRequest(segment)?.selector ? 1 : 0)) {
      return denied(
        "CODEX PRODUCTION GATE: raw GitHub REST merge calls (curl/wget/Invoke-RestMethod/fetch against " +
        ".../pulls/<n>/merge) are denied because the guard cannot resolve and verify the PR's base, head, " +
        "and checks for them. Use `gh pr merge <number>` so the gate can verify the merge."
      );
    }
    if (mentionsMergePullRequest(segment)) {
      return denied(
        "CODEX PRODUCTION GATE: GraphQL mergePullRequest mutations are denied — whatever transport carries " +
        "them — because the guard cannot resolve and verify the PR's base, head, and checks for them. " +
        "Use `gh pr merge <number>` so the gate can verify the merge."
      );
    }
    // A merge segment carrying a command substitution is unresolvable, so it is
    // refused rather than gated: the substitution can hold a second
    // `gh pr merge` — `gh pr merge 1 --body "$(gh pr merge 2 --admin)"` runs the
    // INNER merge first while the parser records only the outer request (Codex
    // bot P1 on PR #541). Same stance this guard already takes on interpreter
    // arguments: a shell-expanded command is not statically knowable.
    if (ghRequest && /\$\(|`|\$\{/.test(segment)) {
      return denied(
        "CODEX PRODUCTION GATE: this merge command contains a command substitution, so what it will " +
        "actually run is not statically knowable — a substitution can carry a second merge, or flags the " +
        "parser never sees. Run the merge as its own plain command, with the PR number and flags spelled out."
      );
    }
    if (ghRequest?.unsupportedGraphql) {
      return denied("CODEX PRODUCTION GATE: GraphQL mergePullRequest mutations are denied because the guard cannot safely resolve and verify their PR head/checks. Use `gh pr merge <number>` instead.");
    }
    if (ghRequest?.admin) {
      // Denied before the PR is resolved: there is no base branch and no diff
      // for which an agent asking GitHub to skip the review is the right move.
      return denied(
        "CODEX PRODUCTION GATE: `--admin` merges with administrator privileges, skipping main's required " +
        "review. That override exists for Mason to use by hand on the PR page — an agent may never use it, " +
        "whatever the diff or the deadline. Get a real approval instead, or hand the PR to Mason and say " +
        "why it is stuck."
      );
    }
    if (ghRequest) {
      // `--disable-auto` is gated like any merge; see ghMergeRequest for why.
      // Every text-based denial above has already run for THIS segment; only the
      // network-bound gate is skipped, and only for a parse already gated.
      const requestKey = mergeRequestKey(ghRequest);
      if (gatedRequests.has(requestKey)) continue;
      gatedRequests.add(requestKey);
      const result = gatePullRequestMerge({
        request: ghRequest,
        repoDir: actionRepoDir,
        nowMs,
        runGit: gateRunGit,
        runGh: gateRunGh,
      });
      // mergeRequestKey drops duplicate readings; this bounds DISTINCT merges.
      if (hardGateBudget.exhausted) return denied(hardGateBudgetDenial("CODEX PRODUCTION GATE"));
      if (result.blocked) return result;
      // Cleared every hard gate. Its advisory lookup is DEFERRED until every
      // merge in this command has done the same (Codex round 8, SEC-001).
      if (result.advisoryRequest) deferredAdvisories.push(result.advisoryRequest);
      continue;
    }
    // Resolving one review thread or replying to a review comment in plain text
    // is ordinary review work (#973; Mason, 2026-10-30).
    if (ghApiMutates(segment) && !ghApiIsResolveReviewThreadOnly(segment) && !ghApiIsReviewThreadReply(segment)) {
      return denied("CODEX PRODUCTION GATE: unrecognized mutating `gh api` calls are blocked because they can bypass the reviewed branch/push workflow.");
    }
  }

  for (const segment of commandSegments.filter((part) => isGitPush(part))) {
    if (/--git-dir|--work-tree/i.test(segment)) {
      return denied("CODEX PRODUCTION GATE: pushes using explicit --git-dir/--work-tree contexts are denied because the guard cannot safely bind them to the inspected worktree. Use `git -C <repo> push` instead.");
    }
    if (pushUsesBulkMode(segment)) {
      return denied("CODEX PRODUCTION GATE: bulk push modes (`--all`/`--branches`/`--mirror`/`--prune`) can alter multiple remote refs and are always denied. Push one explicit branch/refspec instead.");
    }
    if (pushIsForced(segment)) {
      return denied("CODEX PRODUCTION GATE: force-pushing any branch rewrites shared history and requires Mason's explicit approval.");
    }
    const pushRepoDir = gitPushCwd(segment, actionRepoDir);
    let currentBranch = requestedWorkingDir ? "" : normalize(branch).toLowerCase();
    // The push checks spend the same hard-gate budget as the merge checks: each
    // segment costs a branch lookup plus several git calls in gateMainChange, and
    // a chain of pushes could otherwise walk past the hook's timeout — where a
    // hook that says nothing ALLOWS (CodeRabbit on PR #630, 2026-09-21).
    if (!currentBranch || pushRepoDir !== actionRepoDir) {
      try {
        currentBranch = normalize(gateRunGit(["rev-parse", "--abbrev-ref", "HEAD"], pushRepoDir)).toLowerCase();
      } catch (error) {
        if (hardGateBudget.exhausted) return denied(hardGateBudgetDenial("CODEX PRODUCTION GATE", "push"));
        return denied(`CODEX PRODUCTION GATE: could not determine the push branch, so the push is denied (fail closed). ${error?.message || error}`);
      }
    }

    if (/\bgit\b[^\r\n;&|]*\bpush\b[^\r\n;&|]*(?:\s|:)(master|production)(?:\s|$)/i.test(segment) ||
        ((currentBranch === "master" || currentBranch === "production") && /\bgit\b[^\r\n;&|]*\bpush\b/i.test(segment))) {
      return denied("CODEX PRODUCTION GATE: pushes to master/production remain blocked.");
    }

    const sourceRef = mainPushSource(segment, currentBranch);
    if (sourceRef === "DELETE") {
      return denied("CODEX PRODUCTION GATE: `git push origin :main` deletes the production branch and is always denied.");
    }
    if (sourceRef) {
      const result = gateMainChange({ repoDir: pushRepoDir, sourceRef, nowMs, runGit: gateRunGit });
      // Checked before `blocked`: a gate that swallowed the refusal must not allow.
      if (hardGateBudget.exhausted) return denied(hardGateBudgetDenial("CODEX PRODUCTION GATE", "push"));
      if (result.blocked) return result;
    }
  }

  const productionDeploy =
    /\bvercel\b[^\r\n]*(?:--prod|--production)(?:\s|$)/i.test(command) ||
    /\bsupabase\s+functions\s+deploy\b/i.test(command) ||
    /\bsupabase\s+(?:db\s+push|migration\s+up)\b/i.test(command) ||
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?deploy\b/i.test(command);
  if (productionDeploy) {
    return denied("Production deployments, edge-function deploys, and live migration commands remain blocked for Codex.");
  }

  // ALLOW point for the whole command. Every merge and push segment above has
  // cleared its hard gates, so the advisory, fail-open Codex App lookups can
  // spend what is left of the hook budget here without being able to starve
  // any of them — including a LATER merge's gates, which is what running the
  // advisory inside the loop allowed (Codex round 8, SEC-001). One deadline is
  // shared by every lookup so N merges cannot multiply the budget.
  // A nested command hands its cleared merges to the outer call, whose allow
  // point is the only one that comes after EVERY hard gate in the command.
  if (nestingDepth > 0) return { blocked: false, deferredAdvisories };
  // On the HARD-gate budget since #973: see the connector route above.
  const advisoryDeadlineMs = Math.min(clock() + CODEX_ADVISORY_BUDGET_MS, hardGateDeadlineMs);
  for (const request of [...nestedAdvisories, ...deferredAdvisories]) {
    const advisory = codexAppAdvisory({ request, repoDir: actionRepoDir, runGh: gateRunGh, clock, deadlineMs: advisoryDeadlineMs, findSkip });
    if (hardGateBudget.exhausted) return denied(hardGateBudgetDenial("CODEX PRODUCTION GATE"));
    if (advisory) return advisory;
  }
  return { blocked: false };
}

function writeDenial(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  }));
}

async function main() {
  // Measured while reading, before decoding: JSON.parse on an unbounded input is
  // itself a way to outrun the hook limit, and a killed hook allows the action.
  const input = await readHookInputBounded();
  if (input.failed) {
    writeDenial(`CODEX PRODUCTION GATE: hook input could not be read (${input.failed}), so the action is denied (fail closed).`);
    return;
  }
  const raw = input.text;
  if (input.tooLarge) {
    writeDenial(
      "CODEX PRODUCTION GATE: this tool call is too large to inspect safely (its hook input is over " +
      `${MAX_HOOK_INPUT_LENGTH.toLocaleString("en-US")} bytes). A guard that runs out of time lets the ` +
      "action through, so it is refused instead. Split it into smaller steps, or move long text into a file."
    );
    return;
  }
  let payload;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    writeDenial(`CODEX PRODUCTION GATE: hook input could not be parsed, so the action is denied (fail closed). ${error?.message || error}`);
    return;
  }
  const result = evaluateProductionAction({
    toolName: payload.tool_name ?? payload.toolName ?? "",
    toolInput: payload.tool_input ?? payload.toolInput ?? {},
    eventCwd: payload.cwd ?? "",
    repoDir: process.env.CODEX_PROJECT_DIR || process.cwd(),
    patchRoot: guardCheckoutRoot(),
    patchWorktrees: (root) => repositoryWorktreeRoots(root),
    hardGateDeadlineMs: hookDeadlineMs(CODEX_HOOK_TIMEOUT_MS, CODEX_HOOK_RESERVE_MS),
    findCodeRabbitSkip: (pullRequest, budget) => findCodeRabbitSkip({
      dirs: skipStateDirs([payload.cwd, process.env.CODEX_PROJECT_DIR, process.cwd()], undefined, budget),
      sessionId: payload.session_id ?? payload.sessionId,
      pullRequest,
    }),
  });
  // Codex treats allow payloads as noisy/failed hook output. Silence means allow.
  if (!result.blocked) return;
  writeDenial(result.reason);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    writeDenial(`CODEX PRODUCTION GATE: unexpected guard failure; action denied. ${error?.message || error}`);
  });
}
