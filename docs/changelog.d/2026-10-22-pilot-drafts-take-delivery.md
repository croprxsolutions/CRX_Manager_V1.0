## 2026-10-22 — Pilot procedure drafts: only a driver account can complete a paper-ticket delivery

- `docs/plans/2026-10-22-pilot-launch-procedures-draft.md` now says plainly that only a driver
  account can complete a delivery from a signed paper ticket. `src/pages/DeliveryDetail.tsx` shows
  the **Customer signed a paper ticket** checkbox and **Delivered on (date on the ticket)** only in the
  driver layout (`role === 'driver'`). An admin or sales rep can press **Take Delivery**, but their
  screen has no paper-ticket option, so CRX would record the delivery as made at that moment, not on
  the ticket's date.
- After a database restore, while CRX is closed to staff, drivers still have to sign in for that step
  with the person running the recovery watching. New outage question 8 asks Mason whether that is
  acceptable, or whether the admin screen should get the paper-ticket option (an app change).
- Follow-up to PR #1041. An earlier version of this PR said admins could complete these deliveries
  through **Take Delivery**; the Codex GitHub App review showed the paper-ticket controls are
  driver-only, so that was corrected before merge. Documentation only.
