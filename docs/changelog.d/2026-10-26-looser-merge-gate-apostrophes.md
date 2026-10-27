## 2026-10-26 — Looser merge gate: apostrophes in comments and heredocs

The Codex GitHub App (P2) found the backtick scanner's fail-closed path refused harmless commands with an
apostrophe in a comment or heredoc (`# don't …`, `cat <<'EOF' … Don't …`). The scanner only exists to find
backtick commands, so unreadable quoting is now refused only when the text contains a backtick.
`.claude/hooks/codex-push-lib.mjs`; cases in `.claude/hooks/guards.test.mjs`.
