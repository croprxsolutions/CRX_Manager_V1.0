## 2026-10-29 - Product grand plan: setup spreadsheet and rate lock, vendors, parent records, bulk by the gallon, label link

Mason added six decisions to `docs/plans/2026-10-29-product-GRAND-PLAN.md` (overlaps 11 to 15):
- **Setup spreadsheet, then rate lock:** a setup workbook for setup fields, rates and vendors, followed by a database-enforced "Lock rates" switch on live rates.
- **One product, many vendors:** one preferred vendor per product (WP-PM-15).
- **One parent record per formulation:** each size stays its own row (PAR-1 and PAR-2, first in Stage 2). Label facts are kept per EPA registration.
- **Bulk sold by the gallon:** a tote is the container, not a separate product.
- **A label link on every product:** WP-PM-16, early in Stage 1 ("Search EPA labels", becoming "View label" once the label PDF is saved).
- **No CFU count for biologicals.**

Sol (`gpt-6-sol`, high, advisory) reviewed the additions and returned 38 findings, 3 of them BLOCKERs. A third, whole-plan Sol review of the final text returned 51 more (4 BLOCKERs). All 89 are folded in; two follow-up questions for Mason are open (a tote fill when Bulk shows too little; what a shop-filled tote costs).

Updated to match:
- the decision log;
- the build sheet: four new packages, 20 in total;
- the overnight-loop mission, which still passes its validator;
- START HERE;
- the To-Do list.

Mason then answered the four follow-up questions:
- **Categories:** a "Seed" category is added, and the category list becomes admin-maintained.
- **Rate lock:** any admin may switch it, with a reason.
- **Totes:** filled both ways, with a new recorded "fill a tote from bulk" step (BLK-1).
- **Deposits:** totes carry no deposit.

Mason's last two changes: a rate above the label maximum warns instead of being refused, and the Brand vs Generic page is rebuilt from scratch after all the other product work.

Documentation only; nothing is built.
