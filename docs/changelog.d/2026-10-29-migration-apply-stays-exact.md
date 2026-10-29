## 2026-10-29 — Migration apply keeps its exact-base rule (Sol on PR #1206)

- Dropped from PR #1206: the landing gate accepting a Sol proof reviewed on an older main
  when no migration landed since. Sol blocked it: SQL reviewed against an older main could
  break newer app code already live. Mason chose to drop it ("Do your recommendation").
- `.claude/hooks/migration-landing-gate-lib.mjs` and its tests are unchanged from main. Because
  Sol now reviews from the branch's split point, a branch behind main merges it in and runs
  Sol again before a live apply (ship.md, codex-review skill, DECISION_LOG updated).
