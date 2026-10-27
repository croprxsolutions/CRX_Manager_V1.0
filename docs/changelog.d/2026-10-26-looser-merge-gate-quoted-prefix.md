## 2026-10-26 — Looser merge gate: empty single-quoted prefixes

The Codex GitHub App (P1) found `"$A" ''"$B" ''"$C" 951 --admin` passed both gates: a word starting with a
single quote was treated as wholly literal, but `''"$B"` still expands. The variable-argument check now
drops only the single-quoted spans and looks for `$` or a backtick in the rest of each word.
`.claude/hooks/codex-push-lib.mjs`; cases in `.claude/hooks/guards.test.mjs`.
