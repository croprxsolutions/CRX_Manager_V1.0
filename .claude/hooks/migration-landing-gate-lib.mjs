// MIGRATION LANDING GATE (Mason's autonomous-landing rule, 2026-09-26).
//
// The rule lets an agent apply a NON-destructive migration live with no in-chat
// ask — but only "under the same conditions" as an agent merge: the exact-SHA
// Sol review of the frozen final head is clean and every check is green.
// (CodeRabbit's approval was one of those conditions until Mason made CodeRabbit
// advisory on 2026-10-19.) The migration's own reviewer + Sol proofs (the rest
// of migration-apply-lib.mjs) prove the SQL was reviewed; they say nothing about
// the pull request carrying it. Sol's exact-SHA review of the introducing PR
// (HIGH, 2026-09-26) found exactly that gap: a migration could reach production
// before the PR's final reviews. This binds the apply to them.
//
// The apply must come from a checkout of the PR's branch where:
//   * the migration file is committed at HEAD and unchanged in the worktree, so
//     the SQL being applied is the SQL in the reviewed commit;
//   * HEAD is the open PR's headRefOid, and the PR targets main;
//   * CodeRabbit's latest verdict is APPROVED on that exact head, nothing is
//     CHANGES_REQUESTED, and the newest run of every check is green (CLEAN);
//   * a fresh gpt-6-sol/high merge proof is bound to that head and to GitHub's
//     real base — the same proof the merge gates require.
// Anything unreadable fails CLOSED. The same predicates as the merge gates are
// imported, never re-derived.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  headContainsBaseOnGitHub,
  proofSearchDirs,
  proofValid,
  newestCheckRollup,
  pullRequestChecksGreen,
  pullRequestReviewBlocked,
} from "./codex-push-lib.mjs";
import {
  CODEX_THREADS_QUERY,
  CODEX_THREAD_PAGE_SIZE,
  coderabbitThreadCount,
  readCodeRabbitRequirement,
  collectCodexThreads,
} from "./codex-bot-review-lib.mjs";
import { findCodeRabbitSkip, skipPullRequestFor, skipStateDirs } from "./coderabbit-skip-lib.mjs";
import { readTeammateComments, teammateCommentsDenial, READY_TO_MERGE_LINE } from "./teammate-comments-lib.mjs";

const PROTECTED_BRANCH_RE = /^(?:main|master|production)$/i;
// A live apply accepts the same 24-hour exact-head Sol proof as the merge gates
// (Mason, 2026-10-29, superseding his 2026-10-23 "Keep migration apply at 30
// minutes"). The PR's head, checks and reviews are still read live at apply time.
export const APPLY_SOL_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// TAHA'S 4-HOUR HOLD (Mason, 2026-11-06; enforced 2026-11-08 at Taha's request,
// after DM-1 #1634 and KI-30 #1653 were applied live within an hour of opening).
// Every migration sits under supabase/, which is on the Sol list, so every PR this
// gate sees is held: no live apply until Taha has posted a review or comment on it,
// or 4 hours have passed since it opened. Mason's "I approve" does not lift it (the
// owner-approval check runs only after this gate passes). Taha's own PRs are his.
export const TAHA_LOGIN = "tahakhanabdalli";
export const TAHA_HOLD_MS = 4 * 60 * 60 * 1000;

// Returns null when the hold is over, else why the apply must wait. `pr` is the
// `gh pr view --json author,createdAt,reviews,comments` answer.
export function tahaHoldProblem(pr, now = Date.now()) {
  const isTaha = (node) => String(node?.author?.login ?? "").trim().toLowerCase() === TAHA_LOGIN;
  if (isTaha(pr)) return null;
  const opened = Date.parse(String(pr?.createdAt ?? ""));
  if (!Number.isFinite(opened) || !Array.isArray(pr?.reviews) || !Array.isArray(pr?.comments)) {
    return "GitHub did not say when this PR opened or who has commented on it, so Taha's 4-hour review hold cannot be checked (fail closed).";
  }
  if (now - opened >= TAHA_HOLD_MS) return null;
  // A PENDING review is a draft only Taha can see; it is not posted yet.
  if (pr.reviews.some((r) => isTaha(r) && String(r?.state ?? "").toUpperCase() !== "PENDING")) return null;
  if (pr.comments.some(isTaha)) return null;
  const waitMin = Math.ceil((TAHA_HOLD_MS - Math.max(0, now - opened)) / 60_000);
  return `Taha's 4-hour review hold is still on (ship.md Step 8 item 4a): the PR opened ${Math.floor(Math.max(0, now - opened) / 60_000)} minutes ago and Taha (TahaKhanAbdalli) has not posted a review or comment on it. ` +
    `Wait about ${waitMin} more minutes or for his review, then re-run. Mason's chat approval does not lift this hold.`;
}

