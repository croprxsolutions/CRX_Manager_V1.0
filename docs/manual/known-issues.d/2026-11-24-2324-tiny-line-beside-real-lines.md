## 2026-11-24 — A delivered line under 0.01 next to real lines still bills a tiny amount

**Severity:** LOW. **Area:** order completion / chemical invoices. **Status:** OPEN.
**Owner:** unassigned (small separate PR; Taha reviews). **Tracked:** #2324.

#2324 makes the database refuse completing an order where nothing was delivered, and treats a
delivered quantity under 0.01 as nothing. That rule only covers the whole order: if one line has
under 0.01 delivered but other lines have real quantities, that one line still goes onto the invoice
as a tiny amount. Taha asked (2026-11-24) for such lines to be treated as zero too, in a small PR
of their own after #2324.
