**LOCAL CANDIDATE — NOT APPLIED.** `20261102230000_chicago_season_and_statement_dates.sql` (SQL sha256: `0c0b9136753cc0376cb61afd082233e7ba710b19229ac9407abd04df9b591a5b`). `current_season()` reads the America/Chicago date instead of the UTC date, and the customer statement dates prepay applications and undated payment allocation sets by the Chicago date; `invoices.invoice_date` defaults to the Chicago date and the return-credit header dates credit memos by it, so an invoice's date and season agree. No grant or data change; every live body and the old default are pinned before the edit.

Rollback: a reviewed migration restoring the two pinned bodies. Proof: `scripts/smoke/prove-chicago-season-and-statement.mjs`.

**Live capture — 2026-11-02 (read-only ledger query):** effective high-water is `20261102200000` (`cost_definer_leaks_closed`, recorded as version `20261102183928`); this candidate's stamp follows it. Re-read before applying.
