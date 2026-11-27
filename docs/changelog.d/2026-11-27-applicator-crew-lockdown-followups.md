## 2026-11-27 - Applicator crew lockdown follow-ups (#2702)

- `scripts/smoke/smoke-dispatch-job-locations.sql` reads the parent job through `jobs_crew` when that view exists and through `jobs` on older replays, so the historical proof runners that reuse it (booking guard, booking live-job guard, completed-job delete, edit jobs) no longer fail with `relation "jobs_crew" does not exist`.
- `scripts/smoke/prove-applicator-crew-lockdown-real-schema.mjs` arms its reuse-mode cleanup as soon as the apply commits (exit 0), not after it sees the `POSTFLIGHT_OK` notice, so a reused container is never left locked down by a failed notice check.
- The remaining #2702 review notes are recorded in `docs/manual/known-issues.d/2026-11-27-applicator-crew-lockdown-review-notes.md`.
