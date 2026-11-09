#!/usr/bin/env node
// Usage: npm run pr-readiness -- <pr-number> [<pr-number> ...]
// One read-only block per PR for the merge captain: merge state, checks, whether
// the Codex GitHub App reviewed the exact head, open review threads, and the
// sol-needed verdict. It never pushes, comments or merges; the merge gates still
// decide (`.claude/commands/ship.md` Step 8). There is deliberately no overall
// READY line: this script does not check everything the gates do (Sol, 2026-11-08).
// Exit 0 means every PR was read, not that any is ready.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isCodexBotLogin } from "../.claude/hooks/codex-bot-review-lib.mjs";
import { readTeammateComments } from "../.claude/hooks/teammate-comments-lib.mjs";

const REPO = "croprxsolutions/CRX_Manager_V1.0";
const THREADS_QUERY = `query($n:Int!,$after:String){repository(owner:"croprxsolutions",name:"CRX_Manager_V1.0"){pullRequest(number:$n){
reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated comments(first:1){nodes{author{login} path}}}}}}}`;

// The App leaves either a codex-review-state comment naming the head or a formal review on it.
export function codexReviewedHead(view) {
  const head = String(view.headRefOid || "").toLowerCase();
  if (!head) return false;
  const byComment = (view.comments || []).some((c) => isCodexBotLogin(c.author?.login)
    && new RegExp(`"commit_sha":"${head}"[^}]*"status":"completed"`).test(c.body || ""));
  const byReview = (view.reviews || []).some((r) => isCodexBotLogin(r.author?.login) && r.state !== "PENDING"
    && String(r.commit?.oid || "").toLowerCase() === head);
  return byComment || byReview;
}

export function checkCounts(rollup = []) {
  const bad = [];
  let pending = 0;
  for (const c of rollup) {
    const name = c.name || c.context || "?";
    if (c.__typename === "StatusContext") {
      if (c.state === "PENDING" || c.state === "EXPECTED") pending++;
      else if (c.state !== "SUCCESS") bad.push(name);
    } else if (c.status !== "COMPLETED") pending++;
    else if (!["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion)) bad.push(name);
  }
  return { total: rollup.length, pending, bad };
}

// Outdated threads are left out: they never hold a merge (AGENTS.md, review threads).
export function openThreads(threadsNode) {
  return (threadsNode?.nodes || [])
    .filter((t) => !t.isResolved && !t.isOutdated)
    .map((t) => `${t.comments?.nodes?.[0]?.author?.login || "?"} ${t.comments?.nodes?.[0]?.path || "?"}`);
}

// Issue-level PR comments are invisible to "open threads"; #1650's apply missed one
// (2026-11-08). `teammates` is readTeammateComments' result: null = unreadable.
export function teammateLines(n, teammates) {
  const label = "  unanswered teammate comments";
  if (!teammates) return `${label}: UNREADABLE - NOT READY: read them by hand (gh pr view ${n} --comments)`;
  const { comments, truncated } = teammates;
  const list = comments.map(({ login, url }) => `\n    - @${login} ${url}`).join("");
  if (truncated) return `${label}: ${comments.length} seen, list TRUNCATED - NOT READY: read them by hand (gh pr view ${n} --comments)${list}`;
  if (!comments.length) return `${label}: 0`;
  return `${label}: ${comments.length} - NOT READY: answer each on the PR with its link (gh pr comment ${n} --body "<link> <answer>")${list}`;
}

export function formatBlock(n, view, threadsNode, sol, teammates) {
  const { total, pending, bad } = checkCounts(view.statusCheckRollup);
  const threads = openThreads(threadsNode);
  return [
    `#${n} ${view.title}`,
    `  head=${view.headRefOid} author=${view.author?.login} draft=${view.isDraft} mergeState=${view.mergeStateStatus}`,
    teammateLines(n, teammates),
    `  checks: ${total} total, ${pending} pending, ${bad.length} bad${bad.length ? ` (${bad.join("; ")})` : ""}`,
    `  codex App on head: ${codexReviewedHead(view) ? "yes" : "NO"}`,
    `  open threads: ${threads.length}${threads.map((t) => `\n    - ${t}`).join("")}`,
    `  ${sol}`,
  ].join("\n");
}

function gh(args) {
  const run = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error((run.stderr || "gh failed").trim());
  return run.stdout;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const prs = process.argv.slice(2);
  if (!prs.length || !prs.every((n) => /^\d+$/.test(n))) {
    console.error("usage: npm run pr-readiness -- <pr-number> [<pr-number> ...]");
    process.exit(2);
  }
  let failed = false;
  for (const n of prs) {
    try {
      const view = JSON.parse(gh(["pr", "view", n, "--repo", REPO, "--json",
        "title,author,headRefOid,mergeStateStatus,isDraft,statusCheckRollup,comments,reviews"]));
      const threads = { nodes: [] };
      for (let after = null, page; !page || page.pageInfo.hasNextPage; after = page.pageInfo.endCursor) {
        page = JSON.parse(gh(["api", "graphql", "-F", `n=${n}`, "-f", `query=${THREADS_QUERY}`, ...(after ? ["-f", `after=${after}`] : [])]))
          .data.repository.pullRequest.reviewThreads;
        threads.nodes.push(...page.nodes);
      }
      // sol-needed exits 1 for SOL NEEDED, so read its output, not its exit code.
      const solRun = spawnSync(process.execPath, [fileURLToPath(new URL("./sol-needed.mjs", import.meta.url)), n], { encoding: "utf8" });
      const sol = String(solRun.stdout || "").trim();
      // sol-needed also exits 1 when it cannot read the PR, printing its reason to stderr only.
      if (![0, 1].includes(solRun.status) || !/^(NO )?SOL NEEDED: /.test(sol)) {
        throw new Error(`sol-needed gave no verdict: ${(solRun.stderr || solRun.error?.message || "no output").trim()}`);
      }
      let teammates = null;
      try {
        teammates = readTeammateComments(gh, { owner: "croprxsolutions", name: "CRX_Manager_V1.0", number: Number(n) });
      } catch {} // stays null: printed as UNREADABLE, never as 0
      console.log(formatBlock(n, view, threads, sol, teammates) + "\n");
    } catch (error) {
      failed = true;
      console.log(`#${n} UNREADABLE: ${String(error.message).split(/\r?\n/)[0]}\n`);
    }
  }
  process.exit(failed ? 1 : 0);
}
