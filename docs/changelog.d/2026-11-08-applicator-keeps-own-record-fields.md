## 2026-11-08 — An applicator keeps the field on their own spray records (KI-73 part C follow-up)

Taha's review of #1650 (`20261217100000_job_access_ends_with_the_job`, live 2026-11-09 05:29 UTC).

### What was wrong

* MED: part C ended a whole-job applicator's field access 7 days after the job ended. The field and
  spray-record field rows (`fields_select`, `arf_select`) went through the same check, so an applicator's
  own spray record lost its field once the job was done, cancelled or deleted: Record Book showed "-".
* LOW (already closed): Taha's review ran on a version whose window used the job's scheduled date. The
  version that went live uses the server's completion stamp (`jobs.completed_at`), with or without a
  dispatch row. The new prover shows a whole-job applicator, with the fields dispatched to someone else,
  keeps a job dated 20 days ago for 7 days after completing it, then loses it.

### What changed

* New migration `20261220100000_applicator_keeps_own_record_fields.sql`: new
  `_is_my_application_field(field)`; `fields_select` and `arf_select` let an active applicator read the
  field (name and boundary, so its boundary parts too) and field rows of spray records that name them as the applicator,
  with no time limit: what they read until 20261217100000, but only for fields on records naming them (on a split job that includes
  the field another applicator was dispatched to: complete_job writes one record per job).
  A deactivated applicator or a driver gains nothing.
* Prover: `scripts/smoke/prove-applicator-keeps-own-record-fields-real-schema.mjs`.
* The `20261217100000` ledger record and KI-73 now say it is live.
