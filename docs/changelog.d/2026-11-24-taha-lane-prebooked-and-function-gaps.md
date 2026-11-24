## 2026-11-24 — Taha lane block: booking-stock write forms and more of his functions

- Taha (Slack, 2026-11-24, via Mason) agreed that migrations touching his lanes, booking stock included, wait for him;
  three gaps from his #2382 review were left for this follow-up, which he reviews and merges.
- A field-word file name ("job", "application") already gets its SQL read since #2382; tests now pin it.
- `TAHA_LANE_FUNCTIONS_RE` gains 23 of his functions whose names carry no lane word (order, return, finance-charge
  and delivery functions found by sweeping staging's migrations); field-billing functions stay Mason's.
- Booking stock: a PL/pgSQL `NEW.quantity_prebooked = …` assignment, a SET that follows a subquery's WHERE, and
  `RENAME COLUMN … TO quantity_prebooked` now count (`.claude/hooks/taha-lane-lib.mjs`).
