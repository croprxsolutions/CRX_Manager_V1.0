**LOCAL CANDIDATE — NOT APPLIED.** `20270313013100_record_direct_order_credit_notices.sql` (SQL sha256: `b8a659b5d4a2cba8aa728a320acdf855ece239482720c57f9de1b53185d7318c`) adds the checked post-save credit notice for ordinary New Order.

The authenticated save wrapper calls existing `create_direct_order` with the same eight arguments and returns the same required JSON fields. The optional authorization marker holds the saved customer's ID and notice delivery state. Existing order receipts never hold credit balances or limits. The checked sender accepts only the original order's retry key and checks the current office role and receipt owner before returning credit data or sending a notice.

The database rolls out first. Current clients keep their original operation. The dependent New Order change will add the updated callable types and remove its direct notice send. Keep the operations installed during an application rollback so cached clients can still save orders.

The local Docker smoke tests use invented data and roll back. The migration checks the expected installed order and credit dependencies and narrows both new function grants to the authenticated API role.
