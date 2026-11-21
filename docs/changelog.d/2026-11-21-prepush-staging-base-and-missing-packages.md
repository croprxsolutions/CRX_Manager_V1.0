## 2026-11-21 - Pre-push compares a new staging branch with staging, and names missing packages

A docs-only branch cut from staging (`claude/inventory-build-plans-2026-11-20`) ran the contract tests and the app build on its first push. Each attempt took about 5–6 minutes, and the first one failed with "CONTRACT TESTS FAILED … add its stamp to MIGRATIONS_AWAITING_TYPE_REGENERATION". The real cause was that the fresh worktree had no `node_modules`.

- `scripts/prepush-needs-build.mjs`: a new branch (no remote sha) is now compared with whichever of `origin/main` and `origin/staging` it forked from last, instead of always `origin/main`. Staging runs ahead of main, so the main base counted every staging registry and `src/` change as part of the push. When the bases are unrelated, main wins, which lists more files and runs more checks.
- `.husky/pre-push`: before the contract tests, the Edge Function source tests and the type check, it checks that Node can find `vitest` and `vite`. If they don't, it blocks with "Run npm ci here, then push again."

Proof:
- New temp-repo cases in `scripts/prepush-needs-build.test.mjs` failed before the fix ("a docs-only staging branch must not rebuild the app": got `build`) and pass after. The cases are: a staging docs branch skips the build and the contract tests; a staging app change builds; main hotfixes still skip or build by content.
- I ran `.husky/pre-push` in a worktree without packages and saw the new message and exit 1.

Not verified: a real push of a staging branch through the hook; CI still checks every PR.
