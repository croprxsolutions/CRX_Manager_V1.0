## 2026-11-24 — One supplier quote test uses rows the server would mark duplicate

**Severity:** LOW. **Area:** Tests, `src/pages/SupplierPricing.test.tsx`. **Status:** OPEN.
**Owner:** unassigned. **Tracked:** #2486 (Sol round 1 LOW, deferred).

The test "the converted cost exposes each unit mistake Sol found before approval" stages two
rows for the same supplier link, effective date and price type. The real staging step marks the
second one `duplicate`, so the real approve dialog would list two rows, not three. The screen
behavior the test checks is still right; only the fixture is unrealistic. Fix: give the rows
different effective dates or price types.
