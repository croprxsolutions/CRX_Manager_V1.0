// Landing claim: a second session is refused, the first is allowed, release and
// expiry work, and every failure fails open.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLAIM_TTL_MS, claimOrRefuse, readClaims, releaseClaim } from "./pr-claim-lib.mjs";
import { pushDestinationBranches } from "./codex-push-lib.mjs";
import { scratchHookEnvironment } from "./git-test-env.mjs";
import { tempDir } from "../../scripts/lib/test-temp-dir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
let passed = 0;
const ok = (value, label) => { assert.ok(value, label); passed += 1; };

// ── library ───────────────────────────────────────────────────────────────────
const dir = tempDir("pr-claim-");
ok(claimOrRefuse({ file: path.join(dir, "state", "pr-claims.json"), branch: "feat/x", sessionId: "A" }) === ""
  && !existsSync(path.join(dir, "state")), "no state folder: nothing is created and nothing is claimed");
mkdirSync(path.join(dir, "state"));
const file = path.join(dir, "state", "pr-claims.json");
const T0 = Date.parse("2026-11-17T12:00:00Z");
const claim = (sessionId, extra = {}) => claimOrRefuse({ file, branch: "feat/x", sessionId, action: "push", now: T0, ...extra });

ok(claim("A") === "", "first session claims a free branch");
ok(readClaims(file)["feat/x"].session === "A", "the claim is recorded for session A");
ok(claim("A", { now: T0 + 60_000 }) === "", "the holder keeps working");
const refusal = claim("B", { now: T0 + 60_000, action: "merge" });
ok(/LANDING CLAIM/.test(refusal) && /session A/.test(refusal), "a second session is refused and told who holds it");
ok(refusal.includes("node scripts/pr-claim.mjs release feat/x"), "the refusal names the one-line release");
ok(claim("B", { now: T0 + 60_000 + CLAIM_TTL_MS }) === "", "a claim older than 2 hours since its last use is ignored");
ok(readClaims(file)["feat/x"].session === "B", "an expired claim is taken over");
ok(claim("A", { now: T0 + 61_000 + CLAIM_TTL_MS }) !== "", "the new holder's claim is then enforced");
ok(releaseClaim(file, "feat/x") === true, "release removes the claim");
ok(claim("A", { now: T0 + 62_000 + CLAIM_TTL_MS }) === "", "after release another session may take over");
ok(claim("B", { branch: "refs/heads/feat/x", now: T0 + 63_000 + CLAIM_TTL_MS }) !== "", "refs/heads/ prefix names the same branch");

// Fail open.
ok(claim("", { now: T0 + 64_000 + CLAIM_TTL_MS }) === "", "no session id never blocks");
ok(claim(undefined) === "" && claim(null) === "", "a missing session id never blocks");
ok(claimOrRefuse({ file: null, branch: "feat/x", sessionId: "B" }) === "", "no claim file (git unresolvable) never blocks");
for (const branch of ["", "HEAD", "main", "staging", "master", "production"]) {
  ok(claimOrRefuse({ file, branch, sessionId: "Z", now: T0 }) === "" && !(branch in readClaims(file)), `"${branch}" is never claimed`);
}
writeFileSync(file, "{ not json");
ok(claim("B", { now: T0 + 65_000 + CLAIM_TTL_MS }) === "", "an unreadable claim file never blocks");
const blocker = path.join(dir, "a-file");
writeFileSync(blocker, "x");
ok(claimOrRefuse({ file: path.join(blocker, "pr-claims.json"), branch: "feat/x", sessionId: "B" }) === "", "an unwritable claim file never blocks");
writeFileSync(file, JSON.stringify({ "feat/x": { session: "A", at: "garbage" } }));
ok(claim("B") === "", "a claim with an unreadable time never blocks");

// Luna round 1 fixes.
writeFileSync(file, "{}");
ok(claim("A", { record: false }) === "" && !("feat/x" in readClaims(file)), "a check with record:false claims nothing (denied merges)");
writeFileSync(file, JSON.stringify({ "feat/x": { session: "A", at: new Date(T0 + 10 * CLAIM_TTL_MS).toISOString() } }));
ok(claim("B") === "", "a claim dated in the future is ignored, not held forever");
writeFileSync(file, "{}");
ok(claim("A", { branch: "__proto__" }) === "" && claim("B", { branch: "__proto__" }) !== "", "a branch named __proto__ is claimed like any other");
writeFileSync(file, JSON.stringify({ "feat/x": null, "feat/y": { session: "A", at: new Date(T0).toISOString() } }));
ok(!("feat/x" in readClaims(file)) && "feat/y" in readClaims(file), "malformed entries are dropped, good ones kept");
const lock = `${file}.lock`;
writeFileSync(lock, "");
const started = Date.now();
ok(claim("B", { branch: "feat/y" }) === "" && readClaims(file)["feat/y"].session === "A", "a lock held by a live writer fails open after a short wait");
ok(Date.now() - started < 5000, "the lock wait is bounded");
utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)); // lock age uses the real clock
ok(claim("B", { branch: "feat/y" }) !== "" && !existsSync(lock), "a stale lock from a crashed writer is cleared");

