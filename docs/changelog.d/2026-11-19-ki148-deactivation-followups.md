## 2026-11-19 - KI-148 follow-ups (issue #2000): deactivation counts shared and unbilled work

- Migration `20270129170000_customer_deactivation_open_work_followups.sql` (needs `20270128140000` first) widens the customer deactivation check: a customer who pays a share of another customer's open order or undelivered delivery, or owns a field share of another customer's open or unbilled spray job, can no longer be deactivated; neither can a customer with approved blend tickets not yet billed.
- A completed spray job now counts as billed only while a live invoice bills it (its own, a split invoice made from it, or its blend ticket's). A job whose invoice was voided or deleted blocks; a job billed through its blend ticket no longer blocks for good.
- A hold for zero no longer blocks. Message wording: "open or unbilled spray job(s)", "unbilled blend ticket(s)", and the farm name is cut to 60 characters.
- Not changed here (Taha's billing work until 2026-12-15): prepay credits, credit memos, the rep's invoice view, the voided-then-deleted order's quote, and split invoices for completed deliveries.
- Proof: `node scripts/smoke/prove-ki148-customer-deactivation-real-schema.mjs` (`KI148_FOLLOWUP_PROOF_PASS`).
