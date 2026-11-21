## 2026-11-20 — Staging is frozen for agents while a release PR is open

While release PR #1990 was open, agents merged into `staging` twice (#2024–#2042 on
2026-11-19, #2093 on 2026-11-20). Each merge made the "Refresh release PR" job re-cut
`release/next`, which moved the release head and voided its Sol proof and Taha's
`Ready to merge`. The written freeze rule did not reach every session, and the enforced
freeze only started at Taha's `Ready to merge` or the first `Applied live:`.

What changed (`.claude/hooks/sol-risk-lib.mjs`, `releaseFreezeProblem`):
- An agent's merge into `staging` is now refused whenever any release PR
  (`release/next` into `main`) is open, from the moment it opens. The refusal names the
  release PR and says to retry after it merges or closes.
- The check no longer reads the release PR's comments: one GitHub call instead of two
  per release PR. An unreadable answer still refuses (fail closed).
- Both merge guards share it: Claude's `pr-merge-guard.mjs` and Codex's
  `.codex/hooks/production-action-guard.mjs`. Taha's and Mason's own GitHub clicks are
  not hooked.

Docs: `.claude/commands/ship.md` › Staging and `docs/reference/agent-guardrails.md`.

Proof: `node .claude/hooks/sol-risk-lib.test.mjs` (open release → refused naming it, two
open → both named, none open → allowed, GitHub error or garbled answer → refused), plus
the unchanged `pr-merge-guard` and `production-action-guard` suites, and a live read of
the current open release PR.
