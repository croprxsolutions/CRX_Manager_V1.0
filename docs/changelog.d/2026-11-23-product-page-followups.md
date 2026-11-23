## 2026-11-23 - Product page follow-ups (#2200, #2160, #1983 parts)

- Reload Product waits only for the Product read; Cost History and Cost Basis show their own loading and Try again, and only the newest reload reports them. An out-of-date cost basis is no longer called current in Cost History.
- Products list: a margin-floor draft is refused while the floors have not loaded; a pricing file chosen while product groups have not loaded says so and clears the pick. A dead rate-lock recovery branch is removed.
- Proof: `npx vitest run src/pages/ProductDetail src/pages/Products` (185 tests), including tests for the newest-reload check and both Products guards that fail when the guarded line is removed.
- Doc stamps: `docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md` "Last verified 2026-11-23" follow a read-only re-read of the live migration ledger on 2026-11-23: the latest live row is still `20261121061349`, so nothing else in either file changed.
