## 2026-11-25 — Supplier Pricing: small leftovers after the unit-floor fix

**Severity:** LOW. **Area:** Supplier Pricing (supplier quotes and product links). **Status:** OPEN.
**Owner:** unassigned. **Tracked:** #2524 (follow-ups section).

Existing behaviour that #2524 did not change. Each one can put a wrong supplier cost in front of
whoever approves the quote; approving still needs a person.

- **A converted cost under one cent shows as $0.** A very cheap quote spread over a large package
  rounds the per-unit cost down to zero instead of refusing or warning.
- **A blank package quantity counts as 1.** A quote row with no package quantity is read as one
  package, so a missing number gives a per-unit cost that looks real.
- **The archived-supplier warning uses the last refresh.** If someone archives a supplier after the
  review screen loaded, its quotes show no warning until Refresh. Approving is allowed either way.
- **Duplicate detection ignores package size.** Two quote rows sent straight to the database that
  differ only by package quantity keep only the first.
- **Saving a product link with blank fields shows a raw code.** Leaving the supplier SKU, unit or
  pack description blank shows `SUPPLIER_LINK_REUSE_FIELDS_REQUIRED` instead of a plain message.

The warning for quotes far from the current approved price is being built separately and is not
part of this entry.
