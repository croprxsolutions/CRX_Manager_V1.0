## 2026-11-01 - The merge wait now covers the tests as well as Codex

- `ship.md` Step 8 now has two background waits, each about 2 hours at most: one for a draft's tests before it is marked ready, and one for both Codex and the restarted tests after. Mason approved covering the tests on 2026-11-01.
- Why: on croprxsolutions/CRX_Manager_V1.0#1261 Codex finished in under a minute, so the Codex-only wait ended before the tests did. Marking that PR ready while its tests ran also cancelled the run and showed false failures, so the step now says not to.
- The Codex check no longer names a commit, because Codex may not review again after a later push and the wait would run out. The merge rechecks still decide.
- No gate changes. When a wait ends, every merge check runs again and the merge stays pinned to the head.
