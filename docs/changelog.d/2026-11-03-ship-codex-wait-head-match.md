## 2026-11-03 - Ship wait loop sees the Codex review of the current head

- `.claude/commands/ship.md` Step 8: the "wait for Codex and the checks" loop now re-reads the head each minute and searches every Codex App comment for a completed review whose `commit_sha` is the PR's current head. It used to read only the last Codex comment, which after an `@codex review` request is the "Codex Review: ..." receipt with no state, so it ran to TIMED_OUT on #1327 although the review had finished. It also never checked which commit was reviewed.
- Checked against #1327: the old check does not match; the new one matches head `2421963f90a5` and does not match a wrong SHA.
