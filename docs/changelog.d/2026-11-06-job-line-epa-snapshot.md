## 2026-11-06 — Spray-job lines keep their EPA number; parent EPA correction built, switched off (database)

- New migration `20261127100000_job_line_epa_snapshot.sql` (record in `docs/reference/migrations.d/`).
  Each spray-job chemical line now carries its own copy of the EPA number, filled by the database
  from the product whenever a line is written or its product changes. Existing lines got their
  product's number, which is what every printout shows today. When a product's EPA number is edited,
  lines of jobs not sprayed yet follow it; sprayed and finished jobs keep theirs. When such a job is
  re-saved (every line erased and written again), a line keeps only a number the save sends back,
  else takes the product's; the screens PR makes the job screen send it, so the database never guesses.
- An invoice line written without an EPA number, saved without one on a draft or unposted invoice, or
  moved to another product without one, gets the product's, so no new invoice line can silently follow a
  later correction. A posted invoice's line is never filled by an unrelated edit.
- **No printout changes yet** (Mason, 2026-11-06): the applicator sheet, report, WPS notice, sent proof
  and year-end summary all still show the product's number, as today. The screens PR moves them to the
  copies.
- A parent's generic EPA number can now be corrected with a reason and evidence: the parent, every
  size and the lines of jobs not sprayed yet take the new number in one logged step; sprayed and
  finished jobs, invoices and restricted-use records keep theirs. It is refused while any
  invoice line for a size has no number of its own, and the refusal names the invoices.
- **Switched off** until the screens PR makes every reader use the copies and the job screen send
  each line's number on save; that PR's migration turns it on. Record map:
  `docs/reference/product-corrections-record-map.md`.
- "New product" and "Add a size" (`create_product_with_parent`, `add_product_size`) now also take
  `quoting_notes` and `internal_notes` inside the size (`p_size`) and save them in the same step, so
  a new product is never live without its notes. Same function inputs; a call without them is
  unchanged (PR #1553 Sol round 2; Mason, 2026-11-06).
- Proof: `node scripts/smoke/prove-parent-epa-correction-real-schema.mjs` (disposable real-schema
  database).
