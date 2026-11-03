## 2026-11-03 - Ship: no stray Codex mentions in PR text

- `.claude/commands/ship.md` Step 8: the standalone review-request comment is the only place an agent may write the at-sign Codex mention. Anywhere else (PR description, commit message, other comments, even inside backticks) it starts a Codex cloud task instead of a review, posts no review-state comment, and the Step 8 wait loop never matches. On #1354 the PR body quoted the request text, the Codex App answered with a summary of its own edits, and the real review came only after a separate bare request comment.
