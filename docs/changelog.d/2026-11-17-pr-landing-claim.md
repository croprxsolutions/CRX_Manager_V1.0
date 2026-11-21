## 2026-11-17 — landing claim: one session lands a PR at a time

Two merge-captain sessions both landed #1937, #1939, #1879 and #1940: their pushes collided,
one pinned merge was refused because the other pushed a new head, and a capped Sol round was
spent on a head replaced two minutes later. Mason approved a claim ("Do 1", 2026-11-17 retro).

What changed:
- `.claude/hooks/pr-claim-lib.mjs`: the first session to push to a PR branch, run
  `scripts/write-codex-push-proof.mjs` on it, or merge its PR claims the branch in the main
  checkout's shared `pr-claims.json` state file. A different session doing one of those on
  that branch within 2 hours of the claim's last use is refused, with the holder named.
- `codex-push-guard.mjs` (pushes, Sol runs) and `pr-merge-guard.mjs` (merges, keyed on the PR's
  head branch) call it. Both are Claude-only, so Codex sessions are never refused.
- `scripts/pr-claim.mjs list | release <branch>` shows or releases claims.
- `codex-push-lib.mjs` gains `pushDestinationBranches` (best effort; never used to allow).

Fails open: missing or corrupt claim file, missing session id, `main`/`staging`, any error.
No existing check was loosened.

Proof: `node .claude/hooks/pr-claim-lib.test.mjs` (including the real push guard in a scratch
repo: session B refused, A allowed, release, expiry, fail-open cases). With the check disabled
the test fails; with it on it passes. Not verified: the merge path end to end against GitHub
(covered by the library tests plus a source check that it keys on `pr.headRefName`).
