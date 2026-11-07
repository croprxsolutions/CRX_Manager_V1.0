## 2026-11-07 — Guards no longer read cat/tee here-document notes as commands

- `bash-safety.mjs` and `review-proof-guard.mjs` judge a Bash command without its here-document
  bodies when every command in it is a bare `cat`/`tee`. Writing a note that mentions
  `git reset --hard` or a `.claude/worktrees/…` path that way is no longer refused (Mason, 2026-11-07).
- Not narrowed: a here-document fed to a language runtime (`python - <<'EOF'`). Luna showed twice that
  a word list cannot tell such a script from one that launches a command, so it is judged on its full
  text as before; write notes with `cat >>` or the Write tool.
- Still refused, pinned by new tests: the real commands, the same inside `bash -c`, a here-document
  fed or piped to a shell, a written script run later, a function named `cat`, `xargs`, `while read`
  loops, unquoted bodies with `$( )`, and never-ending here-documents. See
  `docs/reference/agent-guardrails.md` › "Here-document notes are text".
