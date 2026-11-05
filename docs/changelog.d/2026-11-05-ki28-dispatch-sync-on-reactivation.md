## 2026-11-05 — Re-activating an applicator puts their open jobs on the dispatch board (KI-28)

- New migration `20261107160000_dispatch_sync_on_applicator_reactivation.sql` (record in
  `docs/reference/migrations.d/`). A job assigned to someone who was not an active applicator at the time was
  never synced to the dispatch board, and nothing synced it later. Now, when a person becomes an active
  applicator (re-activated, or their role changed to applicator), every location of their open jobs that has no
  dispatch row gets one, written the same way the existing sync writes it. A location that already has a
  row (a wizard split, a completed row, a location a dispatcher undispatched) is never changed, and repeating
  the save changes nothing. An applicator whose licenses have all expired is skipped, as the dispatch screen
  already requires; those jobs wait for the wizard's admin override.
- Reassigning a dispatched job to someone who is not an active applicator now takes it off the old holder's board
  (its locations become undispatched, and the new person gets them on activation) instead of leaving the old
  holder working it.
- Both existing sync triggers now lock the assigned person's profile while they read it, so a job and a
  re-activation saved at the same instant cannot both miss each other. Accepted: editing that person's job at the
  exact instant they are re-activated can make PostgreSQL cancel one of the two saves; the user saves again.
- New proof `scripts/smoke/prove-dispatch-sync-on-applicator-reactivation-real-schema.mjs` (`npm run
  proof:dispatch-sync-reactivation`): the bug reproduced on a throwaway copy before the candidate, fixed after it,
  with retries, splits, completed/deleted jobs, an undispatch, an expired license, a role change, a reassignment,
  and both orders of a simultaneous job save and of a simultaneous reassignment.
- Live read-only 2026-11-05: 0 affected job locations; no backfill.
