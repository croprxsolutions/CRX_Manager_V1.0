## 2026-10-29 — Fewer re-reviews after main moves (Mason: "Approve package")

- `scripts/write-codex-push-proof.mjs`: Sol reviews against `git merge-base origin/main HEAD`,
  so a branch behind main no longer has to merge it first; the proof records that base.
  A head that only merges main cleanly (no conflicts, no shared files, no hand edit) skips
  the wait for the Codex GitHub App; unanswered App threads still refuse.
- `scripts/check-doc-drift.mjs`: a stale "Last verified" date on CURRENT_STATE/KNOWN_ISSUES
  is a WARN, not a failure.
- Docs: `.claude/commands/ship.md`, `docs/reference/agent-guardrails.md`,
  `docs/manual/DECISION_LOG.md`. Tests in `write-codex-push-proof.test.mjs`.
