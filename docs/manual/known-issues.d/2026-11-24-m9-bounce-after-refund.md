## 2026-11-24 — A bounced check whose prepay was partly refunded must be recorded by hand

**Severity:** MED. **Area:** billing / prepay (M9 returned checks). **Status:** ACCEPTED.
**Owner:** Taha. **Tracked:** #2416.

If part of a check's prepay was refunded to the customer outside CRX ("Refund paid outside CRX") and the
bank later returns (bounces) that check, CRX refuses to record the bounce (`CHECK_PREPAY_REFUNDED`) and
says to record it by hand. Until then the invoices the check paid stay marked paid, and the check stays
in Month-End's payments received. It only happens when money is refunded before the check has cleared.

**Decision (Taha, 2026-11-24):** accepted for the trial (Sol advisory review at `693746e3a`, HIGH 5).
The refusal is deliberate in the M9 design (a refund would have to be reversed too). Revisit if it
happens in practice.
