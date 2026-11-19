## 2026-11-19 - KI-148 follow-ups (issue #2000): deactivation counts split payers

- Migration `20270129170000_customer_deactivation_open_work_followups.sql` (needs `20270128140000` first) widens the customer deactivation check: a customer who pays a share of another customer's open order or undelivered delivery can no longer be deactivated.
- A hold for zero no longer blocks. Message wording: "open or unbilled spray job(s)", and the farm name is cut to 60 characters.
- Not changed here (Taha's billing work until 2026-12-15): prepay credits, credit memos, the rep's invoice view, the voided-then-deleted order's quote, split invoices for completed deliveries, field-split spray job owners, unbilled blend tickets, and when a completed spray job counts as billed.
- Proof: `node scripts/smoke/prove-ki148-customer-deactivation-real-schema.mjs` (`KI148_FOLLOWUP_PROOF_PASS`).
