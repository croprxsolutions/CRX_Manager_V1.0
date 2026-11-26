## 2026-11-26 - Add a dedicated admin vehicle register read

Add a read-only register for active admins. Job, application record and report reads keep using the base table. The base table still allows its existing reads of registration and notes until a later migration.
