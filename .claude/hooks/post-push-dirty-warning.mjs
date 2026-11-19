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

const run = promisify(execFile);
// Each gh call is capped, and at most two fit inside the router's 20s hook limit.
const GH_CALL_TIMEOUT_MS = 6_000;
const RETRY_DELAY_MS = 3_000;

// The folder the push ran in: `git -C <dir> push` (the push guard's required
// spelling on this machine) wins over the tool's cwd.
export function pushDir(command, cwd) {
  const m = /\bgit\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(String(command || ""));
  const dir = m ? m[2] || m[3] || m[4] : "";
  return dir ? path.resolve(cwd || process.cwd(), dir) : cwd || process.cwd();
}

async function ghPrState(dir) {
  const { stdout } = await run("gh", ["pr", "view", "--json", "number,state,mergeStateStatus"], {
    cwd: dir, timeout: GH_CALL_TIMEOUT_MS, windowsHide: true,
  });
  return JSON.parse(stdout);
}

// GitHub recomputes mergeability after a push and answers UNKNOWN meanwhile, so
// an UNKNOWN gets one retry.
export async function dirtyWarning(dir, { view = ghPrState, delayMs = RETRY_DELAY_MS } = {}) {
  try {
    let pr = await view(dir);
    if (pr?.mergeStateStatus === "UNKNOWN") {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      pr = await view(dir);
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
  const warning = await dirtyWarning(pushDir(command, input?.cwd || input?.tool_input?.cwd));
  if (warning) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: warning } }));
  }
}
