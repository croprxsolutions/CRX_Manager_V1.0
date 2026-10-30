## 2026-10-29 — Clean-merge skip needs a finished App review (Sol MED on PR #1206)

- The clean-main-merge skip also accepted a Codex GitHub App run that had only started on the
  merge commit, so Sol could run with no finished App review of the PR's own changes. Only the
  App's completed review of the commit before the merge counts now; once the App has started on
  the merge, the pre-flight waits for it like any other push (dead after an hour, as before).
- `write-codex-push-proof.test.mjs` asserts the in-progress case now waits; it fails on the old code.
- `/ship` and the codex-review skill say "finished review".
