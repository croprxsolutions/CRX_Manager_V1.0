## 2026-11-24 — Price sheet download ignores the search box

**Severity:** LOW. **Area:** Products, price sheet (.xlsx). **Status:** OPEN.
**Owner:** Taha (the search box lives in `src/components/ui`). **Tracked:** #2453.

On Products, "Pricing .xlsx" downloads the selected products, or every active product the
category, vendor and status filters show. Typing in the search box narrows the table but not the
file. Since #2453 the button's tooltip and the download toast say so, so nobody is misled, but a
user who searches for a few products still gets a larger sheet. Fix: let the table report its
searched rows so the export can use them, or move the search into the page's own filters.
