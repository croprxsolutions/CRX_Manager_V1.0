## 2026-11-23 - #2014: the post-push conflict warning checks every push and the real destination branch

- `.claude/hooks/post-push-dirty-warning.mjs` now asks GitHub about every push in the command (up to three, in parallel, so the router's time limit still holds) and, for a refspec push, about the destination branch (`topic:release` asks for `release`). It still only warns and never blocks.
- Proof: `node .claude/hooks/hook-router.test.mjs` (93 assertions).
