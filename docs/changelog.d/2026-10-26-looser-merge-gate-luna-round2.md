## 2026-10-26 — Looser merge gate: Luna round 2 fixes

Follow-up to `2026-10-26-looser-merge-gate.md`. Luna reported 4 findings; all fixed in
`.claude/hooks/codex-push-lib.mjs` with new cases in `.claude/hooks/guards.test.mjs`:

- Inline code that names the merge or push action itself (`pr merge`, `['pr','merge']`, Octokit's
  `pulls.merge`, a `/pulls/1/merge` path, `git push`, `HEAD:main`) is refused however it would run
  it, so a client library is covered without listing every API. `push` or `merge` alone is data.
- Perl `qx(…)` and Ruby `%x(…)` count as running a shell command.
- Two run-time pieces touching (`$(printf g)` followed by a backtick piece) count as glued.
- `execute` no longer reads as `exec`.
