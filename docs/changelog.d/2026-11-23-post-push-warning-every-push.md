## 2026-11-23 - #2014: the post-push conflict warning checks every push and the real destination branch

- `.claude/hooks/post-push-dirty-warning.mjs` now asks GitHub about every push in the command (up to three, in parallel, so the router's time limit still holds) and, for a refspec push, about the destination branch (`topic:release` asks for `release`). A `HEAD` refspec beside another (`git push origin HEAD other`) still checks the current branch. It still only warns and never blocks.
- Proof: `node .claude/hooks/hook-router.test.mjs` (95 assertions).
- Doc stamps: `docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md` "Last verified 2026-11-23" follow a read-only re-read of the live migration ledger on 2026-11-23: the latest live row is still `20261121061349`, so nothing else in either file changed.
