## 2026-10-26 — Looser merge gate: PowerShell splats

The Codex GitHub App (P2) found `& $A @params` passed both gates: a PowerShell splat passes a variable's
values as arguments, but the variable-argument check only recognised `$` and backticks. A word starting
with `@name` now counts as a variable argument. `.claude/hooks/codex-push-lib.mjs`; cases in
`.claude/hooks/guards.test.mjs`.
