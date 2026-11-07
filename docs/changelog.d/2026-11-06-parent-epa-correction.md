## 2026-11-06 — Parent EPA correction built, switched off; invoice lines always keep an EPA number (database)

- New migration `20261206113000_parent_epa_correction.sql` (record in `docs/reference/migrations.d/`).
  Applies after `20261204120000_job_lines_keep_epa_number` (sprayed and finished jobs keep their number).
- An invoice line written without an EPA number, saved without one on a draft or unposted invoice, or
  moved to another product without one, gets the product's, so no new invoice line can silently follow a
  later correction. A posted invoice's line is never filled by an unrelated edit.
- A parent's generic EPA number can be corrected with a reason and evidence: the parent and every size
  take the new number in one logged step, which jobs not sprayed yet show; sprayed and finished jobs,
  invoices and restricted-use records keep theirs. It is refused while any invoice line for a size has
  no number of its own, and the refusal names the invoices.
- **Switched off** until the screens PR makes every printout read the job's kept number and the year-end summary the invoice line's copy; that PR's
  migration turns it on. **No printout changes.** Record map:
  `docs/reference/product-corrections-record-map.md`.
- Proof: `node scripts/smoke/prove-parent-epa-correction-real-schema.mjs` (disposable real-schema
  database).