// #1838 (Taha's choice, 13 Nov 2026): an agent applies a release or hotfix migration live only while Taha is there
// to merge right after, so live never runs the old app on the new database for long. His go-ahead is a PR comment
// from his own account (Mason's is the one his agents share), naming the PR's current head, at most 30 minutes old.
export const READY_WINDOW_MS = 30 * 60_000;
export function readyToMergeProblem({ comments, head, now = Date.now() }) {
  if (!Array.isArray(comments)) return "GitHub did not list the PR's comments, so Taha's go-ahead cannot be checked (fail closed).";
  const fresh = comments.some((c) => {
    const m = READY_TO_MERGE_LINE.exec(String(c?.body ?? ""));
    const at = Date.parse(String(c?.createdAt ?? ""));
    return m && String(c?.author?.login ?? "").trim().toLowerCase() === TAHA_LOGIN &&
      String(head).toLowerCase().startsWith(m[1].toLowerCase()) && Number.isFinite(at) && now - at <= READY_WINDOW_MS && at - now <= 60_000;
  });
  return fresh ? null
    : `Taha hasn't given the go-ahead for this head: he comments \`Ready to merge: ${String(head).slice(0, 12)}\` on the PR when he's there to merge right after, and an agent applies within 30 minutes of it (ship.md › Staging). Ask him, then retry.`;
}

function refuse(why) {
  return {
    ok: false,
    reason:
      `MIGRATION LANDING GATE: ${why}\n\n` +
      `Under Mason's autonomous-landing rule (2026-09-26) a live apply happens only after the pull request ` +
      `that carries the migration is ready to merge: every check is green, no review asks for changes, ` +
      `and a fresh exact-SHA gpt-6-sol proof (node scripts/write-codex-push-proof.mjs) is bound to that ` +
      `head. Apply from a clean checkout of the PR's branch with the migration committed, then merge right ` +
      `after. A destructive migration never applies through an agent — it is parked for Mason.`,
  };
}

export function evaluateLandingGate({
  checkoutDir,
  migName,
  // sha256 of the EXACT SQL being transmitted. The committed migration at the
  // PR's head must hash to the same value (Sol HIGH, round 2): checking only that
  // a same-named file is committed let different SQL — e.g. a same-named file the
  // source resolver found in another checkout — ride on this PR's approvals.
  queryHash,
  now = Date.now(),
  // Wall-clock deadline for EVERY git/gh call below (Sol HIGH, 2026-09-26). The
  // PreToolUse hook is killed at 15 seconds and a killed hook ALLOWS, so each call
  // is capped by the time left and the gate refuses — while it can still say so —
  // once too little remains. Callers with no hook timeout get a minute.
  deadlineMs,
  clock = () => Date.now(),
  runGit,
  runGh,
  listWorktrees,
  // The Claude Code session running the apply: Mason's "skip coderabbit" waiver
  // counts only in the session he said it in (coderabbit-skip-lib.mjs).
  sessionId,
} = {}) {
  const dir = String(checkoutDir || "");
  if (!dir) return refuse("the checkout the apply runs from is unknown (fail closed).");
  if (!/^[0-9a-f]{64}$/i.test(String(queryHash || ""))) {
    return refuse("the SQL being applied has no content hash to bind to the reviewed commit (fail closed).");
  }
  const deadline = Number.isFinite(deadlineMs) ? deadlineMs : clock() + 60_000;
  const RESERVE_MS = 500;
  const MIN_CALL_MS = 1_000;
  const left = () => deadline - clock() - RESERVE_MS;
  const OUT_OF_TIME = "ran out of time before every PR check finished; a hook cut off mid-check would ALLOW, so this refuses (fail closed). Retry, or apply through scripts/apply-migration-file.mjs, which has no hook time limit.";
  // Raw output: `git show` content must not be trimmed before it is hashed.
  const rawGit = runGit || ((args) => execFileSync("git", args, {
    cwd: dir, encoding: "utf8", timeout: Math.min(10_000, left()), stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
  }));
  const rawGh = runGh || ((args) => execFileSync("gh", args, {
    cwd: dir, encoding: "utf8", timeout: Math.min(15_000, left()), stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024,
  }));
  class OutOfTime extends Error {}
  const timed = (call) => (args) => {
    if (left() < MIN_CALL_MS) throw new OutOfTime(OUT_OF_TIME);
    return call(args);
  };
  const git = timed(rawGit);
  const gh = timed(rawGh);
  try {
    return evaluate({ dir, migName, queryHash, now, git, gh, listWorktrees, sessionId });
  } catch (error) {
    if (error instanceof OutOfTime) return refuse(OUT_OF_TIME);
    return refuse(`the check itself failed (${error?.message || error}); fail closed.`);
  }
}

