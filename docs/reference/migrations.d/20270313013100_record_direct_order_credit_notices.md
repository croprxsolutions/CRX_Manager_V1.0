**LOCAL CANDIDATE — NOT APPLIED.** `20270313013100_record_direct_order_credit_notices.sql` (SQL sha256: `f3bb722934482cc1204439dc8c2a33e392edc81709a2aa25d9b46fb7abdc5dcc`) adds the checked post-save credit notice for ordinary New Order.

The authenticated save wrapper calls existing `create_direct_order` with the same eight arguments and returns the same required JSON fields. The optional authorization marker holds the saved customer's ID and notice delivery state. Existing order receipts never hold credit balances or limits. The checked sender accepts only the original order's retry key and checks the current office role and receipt owner before returning credit data or sending a notice.

The database rolls out first. Current clients keep their original operation. The dependent New Order change will add the updated callable types and remove its direct notice send. Keep the operations installed during an application rollback so cached clients can still save orders.

The local Docker smoke tests use invented data and roll back. The migration checks the expected installed order and credit dependencies and narrows both new function grants to the authenticated API role.
