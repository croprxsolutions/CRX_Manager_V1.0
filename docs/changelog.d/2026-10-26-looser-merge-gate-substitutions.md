## 2026-10-26 — Looser merge gate: variable-run programs inside substitutions

The Codex GitHub App (P1) found `echo "$("$A" "$B" "$C" 951 --admin)"` passed both gates: the
variable-argument check only looked at the outer `echo`. It now also reads every `$( … )` and backtick
body, recursively (refusing past the nesting limit, as elsewhere), and runs on its own rather than only
when the outer program is run-time built. `.claude/hooks/codex-push-lib.mjs`; cases in
`.claude/hooks/guards.test.mjs`.
