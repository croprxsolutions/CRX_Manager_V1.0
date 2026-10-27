## 2026-10-26 — Looser merge gate: literal backticks inside single quotes

The Codex GitHub App (P2) found the substitution fix over-blocked: a JS template string inside single
quotes (``node -e 'console.log(`$HOME …`)'``) was read as a shell command substitution. Single-quoted
text is now skipped before backtick bodies are extracted. `.claude/hooks/codex-push-lib.mjs`; case in
`.claude/hooks/guards.test.mjs`.
