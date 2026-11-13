# Business logic and workflow review (2026-11-11)

Read-only review comparing recorded business decisions, `origin/main` source (through `c2aaadce8`), the
[Agvance/AgWorks research](../research/2026-11-03-ag-retail-software/README.md) and the Chem Man gap analysis.
No code or data was changed. Live function bodies and real transactions were not checked: these are
source-confirmed gaps and decision inconsistencies, not proof that each example has happened in production.
Filed 2026-11-13 as known issues and to-do items for future work; nothing here is scheduled for building.

## Overall

The main direction stands: delivery separate from invoicing, advance money recorded as prepay, the books kept
outside CRX, costs and margins admin-only, enterprise features deferred. The December billing rehearsal should prove
the difficult cases before more competitor-inspired features are added. The main concerns are incomplete exception
workflows and reports that do not define their numbers the same way.

## Findings and where they are tracked

| # | Finding | Priority | Tracked in |
|---|---|---|---|
| 1 | Reports answer "what did we sell / bill / collect / earn" on different bases: booked orders called revenue, P&L commissions by order date, Monthly Summary reading the old payments table, past-month AR showing today's AR | HIGH | KI-125, KI-129, KI-130, KI-133 |
| 2 | Commissions need one lifecycle: when calculated, when they count in profit, when payable. Payout does not check the customer has paid; return clawback unbuilt; partial billing across months unspecified | HIGH | KI-13, KI-125 (split by share billed, decided 2026-11-13), KI-154, To-Do 8.3 |
| 3 | Stock count applied movement during the count twice | HIGH | KI-134 — **closed 2026-11-11 (PR #1775)** |
| 4a | A partly received PO could not be closed short | HIGH | KI-142 — **closed 2026-11-11 (PRs #1798, #1807)** |
| 4b | Receiving adds the typed number without checking the purchase unit matches the stock unit | HIGH | KI-136 |
| 5 | Customer credit loop: outside refunds unrecorded, reminders/finance charges ignore available credit, finance-charge rate label ambiguous | HIGH before use | To-Do 6.4, 6.8; KI-127, KI-132; decisions 17 and 21 |
| 6 | Cut-over plan is underspecified and older plans describe a different finish line (all billing Jan 1, automatic QuickBooks Desktop sync) | Important | To-Do 16.3, 16.4; KI-155 |
| 7 | "Profit" and "inventory value" use the saved pricing cost, not the cost actually paid; labels should say so | MEDIUM | KI-135 |

Keep generic customer prepay; do not revive the shelved product-earmark engine (it could double-spend funds).
Parking the full inventory-costing project remains a reasonable scope decision.

## Corrections to the older Chem Man gap analysis

- **"Bill Split saves percentages that billing ignores"** — outdated. Order and delivery split billing now use Bill Split; what remains is proof and exception handling.
- **"CRX charges no sales tax"** — superseded by the per-sale tax checkbox decision; tax and discount work still needs its planned verification.
- **"Restricted-use sales should gain a blocking option"** — settled: Mason chose warn-only. The one-time EPA registration setup ran 2026-11-11.
- **"Prepay should be tied to products"** — an optional redesign; generic customer prepay is the chosen model.
- **"CRX needs one unified work-ticket object"** — not established. Separate orders, deliveries, jobs and invoices work if their handoffs are reliable; a redesign needs an observed staff problem.
- **"CRX needs broader accounting, portal and costing features"** — the narrower scope stands.
- **"The gap analysis is a build list"** — no. Mason's 2026-11-04 decision: the audit flags differences; each feature is built only when separately approved.

## Recommended acceptance scenario for the December rehearsal

A split sale delivered across two months, with a discount and prepay, a partial payment, a return and an outside
refund, then reconciled through commissions, statements, month-end, stock and the accounting summary. Taha's billing
work and the inventory fixes should prove that chain before launch. Recorded as To-Do 16.11.