// Mason's agents, 2026-11-12 (#1838 HIGH 1): a hotfix migration applied live with a stamp above a migration that
// is waiting on staging for the release makes that one older than live's newest, so live's ordering guard refuses
// it on release day. Only waiting migrations stamped above main's newest count: one stamped below it is already
// out of order and needs its own restamp. null when the hotfix stamp is fine, otherwise why not.
// RELEASE_FLOW switched on (Taha, 13 Nov 2026, 05:16:22 UTC).
export const RELEASE_FLOW_ON_AT = "2026-11-13T05:16:22Z";

export function hotfixStampProblem({ stamp, mainFiles, stagingFiles }) {
  const stampOf = (f) => (/^(\d{14})_/.exec(String(f)) || [])[1];
  const onMain = new Set(mainFiles);
  const mainTop = mainFiles.map(stampOf).filter(Boolean).sort().pop() || "";
  const waiting = stagingFiles.filter((f) => !onMain.has(f)).map(stampOf).filter((s) => s && s > mainTop).sort();
  if (!waiting.length || stamp < waiting[0]) return null;
  return `its stamp ${stamp} is not below ${waiting[0]}, a migration waiting on staging for the release, so live would refuse that one on release day. Restamp this hotfix between main's newest (${mainTop}) and ${waiting[0]}: node scripts/next-migration-stamp.mjs --hotfix`;
}

