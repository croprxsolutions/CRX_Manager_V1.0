## 2026-11-24 — The live database sweeps stop at the cost check (statement timeout)

**Severity:** LOW. **Area:** tooling / live database sweeps. **Status:** OPEN.
**Owner:** unassigned. **Tracked:** found during #2457.

`npm run db-sweeps:live` stopped at sweep 7 of 33 twice on 2026-11-24: the `cost-exposure-review` check
(`scripts/db-invariant-sweeps/predicates/cost-exposure-review.sql`) runs past the live database's
statement timeout, and the runner gives up on the first failure, so the 26 sweeps after it never run.
Until it is fixed, a live sweep run proves nothing past sweep 7. Fix: make that check cheaper, or let
the runner record the timeout and carry on with the remaining sweeps.
