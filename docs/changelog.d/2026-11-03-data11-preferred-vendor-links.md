## 2026-11-03 — Every product gets a preferred vendor (WP-PM-15b data step, local candidate)

Local candidate migration `20261105100000_data11_preferred_vendor_links.sql` carries out Mason's DATA-11 approval:
- Each active product without a vendor link gets one to the vendor its vendor text already names, marked preferred, with item details "not yet known".
- The two products with no vendor text get the vendors Mason chose, and that vendor's name as their vendor text.
- The existing single links get marked preferred.

It is bound to the exact list Mason reviewed and refuses if anything changed since. It changes no other vendor text and no price. Proof: `scripts/smoke/prove-data11-preferred-links-real-schema.mjs`.
