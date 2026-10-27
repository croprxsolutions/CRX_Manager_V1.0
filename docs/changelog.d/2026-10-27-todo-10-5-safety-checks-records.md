## 2026-10-27 — To-Do row 10.5 records the safety-check PR (#1132)

- `docs/manual/TO_DO_LIST.md` row 10.5 now records PR #1132 (merged 2026-10-27): the RUP-license
  and credit-limit checks before Post stop when they cannot read their data, the credit check uses
  the server's `customer_credit_exposure` (PR #1138), invoice PDFs and Email refuse rather than
  print or send with blank customer details, and what was left as it is. Records only: no code
  changes. The row edit was held out of #1132 at the Coordinator's request so it would not void
  that PR's review when other PRs touched the same file.
