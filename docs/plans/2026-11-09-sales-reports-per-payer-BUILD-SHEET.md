# Build sheet: sales reports show each payer's share of a split sale

Mason, 2026-11-06 (top priority; replaces "sales reports stay under the main customer until M15" in
`20261215110000_chem_sale_bill_split_invoices.sql`). One PR, database only.

## What changes

Today a $1,000 chemical sale where the landlord pays 40% shows the farmer at $1,000 in Sales Reports and
on the dashboard. After this change the farmer shows $600 and the landlord $400. Every total stays the
same to the cent.

- **Sales Detail**: a split sale line becomes one row per payer (their dollars, quantity, cost and
  profit, and their own invoice number). An unsplit line is exactly as before.
- **Sales Summary**: "By customer" credits each payer their share. By product, month and rep the
  totals are unchanged; the line count stays one per sale line.
- **Dashboard**: "Top customers" and "Lowest-margin customers" use each payer's share. The headline,
  monthly trend and product lists don't group by customer and are unchanged.
- **Customer filter** on Sales Reports finds a payer's shares: filtering on the landlord shows their $400.

## How the split is worked out

The same rule the invoices use (`_bill_split_line_shares`, billing plan M2): the line's own shares,
else the sale's Bill Split card; each other payer gets their percentage rounded down to the cent, and
the main customer (or, if they have no share, the largest payer) gets the rest. So the payers always add
up to the line exactly. Quantity splits the same way; cost splits by each payer's quantity, rounded down,
with the rest to the same payer, so cost and profit totals don't move either.

The report keeps reading the sale (ordered amounts, order date, season, rep), as today. It does not
switch to reading invoices: that is roadmap area 2 (one sales source from invoice lines) and would
change totals.

## Edge cases

| Case | Result |
|---|---|
| Sale with no other payers | One row, byte-for-byte the same numbers as today. |
| Field/acre split sale | Unchanged (under the main customer). Field splits have their own engine; per-payer field reporting is roadmap area 2. |
| Credits and returns | Not subtracted today; still not. Unchanged. |
| Voided, cancelled, deleted sales; unpriced rush lines | Still left out, as today. |
| A payer's invoice voided or not yet posted | The share still shows (the report is by sale, as for any sale); the invoice number column shows that payer's live invoice, or blank. |
| Rounding | Payer shares add to the line exactly (cents, quantity and cost). |
| Date, season, product, category, rep filters | Unchanged; they apply to the sale. |
| Orders count on "By customer" | A split sale counts once under each payer who has a share. |
| Who sees what | Unchanged: admins and reps already see every customer's sales here; cost, profit and margin stay admin-only; the dashboard stays admin-only. The new helper can't be called from the app. |

## Files

- `supabase/migrations/20261229150000_sales_reports_per_payer.sql`: new read-only helper
  `_sales_line_payers`, and the two report bodies and `financial_dashboard_summary` re-written to use it.
- Its record, a changelog entry, a smoke chain and a real-schema proof with split fixtures.
- No screen change: the reports return the same columns.

## Risks

- Money display (read-only): wrong numbers would mislead, never change stored money. The proof checks
  totals equal before and after on live, and the split numbers on test rows.
- Live has no split sales yet (0 Bill Split rows on 2026-11-09), so the split numbers are proven on
  test rows; on live the proof is "nothing changed".

## Proof

1. Real-schema test database: a $1,000 sale with a 40% landlord shows $600 / $400, a line override, a
   three-way split with cents to round, and totals equal before and after.
2. Live, read-only, before and after the apply: Sales Detail, Summary and dashboard totals identical.
