## 2026-11-25 — Supplier quote review warns when a price is more than 40% from the current approved one

- Supplier Pricing › Staged import: a pending row whose cost per inventory unit is more than 40% above or below the
  current approved price per unit (Mason, 2026-11-25) for the same supplier link shows a warning naming both amounts
  and the approved price's date (for example a $4,500.00 typo for $45.00). Approval stays allowed. No warning when
  the link has no approved price yet, or when its supplier is archived (evidence skips archived suppliers).
- The approve confirmation adds "Check first: N selected row(s) are more than 40% away from the current approved price."
- Screen only: the current approved price comes from the supplier evidence the page already loads. No database change.
- Contract: `docs/plans/2026-11-25-supplier-quote-price-jump-warning-CONTRACT.md` (follow-up Astra #4 of the
  2026-11-24 unit-floor contract).
