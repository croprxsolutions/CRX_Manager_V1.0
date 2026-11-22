## 2026-11-21 — Purchasing plan: the booking line is the reservation (#1989 redesign)

- New migration `20270207140000_purchasing_plan_booking_reservations.sql` (not applied live; record in `docs/reference/migrations.d/`). Replaces the never-applied `20270206130000` held-stock candidate. Built on release #1990's body (`20270129160000`); re-emits `get_purchasing_plan` and adds a private helper `_purchasing_allocate` (no client can call it).
- Contract `docs/plans/2026-11-21-booking-reservations-CONTRACT.md` (v4, Mason "Yes, build it", first build "Per product"); it replaces `2026-11-18-purchasing-held-stock-CONTRACT.md`.
- An open booking line reserves stock itself; the plan no longer reads a counted booking's or active job's own hold rows. A draft Planned booking counts like a sent one.
- One allocation per product: shelf, then POs by date. Orders, jobs, manual holds and Firm lines choose first, then Likely, then Maybe. Each need takes the latest supply arriving by its date, then the earliest later supply (late cover), and the rest is not covered.
- A late or undated PO counts as cover and never adds a buy. Only the not-covered part of the deficit and committed needs is bought, and could-add comes from the Likely lines.
- Stale holds (booking or job gone, closed or converted) take shelf stock only and never buy; the unbacked part shows as `hold_unbacked`.
- New product keys: `coverage` (per group: booked, on_time, late, not_covered, from_shelf, POs), `has_late_cover`, `has_followup`, `estimated`, `hold_unbacked`. A booking row gains `overdue_followup` (14+ days past its need date). The horizon only filters what is shown; POs are no longer cut at the horizon (no `later` PO flag).
- Kept from the old #1989 build: the safe draw guess, the draw lists and the timing-window fixes.
- No screen calls `get_purchasing_plan` yet (#1980 adds the first).
- Proof: `node scripts/smoke/prove-purchasing-plan-reservations-real-schema.mjs` with `smoke-purchasing-plan-reservations.sql` (C1-C19) and `smoke-purchasing-plan.sql`. Not yet verified on staging.
