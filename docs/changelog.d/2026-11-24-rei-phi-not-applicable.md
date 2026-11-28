## 2026-11-24 — REI / PHI "not applicable" on products

- Migration `20270303130000_product_interval_not_applicable.sql` (NOT APPLIED): `products.rei_not_applicable` and
  `phi_not_applicable` (default false), a CHECK that a flag is only set while its interval is blank, a trigger that
  clears a flag when a number is written or the EPA number changes, and the two flags in product change history.
- Product page: "Label gives no REI" / "Label gives no PHI" ticks on a saved product; a ticked field no longer counts
  toward "Incomplete setup". Never stored as 0. No backfill.
- Contract: `docs/plans/2026-11-24-rei-phi-not-applicable-CONTRACT.md`.
