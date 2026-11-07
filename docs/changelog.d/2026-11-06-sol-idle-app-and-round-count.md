## 2026-11-06 — Sol skips the wait for an idle Codex App and prints its round number

- `scripts/write-codex-push-proof.mjs`: the Sol pre-flight skips the up-to-15-minute wait for the Codex
  GitHub App when the App reviewed none of the PR's last 3 pushed heads (a pushed head = a commit GitHub
  ran check suites on). It keeps the wait when the App reviewed one of them, when the PR has fewer than 3
  pushes, or when the pushes cannot be read. It prints one line saying which case applied.
- Each full Sol run prints "Sol round N on PR #n" (or "on this branch" before the PR opens) and appends
  one line to `.claude/session-state/sol-rounds.jsonl` in the main checkout. A run counts for a branch
  when its head is one of the branch's own commits. From round 3 the line points at the AGENTS.md stop rule.
- `/codex-review` skill documents both. Decision: `docs/manual/DECISION_LOG.md` (2026-11-06).
- Proof: replay of PR 1524 at the push of `7775767e6` with real GitHub data says the App reviewed none of
  the last 3 pushes and Sol does not wait; a live dry run on PR 1524's current head prints "Sol round 1 on PR #1524".
