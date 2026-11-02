## 2026-11-01 - A clean Sol review survives main moving forward

- `scripts/write-codex-push-proof.mjs` now keeps a clean review when `origin/main` only moved forward during it, recorded against the version of main the review started from. It prints that this happened.
- Why: any other PR merging during a Sol run threw the result away. That cost one full run (about 6 minutes) on croprxsolutions/CRX_Manager_V1.0#1250 and five on croprxsolutions/CRX_Manager_V1.0#1075. The kept proof is the same as main moving just after the review, which the merge gates already accept.
- Still refused: a changed HEAD, a dirty tree, main rewinding or moving sideways, an unreadable sha, or a failed Git check.
- No gate changes. `proofValid`, `proofValidForMerge` and the merge guards are untouched, so a push of that head still needs main merged in and `--carry-forward` (or a new run), and a migration still needs its exact-base proof.
- Proof: `node scripts/write-codex-push-proof.test.mjs` failed on the forward-move case under the old rule and passes now, on real Git history and the real merge and push validators.
- Not covered: no live Sol run has hit this yet, because `run()` deliberately cannot be pointed at a fake Codex.
