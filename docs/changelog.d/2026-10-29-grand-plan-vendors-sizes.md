## 2026-10-29 - Product grand plan: setup spreadsheet and rate lock, vendors, parent records, bulk by the gallon, label link

Mason added six decisions to `docs/plans/2026-10-29-product-GRAND-PLAN.md` (overlaps 11 to 15):
- **Setup spreadsheet, then rate lock:** a setup workbook for setup fields, rates and vendors, followed by a database-enforced "Lock rates" switch on live rates.
- **One product, many vendors:** one preferred vendor per product (WP-PM-15).
- **One parent record per formulation:** each size stays its own row (PAR-1 and PAR-2, first in Stage 2). Label facts are kept per EPA registration.
- **Bulk sold by the gallon:** a tote is the container, not a separate product.
- **A "View label" link on every product:** WP-PM-16, early in Stage 1.
- **No CFU count for biologicals.**

Sol (`gpt-6-sol`, high, advisory) reviewed the additions and returned 38 findings, 3 of them BLOCKERs. All 38 are folded in.

Updated to match:
- the decision log;
- the build sheet: four new packages, 20 in total;
- the overnight-loop mission, which still passes its validator;
- START HERE;
- the To-Do list.

Four questions for Mason are open: categories, who may unlock rates, how fixed totes are stocked, and tote deposits.

Documentation only; nothing is built.
