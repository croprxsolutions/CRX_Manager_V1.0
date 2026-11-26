#!/usr/bin/env node
// After a clean Sol that covers a PR's current head, add `ready-for-taha` and request Taha's review
// (ship.md › Taha's PRs). The Taha ready bot cannot see Sol proofs, so it leaves Sol-list lane
// PRs to the agent, and agents kept forgetting (Mason labelled #2610 by hand, 2026-11-26).
// Runs when the proof is written (write-codex-push-proof.mjs) and after a push, `gh pr create`
// or `gh pr ready` (posttool-router.mjs), because Sol usually runs before the PR exists.
// Best-effort: never blocks or fails anything; a gh failure prints one line with the manual command.
// "Covers" is the merge gate's own rule (proofValidForMerge): a clean Sol of this head or of an earlier
// commit of this PR, so a fix pushed after Sol asks Taha again too.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_REPO_NAME } from "./app-repo-identity.mjs";
import { gitPushCwd, isGitPush, proofSearchDirs, proofValidForMerge } from "./codex-push-lib.mjs";
import { prFilesOnGitHub, tahaLaneProblem, TAHA_LOGIN } from "./taha-lane-lib.mjs";

const LABEL = "ready-for-taha";
const GH_TIMEOUT_MS = 6_000;
const isTaha = (login) => String(login ?? "").trim().toLowerCase() === TAHA_LOGIN;

/** Why this PR should NOT be labelled now, or null when it should. `files()` (GitHub calls) is asked last. */
export function tahaReadyAfterSolProblem({ pr, proofClean, files }) {
  if (pr?.state !== "OPEN") return "no open PR";
  if (pr.isDraft) return "draft";
  if (pr.isCrossRepository) return "from a fork";
  if (isTaha(pr.author?.login) || /^taha\//i.test(pr.headRefName ?? "")) return "Taha's own PR";
  if (!proofClean) return "no clean Sol covers its current head";
  const head = String(pr.headRefOid ?? "").toLowerCase();
  if ((pr.reviews ?? []).some((r) => isTaha(r.author?.login) && String(r.commit?.oid ?? "").toLowerCase() === head)) return "Taha already reviewed this head";
  if (!tahaLaneProblem({ files: files() })?.files?.length) return "not in Taha's lane";
  return null;
}

function defaultGh(args, cwd) {
  const run = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw new Error(String(run.error?.message || run.stderr || "gh failed").trim().split(/\r?\n/)[0]);
  return run.stdout;
}

/**
 * True when a clean Sol proof covers the PR's current head the way the merge gate counts it: this head, or an
 * earlier commit of this PR. Proofs with BLOCKER/HIGH findings Mason accepted are valid for merge but not "clean" here.
 * `readProof(sha)` returns the parsed proof or null; `isAncestor` / `mergeBase` answer from git (null when unsure).
 */
export function solCoversHead({ pr, readProof, isAncestor, mergeBase, now = Date.now() }) {
  const commits = [...new Set([pr.headRefOid, ...(pr.commits ?? []).map((c) => c?.oid)].map((sha) => String(sha ?? "").toLowerCase()).filter(Boolean))];
  const prCommits = new Set(commits);
  return commits.some((sha) => {
    const data = readProof(sha);
    return Boolean(data) && !("owner_accepted" in data) && data.carry?.root_review?.owner_accepted !== true
      && proofValidForMerge({ data, headSha: pr.headRefOid, nowMs: now, baseSha: pr.baseRefOid, isAncestor, mergeBase, prCommits, baseRef: pr.baseRefName });
  });
}

function cleanSolProof(root, pr, now) {
  const git = (args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: GH_TIMEOUT_MS, windowsHide: true });
  const dirs = proofSearchDirs(root, () => {
    const run = git(["worktree", "list", "--porcelain"]);
    if (run.status !== 0) throw new Error("git worktree list failed");
    return run.stdout;
  });
  const readProof = (sha) => {
    for (const dir of dirs) {
      try { return JSON.parse(readFileSync(path.join(dir, `codex-review-${sha}.json`), "utf8")); } catch { /* next checkout */ }
    }
    return null;
  };
  // Local git has the pushed commits; one it lacks answers null, which refuses.
  const isAncestor = (a, b) => { const r = git(["merge-base", "--is-ancestor", a, b]).status; return r === 0 ? true : r === 1 ? false : null; };
  const mergeBase = (a, b) => { const r = git(["merge-base", a, b]); return r.status === 0 ? r.stdout.trim() : null; };
  return solCoversHead({ pr, readProof, isAncestor, mergeBase, now });
}

/**
 * Label + request Taha for the PR of `cwd`'s current branch when every condition holds.
 * `headSha` (from the proof writer) must equal the PR's head. Returns a one-line note, or "" when nothing was due.
 */
export function askTahaAfterSol({ cwd, headSha = null, gh = defaultGh, hasCleanSol = cleanSolProof, now = Date.now() }) {
  // Only this app's checkouts (a fast local check; also keeps throwaway test repos off GitHub).
  if (gh === defaultGh && !String(spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", windowsHide: true }).stdout).includes(APP_REPO_NAME)) return "";
  let pr;
  try {
    pr = JSON.parse(gh(["pr", "view", "--json", "number,state,isDraft,isCrossRepository,author,headRefName,headRefOid,baseRefName,baseRefOid,commits,reviews"], cwd));
  } catch { return ""; } // no PR for this branch (yet), or GitHub unreachable
  if (headSha && String(pr.headRefOid).toLowerCase() !== String(headSha).toLowerCase()) return "";
  const manual = `gh pr edit ${pr.number} --add-label ${LABEL} --add-reviewer TahaKhanAbdalli`;
  try {
    const proofClean = pr?.state === "OPEN" && hasCleanSol(cwd, pr, now);
    const files = () => prFilesOnGitHub({ repo: undefined, gh: (args) => gh(args, cwd), number: pr.number, headSha: pr.headRefOid });
    if (tahaReadyAfterSolProblem({ pr, proofClean, files })) return "";
    gh(["api", `repos/{owner}/{repo}/issues/${pr.number}/labels`, "-f", `labels[]=${LABEL}`], cwd);
    gh(["api", `repos/{owner}/{repo}/pulls/${pr.number}/requested_reviewers`, "-f", "reviewers[]=TahaKhanAbdalli"], cwd);
    return `PR #${pr.number}: a clean Sol covers its current head, so it is now labelled ${LABEL} and Taha is asked to review.`;
  } catch (error) {
    return `PR #${pr.number}: could not label it for Taha automatically (${error.message}); run: ${manual}`;
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
  const head = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout?.trim();
  const note = head ? askTahaAfterSol({ cwd, headSha: head }) : "";
  if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } }));
}
