## 2026-11-05 - The post-apply carry also accepts the awaiting-type-regeneration line

- `--carry-post-apply` now also accepts the one `src/lib/rpcContracts.test.ts` edit the registry refresh requires: the PR's own migration timestamps joining `MIGRATIONS_AWAITING_TYPE_REGENERATION`. Any other change to that file still refuses and needs the full review.
- Why: that required edit forced a second full Sol run after the KI-27 apply (PR #1493) (Mason, 2026-11-05; `docs/manual/DECISION_LOG.md`).
- Tests: `scripts/write-codex-push-proof.test.mjs`.
