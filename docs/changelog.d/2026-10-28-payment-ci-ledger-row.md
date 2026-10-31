## 2026-10-28 - Correct payment candidate ledger row for CI

- PR #1179's Linux and Windows guard jobs failed the same repository cross-reference assertion: the candidate parser found the hash-pinned migration, but the independent counter requires numeric history rows and ignored the text row label `payment-date`.
- Assign numeric row 1001 and update the history header. Row 1000 is already used by other open PR candidates, so it is not reused here. Migration filename, SQL bytes, hash, status and payment behavior are unchanged.
- Keep the existing guard/test logic intact. The migration remains NOT APPLIED and PR #1179 remains draft, with no merge/live apply/deploy authority.
- Reproduced the original assertion locally before the fix. After staging the corrected canonical history row, `worktree-awareness-lib.test.mjs` passes all 282 assertions and `check-doc-drift.mjs` passes. SQL SHA256 remains `5ced6a5e8e3d8a40d7ecca4985d2bd5e3d25ca6f980f2dee1e6bacabff9b93dd`.