// Push destinations.
assert.deepEqual(pushDestinationBranches("git push origin feat/x", "other"), ["feat/x"]);
assert.deepEqual(pushDestinationBranches("git push", "feat/y"), ["feat/y"]);
assert.deepEqual(pushDestinationBranches("git -C C:/w push -u origin HEAD", "feat/y"), ["feat/y"]);
assert.deepEqual(pushDestinationBranches("git push origin HEAD:refs/heads/feat/z", "feat/y"), ["feat/z"]);
assert.deepEqual(pushDestinationBranches("git push -o ci.skip origin a b:c", "x"), ["a", "c"]);
assert.deepEqual(pushDestinationBranches("git status", "x"), []);
assert.deepEqual(pushDestinationBranches("git push origin 'feat/*:feat/*' b", "x"), ["b"]);
passed += 7;

// ── through the real push guard (Claude-only hook) ───────────────────────────
const repo = tempDir("pr-claim-repo-");
const git = (...args) => execFileSync("git", args, { cwd: repo, env: scratchHookEnvironment(repo), stdio: "ignore" });
git("init", "-q", "-b", "feat/land");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
mkdirSync(path.join(repo, ".claude", "session-state"), { recursive: true });
const claimsPath = path.join(repo, ".claude", "session-state", "pr-claims.json");

function pushGuard(command, sessionId) {
  const payload = { tool_name: "Bash", tool_input: { command }, cwd: repo };
  if (sessionId !== undefined) payload.session_id = sessionId;
  const res = spawnSync(process.execPath, [path.join(HERE, "codex-push-guard.mjs")], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 20000, cwd: repo, env: scratchHookEnvironment(repo),
  });
  let reason = "";
  try { reason = JSON.parse(res.stdout).hookSpecificOutput.permissionDecisionReason; } catch { /* allowed */ }
  return reason;
}

ok(pushGuard("git push origin feat/land", "A") === "", "session A's push is allowed and claims the branch");
ok(readClaims(claimsPath)["feat/land"]?.session === "A", "the push recorded A's claim in the main checkout's session-state");
ok(/LANDING CLAIM/.test(pushGuard("git push origin feat/land", "B")), "session B's push to the same branch is refused");
ok(/LANDING CLAIM/.test(pushGuard("node scripts/write-codex-push-proof.mjs", "B")), "session B's Sol run on that branch is refused");
ok(pushGuard("node scripts/write-codex-push-proof.mjs --dry-run", "B") === "", "a dry run is never refused");
ok(pushGuard("node scripts/write-codex-push-proof.mjs", "A") === "", "the holder's Sol run is allowed");
ok(pushGuard("git push origin other-branch", "B") === "", "B may push a different branch");
ok(pushGuard("git push --dry-run origin dry-branch", "B") === "" && !("dry-branch" in readClaims(claimsPath)), "a dry-run push claims nothing");
ok(pushGuard("git status && npm test", "B") === "", "ordinary commands are never refused");
ok(pushGuard("git push origin feat/land") === "", "a call with no session id is never refused");
writeFileSync(claimsPath, "garbage");
ok(pushGuard("git push origin feat/land", "B") === "", "a corrupt claim file never blocks");
pushGuard("git push origin feat/land", "A");
writeFileSync(claimsPath, JSON.stringify({ ...JSON.parse(readFileSync(claimsPath, "utf8")), broken: null }));
const listed = spawnSync(process.execPath, [path.join(ROOT, "scripts", "pr-claim.mjs"), "list"], { cwd: repo, encoding: "utf8", env: scratchHookEnvironment(repo) });
ok(listed.status === 0 && /feat\/land: held, session B/.test(listed.stdout), "list shows the claim and skips a malformed one");
const cli = spawnSync(process.execPath, [path.join(ROOT, "scripts", "pr-claim.mjs"), "release", "feat/land"], { cwd: repo, encoding: "utf8", env: scratchHookEnvironment(repo) });
ok(/Released/.test(cli.stdout), "the release command releases the claim");
ok(pushGuard("git push origin feat/land", "B") === "", "after release, B takes over");

// Codex never runs the hooks that hold the claim check.
const codexHooks = readFileSync(path.join(ROOT, ".codex", "hooks.json"), "utf8");
ok(!/codex-push-guard|pr-merge-guard|pr-claim/.test(codexHooks), "Codex sessions never run the claim check");
// The merge gate keys its claim on the PR's head branch (needs GitHub, so checked by source here).
const mergeGuard = readFileSync(path.join(HERE, "pr-merge-guard.mjs"), "utf8");
ok(/claimOrRefuse\(\{[\s\S]{0,200}branch: pr\.headRefName/.test(mergeGuard), "the merge gate checks the claim on the PR's head branch");

console.log(`pr-claim-lib: ${passed} checks passed`);
