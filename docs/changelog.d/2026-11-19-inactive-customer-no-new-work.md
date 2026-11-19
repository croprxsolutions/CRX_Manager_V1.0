## 2026-11-19 - An inactive customer gets no new orders, deliveries, holds or spray jobs (#2000)

- Migration `20270129200000_inactive_customer_refuses_new_work.sql` carries out Mason's 2026-11-19 decision: an inactive customer must be made active again before new work is done for them. The database refuses a new order, delivery, stock hold or spray job for an inactive customer, and refuses reopening closed work (undeleting, switching a hold back on, pushing out an expired hold) or moving open work onto one. A delivery is checked against its own customer and its order's customer. It applies to every role and every path.
- Existing work of an inactive customer can still be edited, part-filled, cancelled, deleted or released. The one live inactive customer with 2 confirmed orders stays as it is; delivering them needs the customer reactivated first.
- Closes KI-148's accepted timing gap: the check locks the customer row, so a deactivation and a new piece of work saved at the same moment can no longer both go through.
- Not here (Taha's quote, invoice and booking work until 2026-12-15): quotes, invoices and bookings for inactive customers.
- Screen: the refusal sentence is shown as written (`errorSanitizer`).
- Proof: `node scripts/smoke/prove-inactive-customer-new-work-real-schema.mjs` (`INACTIVE_CUSTOMER_NEW_WORK_PROOF_PASS`). Contract: `docs/plans/2026-11-19-inactive-customer-no-new-work-CONTRACT.md`.
