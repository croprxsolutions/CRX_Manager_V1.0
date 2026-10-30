## 2026-10-29 — The clean-main-merge exception refuses a criss-cross (Luna MED on PR #1206)

- `cleanMainMergeParent` now requires exactly one merge-base between the branch and the merged
  main commit. With several, git picks one by commit date and the shared-file check could miss a
  deletion of main's file, skipping the Codex GitHub App wait on a merge that is not clean.
- Test: a dated criss-cross fixture where plain merge-base picks the wrong base; it fails without
  the fix and passes with it.
