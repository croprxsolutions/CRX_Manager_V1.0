## 2026-11-07 — KI-18 leftovers: evening hold expiry, the month a reversal belongs to, stale-quote timing

- New migration `20261206110000_ki18_leftovers_hold_expiry_reversal_month_stale_quotes.sql`, applied live 2026-11-07 (PR #1615).
- A job's stock-shortfall warning keeps counting a hold that ends today until the Central day ends; from 6 pm
  (7 pm in summer) it used to treat that hold as already expired. The same function now refuses a signed-in
  caller who passes someone else as the acting user (every app path already passes its own).
- Reversing a write-off or a credit applied to an invoice checks only the month of the Central day it was
  made (Mason, 2026-11-07). Before, one made in the evening of a month's last day could not be reversed once
  the next month was closed.
- The stale-quote call list puts a quote on its N-day list on the day its shown age reaches N, not hours later.
- Proof: `scripts/smoke/prove-ki18-leftovers-real-schema.mjs`.
