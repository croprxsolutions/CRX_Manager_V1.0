## 2026-11-22 — Sol carry-forward's merge check reads the checkout's own Git settings

**Severity:** LOW. **Area:** agent gates (`scripts/write-codex-push-proof.mjs`). **Status:** ACCEPTED.
**Owner:** unassigned. **Tracked:** #2226 (Taha's review, LOW 1).

When a branch merges main, the carry-forward step rebuilds that merge to confirm nothing else
changed. The rebuild honours the local checkout's Git settings, so a custom merge setting on the
reviewer's own computer could influence it. Using that would need someone who can already change
Git settings on that computer, which already means control of the machine.

**Decision (Mason, 2026-11-22):** accepted as a known gap. Three Sol rounds on a fix each found a
new HIGH in the fix itself, so the fix was dropped rather than patched further.
