## 2026-11-04 - A byte-identical migration restamp keeps its reviews

- `scripts/write-codex-push-proof.mjs --carry-restamp` carries a clean Sol proof to a head that is one commit on top of it and only gives one migration a new timestamp (identical LF-normalized SQL; other files may only swap the old stamp for the new one). No model call; anything else refuses. `carriedSolProof()` in `.claude/hooks/codex-push-lib.mjs` accepts the new `restamp` mode with an unchanged base.
- `scripts/write-apply-proofs.mjs --restamp-from <old-name> <new-name>` copies both apply proofs to the new name when they are clean, fresh and bound to the same SQL hash; the original 24-hour clock keeps running.
- Mason's owner approval never carries. Why: restamps forced a full Sol re-run three times, most recently on PR #1425 (Mason, 2026-11-04; `docs/manual/DECISION_LOG.md`).
- Tests: `scripts/write-codex-push-proof.test.mjs`, `scripts/write-apply-proofs.test.mjs`, `.claude/hooks/migration-apply-lib.test.mjs`.
