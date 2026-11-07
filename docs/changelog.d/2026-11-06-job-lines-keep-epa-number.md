## 2026-11-06 — Sprayed jobs keep the EPA number of each product they used (database)

- New migration `20261204120000_job_lines_keep_epa_number.sql` (record in `docs/reference/migrations.d/`).
  Rule (Mason, 2026-11-06, "Yes, lock per product"): once a job is sprayed (a spray record is saved) or
  finished (completed or invoiced), every product on it keeps the EPA number the job recorded for it,
  however its line is edited, deleted or re-added. A product never on the job takes the product's
  current number when it is added, and then keeps that. The first number recorded wins. Deleting a
  spray record does not unlock the job.
- The numbers live in a new table, `job_product_epa` (one row per job and product), with a marker
  table `job_epa_sprayed`. Nothing copies a number onto job lines and nothing follows product edits,
  so job saves, product edits and inventory holds work exactly as before.
- Jobs already sprayed or finished when this is applied keep their products as "Not recorded": the
  product's number today cannot prove what was sprayed (REG-1 build sheet section 7). A product added
  to such a job later is "Not recorded" too, since it may have been on the job before and removed.
- Kept numbers survive deleting the product or the job, and staff see them wherever they can see the job.
  A deleted job's or product's ID can never be given to a new one, so its numbers cannot attach elsewhere.
- A spray record moved onto a job not yet sprayed or finished makes that job "Not recorded" (Mason,
  2026-11-06, "Mark Not recorded"): a moved record proves nothing about the numbers its new job used.
- No printout reads the kept numbers yet, so every printout still shows the product's number. A
  follow-up PR moves the sent proof, applicator sheet, chemical application report and WPS notice to
  them. Recording starts when this is applied, so that history exists for the follow-up.
- Permission change (Mason, 2026-11-06, "Yes, remove it"): signed-in users can no longer add, change
  or delete job chemical lines directly through the database API; the app never did, and every job
  screen and quote path still writes them through its server function. Reading lines is unchanged.
- Proof: `node scripts/smoke/prove-job-lines-keep-epa-real-schema.mjs` (disposable real-schema database).
