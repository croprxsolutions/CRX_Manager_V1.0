## 2026-11-24 - Field application FP-1: one split per field, with history

- Migration `20270303120000_field_split_versions.sql` (contract: `docs/plans/field-application/CONTRACT-who-pays.md` › FP-1). Each field's split (who pays and what share) is now kept as dated versions with two share sets, product and application, in exact micro-percent (100,000,000 = 100%), so the split in force on any spray date can be looked up later and a payer can be 0% on one side. History cannot be edited or deleted; each share set must total exactly 100%.
- New office functions: `set_field_billing_split` (save a split from any start date, with notes; replay-safe) and `field_split_as_of` (who pays for these fields on this date). Admins and sales reps only.
- `field_billing_defaults` becomes a read-only copy of today's split, kept current by the writer and a nightly job just after Central midnight; every existing screen keeps reading it. Browser and service_role writes to it are revoked (the app never wrote it directly).
- `save_field` (today's Field Setup screen) saves through the same writer: a save that does not change who pays writes no new version and keeps the notes; no split sent (NULL) leaves the split and notes alone; an empty split puts the field back on its owner at 100% from today (a new version, so history is kept).
- Until FP-4 (job billing reads split history), each payer's product and application shares must be equal (`FIELD_SPLIT_SHARES_MUST_MATCH_UNTIL_FP4`), because billing still uses the one-share copy.
- The copy marks the owner primary when the owner pays, otherwise the largest payer (lowest customer id on a tie); the apply stops if that would move today's primary mark.
- Deleting a customer who owns or pays on a field is now refused (was: the customer's fields were deleted with it). Deleting a field that has a split is refused until FP-3 adds archiving; mark it inactive instead.
- Existing splits become version 1 ("history before this date unknown"); thirds saved as 33.333333% each become exactly 33.333334 / 33.333333 / 33.333333.
- Proof: `node scripts/smoke/prove-field-split-versions-real-schema.mjs` (`FIELD_SPLIT_VERSIONS_PROOF_PASS`, local Docker).
- Not verified: the staging database (applied by the staging DB job after merge); the Field Setup screen change (its own PR).
