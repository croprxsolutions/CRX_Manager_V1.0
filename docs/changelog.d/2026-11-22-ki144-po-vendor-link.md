## 2026-11-22 - KI-144: a purchase order keeps a link to its vendor (database part)

- Migration `20270224150000_po_vendor_link.sql`: new `purchase_orders.vendor_id`, set by the server on every new PO or vendor-name change. Renaming a vendor keeps a linked PO's printed name and link (Mason, 2026-11-22: "Keep original name").
- A vendor bill on a linked PO must come from that vendor, whatever it is called now; before, a rename made every bill on the vendor's older POs fail with VENDOR_PO_MISMATCH. Unlinked POs keep the old name check.
- Data: none. Existing POs are not linked (Mason, 2026-11-22: "drop old-po linking"); they keep the name check, so renaming a vendor still breaks billing its POs written before this change.
- Proof: `node scripts/smoke/prove-po-vendor-link-real-schema.mjs` (`PO_VENDOR_LINK_PROOF_PASS`, local Docker).
- Not yet: screens and reports reading the link (follow-up PR).
