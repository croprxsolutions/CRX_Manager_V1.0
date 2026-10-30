## 2026-10-29 - Sol risk check: second review round

Luna's second round. In the Codex merge guard, git's "not an ancestor" answer from a shallow clone now counts as unreadable, so a Sol proof of an earlier commit is not accepted on it. A Claude merge-guard test that checked allow-point ordering against text no longer in the guard now pins the real proof check. The guard header and `.claude/commands/ship.md` now say Sol is needed only on risky PRs and may cover an earlier commit on the branch. Kept as designed: unreadable labels still require CodeRabbit (fail closed).
