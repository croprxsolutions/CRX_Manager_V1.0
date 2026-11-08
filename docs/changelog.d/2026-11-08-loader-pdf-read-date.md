## 2026-11-08 — Loader worksheet PDF header comes from the same read as its weights

- New migration `20261211110000_loader_weights_getter_job_schedule.sql` (record in
  `docs/reference/migrations.d/`): `get_loader_worksheet_weights` also returns each job's `job_date`,
  `scheduled_time` and `applicator_id` from the read that gives its lines and weights. Same signature,
  security and grants. The loader worksheet PDF now prints its date, time and applicator from that read, so
  an edit between two reads can no longer label a new mix with an old date or applicator (the MED deferred
  from #1631's Sol review).
- Ledger freshness: on 2026-11-08 (America/Chicago) a read-only read of the live ledger showed latest row
  `20261108043505` (`20261211100000_product_chemistry_confirmed_swaps`); the "Last verified" lines of
  `CURRENT_STATE.md` and `KNOWN_ISSUES.md` were moved to it. Nothing else in either file was re-certified.
