## 2026-11-19 - Two small harness checks from the PR #1989 retro

Mason approved both in the 2026-11-19 retro; both stay minimal (he asked for fewer guardrails on 2026-10-30).

- **Smoke chains at commit.** A commit that stages a live smoke chain (`scripts/smoke/*.sql` listed in `smoke-specs.json`, not container- or psql-only) is refused when the live-SQL guard would not read it as a rolled-back smoke. On PR #1989 two CASE expressions in one statement inside a setup loop made the guard refuse the chain, and only CI's guards.test.mjs caught it. `scripts/check-staged-smoke-chains.mjs`, run from `.husky/pre-commit`; test `scripts/check-staged-smoke-chains.test.mjs`.
- **Conflicted PR warning after a push.** After a `git push`, if the branch's open PR conflicts with its base, the agent sees one line: "PR #N conflicts with its base; GitHub runs no full CI until you merge the base in." It never blocks and stays silent if GitHub is slow or unreachable. PR #1989 sat conflicted for several pushes, so real failures stayed hidden for about an hour. `.claude/hooks/post-push-dirty-warning.mjs`, routed by `posttool-router.mjs` for Claude and Codex.
