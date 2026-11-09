## 2026-11-06 — KI-18 batch 1: money, compliance and stock decisions use the Chicago date

- New migration `20261204100000_ki18_batch1_chicago_today.sql`. The database clock is UTC, so after 6 PM
  (7 PM in summer) Central it thought it was already tomorrow. 30 functions now take "today" from the
  Chicago date: accounting-month checks on payments and credits, commission payment dates, the default
  quote expiry, AR reminder day counts, applicator-license expiry, inventory hold and stock checks, and default delivery, bill and payment dates. Four column defaults change the same way.
  A RUP sale record carries the earlier of the invoice date and the posting day; its license must be
  valid on the invoice date and today and issued by the sale date (no issue date on file is a warning). Undoing a credit application or
  write-off is refused when its UTC or Chicago date falls in a closed month (3 more functions).
- The overnight overdue, quote-expiry and morning-notice jobs are left as they are: they run between midnight
  and 6 am Central, when both dates agree. The job-holds helper's evening hold expiry is a follow-up.
- Nothing else in those functions changes. Boards and reports (batch 2) ship in the same PR; statement and AR aging
  ranges in batch 3.
- Proof: `scripts/smoke/prove-ki18-batch1-chicago-today-real-schema.mjs`.
- Applied live 2026-11-06 (ledger `20261107041703`). The RUP smoke chain's test license now has an issue date, and
  six actor-forgery allowlist pins plus the reversal-helper pin in `return-credit-intent-binding` follow the new
  one-line date bodies.
