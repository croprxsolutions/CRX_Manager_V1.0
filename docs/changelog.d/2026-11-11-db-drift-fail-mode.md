## 2026-11-11 - Staging DB job: ledger drift now fails the job

The first drift report on staging (run 42955143471) was clean: 0 rows without a file, 0 changed, 0 not
applied. So `DRIFT_MODE: report` is removed from `.github/workflows/db-apply.yml`. A ledger row with no
migration file, or a file whose text changed after it ran, now fails "Apply migrations to staging". Files
not applied yet stay a warning. Migrations from that run are already committed when drift runs; the
edge-function deploy waits until the drift is fixed (rename the file back, or record the change in a new
migration). Report mode is still there for a one-off run: `DRIFT_MODE=report`.
