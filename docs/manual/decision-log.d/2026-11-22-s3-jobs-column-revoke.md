## 2026-11-22 — S-3 (`20270303110000_close_direct_job_writes`): column-level REVOKE added beside the table REVOKE

**Decision (Mason, 2026-11-22, bug-captain session):** close the column-grant question in code: the migration also runs an explicit column-level `REVOKE` naming every `jobs` column, and its postcheck fails the apply if any write privilege remains.
**Why:** a review round asked whether the table-level `REVOKE` also removes the column-level `INSERT`/`UPDATE` grants on `jobs`; naming every column settles it without argument.
**What this forbids/implies:** nothing beyond this migration; it changes no review rule.
