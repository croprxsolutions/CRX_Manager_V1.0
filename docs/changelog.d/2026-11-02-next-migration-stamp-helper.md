## 2026-11-02 - Helper picks a migration stamp that cannot collide

- New `npm run next-migration-stamp -- [--live <version>] [--gap-minutes <n>]` (`scripts/next-migration-stamp.mjs`) reads every migration stamp in `origin/main`, every local worktree and every open PR, plus the live high-water when passed, and prints a stamp at least an hour above all of them. One Product Master run re-stamped five times on 2026-11-02 after hand-picked stamps collided; each re-stamp after Sol cost a new Sol review. It is a helper, not a blocking hook; the caller reads the live high-water read-only.
- The `create-migration` skill, the `run-loop` launcher, the Product Master mission doc and `DATABASE_CHANGE_CHECKLIST.md` now say to use it.
- `scripts/next-migration-stamp.test.mjs` (in `npm run test:agent-workflows`) checks the choice with fixture lists: never equal to an open PR's stamp, always above the max by the gap.
