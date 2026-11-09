## 2026-11-08 - KI-89 closed; turn-off race and retired negative stock proofs (KI-90, KI-91)

- KI-89 closed: the inventory position report already uses Central dates live (KI-18 batch 1, `20261204100000`); no new migration.
- KI-90, KI-91: new real-schema proof `scripts/smoke/prove-product-retire-race-and-negative-stock-real-schema.mjs` covers an order reopen racing a product turn-off through `set_product_active`, and a turned-off product with negative stock in the position and cost reports.
