## 2026-11-22 - KI-144: a purchase order keeps a link to its vendor (database part)

- Migration `20270217130000_po_vendor_link.sql`: new `purchase_orders.vendor_id`, filled from the vendor name for existing POs and set by the server on every new PO or vendor-name change. Renaming a vendor keeps its old POs' printed name and link (Mason, 2026-11-22: "Keep original name").
- A vendor bill on a linked PO must come from that vendor, whatever it is called now; before, a rename made every bill on the vendor's older POs fail with VENDOR_PO_MISMATCH. Unlinked POs keep the old name check.
- Data: links existing POs whose name matches exactly one active vendor (live 2026-11-22: 31 of 34); the other 3 stay unlinked (To-Do decision 23).
- Proof: `node scripts/smoke/prove-po-vendor-link-real-schema.mjs` (`PO_VENDOR_LINK_PROOF_PASS`, local Docker).
- Not yet: screens and reports reading the link (follow-up PR).
