## 2026-11-27 — Applicator crew lockdown: deferred review notes

**Severity:** MED. **Area:** applicator price hide (crew reads of jobs, job chemicals, field shares and billing splits). **Status:** OPEN (review notes deferred by the field orchestrator on 2026-11-27; no owner decision recorded).
**Owner:** unassigned. **Tracked:** #2702 (merged into staging 2026-11-27), this follow-up PR.

#2702 (migration `20270314160000_applicator_crew_base_read_lockdown.sql`) stopped applicators and
dispatched crew from reading four price-bearing base tables; their screens read the price-free crew
views instead. Sol passed it clean and left these notes open. Through the app none exposes a price; item 2 can re-open crew price reads only if someone runs the reverse script by hand the wrong way.

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

From the #2712 follow-up review (Sol round 3, all LOW, left open to stop the review loop):
6. LOW: `scripts/smoke/smoke-dispatch-job-locations.sql` picks `jobs` whenever `jobs_crew` is missing,
   so it cannot tell a historical replay from a current database missing the crew view. The
   lockdown migration's own preflight refuses when the view is missing.
7. LOW: that smoke's failure messages name `jobs_crew` even when the older branch queried `jobs`.
8. LOW: a correctly run, approved reverse of the lockdown also re-opens crew price reads; that is
   its purpose, and it needs Mason's yes under the contract's Undo / recovery rule.
9. LOW: item 5's field-access prover also pins the old `fbd_select` policy, so a view fallback in
   the smoke alone will not make it pass after the lockdown; the prover's policy pin must change too.
