## 2026-11-04 — Drift reviewer: missing live-ordering evidence is a MED, not a HIGH

`.claude/agents/migration-drift-reviewer.md` CHECK 6 used to emit a HIGH (so no apply proofs were minted) whenever the migration record carried no live `list_migrations` capture. On #1439 (`20261106140000`) it did this twice in a row on a correctly ordered file, and the fix each time was to paste a live capture into the record. That evidence is now a MED that names the backstop. Mason approved this cut in the 2026-11-04 retro ("Yes, narrow it").

Remaining enforcement: `scripts/apply-migration-file.mjs` re-reads the live ledger right before transmitting, applies the same row-by-row ordering rule, and refuses an out-of-order stamp (no live list, no apply). The reviewer still emits a HIGH when the evidence it has shows the filename is not greater. `scripts/check-agent-guidance.mjs` pins the new wording.
