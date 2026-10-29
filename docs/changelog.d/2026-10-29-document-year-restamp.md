## 2026-10-29 - Prepare Chicago document years for protected landing

- Merge current main, preserve the live ticket-number concurrency logic, and re-stamp the unapplied migration as `20261029160300_document_numbers_chicago_year.sql`.
- Refresh the narrowly verified date/year issue notes against the live catalog and migration ledger. Update the disposable proof's candidate path.
- Remove the branch's draft-only preview deployment hold while retaining main's build ignore command. Release gates remain required before apply and merge.
