## 2026-11-23 - #2265: an invoice whose payments were all voided can be unposted

- Migration `20270225130000_unpost_ignores_voided_payment_history.sql`: Unpost (single and group) no longer refuses an invoice just because a voided payment's allocation rows are still kept as history. An active payment, order or invoice allocations, write-offs, prepay and applied credit still refuse, as before.
- On unpost, those history rows lose only their link to an invoice line (they keep the invoice, amount and payment), so saving the unposted draft no longer fails on the line delete. The audit row records how many (`voided_payment_history_unlinked`).
- Proof: `node scripts/smoke/prove-unpost-voided-payment-history-real-schema.mjs` (`UNPOST_VOIDED_PAYMENT_HISTORY_PROOF_PASS`, local Docker): reproduces the refusal, then shows unpost, draft save with its lines and re-post work, the save would fail without the unlink, active or partly voided payments still block, and group unpost works the same way.
- Not verified: the staging database (applied by the staging DB job after merge).
