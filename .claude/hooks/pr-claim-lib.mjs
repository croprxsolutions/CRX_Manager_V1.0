// Landing claim: stop two sessions on this PC landing the same PR at once
// (Mason, 2026-11-17 retro: two merge captains raced #1937, #1939, #1879, #1940).
//
// The first session to push to, run Sol on, or merge a PR branch claims it in
// <main checkout>/.claude/session-state/pr-claims.json, which every worktree on
// this PC shares. A DIFFERENT session doing one of those three things on that
// branch within CLAIM_TTL_MS of the claim's last use is refused. Nothing else is
// ever refused.
//
// FAILS OPEN by design (Mason, 2026-10-30: fewer guards that block harmless work):
// a missing or unreadable claim file, a missing session id, an unknown branch, or
// any error means "no claim", never a refusal. Callers: Claude's codex-push-guard.mjs
// and pr-merge-guard.mjs, and Codex's .codex/hooks/production-action-guard.mjs for
// pushes and merges (#1948). @proven-by .claude/hooks/pr-claim-lib.test.mjs

import { readFileSync, writeFileSync, renameSync, openSync, closeSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { resolveMainCheckoutRoot } from "./registry-freshness-lib.mjs";

export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
export const CLAIMS_FILE = "pr-claims.json";
const UNCLAIMABLE = new Set(["", "head", "main", "master", "staging", "production"]);
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const CLOCK_SKEW_MS = 60_000;
const pause = new Int32Array(new SharedArrayBuffer(4));

const normalBranch = (branch) => String(branch || "").trim().replace(/^refs\/heads\//i, "");

// The shared claim file for the checkout at `cwd`, or null when git cannot say.
export function claimsFileFor(cwd) {
  const root = resolveMainCheckoutRoot(cwd || process.cwd());
  return root ? path.join(root, ".claude", "session-state", CLAIMS_FILE) : null;
}

// Claims keyed by branch, in a prototype-free object so a branch named
// `__proto__` is an ordinary entry. Malformed entries are dropped.
export function readClaims(file) {
  const claims = Object.create(null);
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [name, claim] of Object.entries(data)) {
        if (claim && typeof claim === "object" && typeof claim.session === "string") claims[name] = claim;
      }
    }
  } catch { /* no claims */ }
  return claims;
}

// Never creates the state folder, so a push from another repository (a notes
// vault, FarmRx) leaves no stray file there; without the folder there is no claim.
function writeClaims(file, claims) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(claims, null, 2)}\n`);
  renameSync(tmp, file);
}

// Runs `fn` holding <file>.lock so two sessions cannot both read the same free
// branch and both claim it. A lock older than LOCK_STALE_MS is a crashed holder
// and is removed. Returns undefined (fail open) when the lock cannot be had.
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") return undefined;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); } catch { /* raced */ }
      if (Date.now() > deadline) return undefined;
      Atomics.wait(pause, 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* gone */ } }
}

// Is this claim still enforced? A timestamp in the future (beyond clock skew) is corrupt, not fresh.
export function claimIsFresh(claim, now = Date.now()) {
  const at = Date.parse(claim?.at);
  return Number.isFinite(at) && at <= now + CLOCK_SKEW_MS && now - at < CLAIM_TTL_MS;
}

// Returns a refusal message when another session holds a fresh claim on `branch`;
// otherwise, unless `record` is false, records/refreshes this session's claim. "" = go ahead.
export function claimOrRefuse({ file, branch, sessionId, action, cwd = "", now = Date.now(), record = true }) {
  try {
    const name = normalBranch(branch);
    const session = String(sessionId || "").trim();
    if (!file || !session || UNCLAIMABLE.has(name.toLowerCase())) return "";
    return withLock(file, () => {
      const claims = readClaims(file);
      const held = claims[name];
      const heldAt = Date.parse(held?.at);
      if (held && held.session !== session && claimIsFresh(held, now)) {
        const minutes = Math.max(1, Math.round((now - heldAt) / 60000));
        return (
          `LANDING CLAIM: another session is landing branch "${name}" (session ${held.session}` +
          `${held.cwd ? `, folder ${held.cwd}` : ""}; its last ${held.action || "action"} was ${minutes} min ago). ` +
          `Two sessions landing one PR collide (pushes race, pinned merges fail, Sol rounds are wasted), so this ` +
          `${action} is refused. Leave this PR to that session. Only if that session is finished or gone ` +
          `(ask Mason when unsure; never just to get past this), release the claim and retry: ` +
          `${/^[\w./-]+$/.test(name) ? `\`node scripts/pr-claim.mjs release ${name}\`` : "`node scripts/pr-claim.mjs release <branch>` (quote the branch name)"}. Claims expire 2 hours after ` +
          `their last use; the check fails open on any error.`
        );
      }
      if (record) {
        claims[name] = { session, action, cwd: String(cwd || ""), at: new Date(now).toISOString() };
        writeClaims(file, claims);
      }
      return "";
    }) || "";
  } catch {
    return "";
  }
}

// Removes the claim on `branch`; true when one was removed.
export function releaseClaim(file, branch) {
  const name = normalBranch(branch);
  return withLock(file, () => {
    const claims = readClaims(file);
    if (!(name in claims)) return false;
    delete claims[name];
    writeClaims(file, claims);
    return true;
  }) ?? false;
}
