## 2026-11-25 — Supplier Pricing: small leftovers after the unit-floor fix

**Severity:** LOW. **Area:** Supplier Pricing (supplier quotes and product links). **Status:** OPEN.
**Owner:** unassigned. **Tracked:** #2524 (follow-ups section) for items 1 to 4; item 5 is new here.

Existing behaviour that #2524 did not change. Items 1 and 2 can show a per-unit cost that looks real but is
wrong; items 3 to 5 are a stale warning, a dropped duplicate and a raw error code.

- **A converted cost under half a cent shows as $0.00.** It rounds to the nearest cent, so a very cheap quote
  spread over a large package shows $0.00. Nothing refuses it; the price-jump warning (#2546) flags it only when
  the link already has a current approved price.
- **A blank package quantity counts as 1.** A quote row with no package quantity is read as one
  package, so a missing number gives a per-unit cost that looks real.
- **The archived-supplier warning uses the last refresh.** If someone archives a supplier after the
  review screen loaded, its quotes show no warning until Refresh. Approving is allowed either way.
- **Duplicate detection ignores package size, price unit and end date.** Two quote rows sent straight to the
  database that differ only in those keep only the first.
- **Saving a product link with blank fields shows a raw code.** Leaving the supplier SKU, unit or
  pack description blank shows `SUPPLIER_LINK_REUSE_FIELDS_REQUIRED` instead of a plain message.

The price-jump warning for quotes far from the current approved price shipped separately in #2546.
