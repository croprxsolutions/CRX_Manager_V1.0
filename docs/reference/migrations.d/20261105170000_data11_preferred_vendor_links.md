**APPLIED LIVE 2026-11-03** (ledger version `20261104012254`, Mason's approval in chat, PR #1385 merged as `2622eb97b`; live check after apply: 596 active products, 596 preferred links, 0 products without exactly one, 0 vendor-name mismatches, 586 new vendor-only links). `20261105170000_data11_preferred_vendor_links.sql` (LF SQL sha256: `30fd1d2ae165027557e7886da8d4fd2b8a45e543a5a5bb409c2bb063a15e82b1`). WP-PM-15b data step, Mason's DATA-11 decisions 2, 3 and 4 (2026-11-03). REQUIRES `20261105090000`.

What it does:
- Gives every active product with no vendor link a vendor-only link (item details not yet known), marked preferred. The link goes to the one vendor its vendor text already names, directly, by an approved alias, or by an approved legacy resolution.
- Gives the two products with no vendor text that Mason assigned by hand their vendor. Only the ids are in the file; the names stay in his private review list. Their blank vendor text becomes that vendor's name, so every active product's vendor text matches its preferred vendor (the other 594 already match exactly, read live 2026-11-03). Any planned product whose text is not exactly its vendor's name gets that name too; live, that is only these two, and the step refuses unless every active product then shows its preferred vendor's exact name.
- Marks preferred the single confirmed link of each product that has links but none preferred (decision 3).
- Records the links as confirmed by Mason. It changes no other product vendor text (on live), no other link, no vendor and no price.

Bound to the approved list: the plan is fingerprinted over every active product, and the migration refuses (changing nothing) unless it equals the plan read live on 2026-11-03 and reviewed by Mason: 596 active products, 586 new links, 10 preferred flags, 0 left over. Any product, vendor, alias or link change that alters what it would write (which product gets which vendor, which link, by id, becomes preferred, or the vendor text of any planned product) stops it for a fresh review. A lone existing link is made preferred only when the product's vendor text names that same vendor. It also refuses unless the approver is an active admin, the written counts match (586 links, 10 preferred flags, 2 vendor names), and afterwards every active product has exactly one active, confirmed, preferred link to a live vendor.

Rollback: delete the vendor-only links it created (`supplier_product_name IS NULL AND confirmed_by = <approver> AND created_at = <apply time>`), set `is_preferred = false` on the 10 links it marked, and set `vendor = ''` (empty text, its value before, read live 2026-11-03) on the two hand-assigned products named by id in the migration (`updated_at` = the apply time). All three steps are exactly identifiable from the apply transaction's timestamp. Run it before the enforcement migration (20261105180000) is installed, or remove that first, since it refuses blank vendor text on a linked product.

Proof: `node scripts/smoke/prove-data11-preferred-links-real-schema.mjs` prints `DATA11_PREFERRED_LINKS_PROOF_PASS`. It runs in Docker with invented rows and covers:
- refusal on a different plan, with nothing written;
- refusal for a non-admin approver, a count mismatch, and an unresolvable product;
- the exact writes;
- a second run refusing.

Live preflight (2026-11-03): the plan fingerprint (including vendor text and the id of each link it marks preferred) matches, and all 10 lone-link products' vendor text names their link's vendor; the ledger high-water is `20261105090000` once step 1 is applied.

Live ledger preflight, read 2026-11-03 23:43 UTC (5:43 PM Central) with read-only `execute_sql`: 1111 rows; effective high-water `20261105130000` (`20261105130000_month_end_deliveries_skip_cancelled`, ledger version `20261103223741`); no ledger name contains `data11`. **Renumbered `20261105100000` -> `20261105170000`** the same day because that month-end migration went live first and the old stamp would have sorted below the high-water. Read the ledger again at apply time.
