## 2026-11-04 - Migration commits also run the column-grant test

- `.husky/pre-commit` now adds `src/lib/costFields.test.ts` to the Vitest run it already does when a commit stages a migration. A column added to a cost table that has per-column grants must grant read access on it in the same migration, or the commit stops.
- Why: on PR #1437 a new column shipped without its grants. Only the CI Vitest shard caught it, after a clean Sol review, so the fix needed another review round.
- Proof: a temporary migration adding `quotes.zz_proof` with no grants failed the commit on this test. Adding the three grants made the test pass. The temporary files were removed.
- The run takes a few extra seconds and only on migration commits. `scripts/supplier-pricing-phase3-private-artifacts.test.mjs` mocks the new command string.
