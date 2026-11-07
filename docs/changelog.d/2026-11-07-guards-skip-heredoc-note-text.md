## 2026-11-07 — Guards no longer read here-document notes as commands

- `bash-safety.mjs` and `review-proof-guard.mjs` judge a Bash command without its here-document
  bodies when every command in it is a bare `cat`/`tee` (bash-safety also: a runtime such as
  `python -` with no process launch in its text). Writing a note that mentions `git reset --hard` or
  a `.claude/worktrees/…` path is no longer refused (Mason, 2026-11-07).
- Still refused, pinned by new tests: the real commands, the same inside `bash -c`, a here-document
  fed or piped to a shell, a written script run later, a function named `cat`, `xargs`, `while read`
  loops, unquoted bodies with `$( )`, and never-ending here-documents. See
  `docs/reference/agent-guardrails.md` › "Here-document notes are text".
