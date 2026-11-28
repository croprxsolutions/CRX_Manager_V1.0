## 2026-11-24 — #2470 drops the Edit PO cost-cut rules and keeps the billed-PO line lock

**Decision (Mason, 2026-11-24, after Sol round 4 on #2470 found another HIGH in Edit PO):** "Drop the cut rules".
**What this implies:** #2470 ships only the billed-PO line lock: once a PO has an active vendor bill, Edit PO cannot change its lines for anyone (void the bill, edit, enter it again); header edits still save. The 5% cost-cut checks and the reversed-receipt tests this branch had added are removed, and the earlier 2026-11-23 Edit PO 5% decision (`2026-11-24-po-edit-and-reversal-bill-rules.md`) is not built. Staging's existing Correct Unit Cost behaviour (`set_purchase_order_item_costs`) is unchanged. Sol round 5 on #2470 reviews this reduced change.
