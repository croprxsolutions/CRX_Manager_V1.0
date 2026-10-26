## 2026-10-26 — Looser merge gate: Codex App fix on #1128

The Codex GitHub App (P2) found that dropping single-quoted text before the glue check also dropped
quoted letters glued to a variable, so `H=h; R=erge; 'g'$H pr 'm'$R 951 --squash` (which runs
`gh pr merge`) passed both gates. Single-quoted letters are now kept and only a `$` or backtick inside
them is neutralised, so that command is refused again while `'literal$USER'` still passes.
`.claude/hooks/codex-push-lib.mjs`, case added to `.claude/hooks/guards.test.mjs`.
