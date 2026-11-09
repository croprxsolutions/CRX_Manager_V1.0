## 2026-11-09 - pr-readiness shows unanswered teammate comments

`npm run pr-readiness` now prints `unanswered teammate comments: N` right under each PR's head line, with
each comment's link, using the same rule as the merge and apply gates (`.claude/hooks/teammate-comments-lib.mjs`).
Its `open threads` line counts only line-level review threads, so on 2026-11-08 #1650 showed "0" while
Taha's general PR comment sat unanswered and the migration was applied live. A failed or cut-off read
prints `UNREADABLE`/`TRUNCATED`, never 0. Per Sol's advice there is no overall READY verdict; exit 0
still means "every PR was read".
