**LOCAL CANDIDATE, not applied. Needs Mason's `I approve` (it overwrites existing rows).** `20261105100000_data11_preferred_vendor_links.sql` (LF SQL sha256: `e7606435f3c5f3fb81c7dc6bf22e930c2ea31329a0795bcf6938dd91cd147c4c`). WP-PM-15b data step, Mason's DATA-11 decisions 2, 3 and 4 (2026-11-03). REQUIRES `20261105090000`.

What it does:
- Gives every active product with no vendor link a vendor-only link (item details not yet known), marked preferred. The link goes to the one vendor its vendor text already names, directly, by an approved alias, or by an approved legacy resolution.
- Gives the two products with no vendor text that Mason assigned by hand their vendor. Only the ids are in the file; the names stay in his private review list. Their blank vendor text becomes that vendor's name, so every active product's vendor text matches its preferred vendor (the other 594 already match exactly, read live 2026-11-03).
- Marks preferred the single confirmed link of each product that has links but none preferred (decision 3).
- Records the links as confirmed by Mason. It changes no other product vendor text, no other link, no vendor and no price.

Bound to the approved list: the plan is fingerprinted over every active product, and the migration refuses (changing nothing) unless it equals the plan read live on 2026-11-03 and reviewed by Mason: 596 active products, 586 new links, 10 preferred flags, 0 left over. Any product, vendor, alias or link change that alters what it would write (which product gets which vendor, or which link becomes preferred) stops it for a fresh review. It also refuses unless the approver is an active admin, the written counts match (586 links, 10 preferred flags, 2 vendor names), and afterwards every active product has exactly one active, confirmed, preferred link to a live vendor.

Rollback: delete the vendor-only links it created (`supplier_product_name IS NULL AND confirmed_by = <approver> AND created_at = <apply time>`), and set `is_preferred = false` on the 10 links it marked. Both steps are exactly identifiable from the apply transaction's timestamp.

Proof: `node scripts/smoke/prove-data11-preferred-links-real-schema.mjs` prints `DATA11_PREFERRED_LINKS_PROOF_PASS`. It runs in Docker with invented rows and covers:
- refusal on a different plan, with nothing written;
- refusal for a non-admin approver, a count mismatch, and an unresolvable product;
- the exact writes;
- a second run refusing.

Live preflight (2026-11-03): the plan fingerprint matches; the ledger high-water is `20261105090000` once step 1 is applied.
