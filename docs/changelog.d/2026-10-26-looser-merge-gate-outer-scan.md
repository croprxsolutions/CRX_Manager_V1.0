## 2026-10-26 — Looser merge gate: no false blocks on assignments

Two Codex GitHub App findings (P2) on over-blocking, both fixed in `.claude/hooks/codex-push-lib.mjs` with
cases in `.claude/hooks/guards.test.mjs`:

- `x=$(echo "$HOME" "$USER")` was refused: the outer command was re-read with the substitution body in it.
  It is now read with each body collapsed, as `programBuiltAtRuntime` does.
- `$result = Get-Content $path` (PowerShell) was refused: the assignment target was taken as the program.
  The same assignment-prefix handling as `programWordBuiltAtRuntime` now applies.
