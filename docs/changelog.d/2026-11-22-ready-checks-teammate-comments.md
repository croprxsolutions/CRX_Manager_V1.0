## 2026-11-22 - A PR's session checks teammate comments before READY

- `ship.md` › Landing several PRs with a merge captain: a child session now runs `npm run pr-readiness -- <n>` before it sends `READY`, and answers every unanswered teammate comment with a reply that contains the comment's link. Before this change, only the captain was told to check.
- Why: on 2026-11-22 the merge gate refused #1989 after READY because of three unanswered Taha reviews, which cost a round trip. The same miss happened on #1650 on 2026-11-09.
- The merge gate still enforces this. This line only moves the check earlier.
