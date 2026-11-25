## 2026-11-24 — Price sheet download ignores the search box

**Severity:** LOW. **Area:** Products, price sheet (.xlsx). **Status:** FIXED (2026-11-25, on staging once merged).
**Owner:** none. **Tracked:** #2453.

**Fixed:** the table now reports its search text (`onSearchChange`, Mason's OK to touch `src/components/ui` for
this: "price sheet doesnt effect taha, so add it to work"), and "Pricing .xlsx" exports only the active products
the filters and search show, or the ticked ones. The tooltip and toast no longer say the search is ignored.

On Products, "Pricing .xlsx" downloads the selected products, or every active product the
category, vendor and status filters show. Typing in the search box narrows the table but not the
file. Since #2453 the button's tooltip and the download toast say so, so nobody is misled, but a
user who searches for a few products still gets a larger sheet. Fix: let the table report its
searched rows so the export can use them, or move the search into the page's own filters.
