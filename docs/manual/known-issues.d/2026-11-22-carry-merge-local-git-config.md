## 2026-11-22 — Sol carry-forward's merge check reads the checkout's own Git settings

**Severity:** LOW. **Area:** agent gates (`scripts/write-codex-push-proof.mjs`). **Status:** ACCEPTED.
**Owner:** unassigned. **Tracked:** #2226 (Taha's review, LOW 1), #2298.

When a branch merges main, the carry-forward step rebuilds that merge to confirm nothing else
changed. A merge driver or filter set in this checkout's own `.git/config` or `.git/info/attributes`
runs during that rebuild and can rewrite a file both sides changed. Any agent session with shell
access to the checkout can set one, and no hook blocks that. Global and system Git settings are
already ignored. The same gap covers the carry-forward's clean-checkout check, which also runs
the checkout's local filters (#2298).

**Decision (Mason, 2026-11-22):** accepted as a known gap. Three Sol rounds on a fix each found a
new HIGH in the fix itself, so the fix was dropped rather than patched further.
