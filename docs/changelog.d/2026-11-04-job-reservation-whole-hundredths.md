## 2026-11-04 — A spray job no longer leaves a booking remainder no Partial Order can take (KI-100)

- New migration `20261106170000_job_reservation_whole_hundredths.sql` (record in
  `docs/reference/migrations.d/`). Since S02 (`20261106110000`) a Partial Order must be in whole
  hundredths, but a spray job that reserves product from a booking drew an unrounded unit conversion
  from it: 1 fl oz from a 10 gal booking drew 0.0078125 gal and left 9.9921875 gal, so the booking
  could never close. A booking's job draws are now whole hundredths and together match the real
  total its jobs applied, rounded once (so many small jobs never add up to more), and a job's hold on
  shed stock is at least its draw. Live had no job draws, so no existing booking changes; the migration
  refuses to apply if a finished job has kept an unrounded draw by then.
- New proof `scripts/smoke/prove-job-reservation-whole-hundredths-real-schema.mjs` (before and after
  in a disposable database).
- `KNOWN_ISSUES.md`: KI-100 recorded, fixed by this migration once it is applied.
