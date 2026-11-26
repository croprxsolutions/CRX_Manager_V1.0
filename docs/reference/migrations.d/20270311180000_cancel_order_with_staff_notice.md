**LOCAL CANDIDATE — NOT APPLIED.** `20270311180000_cancel_order_with_staff_notice.sql` (SQL sha256: `1c72f8d32bfbc82e26abdaa44c21fbcdcfec91988d2d072f2e17bf72c6511b8a`) adds the checked staff notice after whole-order cancellation.

An active admin can call `cancel_order_with_notice(p_order_id, p_performed_by, p_idempotency_key)`. It calls the existing cancellation operation and returns the same JSON result. The new operation has a separate bound receipt. A fresh whole cancellation alerts active admins and records the signed-in sender. A failed send preserves the successful cancellation and records the failure.

Older clients may keep calling the existing cancellation operation during rollout. Add the new operation to the app RPC catalog when Order Detail starts using it. For rollback, restore the dependent app before retiring the added operation in a reviewed migration. Keep saved cancellations, notices and receipts.

The local Docker prover runs a rollback-only check and a separate two-session contention check. It exercises checked and legacy cancellation, actor and recipient rules, receipt expiry, remainder close, exact notice text, and both ordinary notification errors and cancelled notification queries. The contention check covers an exact retry, different admin requests, and a change to admin eligibility during cancellation.

Apply after the existing commission-settlement migration. The preflight checks the installed cancellation and lifecycle receipt dependencies.
