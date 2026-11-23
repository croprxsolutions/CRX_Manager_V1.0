## 2026-11-23 - KI-133 and KI-135 closed: reports say "Booked Sales" and "price-list cost"

- Docs only. KI-135 (D12 item 7) moves to the closed list: PR #2259, merged to staging 2026-11-23, relabelled the
  Inventory page card "Inventory Value (price-list cost)" and the Reports total "Inventory value at price-list cost",
  and marked the per-row rows left out of the total. MASTER_FIX_PLAN row W3-27 now says Closed. The entry's original
  text is in `docs/manual/archive/KNOWN_ISSUES-history-2026-10.md`.
- Proof: the new label seen on the Inventory page of the local test copy (staging `5b549b9e4`) on 2026-11-23.
- KI-133 closes on the same PR #2259: Profitability and Gross Sales say "Booked Sales" with an order-based basis note, and no draft filter is needed because the database refuses a draft order status. MASTER_FIX_PLAN row W3-26 now says Closed. The note and the "Booked Sales Summary" tab were seen on the local test copy on 2026-11-23 (no orders there, so column headers were checked by the Reports tests only).
