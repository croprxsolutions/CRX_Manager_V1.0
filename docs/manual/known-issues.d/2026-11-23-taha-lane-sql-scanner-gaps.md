## 2026-11-23 — Taha lane merge block reads migration SQL by text pattern, so it is best-effort

**Severity:** LOW. **Area:** agent gates (`.claude/hooks/taha-lane-lib.mjs`). **Status:** ACCEPTED.
**Owner:** unassigned. **Tracked:** #2382.

The Taha lane block (until 2026-12-15) reads each changed SQL file and refuses an agent merge that
touches quotes, bookings, holds, chemical billing or booking stock. It matches SQL text with patterns,
not a real SQL parser, so unusual but valid SQL can still slip past it, and some harmless SQL is
refused (costing one override code). Sol's advisory review at `6caed60b3` listed 3 HIGH, 15 MED and
9 LOW cases of both kinds. The block still catches the ordinary forms, including the two real
misses that prompted it (#2331, #2338). Taha's own review and the other merge gates are unchanged.

**Decision (Mason, 2026-11-23):** land as best-effort and log the gaps. Each patch round found new
cases because the method is text matching; the lane is temporary.

Taha's re-check at `6caed60b3` (issuecomment-7123041210): MED 1 (`_`-prefixed impls and wrappers of
his functions) is fixed. LOW 2 (three booking-stock write forms no staging migration uses yet:
a PL/pgSQL `quantity_prebooked = x` assignment, a SET with a `where` subquery before the column, and
`RENAME COLUMN … TO quantity_prebooked`) is one more case under this accepted best-effort decision.