function evaluate({ dir, migName, queryHash, now, git, gh, listWorktrees, sessionId }) {
  const OUT = (error) => error?.constructor?.name === "OutOfTime";

  const stem = path.basename(String(migName || "")).replace(/\.sql$/i, "");
  if (!stem) return refuse("the migration name is missing (fail closed).");
  const rel = `supabase/migrations/${stem}.sql`;

  let head;
  let branch;
  try {
    head = String(git(["rev-parse", "HEAD"])).trim();
    branch = String(git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch (error) {
    if (OUT(error)) throw error;
    return refuse(`could not read this checkout's HEAD (${error?.message || error}).`);
  }
  if (!/^[0-9a-f]{40}$/i.test(head)) return refuse("this checkout's HEAD is not a commit.");
  if (!branch || branch === "HEAD" || PROTECTED_BRANCH_RE.test(branch)) {
    return refuse(`the apply runs from ${!branch || branch === "HEAD" ? "a detached HEAD" : `"${branch}"`}, not from the pull request's own branch.`);
  }

  let committed;
  try {
    committed = git(["show", `HEAD:${rel}`]);
  } catch (error) {
    if (OUT(error)) throw error;
    return refuse(`${rel} is not committed at HEAD ${head.slice(0, 12)}, so the SQL cannot be the reviewed SQL.`);
  }
  // The same normalization scripts/apply-migration-file.mjs applies before hashing
  // and transmitting (CRLF → LF), so equal bytes on disk always compare equal.
  const committedHash = createHash("sha256").update(String(committed).replace(/\r\n/g, "\n")).digest("hex");
  if (committedHash !== String(queryHash).toLowerCase()) {
    return refuse(`the SQL being applied is not byte-identical to ${rel} in the reviewed commit ${head.slice(0, 12)} (committed ${committedHash.slice(0, 12)}, transmitted ${String(queryHash).slice(0, 12)}).`);
  }
  let dirty;
  try {
    dirty = String(git(["status", "--porcelain", "--untracked-files=all", "--", rel])).trim();
  } catch (error) {
    if (OUT(error)) throw error;
    return refuse(`could not confirm ${rel} is unchanged since HEAD (${error?.message || error}).`);
  }
  if (dirty) return refuse(`${rel} has uncommitted changes, so the SQL being applied is not the reviewed commit.`);

  let pr;
  try {
    pr = JSON.parse(gh(["pr", "view", branch, "--json",
      "number,url,state,isCrossRepository,baseRefName,baseRefOid,headRefName,headRefOid,mergeStateStatus,reviewDecision,reviews,statusCheckRollup,author,createdAt,comments"]));
  } catch (error) {
    if (OUT(error)) throw error;
    return refuse(`could not find or read the open pull request for branch "${branch}" (${error?.message || error}).`);
  }
  const number = pr?.number ? `#${pr.number}` : "the pull request";
  if (String(pr?.state || "").toUpperCase() !== "OPEN") return refuse(`${number} is not open.`);
  // Staging-first: a migration PR into staging is never applied live before its merge; the
  // staging database job applies it after the merge, and live gets it at release time. Only a
  // PR into main (the release PR or a hotfix, below) is applied live before its merge (ship.md › Staging).
  if (String(pr?.baseRefName || "").toLowerCase() !== "main") {
    return refuse(`${number} does not target main. A migration PR into staging is not applied live before its merge: the staging database job applies it after the merge, and live gets it at release time (ship.md › Staging). Only the release PR or a hotfix PR into main is applied live first.`);
  }
  // Into main, only the weekly release (release/next) and a hotfix are applied live before their merge
  // (Mason's Decision A, 2026-11-12: his agents apply a release's migrations from the release PR, in stamp
  // order). Any other branch into main is not allowed at all.
  // #1838 LOW 1: a fork's release/next or hotfix/<name> is not this repository's.
  if (pr?.isCrossRepository !== false) return refuse(`${number} comes from a fork, or GitHub didn't say it doesn't; only this repository's branches are applied live.`);
  const headRef = String(pr?.headRefName || "");
  if (headRef !== "release/next" && !/^hotfix\/[^/]+$/.test(headRef)) {
    return refuse(`${number} is not the release PR (release/next) or a hotfix/<name> PR. Into main, only those are applied live before their merge; feature work goes to staging (ship.md › Staging).`);
  }
  if (headRef !== "release/next") {
    let trees;
    try {
      // Documented route: the directory's tree id from the contents API, then that tree (no ref:path ids).
      const names = (branch) => {
        const dirSha = String(gh(["api", `repos/{owner}/{repo}/contents/supabase?ref=${branch}`, "--jq", '.[] | select(.path == "supabase/migrations" and .type == "dir") | .sha'])).trim();
        if (!/^[0-9a-f]{40}$/i.test(dirSha)) throw new Error(`no supabase/migrations directory on ${branch}`);
        return String(gh(["api", `repos/{owner}/{repo}/git/trees/${dirSha}`, "--jq", "if .truncated then error(\"truncated\") else .tree[].path end"])).split(/\r?\n/).filter(Boolean);
      };
      trees = { mainFiles: names("main"), stagingFiles: names("staging") };
    } catch (error) {
      if (OUT(error)) throw error;
      return refuse(`could not list the migrations on main and staging to check this hotfix's stamp against the release (${error?.message || error}); fail closed.`);
    }
    if (!trees.mainFiles.length || !trees.stagingFiles.length) return refuse("GitHub listed no migrations on main or staging (fail closed).");
    const stampProblem = hotfixStampProblem({ stamp: stem.slice(0, 14), ...trees });
    if (stampProblem) return refuse(`${number}: ${stampProblem}`);
  }
  if (String(pr?.headRefOid || "").toLowerCase() !== head.toLowerCase()) {
    return refuse(`${number}'s head on GitHub (${String(pr?.headRefOid || "?").slice(0, 12)}) is not this checkout's HEAD (${head.slice(0, 12)}) — push, or pull, so the reviewed commit is the one applied.`);
  }
  const hold = tahaHoldProblem(pr, now);
  if (hold) return refuse(`${number}: ${hold}`);
  const ready = readyToMergeProblem({ comments: pr?.comments, head, now });
  if (ready) return refuse(`${number}: ${ready}`);
  if (pullRequestReviewBlocked(pr)) return refuse(`${number} has an unresolved CHANGES_REQUESTED review.`);
  if (!pullRequestChecksGreen(pr)) {
    return refuse(`${number} is not merge-ready: mergeStateStatus must be CLEAN and the newest run of every check green.`);
  }
  // The name alone proves nothing: main's release guard checks that release/next is exactly staging + main
  // (plus the bot's version files) and that a hotfix carries no unreleased staging work. Its run on this
  // head must be there and green, not merely absent. A PR could add a job with that name, or edit the
  // workflow: both are under .github/, which needs a code owner's review on main, and mergeStateStatus
  // (CLEAN, checked above) is not CLEAN without it.
  const guard = (newestCheckRollup(pr?.statusCheckRollup) || []).filter((c) => c?.__typename === "CheckRun" && c?.workflowName === "Release flow" && c?.name === "Release flow guard (main)");
  if (!guard.length || !guard.every((c) => String(c.status || "").toUpperCase() === "COMPLETED" && String(c.conclusion || "").toUpperCase() === "SUCCESS")) {
    return refuse(`${number} has no green "Release flow guard (main)" check, so it is not proven to carry only what it should. Wait for it, or fix what it reports.`);
  }
  // Sol, #1838: before switch-on the guard passed without checking anything, so only a run started after it counts.
  if (!guard.every((c) => Date.parse(String(c.startedAt || "")) > Date.parse(RELEASE_FLOW_ON_AT))) {
    return refuse(`${number}'s "Release flow guard (main)" result is from before the release flow was switched on (${RELEASE_FLOW_ON_AT}), when it checked nothing. Re-run that check, then retry.`);
  }
  // #1838 HIGH 2: GitHub runs the PR's own copy of the workflows, so a PR that changes .github/workflows could
  // change (or imitate) the guard it is judged by. Its migrations wait until that change has been reviewed onto main.
  let workflowsHere;
  let workflowsOnMain;
  try {
    workflowsHere = String(git(["rev-parse", "HEAD:.github/workflows"])).trim();
    workflowsOnMain = String(gh(["api", "repos/{owner}/{repo}/contents/.github?ref=main", "--jq", '.[] | select(.name == "workflows" and .type == "dir") | .sha'])).trim();
  } catch (error) {
    if (OUT(error)) throw error;
    return refuse(`could not compare ${number}'s .github/workflows with main's (${error?.message || error}); fail closed.`);
  }
  if (!/^[0-9a-f]{40}$/i.test(workflowsHere) || workflowsHere !== workflowsOnMain) {
    return refuse(`${number} changes .github/workflows, the checks it is judged by, so its migrations are not applied by an agent. Taha or Mason reviews that change onto main first (or applies by hand).`);
  }
  // A money PR needs a completed CodeRabbit review of its head before it merges
  // (Mason, 2026-10-21), so it needs one before its migration applies too —
  // otherwise production could take a migration whose PR cannot merge. Read
  // BEFORE the threads (Codex App P1 on #1009): a review finishing between the
  // two reads would otherwise pair "Review completed" with a stale empty thread list.
  let coderabbitReview;
  try {
    coderabbitReview = readCodeRabbitRequirement(gh, { owner: "{owner}", name: "{repo}", number: pr.number });
  } catch (error) {
    if (OUT(error)) throw error;
    return refuse(`could not read ${number}'s labels, files and commit statuses to check the CodeRabbit review requirement (${error?.message || error}); fail closed.`);
  }
  if (coderabbitReview.status === "unreadable" || coderabbitReview.headOid !== head.toLowerCase()) {
    const why = coderabbitReview.why && coderabbitReview.status === "unreadable" ? ` (${coderabbitReview.why})` : "";
    return refuse(`${number}'s CodeRabbit review requirement could not be read for this exact head${why} (fail closed) — re-run on the current head; do not post a new @coderabbitai request for this.`);
  }
  // Mason's "skip coderabbit" in THIS session waives only the missing review
  // (2026-10-22); the thread check below still runs.
  let skip = null;
  if (coderabbitReview.status === "missing") {
    // Only a waiver naming THIS pull request counts (Mason, 2026-10-22: per PR).
    // Waivers live in the main checkout's state folder, found through git's
    // shared folder, wherever the apply runs from (a subfolder or another
    // worktree: Codex App P2 and the final Sol review on #1035). This gate asks
    // its own deadline-bound git; a failed lookup finds no waiver.
    let common = "";
    try { common = String(git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(); } catch (error) { if (OUT(error)) throw error; }
    const where = skipStateDirs([dir], () => common);
    // A waiver covers this repository's PRs only: GH_REPO or a fork's remote can
    // point gh at another repository whose PR numbers overlap (Codex App P2 on #1035).
    const pullRequest = skipPullRequestFor(pr?.url, pr?.number);
    try { skip = findCodeRabbitSkip({ dirs: where, sessionId, pullRequest, now }); } catch { skip = null; }
  }
  if (coderabbitReview.status === "missing" && !skip) {
    return refuse(`${number} needs a completed CodeRabbit review before its migration applies, because ${coderabbitReview.why}. Post "@coderabbitai full review" once (docs/reference/coderabbit-native-review.md), answer its threads, then re-run.`);
  }
  // CodeRabbit is advisory (2026-10-19), but its unanswered threads block the
  // merge gates, so they block an apply too — otherwise production could take a
  // migration whose PR cannot merge (Luna round 2, HIGH). Unlike the merge gates'
  // fail-open notice, an apply FAILS CLOSED here like every other check in this
  // gate: an unreadable or partly read thread list refuses.
  let threads;
  try {
    threads = collectCodexThreads((cursor) => {
      const args = [
        "api", "graphql",
        "-f", `query=${CODEX_THREADS_QUERY}`,
        "-F", "owner={owner}",
        "-F", "name={repo}",
        "-F", `number=${pr.number}`,
        "-F", `first=${CODEX_THREAD_PAGE_SIZE}`,
      ];
      if (cursor) args.push("-F", `after=${cursor}`);
      return JSON.parse(gh(args))?.data?.repository?.pullRequest;
    });
  } catch (error) {
    if (OUT(error)) throw error;
    return refuse(`could not read ${number}'s review threads to check for unanswered CodeRabbit findings (${error?.message || error}); fail closed.`);
  }
  // The thread answer must describe the SAME head everything above checked
  // (Luna round 8): a push between the two lookups would otherwise apply A's
  // migration on the strength of B's threads.
  if (String(threads.headRefOid || "").toLowerCase() !== head.toLowerCase()) {
    return refuse(`${number}'s head moved while it was being checked (threads read at ${String(threads.headRefOid || "?").slice(0, 12)}, applying ${head.slice(0, 12)}); fail closed — re-run on the current head.`);
  }
  // Same counter as the merge gates: null = unreadable or partial → refuse.
  const coderabbitOpen = coderabbitThreadCount(threads);
  if (coderabbitOpen === null) {
    return refuse(`${number}'s review threads could not be read completely, so unanswered CodeRabbit findings cannot be ruled out (fail closed).`);
  }
  if (coderabbitOpen > 0) {
    return refuse(`${number} has ${coderabbitOpen} unresolved CodeRabbit comment thread(s). Reply on each (the fix or the reason) and resolve it before applying.`);
  }
  // A teammate's unanswered PR comment blocks the merge, so it blocks the apply
  // that runs before the merge (Mason, 2026-11-08): Taha usually posts plain
  // comments, which the CHANGES_REQUESTED check above never sees. Fails closed.
  let teammates;
  try {
    teammates = readTeammateComments(gh, { owner: "{owner}", name: "{repo}", number: pr.number });
  } catch (error) {
    if (OUT(error)) throw error;
    teammates = null;
  }
  if (!teammates) {
    return refuse(`could not read ${number}'s comments, so an unanswered teammate comment (e.g. Taha's) cannot be ruled out (fail closed). Retry; if it keeps failing, read them by hand (gh pr view ${pr.number} --comments).`);
  }
  if (teammates.comments.length > 0) {
    return refuse(teammateCommentsDenial(`${number} — answer before the live apply`, pr.number, teammates.comments));
  }
  if (teammates.truncated) {
    return refuse(`${number} has more comments than the gate reads at once, so an unanswered teammate comment cannot be ruled out (fail closed). Read them by hand and ask Mason.`);
  }

  const baseSha = String(pr?.baseRefOid || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) return refuse(`GitHub returned an unusable base for ${number} (fail closed).`);
  // The head must already contain that base (Sol HIGH, round 7), the same rule as
  // both merge gates: otherwise the merge that follows lands base-only commits the
  // Sol proof never reviewed alongside this migration.
  let headContainsBase = false;
  try {
    headContainsBase = headContainsBaseOnGitHub({ baseSha, headSha: head, gh });
  } catch (error) {
    if (OUT(error)) throw error;
    headContainsBase = false;
  }
  if (!headContainsBase) {
    return refuse(`${number}'s head ${head.slice(0, 12)} does not contain its base ${baseSha.slice(0, 12)}, or GitHub could not confirm it — merge origin/main into the branch, push, and re-run the checks and the Sol review.`);
  }
  // Sol (#1838): the guard proved this release head equals staging + main when it ran. If staging has moved since
  // (and the bot hasn't refreshed release/next yet), that proof is stale: the head must still contain staging's tip.
  if (headRef === "release/next") {
    let stagingTip = "";
    let fresh = false;
    try {
      stagingTip = String(gh(["api", "repos/{owner}/{repo}/commits/staging", "--jq", ".sha"])).trim();
      fresh = /^[0-9a-f]{40}$/i.test(stagingTip) && headContainsBaseOnGitHub({ baseSha: stagingTip, headSha: head, gh });
    } catch (error) {
      if (OUT(error)) throw error;
      fresh = false;
    }
    if (!fresh) {
      return refuse(`${number}'s head ${head.slice(0, 12)} does not contain staging's tip ${stagingTip.slice(0, 12) || "(unreadable)"}: staging moved after the release guard ran. Wait for the bot to refresh release/next (no staging merges during the release), then re-run the checks and Sol.`);
    }
  }
  let proven = false;
  for (const stateDir of proofSearchDirs(dir, listWorktrees || (() => git(["worktree", "list", "--porcelain"])))) {
    try {
      if (!existsSync(stateDir)) continue;
      for (const file of readdirSync(stateDir)) {
        if (!/^codex-review-[A-Za-z0-9_.-]+\.json$/.test(file)) continue;
        let data;
        try { data = JSON.parse(readFileSync(path.join(stateDir, file), "utf8")); } catch { continue; }
        if (proofValid(data, head, now, baseSha, APPLY_SOL_PROOF_MAX_AGE_MS)) { proven = true; break; }
      }
    } catch { /* an unreadable directory holds no proof — keep looking */ }
    if (proven) break;
  }
  if (!proven) {
    return refuse(`no fresh gpt-6-sol/high proof is bound to ${number}'s head ${head.slice(0, 12)} and base ${baseSha.slice(0, 12)}.`);
  }
  return { ok: true, pullRequest: pr.number, head, ...(skip ? { coderabbitSkippedBy: skip } : {}) };
}
