## 2026-11-22 - #2297: a release-rules Sol proof counts only for the release PR

- `proofValidForMerge` (`.claude/hooks/codex-push-lib.mjs`) now takes the PR's head branch: a proof made under the release-only rules counts for a merge into `main` only when the PR comes from `release/next`, so it can no longer satisfy a hotfix merge. The Claude merge guard and the Codex production-action guard pass the head branch they already read from GitHub. A missing head branch refuses a release-rules proof. Proofs that record no review kind are judged as before.
- Proof: `node .claude/hooks/pr-merge-guard.test.mjs` (345 assertions), `node .codex/hooks/production-action-guard.test.mjs`, `node scripts/write-codex-push-proof.test.mjs`.
