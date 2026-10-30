## 2026-10-29 — Pre-merge App threads checked even when the App re-reviews the merge (Luna MED on PR #1213)

- After a clean main merge, the Sol pre-flight now checks the Codex GitHub App's threads on the
  commit before the merge whether or not the App also reviewed the merge commit. Before, a
  finished App review of the merge let an unanswered thread on the pre-merge commit through,
  because at the merge head it reads as stale.
- `/ship` and the codex-review skill name the existing one-hour dead-run rule.
- New test cases in `write-codex-push-proof.test.mjs`; the refusal case fails on the previous code.
