**LOCAL CANDIDATE — NOT APPLIED.** `20261104170000_product_unit_backfill.sql` (LF SQL sha256: `e23d3a100d5dc46d0755b05949adf2bda771958fa2c7872754011a15d7d2b6b4`). DATA migration for WP-PM-6a: sets `products.unit_size` to the row's `inventory_unit` on the nine products the owner approved one by one on 2026-11-03 (the review list is private; the file names rows by id only). One row changes `LB` to `Lb`; eight change `''` (empty text) to `Gal` (seven) or `MG` (one). No other row, column, grant, policy or function changes.

It **overwrites existing rows**, so its live apply needs Mason's own `I approve` reply for this exact file (`scripts/owner-approve-migration.mjs`; ship.md, Migrations bullet), on top of the normal proofs.

**Safety rules in the file.**
- One statement. On a database with none of the nine ids (a fresh rebuild) it changes nothing.
- Otherwise all nine must exist and still hold exactly the approved old Unit and inventory unit, or it raises `PRODUCT_UNIT_BACKFILL_DRIFT` and changes nothing.
- It raises `PRODUCT_UNIT_BACKFILL_PRICE_MOVED` if any per-acre price or `pricing_version` moves. `recalc_product_price_per_acre` reads `inventory_unit` first, which is set on all nine, so none should.
- Old billed lines keep their own stored unit (`order_items`, `quote_items`, `invoice_items`, `delivery_items`, `purchase_order_items`, `delivery_remainders`, `job_chemicals.unit`); no trigger on `products` writes to them.
- `write_product_change_history` records one `unit_size` row per product, with no actor (no signed-in user).

**Readers that see the new Unit afterwards** (none changes a stored amount):
- `_transfer_job_to_invoice_intent_impl_20260908` and `create_job_from_quote_section` copy the product's Unit as the new line's label; amounts come from the stored line cents.
- `_cost_step2_job_chemicals` fills a missing job-line cost by converting from the product's Unit; with a blank Unit it skipped the conversion, so the corrected Unit makes that fill correct.
- `preview_product_pricing_changes`, `apply_product_pricing_change_set` and `create_pricing_workbook_export` fingerprint `unit_size`. A pricing preview or price workbook made before the apply is refused for these nine rows afterwards and must be redone. Live, 2026-11-03: one unapplied single-product preview (product page) includes one of the nine.

**Stale product page (after apply).** `ProductDetail.tsx` re-sends every setup field, `unit_size` included, and checks only `pricing_version`, which this file deliberately leaves alone. A product page opened on one of the nine before the apply and saved after it would write the old Unit back. The history table would record that, but nothing blocks it. After the apply, re-read the nine rows' `unit_size` the next day.

**Proof.** `node scripts/smoke/prove-product-unit-backfill-real-schema.mjs` (Docker, no network): fresh database is a no-op; a hand-fixed row, a moved inventory unit or a missing row each refuse with nothing changed; a mutated copy that also moves a per-acre price is refused; the real apply sets the nine Units while every other product column, every other product (one unapproved blank included) and every other public table stay byte-identical, with nine history rows; a second apply is refused.

**Live rehearsal, 2026-11-03 (rolled back).** The exact DO block ran against live inside a transaction that ended in `SMOKE_PASS_ROLLBACK`: no drift or price error; `unit_now_matches=9 other_columns_changed=0 new_history_rows=9 mismatches_left_all_products=0`. So on the live rows the per-acre recompute and the use-timing re-sync leave every other column byte-identical (`to_jsonb(row) - 'unit_size'`). A read straight afterwards still showed the nine mismatches and no new history rows.

**Live read, 2026-11-03 (read-only).** 604 products, 595 agree; the nine that differ are exactly the approved ids, with the approved old values. Live migration high-water: `20261104140000_pricing_tier_order_warning`. Open PRs hold `20261104150000` and `20261104160000`. Re-read both at apply time.

**Rollback.** A reviewed migration setting each id's `unit_size` back to its old value (the ids and old values are in the file).
