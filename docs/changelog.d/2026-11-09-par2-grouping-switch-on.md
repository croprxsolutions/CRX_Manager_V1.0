## 2026-11-09 - PAR-2: switch product grouping on (migration 20261229100000, candidate)

Mason approved turning on product grouping so the PAR-2 data step can start (batch 1: 36 groups whose sizes
already agree). The migration only flips `_product_parent_grouping_open()` to true; approval on the Group
Products screen then works. Record: `docs/reference/migrations.d/20261229100000_product_grouping_switch_on.md`.
Proof: `scripts/smoke/prove-product-grouping-switch-on-real-schema.mjs`.
