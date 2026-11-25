## 2026-11-25 — Supplier quote review fixes, and the price sheet follows the search box

- Supplier Pricing › Recent: opening an import now reloads the workspace first, so the 40% price-jump warning and the
  archived-supplier warning use the approved prices and suppliers as they are now, not as they were when the page
  loaded (#2545).
- The price-jump warning no longer misses (or invents) a swing hidden by rounding to whole cents per unit when the
  package size matches the approved quote (for example a per-ton quote on a per-pound product). When the
  quote reproduces the approved per-unit price, it compares exact package prices and names them (#2545). Supplier evidence does not return the
  approved package quantity, so it is inferred: under a few cents per unit, a different package size can still
  compare rounded cents or, rarely, warn when it should not (a warning only; approval is never blocked; #2561).
- A cost per inventory unit under half a cent shows as "less than $0.01" instead of "$0.00" (converted cost,
  warning, supplier evidence).
- Screen only. No database change; stored prices and approvals are unchanged.
- Products › "Pricing .xlsx" now exports only the products the search box shows (or the ticked ones), not every
  product the filters allow. The table reports its search text through a new optional `onSearchChange`; other
  tables are unchanged. "Full price sheet" still exports every active product.
