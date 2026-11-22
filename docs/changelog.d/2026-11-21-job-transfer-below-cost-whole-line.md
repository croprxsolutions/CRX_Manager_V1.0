## 2026-11-21 — Create Invoice on a spray job no longer refuses small or customer-supplied chemical lines

- New migration `20270207125000_job_transfer_below_cost_whole_line.sql` (not applied live; record in `docs/reference/migrations.d/`).
- Before: the below-cost check compared each job chemical line's whole total with ONE stock unit's cost, so a 3 fl oz line of a product stocked by the gallon, half a gallon, or any customer-supplied $0 line stopped Create Invoice, while 10 gallons sold under cost passed. Those jobs were billed by hand.
- Now the spray job's Create Invoice judges each chemical line on its whole quantity: the line total must cover the product's cost for that quantity (units converted exactly). Customer-supplied lines bill at $0 as labelled. A line genuinely below cost stops Create Invoice with a plain sentence naming the product (never the cost), and nothing is invoiced.
- A unit that does not convert to the stock unit (for example Ea on a gallon product) is judged exactly as before. Orders, quotes, invoices, deliveries and field-invoice saves are unchanged.
- Known follow-up: re-saving such an invoice later from the invoice screen still judges the small line against one stock unit (a rep is refused; an admin gives a reason).
- Overlap: Taha's open issue #2061 touches the same function; no open PR re-emits it.
- Live 2026-11-21: 0 completed-and-unbilled jobs. Proof: `node scripts/smoke/prove-job-transfer-below-cost-real-schema.mjs`. Not yet verified on staging.
