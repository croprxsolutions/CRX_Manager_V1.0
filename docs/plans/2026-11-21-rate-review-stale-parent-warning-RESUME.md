# Resume note (#1722 item 4), paused 2026-11-21 for a computer restart

Done (committed on fix/1722-stale-rate-warning): migration 20270206100000 (pins computed, prover not yet passed), screen warning + 2 tests (39/39 pass), types/lib, contract updated, RT1 1e12->1e9 typo, changelog, FOLLOW_UPS entry in prove-product-rate-review-real-schema.mjs.

Next, in order:
1. `node scripts/smoke/prove-rate-review-parent-changed-real-schema.mjs` (Docker) until RATE_REVIEW_PARENT_CHANGED_PROOF_PASS; fix the prover or migration (recompute postflight md5s if the SQL changes).
2. Add docs/reference/migrations.d/20270206100000_rate_review_parent_changed_warning.md (LF SQL sha256) and the pilot-log row.
3. Full typecheck/lint/test; Luna (`node scripts/luna-review.mjs --base origin/staging`); Sol; PR into staging "Refs #1722"; send MERGE CAPTAIN (local_6f0e92ce-79da-447b-abfd-47e475a51a59) READY/BLOCKED.
4. Delete this note before the PR. Then continue even-numbered issues per the hand-over note.
