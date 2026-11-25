## 2026-11-25 — Supplier Pricing: small leftovers after the unit-floor fix

**Severity:** LOW. **Area:** Supplier Pricing (supplier quotes and product links). **Status:** OPEN.
**Owner:** unassigned. **Tracked:** #2524 (follow-ups section) for items 1 to 4; item 5 is new here.

Existing behaviour that #2524 did not change. Items 1 and 2 can show a per-unit cost that looks real but is
wrong; items 3 to 5 are a stale warning, a dropped duplicate and a raw error code.

- **FIXED (#2565): A converted cost under half a cent shows as $0.00.** It now shows "less than $0.01" (converted
  cost, price-jump warning and supplier evidence). Screen only; stored prices are unchanged.
- **A blank package quantity counts as 1.** A quote row with no package quantity is read as one
  package, so a missing number gives a per-unit cost that looks real.
- **FIXED (#2565): The archived-supplier warning uses the last refresh.** Opening an import from Recent now
  reloads suppliers and approved prices first. An import already open still shows what it loaded until Refresh.
- **Duplicate detection ignores package size, price unit and end date.** Two quote rows sent straight to the
  database that differ only in those keep only the first.
- **Saving a product link with blank fields shows a raw code.** Leaving the supplier SKU, unit or
  pack description blank shows `SUPPLIER_LINK_REUSE_FIELDS_REQUIRED` instead of a plain message.

The price-jump warning for quotes far from the current approved price shipped separately in #2546.
