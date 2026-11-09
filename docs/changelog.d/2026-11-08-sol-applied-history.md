## 2026-11-08 - Sol treats a byte-identical applied migration as history (Mason approved)

- `scripts/write-codex-push-proof.mjs` (full Sol review only) reads the live migration ledger read-only through the new
  `scripts/lib/read-applied-migration-sql.mjs` for each migration file the PR adds. A file whose text (line endings
  aside) equals the one SQL text stored live under the same name is named to Sol as applied history: Sol reviews how
  everything else uses it, not its own design. Any other case (no row, two rows, split or missing SQL, one byte
  different, an edited file, a failed read) gets the ordinary full review. The proof lists matches in `applied_history`.
- Why: PR #1653 (KI-30) carried a migration already applied live; Sol rounds 3-7 re-judged its frozen design and the PR
  could never pass. Mason approved the exact rule wording on 2026-11-08.
- No guard changed: the proof is still an ordinary full Sol proof; same model, effort, 24-hour window and gates.
