**LOCAL CANDIDATE — NOT APPLIED.** `20270311110000_receive_po_items_with_excess_notice.sql` (SQL sha256: `f1b35a191da636349a4e9860061729eb0d24a174ac103c3448d5a50d7c384ab9`) adds an opt-in excess-quantity receiving notice.

The existing receipt operation validates and saves the receipt and stock. The optional notice uses the resulting records and the signed-in receiver. Existing app builds can continue to use the original operation. The updated Purchase Order Detail screen depends on this migration. The staging Database workflow for PR #2646 succeeded. Apply the migration through the approved release workflow before deploying an app build that calls it in production.

`receive_po_items_with_excess_notice(p_items, p_performed_by, p_idempotency_key, p_allow_over_receive)` returns `{ status, receiving_record_ids }`. The current app RPC catalog documents the Purchase Order Detail call.

The local Docker smoke chain passed with invented records. It confirmed the saved stock, previously received quantities, recipients, sender, old and new retries, refusal of sales-rep excess, notice failure isolation and receipt reversal.

Revert the dependent Purchase Order Detail app before retiring this database operation in a reviewed migration.
