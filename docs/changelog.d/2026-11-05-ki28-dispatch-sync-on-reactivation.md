## 2026-11-05 — Re-activating an applicator puts their open jobs on the dispatch board (KI-28)

- New migration `20261107160000_dispatch_sync_on_applicator_reactivation.sql` (record in
  `docs/reference/migrations.d/`). A job assigned to someone who was not an active applicator at the time was
  never synced to the dispatch board, and nothing synced it later. Now, when a person becomes an active
  applicator (re-activated, or their role changed to applicator), every location of their open jobs that has no
  dispatch row gets one, written the same way the existing sync writes it. Existing rows (wizard splits, cancelled
  or completed rows) are never changed, and repeating the save adds nothing. An applicator whose licenses have all
  expired is skipped, as the dispatch screen already requires; those jobs wait for the wizard's admin override.
- New proof `scripts/smoke/prove-dispatch-sync-on-applicator-reactivation-real-schema.mjs` (`npm run
  proof:dispatch-sync-reactivation`): the bug reproduced on a throwaway copy before the candidate, fixed after it,
  with retries, splits, completed/deleted jobs, an expired license and a role change.
- Live read-only 2026-11-05: 0 affected job locations; no backfill.
