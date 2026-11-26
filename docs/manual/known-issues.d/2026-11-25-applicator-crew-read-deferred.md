## 2026-11-25 — Applicator price hide, step 1 (crew views): deferred review items

**Severity:** MED / LOW. **Area:** applicator price hide (crew read path, migration `20270308040000_applicator_crew_read_path.sql`). **Status:** OPEN (deferred to step 3 or later).
**Owner:** whoever builds step 3 (lockdown). **Tracked:** #2602 (merged into staging); contract `docs/plans/2026-11-25-applicator-crew-read-path-CONTRACT.md`, gate settlement sections.

Step 1 added four crew views (`jobs_crew`, `job_chemicals_crew`, `job_field_shares_crew`, `field_billing_defaults_crew`) that copy today's row rules and leave out prices, memo and split values. Sol rounds 1–4 were clean; these items were deferred, not fixed:

- **MED, by design: the views copy the row rules once.** A later migration that tightens who may read `jobs` (or the other three tables) must make the same change to the matching view, or crew keeps the old access through the view. Step 3 and every later migration on these tables must check this.
- **MED: the install check pinned policy text, roles and mode, but not every copied policy's command, nor the five functions' execution settings.** It only matters for a migration that landed before step 1 and changed just those. None did (step 1 is applied on staging). Step 3's check should pin both.
- **MED: the rollback script does not check current definitions.** `scripts/smoke/applicator-crew-read-path-reverse.sql` restores the old policies and functions as written. If it is ever used, it ships as its own reviewed migration with its own pinned checks, and only before step 2 deploys.
- **LOW (proof gaps, for the step-3 proof):**
  - no own-upload attachment delete case
  - the billing-default comparison joins through the caller's field access
  - an identical read error before and after counts as unchanged
  - the office board comparison strips the protected values
  - the loader fixture uses a product that does not exist
  - reuse mode trusts the container name
- **LOW (doc):** the contract says every job foreign key is non-deferrable, but `jobs_quote_section_id_fkey` is DEFERRABLE INITIALLY DEFERRED. Fix the wording in step 2's PR (#2574).
