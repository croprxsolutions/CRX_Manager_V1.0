**APPLIED LIVE 2026-11-03 (PR #1381).** `20261105090000_vendor_only_product_links.sql` (LF SQL sha256: `c2d18939f5691fb13e560c6cd51130ed3552836456743039855183b70472a6c8`). WP-PM-15b step 1, Mason's DATA-11 decision 1 (2026-11-03): a link may name only the vendor, with item details not yet known.

What it does:
- `product_supplier_links.supplier_product_name` may be NULL. A new check, `product_supplier_links_vendor_only_shape`, requires SKU, unit, pack, conversion to be NULL and comparison `pending` whenever it is. Every existing row has a name, so the check validates against today's data.
- A partial unique index allows one active confirmed vendor-only link per product and vendor.
- New `link_product_vendor(product, vendor, make_preferred, performed_by, idempotency_key)`: admin only, actor-bound, idempotent, SECURITY DEFINER with `search_path = public, pg_temp`, EXECUTE for `authenticated` only. It reuses the product's active confirmed link to that vendor or records a vendor-only one, and sets preferred under a lock on the product row (on request, or automatically when the product has none).

Unchanged: `products.vendor` and all its writers, `upsert_product_supplier_link` (still requires all four item facts), every existing grant and policy. A vendor-only link is never reusable, so quote sheets, price imports and comparisons skip it. No data is written.

Rollback: `DROP FUNCTION public.link_product_vendor(uuid, uuid, boolean, uuid, text); DROP INDEX public.uq_product_supplier_links_vendor_only; ALTER TABLE public.product_supplier_links DROP CONSTRAINT product_supplier_links_vendor_only_shape;` and, only once no vendor-only link exists, `ALTER TABLE public.product_supplier_links ALTER COLUMN supplier_product_name SET NOT NULL;`.

Proof: `node scripts/smoke/prove-vendor-only-links-real-schema.mjs` prints `VENDOR_ONLY_LINKS_PROOF_PASS`. Live smoke chain: `smoke-link_product_vendor_vendor_only.sql`.

Live ledger preflight, read 2026-11-03 with read-only `execute_sql` on `supabase_migrations.schema_migrations`, row by row (the 14-digit name stamp when the name has one, otherwise the version): 1,107 rows; effective high-water `20261104180000` (`20261104180000_vendor_link_proposals`, ledger version `20261103191530`); no row at or above `20261105090000`; no function named `link_product_vendor`. Read the ledger again at apply time.

Deferred to the WP-PM-15b enforcement step (named, owner: that step):
- `get_vendor_link_proposals` counts a vendor-only link as `linked` with nothing missing; it should flag "item details not yet known".
- Supplier Pricing never passes `p_link_id`, so entering item details for a vendor that has a vendor-only link adds a second, full link instead of filling it in. The enforcement step routes that save to the vendor-only row (and takes the product-row lock in `upsert_product_supplier_link`).
