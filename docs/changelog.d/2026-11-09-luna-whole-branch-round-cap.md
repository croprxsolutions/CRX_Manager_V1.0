## 2026-11-09 - Luna stops after 6 whole-branch rounds on a branch

`scripts/luna-review.mjs` now refuses the 7th whole-branch Luna round on any branch (`LUNA RESULT: STOPPED`,
exit 1, Codex not called) and says the next step is one of: simplify (a fresh "attack this plan for simplicity"
session), merge or rebase onto current main and re-plan, or ask Mason the business rule behind the mechanism.
Rerunning with `--after-simplify`, `--after-rebase` or `--after-new-approach "<reason>"` allows 6 more rounds and
records the step and reason. It replaces a written stop rule that failed seven times (PR #1688 ran about 12 rounds,
Brand PR B 26). Mason approved the cap of 6 on 2026-11-09. The count shares the guard-change counter file; the
guard-change cap of 2 is unchanged. Advisory tooling only: no proof, gate or pinned model changes.
