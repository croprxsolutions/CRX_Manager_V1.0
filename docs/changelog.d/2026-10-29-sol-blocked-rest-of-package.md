## 2026-10-29 — Three package items dropped after Sol's review of PR #1206

- Dropped: Sol reviewing a branch behind main from its split point; a migration apply on an
  older Sol base; a stale "Last verified" date as a warning. Sol blocked each (unreviewed
  newer main code, live SQL against newer app code, a weakened CI check). Mason agreed.
- `scripts/check-doc-drift.mjs`, `.claude/hooks/migration-landing-gate-lib.mjs`, their tests
  and `docs/reference/agent-guardrails.md` are unchanged from main.
