#!/usr/bin/env node
// After a clean Sol that covers a PR's current head, add `ready-for-taha` and request Taha's review
// (ship.md › Taha's PRs). The Taha ready bot cannot see Sol proofs, so it leaves Sol-list lane
// PRs to the agent, and agents kept forgetting (Mason labelled #2610 by hand, 2026-11-26).
// Runs when the proof is written (write-codex-push-proof.mjs) and after a push, `gh pr create`
// or `gh pr ready` (posttool-router.mjs), because Sol usually runs before the PR exists.
// Best-effort: never blocks or fails anything. When a clean Sol proof is on disk but the hook cannot
// finish (GitHub slow or behind the push), it prints one line with the manual command instead of staying silent.
// "Covers" is the merge gate's own rule (proofValidForMerge): a clean Sol of this head or of an earlier
// commit of this PR, so a fix pushed after Sol asks Taha again too. Ancestry is asked of GitHub, like the gate.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_REPO_NAME } from "./app-repo-identity.mjs";
import { gitPushCwd, headContainsBaseOnGitHub, isGitPush, mergeBaseOnGitHub, proofSearchDirs, proofValid, proofValidForMerge } from "./codex-push-lib.mjs";
import { prFilesOnGitHub, tahaApprovedOnGitHub, tahaLaneProblem, TAHA_LOGIN } from "./taha-lane-lib.mjs";

