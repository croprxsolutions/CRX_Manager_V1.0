## 2026-10-29 - Invoice cap: review round 3 (cancel of an unfinished delivery locks order-level drafts)

- Cancelling a delivery that never completed now also locks the order's whole-order draft
  and unposted invoices, so an invoice being posted at that moment cannot be overwritten
  to "cancelled" by the cancel. They still only block a delivery that was completed.
  This closes a race the security review found; it existed before this change.
- A real-database proof (a second invoice-holder race for a scheduled delivery) was added.
- Deferred with reasons: the rounding allowance is per order line and product (a very large
  split could cross it and fail closed), the apply-time preflight error does not name the
  failing order (live check before apply found no malformed or over-cap invoices), and the
  postflight does not pin which table each cap trigger sits on (names are unique today).
