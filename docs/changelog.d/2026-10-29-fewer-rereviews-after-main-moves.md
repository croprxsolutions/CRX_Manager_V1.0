## 2026-10-29 — No Codex App wait after a clean main merge (Mason: "Approve package")

- `scripts/write-codex-push-proof.mjs`: a head that only merges main cleanly (no conflicts,
  no shared files, no hand edit, one split point) skips the wait for the Codex GitHub App;
  unanswered App threads on the merge or the commit before it still refuse.
- Docs: `.claude/commands/ship.md`, the codex-review skill, `docs/manual/DECISION_LOG.md`.
  Tests in `write-codex-push-proof.test.mjs`.
