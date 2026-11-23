## 2026-11-22 - KI-133 / KI-135: reports say what they measure

- Reports: Profitability (by customer, by product, Booked Sales Summary) and Gross Sales call their sales "Booked Sales" and carry one line saying they are order-based (lines not yet delivered included, credits not subtracted), that profit and margin use the saved pricing cost, and that Bottom Line P&L uses posted invoices. The "Revenue Summary" tab is now "Booked Sales Summary"; CSV headers follow.
- Drafts: no change needed. The database refuses a draft order status (`orders_status_check` allows only confirmed, partially fulfilled, fulfilled, cancelled, voided), so Gross Sales cannot include one.
- Inventory: the Inventory page card reads "Inventory Value (price-list cost)" and the Reports total "Inventory value at price-list cost". The per-row Inventory Cost table marks rows left out of the total ("Below zero, not counted", "No cost, value unknown"); its CSV leaves their value blank and adds an "In Total" column, so the column sums to the total.
- Proof: Reports, Inventory and inventory-value tests.
