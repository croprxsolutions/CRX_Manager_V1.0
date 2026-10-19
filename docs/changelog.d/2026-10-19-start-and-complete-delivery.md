## 2026-10-19 — Deliveries list: Mark Delivered is one server call (closes the Goal 5 two-call gap)

Goal 5 left one gap: on the Deliveries list, **Mark Delivered** on a *scheduled* delivery made two
server calls (`confirm_delivery`, then `complete_delivery`), so signal lost in the instant after the
first answered left the delivery **In Progress** (nothing deducted or billed, driver told).

- **New RPC `start_and_complete_delivery`** (migration `20261019220000_start_and_complete_delivery`).
  It starts a scheduled delivery (by calling `confirm_delivery`, unchanged) and completes it (by
  calling `complete_delivery`, unchanged) in one transaction: the delivery ends completed or
  nothing changed. No stock, invoice or period logic is retyped.
- **It takes the chosen business date** (`p_delivered_on`, America/Chicago). "Today" completes at
  the server's now(); an earlier date completes at midday of that date (the same instant the app
  already sent for a past date). So a "today" completion whose request reaches the server just
  after Chicago midnight keeps the chosen day. A date after today is refused.
- **Retry key required and bound** to the caller and the exact request (SHA-256 fingerprint of the
  actor and every argument, through `check_idempotency_intent`): an exact retry returns the saved
  result; a reused key for a different person or request is refused. The fingerprint carries the
  chosen date, so an exact retry across midnight still replays.
- **Grants:** EXECUTE for `authenticated` only; SECURITY DEFINER, `search_path = public, pg_temp`.
