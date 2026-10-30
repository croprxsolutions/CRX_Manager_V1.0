## 2026-10-30 — merges wait for an answer to a teammate's PR comment

Both merge gates read CodeRabbit and the Codex App but never read a person's
comment, and Taha's review bot posts under his own account. Its blocking finding
on #1174 was fixed only because a session happened to read it.

A merge into main is now refused while a comment from a human other than the PR's
author and `masonwells1` has no comment, from someone else, containing its link.
A one-line reply clears it, with no push and no new Sol run. A failed read refuses
and the agent retries; a PR with over 100 comments in one list refuses and needs
Mason's decision (the largest of the last 100 PRs had 30). The rule lives in
`.claude/hooks/teammate-comments-lib.mjs`, which joins Codex's protected harness
files. Each merge makes one more GitHub read,
inside the gates' existing time budget.
