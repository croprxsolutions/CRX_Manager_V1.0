# Sol review base follows the PR's target branch — behavior contract

Read at `origin/staging` b709432fa (2026-11-16).

## 1. Outcome and authority

**Business result.** A feature PR into `staging` gets a Sol review of its own changes only. Today Sol diffs `origin/main...HEAD`, so every staging PR also reviews all unreleased staging work; on 2026-11-16 four PRs (#1878, #1880, #1885, #1889) each stopped on a different finding in already-merged staging migrations none of them touched. Hotfix and release PRs into `main` keep the whole `origin/main...HEAD` diff, unchanged.

**Smallest change.** `scripts/write-codex-push-proof.mjs` picks the review ref from the current branch name:
- `hotfix/*`, `release/*`, `main`, `staging`, a detached HEAD, or an unresolvable `origin/staging` → `origin/main` (today's behavior; the wider diff is the fail-safe).
- any other branch → `origin/staging`.

The existing `solReviewBase()` then picks the exact commit as it does today against main: the ref's tip when HEAD contains it, else the single fork point, else the tip (and the pre-flight refuses: "merge origin/staging in"). Every place the full review reads the base (the prompt text, dry-run, pre-flight message, the "base moved" check after the review, the "base moved on" message) uses that same ref. No new flag, file, lock or job.

Files: `scripts/write-codex-push-proof.mjs` (+ test), `.claude/hooks/pr-merge-guard.mjs` (help text only), `.claude/commands/ship.md` › Staging, `docs/reference/agent-guardrails.md`, changelog entry.

**Not changed (checked):**
- `pr-merge-guard.mjs` and Codex's `.codex/hooks/production-action-guard.mjs` → `proofValidForMerge` already judges the proof against GitHub's real base tip (`baseRefOid`): the proof's base must be in the head and be that tip or an ancestor of it. A staging fork point or tip passes into `staging`. A staging tip holding unreleased work is not an ancestor of `main`, so that proof cannot be used for a `main` merge; a fork point already on `main` can be, exactly as a fork-point proof can today.
- `migration-landing-gate-lib.mjs` (live apply) needs `base_sha == PR's baseRefOid` exactly; live applies are only for hotfix/release PRs into `main`, which keep `origin/main`.
- `codex-push-guard.mjs` only gates pushes to `main` (already impossible by ruleset) → `origin/main`, unchanged.
- `sol-needed.mjs` / `pr-readiness.mjs` already use the PR's own GitHub base.
- `--carry-forward` stays main-only (merging main into a staging branch is a refused back-merge anyway); a staging proof's base is not an ancestor of `origin/main`, so a carry attempt refuses. Restamp / post-apply / owner-accepted carries keep the proof's own base and work unchanged.
- Luna (`luna-review.mjs`) keeps `origin/main`; not a gate. Follow-up.

**Who decides the base.** The branch name is the agent's choice, so the guards, not the name, carry the weight:
- Into `main` only `release/next` and `hotfix/*` are accepted (`.github/workflows/release-flow.yml`), and those names get `origin/main`.
- Into `staging`, the merge guard checks the proof's base against GitHub's real staging tip, so a forged local `origin/staging` cannot shrink the diff below "this branch's commits not already in staging".

## 2. State and failure

- **Rule that always holds:** every Sol-list change an agent merges into `staging` is covered by a Sol proof (clean, or with every BLOCKER/HIGH owner-accepted by Mason, as today) whose diff includes every change the PR brings that staging does not already have. Every change into `main` keeps a Sol of `origin/main...HEAD`.
- **Existing proofs:** no consumer changes, so every proof minted before this change is accepted or refused exactly as before (24-hour expiry, model, head and base checks). Rollback is a revert PR; staging proofs minted meanwhile expire within 24 hours.
- **Timing:** a peer fetch moving `origin/staging` during a review is handled by the same "base only moved forward → keep the reviewed base" rule used for main.
- **Coverage trade-off (Mason, approved 2026-11-16):** staging PRs no longer re-review other people's merged staging code. That code had its own Sol at its own merge; the release PR's Sol (for live applies) still reads the whole week.

## 4. Proof cases

1. When a non-hotfix branch cut from `origin/staging`, which holds unreleased staging commits, adds one file, then the review base is the staging commit and the review diff lists only that file. Old script: the diff lists staging's unreleased files too. (Real repo, dry-run + `git diff --name-only`.)
2. When a `hotfix/*` branch is cut from `origin/main`, then the review base is `origin/main`'s commit (old and new identical).
3. When the branch is `release/next`, `main`, `staging` or detached, then `origin/main`.
4. When the staging-bound branch is behind `origin/staging` with one fork point, then the base is the fork point (own diff only); with several fork points, the pre-flight refuses and names `origin/staging`.
5. When the staging proof is checked by `proofValidForMerge` against a staging tip, then accepted; against a `main` tip that lacks staging's unreleased work, then refused.

## Open business decisions

None. Mason approved fixing the Sol scope (2026-11-16); Taha reviews the PR before it merges.

## Step 3: cold challenge (gpt-6-astra high, 2026-11-16, FINDINGS 20)

Settled:
- **Corrected:** #6 (a fork-point base can be on main; wording fixed above), #12 (owner-accepted proofs named), #13/#19 (legacy proofs and rollback stated), #16 (adopted: every full run now prints `Sol review base: <ref> (commit <sha>)` before the review).
- **Disproved / pre-existing, unchanged by this PR:**
  - #1 "undo of staging work hidden by an older base": true of today's `origin/main` base, and this change narrows it. New test: a branch that deletes unreleased staging work shows an empty review diff against main and the deleted file against staging. A forged local ref is still caught only by the ancestry rule, as today; tightening the merge gate to "proof base == merge-base of reviewed head and GitHub's base" is a follow-up (it changes both merge guards).
  - #2 branch name vs PR target: every mismatch falls to the wider or an equal diff. A hotfix under another local name gets `merge-base(H, staging)`, which is main's tip or an older main commit, so the diff is the same or larger, and the live-apply gate (exact base) refuses anything else.
  - #3 `RELEASE_FLOW` is `on` (`gh variable list`, 2026-11-13).
  - #4, #5, #9, #11: merge actors, proof-file trust (`review-proof-guard.mjs`), the head pin and `solRiskOnGitHub` are unchanged gates.
  - #7: carries still use `GUARDED_BASE` (origin/main); `cleanMainMergeParent` is ref-agnostic.
  - #8: `reviewProofBase` compares the reviewed commit with the ref after the review, as for main today; `staging` refuses force-pushes.
  - #10: a head behind its base may merge (Mason, 2026-10-26); staging inherits the same accepted risk as main.
  - #14: after merging newer staging in, re-run Sol; it now reviews only the branch's own diff.
  - #15: the four findings are in Taha's staging migrations, posted to him on #1904.
- **Proof added (#17/#18):** real-git tests for the staging tip, fork point, undo case, hotfix base and the merge gate's staging-vs-main decision; the full `write-codex-push-proof`, `codex-push-lib`, both merge-guard and apply-guard suites pass unchanged.
