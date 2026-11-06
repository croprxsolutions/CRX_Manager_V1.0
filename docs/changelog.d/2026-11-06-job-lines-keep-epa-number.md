## 2026-11-06 — Spray-job lines keep their EPA number through re-saves (database)

- New migration `20261201100000_job_lines_keep_epa_number.sql` (record in `docs/reference/migrations.d/`).
  Each spray-job chemical line now carries its own EPA number, filled by the database from the
  product whenever a line is written. Existing lines got their product's number, which is what every
  printout shows today, so nothing visible changes.
- Lines of jobs not sprayed yet still follow a product's EPA edit, as their printouts do today; sprayed
  and finished jobs keep theirs.
- Re-saving a sprayed or finished job keeps each line's number when the screen sends the line back by
  its id (same job, same product). The database reads the stored number itself. Until the screens PR
  sends line ids, a re-save takes the product's number, as today.
- The sent "your field was sprayed" proof prints the line's own number. The screens PR moves the
  applicator sheet, chemical application report and WPS notice to it.
- Needed before a product's EPA number can be corrected (parked work on `claude/sweet-bun-f7920f`,
  which drops its own copy of this column and builds on this file).
- Proof: `node scripts/smoke/prove-job-lines-keep-epa-real-schema.mjs` (disposable real-schema database).
