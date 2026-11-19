## 2026-11-18 - KI-148: deactivating a customer checks its open work

- Migration `20270128140000_customer_deactivation_checks_open_work.sql` refuses switching a customer from active to inactive while it has open orders, undelivered deliveries, active holds, open quotes (draft, sent or revised) or open invoices (posted or overdue). It applies to every role, admins included (To-Do decision 20, answered 2026-11-18), and to every path: the Customers list's bulk Deactivate, the edit page and the API. The refusal names the customer and what is still open, and nothing is deactivated.
- The one live inactive customer with 2 confirmed orders stays as it is (To-Do decision 23) and can still be edited.
- Concurrency: the check first waits for any transaction still creating work for the customer, then reads all five kinds at once. Limit: existing work reopened by a status change, or work added after the deactivation, is not caught.
- Screen: the error sentence is shown as written (`errorSanitizer`); the Customers list keeps its own invoice check.
- Proof: `node scripts/smoke/prove-ki148-customer-deactivation-real-schema.mjs` (`KI148_DEACTIVATION_PROOF_PASS`). Contract: `docs/plans/2026-11-18-ki148-customer-deactivation-CONTRACT.md`.
