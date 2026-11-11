## 2026-11-11 — RT-3: Mason's rate review (database, applied live 2026-11-11 5:55 PM Central)

- Migration `20270104110000_product_rate_review.sql`; contract `docs/plans/2026-11-11-product-RT3-rate-review-CONTRACT.md`.
- Every draft rate row gets a decision (approve, or reopen to correct, with who and when; suggested value and source
  text kept) and every parent an outcome: `approved_default`, `no_per_acre_default` or `needs_label_data`. An
  unapproved row can never be part of a promotable outcome. Any later change to a parent's rates clears its outcome.
- Nothing reads these rates yet: quotes, jobs and PDFs are unchanged until RT-4's cut-over.
- Screens (its own Rate review workbook) come in a follow-up PR once the database part is live.
- Proof: `node scripts/smoke/prove-product-rate-review-real-schema.mjs`.
