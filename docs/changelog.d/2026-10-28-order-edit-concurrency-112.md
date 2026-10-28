## 2026-10-28 - Version-checked order editing and serialized number assignment

Local candidate for To-Do 1.12. Adds database-enforced order edit versions, retains unsaved
edits when a save needs reconciliation, and assigns ticket numbers and allocation versions
under transaction locks. Existing pricing, inventory and lifecycle checks remain authoritative.

Migration: `20261028185500_order_edit_and_number_concurrency.sql` — **not applied**.
No merge, live migration apply or deployment is authorized in this task.

Review follow-up aligns SQL save receipts with the editor, preserves original receipts
across later edits, and makes the ticket-number helper owner-only behind ticket creation.
Real-schema and four browser scenarios passed; the renewed regression run passed 6,632
tests. Future live permission narrowing requires explicit owner approval.

Verification commands, scope limits, future rollout and rollback are documented in
`docs/reference/order-edit-concurrency.md`. Shared to-do/status files are intentionally left
for the coordinating session to update after the parallel tasks are reconciled.
