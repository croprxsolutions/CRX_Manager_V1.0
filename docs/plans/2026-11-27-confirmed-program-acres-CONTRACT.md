# Confirmed program acres

Mason approved the reporting rule on 2026-11-27. Today and Program Tracker count confirmed application acreage and omit removed plans. The base is staging `aad370f1f63ad416c1250eb3665903642525ee0c`.

## Reporting rule

- Both screens continue reading `get_program_completion` with the same office roles, arguments and result keys. Removed, declined, expired and cancelled planned quotes stay out.
- Credit a saved application pass to the job's exact quote, section and farm. The source quote owns the reporting season, even when staff schedule its job in another season. Match the named field when the section names one. On 2026-11-27 Mason confirmed that a farm's plan can also count work on a field it pays for. Count the physical acres if the plan's farm owns the field or has a positive share under the job billing rule. Use saved job shares first and the current Field Setup split when the job has no saved shares for that field. The fallback can change if Field Setup changes. For a section with no named field, accept a saved job-level acreage entry when the pass has no field rows. A saved partial pass counts while more work remains. Removed or cancelled jobs, scheduled acreage and invoice estimates do not count.
- Count saved pass acreage, including distinct partial passes. It measures recorded work, not unique geographic coverage. Blend tickets do not provide a current confirmation path for acreage. Ticket processing and review therefore cannot establish or duplicate progress. Legacy work without a saved as-applied entry has no confirmed acreage in this report.
- Both summaries cap each section's contribution at 100%. The tracker still shows actual acreage and over-application per section. The existing invoice calculation and office access rules stay intact.

## Proof and recovery

- The local database test passed and rolled back the fixtures. It covered pending and approved tickets, confirmed partial and fieldless passes, duplicate sources, removed plans, field and farm mismatches, season attribution, and access for an admin, a sales rep and a driver.
- In the local browser, both screens used the same synthetic plans and excluded removed and prior-season plans. The shared-field regression checks the Field Setup fallback and the precedence of saved job payers.
- The release PR must carry a reviewed update to the cost-exposure sweep fingerprint for `get_program_completion` in `scripts/db-invariant-sweeps/allowlist.json`. After the release applies the migration, rerun the full read-only sweep before the release merges.
- The migration can precede the display adjustment in later delivery. Recovery is a reviewed forward migration restoring the earlier reader body.
