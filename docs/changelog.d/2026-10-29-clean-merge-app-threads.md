## 2026-10-29 — Clean-merge skip checks the App's threads on the pre-merge commit (Codex App P1 on PR #1206)

- The clean-main-merge skip reuses the Codex GitHub App's review of the commit before the
  merge, but its unanswered threads there read as "stale" at the merge head and did not block.
  The pre-flight now also reads the App's threads against that commit and refuses while any
  is unanswered, or when they cannot be read.
- Tests in `write-codex-push-proof.test.mjs`.
