// Landing claim: stop two sessions on this PC landing the same PR at once
// (Mason, 2026-11-17 retro: two merge captains raced #1937, #1939, #1879, #1940).
//
// The first session to push to, run Sol on, or merge a PR branch claims it in
// <main checkout>/.claude/session-state/pr-claims.json, which every worktree on
// this PC shares. A DIFFERENT session doing one of those three things on that
// branch within CLAIM_TTL_MS of the claim's last use is refused. Nothing else is
// ever refused.
//
// FAILS OPEN by design (Mason, 2026-11-30: fewer guards that block harmless work):
// a missing or unreadable claim file, a missing session id, an unknown branch, or
// any error means "no claim", never a refusal. Codex sessions are never refused:
// both callers (codex-push-guard.mjs, pr-merge-guard.mjs) are Claude-only hooks
// (scripts/agent-manifest-parity.mjs). @proven-by .claude/hooks/pr-claim-lib.test.mjs

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveMainCheckoutRoot } from "./registry-freshness-lib.mjs";

export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
export const CLAIMS_FILE = "pr-claims.json";
const UNCLAIMABLE = new Set(["", "head", "main", "master", "staging", "production"]);

const normalBranch = (branch) => String(branch || "").trim().replace(/^refs\/heads\//i, "");

// The shared claim file for the checkout at `cwd`, or null when git cannot say.
export function claimsFileFor(cwd) {
  const root = resolveMainCheckoutRoot(cwd || process.cwd());
  return root ? path.join(root, ".claude", "session-state", CLAIMS_FILE) : null;
}

export function readClaims(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeClaims(file, claims) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(claims, null, 2)}\n`);
  renameSync(tmp, file);
}

// shortcut: read-then-write with no lock, so two sessions claiming the SAME branch
// in the same instant can both win once; upgrade to a lock file if that is ever seen.
//
// Returns a refusal message when another session holds a fresh claim on `branch`;
// otherwise records/refreshes this session's claim and returns "".
export function claimOrRefuse({ file, branch, sessionId, action, cwd = "", now = Date.now() }) {
  try {
    const name = normalBranch(branch);
    const session = String(sessionId || "").trim();
    if (!file || !session || UNCLAIMABLE.has(name.toLowerCase())) return "";
    const claims = readClaims(file);
    const held = claims[name];
    const heldAt = Date.parse(held?.at);
    if (held && held.session && held.session !== session && Number.isFinite(heldAt) && now - heldAt < CLAIM_TTL_MS) {
      const minutes = Math.max(1, Math.round((now - heldAt) / 60000));
      return (
        `LANDING CLAIM: another session is landing branch "${name}" (session ${held.session}` +
        `${held.cwd ? `, folder ${held.cwd}` : ""}; its last ${held.action || "action"} was ${minutes} min ago). ` +
        `Two sessions landing one PR collide (pushes race, pinned merges fail, Sol rounds are wasted), so this ` +
        `${action} is refused. Leave this PR to that session. If that session is finished or gone, release ` +
        `the claim and retry: \`node scripts/pr-claim.mjs release ${name}\`. Claims expire 2 hours after ` +
        `their last use; the check fails open on any error and never applies to Codex sessions.`
      );
    }
    claims[name] = { session, action, cwd: String(cwd || ""), at: new Date(now).toISOString() };
    writeClaims(file, claims);
    return "";
  } catch {
    return "";
  }
}

// Removes the claim on `branch`; true when one was removed.
export function releaseClaim(file, branch) {
  const name = normalBranch(branch);
  const claims = readClaims(file);
  if (!(name in claims)) return false;
  delete claims[name];
  writeClaims(file, claims);
  return true;
}
