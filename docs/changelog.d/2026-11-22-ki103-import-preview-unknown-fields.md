## 2026-11-22 - KI-103: the product import preview flags a field the save would refuse

- Migration `20270214110000_product_import_preview_refuses_unknown_fields.sql`: `preview_product_import` refuses a row carrying a top-level field other than `insert`, `rates` or `expected_prices`, naming the field. Before, the preview said "ready" and the save then refused the whole file.
- No data changes; the import screen only sends those three fields, so nothing it does changes.
- Proof: `node scripts/smoke/prove-product-import-unknown-field-real-schema.mjs` (`PRODUCT_IMPORT_UNKNOWN_FIELD_PROOF_PASS`, local Docker): reproduces the old ready-then-refused behavior, then shows the refusal at preview, good rows and rates still preview ready and save, and the old shape and admin refusals are unchanged.
- Not verified: the staging database (applied by the staging DB job after merge).
