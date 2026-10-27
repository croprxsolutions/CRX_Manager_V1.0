## 2026-10-26 — Looser merge gate: quote-aware backtick scanner

An automated security review found the single-quote skipping used a regex that a single quote inside
double quotes could fool (`echo "'" \`cmd\` "'"` hid a real backtick command). Backtick bodies are now
found by a small character-by-character scanner that follows POSIX quoting and backslash escapes, and an
unclosed quote or backtick is refused when the command shows a variable. `.claude/hooks/codex-push-lib.mjs`
(`backtickBodies`); cases in `.claude/hooks/guards.test.mjs`.
