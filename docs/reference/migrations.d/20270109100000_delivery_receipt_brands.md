**LOCAL CANDIDATE — NOT APPLIED.** Brand PR B part B-3 (#1697) and #1833: `20270109100000_delivery_receipt_brands.sql` (SQL sha256: `f9f52f9ace2024c77b568767288c3700dc35e4e2de871436e6df7a3067be0c87`). Re-issues two functions, each md5 pinned to its live body, same signature, owner postgres, SECURITY DEFINER, `search_path = public, pg_temp` and grants:

- `_enqueue_delivery_receipt(uuid,uuid)` (no app grants): each line of the saved receipt also carries the delivered brands from the current picks: `brands` with amounts when the picks add up to delivered (4 places); `brands` without amounts plus `brand_picked_quantity` when they do not; `brand_recorded: false` for a branded line with no pick. No brand keys for an unbranded line, a delivery with no `completed` brand event, or a completion from an out-of-date screen (`picks_confirmed` false), so the customer is never sent an unconfirmed brand.
- `get_epa_sales_to_check()` (authenticated): #1833, a brand row is listed not reviewed because of the product's registration only when the product has an EPA number.

Order: deploy the `send-delivery-receipts` Edge Function from the same PR BEFORE this apply. The sender re-sends a byte-identical email on retry; the new sender prints a receipt queued before this file exactly as before, while the old sender would drop brand keys queued after it.

Proof: `node scripts/smoke/prove-invoice-brands-real-schema.mjs` (cases 27 and 28 apply this file on top of B-1a and B-1b; prints `INVOICE_BRANDS_PROOF_PASS`).

Rollback (its own reviewed migration): re-issue `_enqueue_delivery_receipt` from `20261113140000_delivery_receipt_queue.sql` (lines 185-243) and `get_epa_sales_to_check` from `20270106110000_invoice_brands_rup.sql` (lines 1058-1193). Receipts already queued keep their brand keys and print them.
