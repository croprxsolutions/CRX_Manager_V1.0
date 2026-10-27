## 2026-10-26 — Looser merge gate: grouping brackets

The Codex GitHub App (P2) found `("$A" "$B" "$C" 951 --admin)` passed: the allow-list scan read the raw word
`("$A"` and skipped it, while the per-occurrence replacement still hid the program. The scan now strips
grouping brackets (as `programCandidates` does) before checking the program word and its arguments.
`.claude/hooks/codex-push-lib.mjs`; cases (`( … )`, `{ …; }`) in `.claude/hooks/guards.test.mjs`.
