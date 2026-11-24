## 2026-11-22 — Turn timer record no longer blocks Mason's plain reply

- `.claude/hooks/owner-approval-lib.mjs`: a `system`/`turn_duration` record with no text (the timer Claude Code writes after a turn; all 267 such records in local transcripts carry no `content`) counts as bookkeeping, so it no longer sits between the agent's request and Mason's `skip` / `I approve` reply and makes the check refuse. A `turn_duration` record that carries text still ends the scan.
- Tests: `.claude/hooks/owner-approval-lib.test.mjs` adds a real-shape timer record that passes and one with text that refuses.
