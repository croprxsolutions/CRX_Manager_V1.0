## 2026-10-28 - Parked Chicago document-number year fix (To-Do 12.1)

Quote, order and rebate-claim numbers select their year in America/Chicago,
following the existing invoice-number pattern. Existing numbers and formats,
sequence positions, rebate counters, access rules and retry handling are preserved.
The quote screen reports a failed number allocation and refuses to save without a
confirmed number rather than creating an identifier in the browser.

Candidate migration: `20261028185021_document_numbers_chicago_year.sql`.
This work is parked: no merge, live migration apply or deployment is authorized.
Verification and remaining delivery gates are recorded in
`docs/operations/2026-10-28-document-number-year-proof.md`.
