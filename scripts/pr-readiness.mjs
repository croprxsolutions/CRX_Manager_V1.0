#!/usr/bin/env node
// Usage: npm run pr-readiness -- <pr-number> [<pr-number> ...]
// One read-only block per PR for the merge captain: merge state, checks, whether
// the Codex GitHub App reviewed the exact head, open review threads, and the
// sol-needed verdict. It never pushes, comments or merges; the merge gates still
// decide (`.claude/commands/ship.md` Step 8).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isCodexBotLogin } from "../.claude/hooks/codex-bot-review-lib.mjs";

const REPO = "croprxsolutions/CRX_Manager_V1.0";
const THREADS_QUERY = `query($n:Int!){repository(owner:"croprxsolutions",name:"CRX_Manager_V1.0"){pullRequest(number:$n){
reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved isOutdated comments(first:1){nodes{author{login} path}}}}}}}`;

// The App leaves either a codex-review-state comment naming the head or a formal review on it.
export function codexReviewedHead(view) {
  const head = String(view.headRefOid || "").toLowerCase();
  if (!head) return false;
  const byComment = (view.comments || []).some((c) => isCodexBotLogin(c.author?.login)
    && new RegExp(`"commit_sha":"${head}"[^}]*"status":"completed"`).test(c.body || ""));
  const byReview = (view.reviews || []).some((r) => isCodexBotLogin(r.author?.login)
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

export function openThreads(threadsNode) {
  return (threadsNode?.nodes || [])
    .filter((t) => !t.isResolved && !t.isOutdated)
    .map((t) => `${t.comments?.nodes?.[0]?.author?.login || "?"} ${t.comments?.nodes?.[0]?.path || "?"}`);
}

export function formatBlock(n, view, threadsNode, sol) {
  const { total, pending, bad } = checkCounts(view.statusCheckRollup);
  const threads = openThreads(threadsNode);
  const more = threadsNode?.pageInfo?.hasNextPage ? " (first 100 threads only)" : "";
  return [
    `#${n} ${view.title}`,
    `  head=${view.headRefOid} author=${view.author?.login} draft=${view.isDraft} mergeState=${view.mergeStateStatus}`,
    `  checks: ${total} total, ${pending} pending, ${bad.length} bad${bad.length ? ` (${bad.join("; ")})` : ""}`,
    `  codex App on head: ${codexReviewedHead(view) ? "yes" : "NO"}`,
    `  open threads: ${threads.length}${more}${threads.map((t) => `\n    - ${t}`).join("")}`,
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
      const threads = JSON.parse(gh(["api", "graphql", "-F", `n=${n}`, "-f", `query=${THREADS_QUERY}`]))
        .data.repository.pullRequest.reviewThreads;
      // sol-needed exits 1 for SOL NEEDED, so read its output, not its exit code.
      const solRun = spawnSync(process.execPath, [fileURLToPath(new URL("./sol-needed.mjs", import.meta.url)), n], { encoding: "utf8" });
      const sol = (solRun.stdout || solRun.stderr || "SOL NEEDED: sol-needed printed nothing").trim();
      console.log(formatBlock(n, view, threads, sol) + "\n");
    } catch (error) {
      failed = true;
      console.log(`#${n} UNREADABLE: ${String(error.message).split(/\r?\n/)[0]}\n`);
    }
  }
  process.exit(failed ? 1 : 0);
}
