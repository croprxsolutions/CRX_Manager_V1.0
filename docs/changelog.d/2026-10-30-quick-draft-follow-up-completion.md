## 2026-10-30 — Keep physical follow-up deliveries available

- Use the existing delivery-wide invoice validator to leave an unpostable completed quick-delivery draft group out of the order-wide draft reservation. Valid groups still count; active posted non-credit invoices always count.
- Preserve both posting checks and the invoice-first delivery reversal rule. The affected draft group must be corrected before any invoice in it can post.
- Add actual follow-up completion/replay, shared-delivery draft, posting-refusal and correction checks to the disposable real-schema chain. Both focused cases recorded inventory once and posted exactly the eight units physically delivered after correction.
