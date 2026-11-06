## 2026-11-05 — Migration approval waits for green checks; restamp refusal says what to do

- `scripts/owner-approve-migration.mjs` no longer asks Mason to approve a migration until its pull request
  is merge-ready (every check green). The apply gate already refused until then; asking earlier let a peer's
  newer migration go live in the gap and voided his approval (PR #1495). Check: `scripts/lib/owner-approval-pr.mjs`.
- When the ordering guard refuses a migration because a newer one is live, `scripts/apply-migration-file.mjs`
  now prints the restamp steps, starting with `npm run next-migration-stamp` (a hand-picked stamp collided with
  another worktree's in PR #1495). `scripts/lib/migration-restamp-hint.mjs`.
- Both tests run in `npm run test:correction-guards`.
