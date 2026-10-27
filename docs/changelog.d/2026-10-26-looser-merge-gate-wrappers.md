## 2026-10-26 — Looser merge gate: wrappers do not hide a variable-run program

The Codex GitHub App (P2) found `env "$A" "$B" "$C" 951 --admin` passed both gates, because the
variable-argument check looked at `env`, not the program it runs. The check now uses the existing
`programCandidates` analysis, so `env`, `command`, `exec` and their options are seen through.
`.claude/hooks/codex-push-lib.mjs`; cases in `.claude/hooks/guards.test.mjs`.
