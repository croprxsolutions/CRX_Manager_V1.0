## 2026-11-06 — Spray-job lines keep their EPA number through re-saves (database)

- New migration `20261202115000_job_lines_keep_epa_number.sql` (record in `docs/reference/migrations.d/`).
  Each spray-job chemical line now carries its own EPA number, filled by the database from the
  product whenever a line is written. Existing lines got their product's number, which is what every
  printout shows today, so nothing visible changes.
- Lines of jobs not sprayed yet still follow a product's EPA edit, as their printouts do today; sprayed
  and finished jobs keep theirs.
- Re-saving a sprayed or finished job keeps each line's number when the screen sends the line back by
  its id (same job, same product). The database reads the stored number itself. The job screen now
  sends each saved line's id (`src/lib/jobChemicalPayload.ts`). If another tab or device saved a
  sprayed job after this screen opened it, the save is refused with "Reload the job" instead of
  quietly changing the number. An older cached copy of the app (which sends no line ids) is refused
  on a sprayed job with "Reload the app".
- No printout reads the new number yet, so every printout still shows the product's number. A
  follow-up PR moves the sent proof, applicator sheet, chemical application report and WPS notice to
  it together.
- An EPA edit takes turns with a spray record, a job save or a new line using that product (the
  product is locked first, then the job). So a spray recorded during an edit keeps its number, and a
  line being added during an edit (even on a brand-new job) ends up with the edited number.
- An EPA-number change alone no longer rebuilds a job's inventory holds (nothing about the amounts
  changed).
- Permission change (Mason, 2026-11-06): signed-in users can no longer add, change or delete job
  chemical lines directly through the database API; the app never did, and every job screen, recipe
  and quote path still writes them through its server function. Reading lines is unchanged.
- Needed before a product's EPA number can be corrected (parked work on `claude/sweet-bun-f7920f`,
  which drops its own copy of this column and builds on this file).
- Proof: `node scripts/smoke/prove-job-lines-keep-epa-real-schema.mjs` (disposable real-schema database).
