**LOCAL CANDIDATE — NOT APPLIED.** `20270309090000_receive_po_items_with_excess_notice.sql` (SQL sha256: `268ab0fb5505cbbb2550b7b5985670a25568663a5060787e03829e2da20eb08e`) adds an opt-in excess-quantity receiving notice.

The existing receipt operation validates and saves the receipt and stock. The optional notice uses the resulting records and the signed-in receiver. The current app continues to use the original operation during rollout.

`receive_po_items_with_excess_notice(p_items, p_performed_by, p_idempotency_key, p_allow_over_receive)` returns `{ status, receiving_record_ids }`. Add it to the app RPC catalog when Purchase Order Detail starts calling it.

The local Docker smoke chain passed with invented records. It confirmed the saved stock, previously received quantities, recipients, sender, old and new retries, refusal of sales-rep excess, notice failure isolation and receipt reversal.

Revert the dependent Purchase Order Detail app before retiring this database operation in a reviewed migration.
