## 2026-11-04 - The post-apply records commit keeps the Sol review

- `scripts/write-codex-push-proof.mjs --carry-post-apply` carries a clean Sol proof to a head that is one commit on top of it and only updates the records after a live migration apply: `docs/reference/migrations.d/*.md`, `docs/changelog.d/*.md`, `docs/manual/KNOWN_ISSUES.md`, `.claude/schema-registry.json`, and allowlist re-keys in `scripts/db-invariant-sweeps/allowlist.json` (same signature, new hash, appended justification). No model call; anything else refuses. `carriedSolProof()` in `.claude/hooks/codex-push-lib.mjs` accepts the new `post_apply` mode with an unchanged base.
- Why: the post-apply commit forced a second full Sol run on PR #1452 (twice) and PR #1327 (Mason, 2026-11-04; `docs/manual/DECISION_LOG.md`).
- Tests: `scripts/write-codex-push-proof.test.mjs`, `.claude/hooks/codex-push-lib.test.mjs`.
