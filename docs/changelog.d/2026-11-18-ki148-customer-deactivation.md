## 2026-11-18 - KI-148: deactivating a customer checks its open work

- Migration `20270128140000_customer_deactivation_checks_open_work.sql` refuses switching a customer from active to inactive while it has open orders, undelivered deliveries, active holds, open quotes (draft, sent, revised, or accepted with no undeleted order) or open invoices (posted or overdue). It applies to every role, admins included (To-Do decision 20, answered 2026-11-18), and to every path: the Customers list's bulk Deactivate, the edit page and the API. The refusal names the customer and what is still open, and nothing is deactivated. (The Customers list checks open invoices itself first and gives its own message for those.)
- The one live inactive customer with 2 confirmed orders stays as it is (To-Do decision 23) and can still be edited.
- Limit (Mason accepted, 2026-11-18 and 2026-11-19): a point-in-time check of all five kinds at once, with no locks. Work being saved at that same moment, or added after the deactivation, is not caught.
- Screen: the error sentence is shown as written (`errorSanitizer`); the Customers list keeps its own invoice check.
- Proof: `node scripts/smoke/prove-ki148-customer-deactivation-real-schema.mjs` (`KI148_DEACTIVATION_PROOF_PASS`). Contract: `docs/plans/2026-11-18-ki148-customer-deactivation-CONTRACT.md`.
