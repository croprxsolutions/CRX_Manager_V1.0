## 2026-10-26 — Looser merge gate: Codex App fix 2 on #1128

The Codex GitHub App (P2) found that Ruby's and Perl's bracket-free `system "gh", *ARGV` (with
`pr merge 951` passed as arguments) passed both gates, because only `system(` counted as running a
program. Any `system` in inline code now counts. `.claude/hooks/codex-push-lib.mjs`, cases added to
`.claude/hooks/guards.test.mjs`.
