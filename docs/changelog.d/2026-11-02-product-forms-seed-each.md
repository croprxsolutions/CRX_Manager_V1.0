## 2026-11-02 — Seed and Each product forms (local candidate)

Migration `20261104090000_product_forms_seed_each.sql` adds Seed and Each / unit. Seed uses Lb or Unit; Each uses Ea or Unit for inventory and containers. Other units are refused. Existing liquid and dry choices remain as they were. Billing keeps a matching unit's quantity, refuses conversion between different seed/each units, and leaves weight or volume equivalent blank. The price workbook cannot change a seed/each rate unit because its unit check knows only liquid/dry/both; use the product page. This candidate has not been applied to production.

Seed and Each require a stock unit. A blank product rate unit is filled from that stock unit before per-acre pricing. Every quote line's rate and price units must match the stock unit; blank and different units are refused. Product, quote, job and field-app pickers offer only that unit.

Every seed/each job-chemical line must be in the stock unit too: the database refuses another unit and fills a blank one, so job completion deducts the exact amount instead of falling back to the raw number. A product with no form cannot become seed/each while any of its quote or job lines uses another or a blank unit.

Live read on 2026-11-03 at 12:22 AM Central (read-only `schema_migrations` query): 1,102 ledger rows, effective high-water `20261103220000` (`period_check_takes_month_lock`, which touches only period and payment functions), highest version `20261103061336`, and no row at or after this candidate. CURRENT_STATE.md and KNOWN_ISSUES.md were re-stamped for the ledger read only.
