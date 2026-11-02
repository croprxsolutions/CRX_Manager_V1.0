## 2026-11-02 — Seed and Each product forms (local candidate)

Product setup now offers Seed and Each / unit. Seed uses Lb or Unit; Each uses Ea or Unit for inventory and containers. Other units are refused. Existing liquid and dry choices remain as they were. Billing keeps a matching unit's quantity, refuses conversion between different seed/each units, and leaves weight or volume equivalent blank. The price workbook accepts only Ea/Unit as a new rate unit on seed/each products and refuses others. This candidate has not been applied to production.

Seed and Each rate units and every quote line's rate and price units must match the product's stock unit. Product and quote screens offer only that unit, and database triggers refuse mixed units before pricing can convert them.
