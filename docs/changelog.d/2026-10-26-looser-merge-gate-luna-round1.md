## 2026-10-26 — Looser merge gate: Luna round 1 fixes

Follow-up to `2026-10-26-looser-merge-gate.md`. Luna reported 3 findings; all fixed in
`.claude/hooks/codex-push-lib.mjs` with new cases in `.claude/hooks/guards.test.mjs`:

- Pieces glued across quotes (`"$G""$H" pr "$M1""$M2" 1`, `'$G'$H …`) are caught: quotes are removed
  before the glue check. (Luna's first example, `G=gh; … "$G" "$V" "$A" 1`, was already refused
  because `gh` and `merge` are visible.)
- Bun's `$` shell tag, `posix_spawn`, `pcntl_exec`, `execv`/`execl` and `startfile` now count as ways
  for inline code to run a program.
- A plain `function(){…}` no longer counts as one (`new Function` still does).
