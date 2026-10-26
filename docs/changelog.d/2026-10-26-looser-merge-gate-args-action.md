## 2026-10-26 — Looser merge gate: inline code with the action in its arguments

The Codex GitHub App (P2) found `perl -e 'print readpipe "gh @ARGV"' pr merge 951` passed both gates.
Rather than add one API name at a time, inline code that shows a gated word (`gh`, …) is now refused
whenever a merge or push action appears anywhere in the same command — however the code would run it.
`readpipe` is also listed. `.claude/hooks/codex-push-lib.mjs`; cases (including a
`Kernel.public_send(:system, …)` spelling) in `.claude/hooks/guards.test.mjs`.
