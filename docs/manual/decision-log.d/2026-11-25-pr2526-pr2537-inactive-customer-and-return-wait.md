## 2026-11-25 — v0.2.1: inactive customers can't be invoiced (#2526); a new return waits for an older pending one (#2537)

**Decision (Mason, reply to Taha's 2026-11-25 chemical-side review posted in #crx-work; "Yes, record them"):** yes to both v0.2.1 behaviour questions. #2526: an inactive customer cannot be invoiced or have an invoice posted until reactivated; credit memos and payment corrections are still allowed. #2537: a new return waits while an older, not-yet-credited return of the same product on the same order is pending.
**Why:** billing an inactive account is a mistake to stop, but fixing money already on it must still work. Two pending returns on the same line could credit the wrong price.
**What this forbids/implies:**
- Keep #2537's wait as narrow as Taha built it: it fires only when tax or a standing discount is on the invoice. Sales tax is rare for CRX, so do not widen it.
- Both PRs are Taha's; they land once reviewed. They are first in the order of work (`2026-11-25-taha-review-order-of-work.md`).