const LABEL = "ready-for-taha";
// One deadline for the whole hook (Taha LOW 3). The router's 40 s limit holds the DIRTY-PR warning (up to 15 s)
// plus this; 15 s because gh can take 5-7 s a call on this PC, so 4 s would rarely finish a label.
export const ROUTER_BUDGET_MS = 15_000;
const WRITER_BUDGET_MS = 20_000;
const RETRY_DELAY_MS = 1_500;
const PR_FIELDS = "number,state,isDraft,isCrossRepository,author,headRefName,headRefOid,baseRefName,baseRefOid,commits,reviews";
const isTaha = (login) => String(login ?? "").trim().toLowerCase() === TAHA_LOGIN;
const lower = (sha) => String(sha ?? "").toLowerCase();
const manual = (n) => `gh pr edit ${n ? `${n} ` : ""}--add-label ${LABEL} --add-reviewer TahaKhanAbdalli`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Why this PR should NOT be labelled now, or null when it should. `files()` (GitHub calls) is asked last. */
export function tahaReadyAfterSolProblem({ pr, proofClean, files }) {
  if (pr?.state !== "OPEN") return "no open PR";
  if (pr.isDraft) return "draft";
  if (pr.isCrossRepository) return "from a fork";
  if (isTaha(pr.author?.login) || /^taha\//i.test(pr.headRefName ?? "")) return "Taha's own PR";
  if (!proofClean) return "no clean Sol covers its current head";
  const head = lower(pr.headRefOid);
  if ((pr.reviews ?? []).some((r) => isTaha(r.author?.login) && lower(r.commit?.oid) === head)) return "Taha already reviewed this head";
  if (!tahaLaneProblem({ files: files() })?.files?.length) return "not in Taha's lane";
  return null;
}

function defaultGh(args, cwd, timeout) {
  const run = spawnSync("gh", args, { cwd, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw new Error(String(run.error?.message || run.stderr || "gh failed").trim().split(/\r?\n/)[0]);
  return run.stdout;
}

// A clean Sol proof judged on its own (no ancestry): Sol, high, under 24 h, no owner-accepted findings.
const ownerAccepted = (data) => "owner_accepted" in data || data.carry?.root_review?.owner_accepted === true;
const cleanSolShape = (data, now) => Boolean(data) && !ownerAccepted(data) && proofValid(data, lower(data.head_sha), now, String(data.base_sha || ""));

/**
 * Does a clean Sol proof cover the PR's current head the way the merge gate counts it (this head, or an earlier
 * commit of this PR)? true / false, or null when a clean Sol proof exists but `isAncestor` / `mergeBase`
 * could not answer (they return null then), so the caller says so instead of staying silent.
 */
export function solCoversHead({ pr, readProof, isAncestor, mergeBase, now = Date.now() }) {
  const commits = [...new Set([pr.headRefOid, ...(pr.commits ?? []).map((c) => c?.oid)].map(lower).filter(Boolean))];
  const prCommits = new Set(commits);
  let unsure = false;
  const watch = (fn) => (...args) => { const answer = fn(...args); if (answer === null || answer === undefined) unsure = true; return answer; };
  const covered = commits.some((sha) => {
    const data = readProof(sha);
    return cleanSolShape(data, now) && proofValidForMerge({ data, headSha: pr.headRefOid, nowMs: now, baseSha: pr.baseRefOid,
      isAncestor: watch(isAncestor), mergeBase: watch(mergeBase), prCommits, baseRef: pr.baseRefName });
  });
  return covered ? true : unsure ? null : false;
}

/** Reads the review proof for a commit from this checkout and every worktree of it (the merge gate's search). */
export function proofReader(root, listWorktrees = () => {
  const run = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 3_000, windowsHide: true });
  if (run.status !== 0) throw new Error("git worktree list failed");
  return run.stdout;
}) {
  const dirs = proofSearchDirs(root, listWorktrees);
  return (sha) => {
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    for (const dir of dirs) {
      try { return JSON.parse(readFileSync(path.join(dir, `codex-review-${sha}.json`), "utf8")); } catch { /* next checkout */ }
    }
    return null;
  };
}

/** The merge gate's GitHub-backed ancestry (works whether or not this checkout fetched the base); null when GitHub cannot say. */
export function githubAncestry(gh) {
  const ask = (fn) => { try { return fn(); } catch { return null; } };
  return {
    isAncestor: (a, b) => ask(() => headContainsBaseOnGitHub({ baseSha: a, headSha: b, repo: undefined, gh })),
    mergeBase: (a, b) => ask(() => mergeBaseOnGitHub({ baseSha: b, headSha: a, repo: undefined, gh })),
  };
}

/**
 * Label + request Taha for the PR of `cwd`'s current branch when every condition holds.
 * `headSha` (the local HEAD) must equal the PR's head; GitHub may lag a push, so it is asked once more.
 * Returns a one-line note, or "" when nothing was due.
 */
export function askTahaAfterSol({ cwd, headSha = null, gh = defaultGh, readProof = null, now = Date.now(),
  budgetMs = WRITER_BUDGET_MS, retryDelayMs = RETRY_DELAY_MS, wait = sleep }) {
  // Only this app's checkouts (a fast local check; also keeps throwaway test repos off GitHub).
  if (gh === defaultGh && !String(spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", windowsHide: true }).stdout).includes(APP_REPO_NAME)) return "";
  const deadline = Date.now() + budgetMs;
  const call = (args) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("ran out of time");
    return gh(args, cwd, Math.max(1, left));
  };
  let reader = readProof;
  const read = (sha) => (reader ??= proofReader(cwd))(sha);
  // Silent unless a clean Sol proof of one of these commits is on disk: then something may be due, so say so.
  const notYet = (n, why, shas) => (shas.map(lower).some((sha) => cleanSolShape(read(sha), now))
    ? `PR #${n ?? "?"}: not labelled for Taha yet (${why}); run: ${manual(n)}` : "");
  const view = () => JSON.parse(call(["pr", "view", "--json", PR_FIELDS]));

  let pr;
  try { pr = view(); } catch (error) {
    return /no (open )?pull requests? found/i.test(error.message) ? "" : notYet(null, `GitHub did not answer: ${error.message}`, [headSha].filter(Boolean));
  }
  if (headSha && lower(pr.headRefOid) !== lower(headSha)) {
    if (deadline - Date.now() > retryDelayMs + 1_000) {
      wait(retryDelayMs);
      try { pr = view(); } catch { /* judged below */ }
    }
    if (lower(pr.headRefOid) !== lower(headSha)) {
      return notYet(pr.number, "GitHub does not show the pushed commit yet", [headSha, pr.headRefOid, ...(pr.commits ?? []).map((c) => c?.oid)]);
    }
  }
  try {
    const { isAncestor, mergeBase } = githubAncestry(call);
    const covered = pr?.state === "OPEN" ? solCoversHead({ pr, readProof: read, isAncestor, mergeBase, now }) : false;
    const files = () => prFilesOnGitHub({ repo: undefined, gh: call, number: pr.number, headSha: pr.headRefOid });
    if (tahaReadyAfterSolProblem({ pr, proofClean: covered !== false, files })) return "";
    // His Approve of an earlier commit still counts after a staging catch-up, docs/ note or restamp (taha-ready.mjs
    // tahaVerdict; Taha MED 1). Asked only when he approved some commit (a push dismisses it): it costs several calls.
    const approvedEarlier = (pr.reviews ?? []).some((r) => isTaha(r.author?.login) && ["APPROVED", "DISMISSED"].includes(r.state));
    if (approvedEarlier && tahaApprovedOnGitHub({ repo: undefined, gh: call, pullRequest: pr.number, headSha: pr.headRefOid })) return "";
    if (Date.now() >= deadline) return `PR #${pr.number}: not labelled for Taha yet (ran out of time checking his earlier sign-off); run: ${manual(pr.number)}`;
    if (covered === null) return `PR #${pr.number}: not labelled for Taha yet (GitHub could not confirm the Sol covers this head); run: ${manual(pr.number)}`;
    call(["api", `repos/{owner}/{repo}/issues/${pr.number}/labels`, "-f", `labels[]=${LABEL}`]);
    call(["api", `repos/{owner}/{repo}/pulls/${pr.number}/requested_reviewers`, "-f", "reviewers[]=TahaKhanAbdalli"]);
    return `PR #${pr.number}: a clean Sol covers its current head, so it is now labelled ${LABEL} and Taha is asked to review.`;
  } catch (error) {
    return `PR #${pr.number}: could not label it for Taha automatically (${error.message}); run: ${manual(pr.number)}`;
  }
}

function routedPayload() {
  if (globalThis.__CRX_ROUTED_HOOK_PAYLOAD) return globalThis.__CRX_ROUTED_HOOK_PAYLOAD;
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) return null;
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return null; }
}

const input = routedPayload();
const command = String(input?.tool_input?.command || "");
if (command) {
  const base = input.cwd || input.tool_input?.cwd || process.cwd();
  const cwd = isGitPush(command) ? gitPushCwd(command, base, command) : path.resolve(base);
  // The local HEAD, so a PR GitHub has not yet moved to the pushed commit is not judged on its old head.
  const head = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 2_000, windowsHide: true }).stdout?.trim();
  const note = head ? askTahaAfterSol({ cwd, headSha: head, budgetMs: ROUTER_BUDGET_MS }) : "";
  if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } }));
}
