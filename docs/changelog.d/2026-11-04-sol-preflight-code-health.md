## 2026-11-04 - Sol pre-flight runs the code-health check first

- `scripts/write-codex-push-proof.mjs` now runs `scripts/check-code-health.mjs` before starting a full Sol review when the branch changes `src/`. If the check fails, it refuses without spending Sol tokens. An unreadable diff runs the check anyway.
- Why: pre-push already runs this check, so a failure only surfaced after Sol was clean, and the fix needed a second Sol run. That happened on PR #1422 (2026-11-04), where New PO went 3 lines over `max-lines`. The check takes about 17 seconds; a Sol run takes about 5 minutes.
- It adds no new rule: pre-push and CI still enforce the same check unchanged. Docs-only branches skip it. Tests are in `scripts/write-codex-push-proof.test.mjs`.
