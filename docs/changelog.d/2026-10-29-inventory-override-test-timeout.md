## 2026-10-29 — Inventory admin-override retry test no longer times out on busy CI

- `src/pages/InventoryPage.uncertainRetry.test.tsx`: the "confirmed ADMIN OVERRIDE" test
  waited only 1s for the saved-once warning; on a busy CI runner the refusal, override
  dialog and save take longer (failed at line 631 in CI on 2026-10-27, twice). It now waits
  up to 5s, and waits for the Retry button to be enabled before clicking it.
- Proof: with the save slowed by 1.1s the old test fails at the same line as CI; the new one passes.
- Test-only; no app code changes.
