## 2026-10-26 — Looser merge gate: ANSI-C quoting fails closed

A commit security review found the backtick scanner did not model Bash's `$'…'` quoting, whose escapes
(`$'\''`) could shift its quote state and hide a backtick command. A command containing `$'` is now treated
as unreadable by `backtickBodies`, so the variable-argument check refuses it when a variable is present.
`.claude/hooks/codex-push-lib.mjs`; case in `.claude/hooks/guards.test.mjs`.
