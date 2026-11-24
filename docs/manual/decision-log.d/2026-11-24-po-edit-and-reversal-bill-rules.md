## 2026-11-24 — Edit PO follows the 5% bill rule; reversed receipts are covered by the exception (KI-151 follow-up)

**Decision (Mason, 2026-11-23, Slack, answering Taha's #2266 review):** "The 5% rule also applies when Edit PO lowers a quantity, and the exception covers bills that went over because a receipt was reversed."

**What this implies:** an Edit PO save that lowers the ordered total (a lower quantity, a removed line, or a lower cost on a line not yet received) is refused when it leaves the active vendor bills more than 5% over that total, as a cost cut already is. A cost cut is not blocked by a bill that is already over what arrived, whether it was billed up front or a receipt was later reversed; the ordered-total rule still applies to both. A receipt can be reversed only while no active bill is on the PO, so in practice the bill is voided, the receipt reversed, and the bill entered again with a confirmed reason. Migration `20270302020000_po_edit_cannot_cut_under_bills.sql`.

**Decision (Mason, 2026-11-24, option A on Sol's HIGH):** once a PO has an active vendor bill, a sales rep cannot lower its total at all; the screen says an admin must make the change. Admins keep the 5% rule. Reason: reps cannot see costs, and a per-amount refusal would let a rep guess the bill's size by trying cuts.
