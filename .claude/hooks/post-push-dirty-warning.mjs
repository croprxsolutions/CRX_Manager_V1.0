#!/usr/bin/env node
// PostToolUse after `git push`: warn (never block) when the branch's open PR
// conflicts with its base. A DIRTY PR gets only light GitHub checks, so real
// failures stayed hidden for about an hour on PR #1989. Fails silent on any gh
// error, timeout, or missing PR.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isGitPush, pushDestinationBranches, shellSegments } from "./codex-push-lib.mjs";

const run = promisify(execFile);
// Each gh call is capped, and at most two fit inside the router's 20s hook limit;
// several pushes are asked about in parallel, so each still gets that budget.
const GH_CALL_TIMEOUT_MS = 6_000;
const RETRY_DELAY_MS = 3_000;
const MAX_PUSHES_CHECKED = 3;

// The folder the push ran in: `git -C <dir> push` (the push guard's required
// spelling on this machine) wins over the tool's cwd. Only a -C directly before
// `push` counts, so another command's -C in the same line is ignored.
export function pushDir(command, cwd) {
  const m = /\bgit\s+-C\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))\s+push\b/.exec(String(command || ""));
  const dir = m ? m[2] || m[3] || m[4] : "";
  return dir ? path.resolve(cwd || process.cwd(), dir) : cwd || process.cwd();
}

// Every push in the command (#2014): its folder, and the remote branch it wrote
// (a refspec's destination), or null for the folder's current branch.
export function pushTargets(command, cwd) {
  const seen = new Map();
  for (const segment of shellSegments(String(command || ""))) {
    if (!isGitPush(segment)) continue;
    const dir = pushDir(segment, cwd);
    let branches = [];
    try { branches = pushDestinationBranches(segment, null); } catch { /* unreadable: current branch */ }
    // An all-digit branch would be read by `gh pr view` as a PR number, so it is skipped (Luna r1 LOW).
    for (const branch of (branches.length ? branches : [null]).filter((name) => !/^\d+$/.test(name ?? ""))) seen.set(`${dir}\0${branch}`, { dir, branch });
  }
  // shortcut: only the first three targets are asked about (time limit), so a fourth push or
  // refspec gets no warning; ask in batches if such commands become common.
  return [...seen.values()].slice(0, MAX_PUSHES_CHECKED);
}

async function ghPrState(dir, branch) {
  const args = ["pr", "view", ...(branch ? [branch] : []), "--json", "number,state,mergeStateStatus"];
  const { stdout } = await run("gh", args, {
    cwd: dir, timeout: GH_CALL_TIMEOUT_MS, windowsHide: true,
  });
  return JSON.parse(stdout);
}

// GitHub recomputes mergeability after a push and answers UNKNOWN meanwhile, so
// an UNKNOWN gets one retry.
export async function dirtyWarning(dir, { view = ghPrState, delayMs = RETRY_DELAY_MS, branch = null } = {}) {
  try {
    let pr = await view(dir, branch);
    if (pr?.mergeStateStatus === "UNKNOWN") {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      pr = await view(dir, branch);
    }
    if (pr?.state !== "OPEN" || pr?.mergeStateStatus !== "DIRTY") return "";
    return `⚠️ PR #${pr.number} conflicts with its base; GitHub runs no full CI until you merge the base in.`;
  } catch {
    return "";
  }
}

// Routed: the router's payload. Run directly: stdin. Imported by a test: nothing.
function payload() {
  if (globalThis.__CRX_ROUTED_HOOK_PAYLOAD) return globalThis.__CRX_ROUTED_HOOK_PAYLOAD;
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) return null;
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

const input = payload();
const command = input?.tool_input?.command;
if (command) {
  const targets = pushTargets(command, input?.cwd || input?.tool_input?.cwd);
  const warnings = await Promise.all(targets.map(({ dir, branch }) => dirtyWarning(dir, { branch })));
  const warning = [...new Set(warnings.filter(Boolean))].join("\n");
  if (warning) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: warning } }));
  }
}
