**LOCAL CANDIDATE, not applied.** `20261105110000_preferred_vendor_enforcement.sql` (LF SQL sha256: `ffa508f6b776e0331c7572e5bf245e7871554d0c9bf9f461e8a12b25cf048fab`). WP-PM-15b enforcement step. REQUIRES `20261105100000` (DATA-11) live first: its install refuses with `PREFERRED_VENDOR_ENFORCEMENT_NOT_READY`, changing nothing, while any product with links lacks exactly one preferred link, shows other vendor text, or prefers a deleted vendor.

What it does:
- A product with active confirmed vendor links has exactly one preferred link (a deferred constraint trigger; `PREFERRED_VENDOR_REQUIRED` at commit otherwise).
- `products.vendor` becomes a read-only copy of the preferred vendor's name. Trigger copies follow a preferred change, an unlink, a link moved between products, and a vendor rename (`save_vendor`). A rename locks the products it reaches and re-reads them, and a preferred change locks the vendor it copies from, so a rename racing a preferred change never leaves the wrong name. A direct write that changes it is refused with `PRODUCT_VENDOR_FOLLOWS_PREFERRED_VENDOR` and points to the Vendors section. A save that leaves it unchanged still works.
- Product inserts still work. When a signed-in user's vendor text names exactly one vendor (directly, by approved alias or approved legacy resolution), the product gets that vendor as a preferred vendor-only link and its exact name.
- A new link is locked against its product, becomes preferred when the product has none, and a full link retires the same vendor's vendor-only link, inheriting its preferred flag.
- Deleting a vendor that is any product's preferred vendor is refused (`VENDOR_IS_PREFERRED`).
- New `unlink_product_vendor(link, performed_by, idempotency_key)`: admin only, actor-bound, idempotent. It refuses the preferred link.
- New `get_product_vendors(product)`: an active admin or sales rep reads the product's vendors (live vendors only), preferred first; other roles get NOT_AUTHORIZED. Last cost (normalized to the inventory unit, the quoted package cost, and its date) is returned to admins only.
- `get_vendor_link_proposals` marks vendor-only links `item_details_known = false` and still lists their missing item fields.

Grants: every new function is revoked from PUBLIC, anon, authenticated and service_role; EXECUTE goes to `authenticated` only on `unlink_product_vendor` and `get_product_vendors`. All are SECURITY DEFINER with `search_path = public, pg_temp`.

Rollback: drop the seven triggers and nine functions this file creates, and restore `get_vendor_link_proposals` from `20261104180000`. No data is written, so nothing needs restoring.

Proof: `node scripts/smoke/prove-preferred-vendor-enforcement-real-schema.mjs` prints `PREFERRED_VENDOR_ENFORCEMENT_PROOF_PASS`.
