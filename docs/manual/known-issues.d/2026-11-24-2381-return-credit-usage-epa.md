## 2026-11-24 — Year-end product usage files a return credit under a corrected EPA number

**Severity:** HIGH (Sol round 11 on #2381; skipped for that PR by Mason). **Area:** chemical invoices / year-end usage reporting. **Status:** OPEN.
**Owner:** Taha (with his chemical invoice work). **Tracked:** #2381.

If a size's EPA number is corrected between a sale and that sale's return credit in the same season,
the year-end product usage file counts the credit under the new number instead of the number the sale
was filed under. The sale's number then shows more product used than really was, and the new number
shows less. The customer's dollar totals are unaffected.
