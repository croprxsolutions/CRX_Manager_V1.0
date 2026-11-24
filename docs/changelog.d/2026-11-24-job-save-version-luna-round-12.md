## 2026-11-24 - Job Save version check: Luna fixes after Sol round 12 (#2352)

- `save_job` (migration `20270302010000`, not applied live): a retried NEW-job save is also marked `"replayed": true`, and the post-wait role check now runs before the version compare, so a rep denied the Job Schedule page gets `INSUFFICIENT_ROLE` rather than learning the job changed. Proof cases added to `scripts/smoke/prove-job-save-version-real-schema.mjs` (passes).
