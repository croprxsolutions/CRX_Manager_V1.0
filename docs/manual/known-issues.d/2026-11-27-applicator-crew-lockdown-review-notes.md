## 2026-11-27 — Applicator crew lockdown: deferred review notes

**Severity:** MED. **Area:** applicator price hide (crew reads of jobs, job chemicals, field shares and billing splits). **Status:** ACCEPTED.
**Owner:** unassigned. **Tracked:** #2702 (merged into staging 2026-11-27), this follow-up PR.

#2702 (migration `20270314160000_applicator_crew_base_read_lockdown.sql`) stopped applicators and
dispatched crew from reading four price-bearing base tables; their screens read the price-free crew
views instead. Sol passed it clean and left these notes open. None exposes a price.

1. MED: the order "frontend first" is written only as a comment in the migration. If the database
   change goes live while an old app bundle is still being served, or a tab is still open from
   before #2574, an applicator's Jobs list comes back empty until the new bundle loads. #2574 has
   been on staging since 2026-11-26; the live release must ship #2574's frontend no later than this
   migration.
2. MED: the migration and its reverse script refuse to run outside one transaction, but that
   refusal is one statement. A person running either file by hand in plain `psql` without
   `ON_ERROR_STOP` could see the later policy statements run anyway. The apply workflow always
   uses one transaction with `ON_ERROR_STOP`; never run these files by hand another way.
3. LOW: the browser test (`scripts/local-app/e2e/crew-price-lockdown.spec.ts`) looks for price
   field names and one invented memo. A database function that returned a price under a different
   name (for example `rate`) would not be caught by that scan.
4. LOW: the browser test checks four screens as one whole-job applicator. Per-location dispatch,
   field-sheet print, the loader worksheet and attachments are covered by the database proof's
   reads, not clicked through in the browser.
5. LOW: the container-only smoke `scripts/smoke/smoke-field-tables-follow-field-access.sql` and its
   prover still expect an applicator to read `field_billing_defaults` rows directly and pin the
   pre-lockdown `fbd_select` policy. Replayed on a chain that includes the lockdown, they report a
   false failure. The prover stops before the crew views exist, so the fix must pick `field_billing_defaults_crew` only when that view is present (as `smoke-dispatch-job-locations.sql` now does for `jobs_crew`), never switch unconditionally.
