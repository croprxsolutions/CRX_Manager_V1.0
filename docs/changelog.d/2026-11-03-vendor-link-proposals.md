## 2026-11-03 — Vendor link proposals and a compatible product-page writer (WP-PM-15a, local candidate)

Local candidate migration `20261104180000_vendor_link_proposals.sql` adds `get_vendor_link_proposals()`, a read-only, admin-only report for DATA-11. For each active product it shows:

- how the legacy `products.vendor` text resolves to an active vendor (by name, an approved alias or an approved legacy resolution);
- the product's existing links;
- a status: `linked`, `linked_text_differs`, `linked_no_preferred`, `proposed`, `ambiguous`, `unresolved` or `no_vendor`;
- purchasing evidence: sent (not draft or cancelled) POs from that vendor, and the newest approved quote-sheet row (these exist only where a link exists or once existed);
- the link fields that no record supplies.

It writes nothing and returns no cost. Confirming a proposal stays with `upsert_product_supplier_link`, which still refuses a link without SKU, unit, pack description and supplier product name.

Product Detail now leaves `vendor` out of its update when the user did not change it, so a page left open can never re-save an old vendor over a newer one once WP-PM-15b makes the vendor a copy of the preferred link. Every other vendor behaviour is unchanged, and no copy rule or refusal is enabled. Proof: `scripts/smoke/prove-vendor-link-proposals-real-schema.mjs`. The migration has not been applied here.
