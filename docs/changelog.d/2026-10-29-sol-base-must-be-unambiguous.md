## 2026-10-29 — Sol refuses an ambiguous split point (security review on PR #1206)

- `reviewBaseFor` now uses `git merge-base --all` and refuses unless there is exactly one.
  In a criss-cross history git picks one of several merge-bases by commit date, which a
  branch author controls, and a review against it could hide the deletion of main code
  (reproduced: the reviewed diff showed one line while the merge deleted a guard file).
  The fix: merge origin/main into the branch, which leaves one split point.
- Test: a real criss-cross fixture in `write-codex-push-proof.test.mjs`; checked against the
  reviewer's own reproduction, which now refuses.
