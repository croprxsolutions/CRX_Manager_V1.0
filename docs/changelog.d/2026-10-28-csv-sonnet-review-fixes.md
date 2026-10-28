## 2026-10-28 - Sonnet review fixes for parked CSV imports

Mason requested fixes and another Sonnet 5.5 high-effort review, with everything unmerged.
This follow-up supersedes the earlier quote sub-cent rounding examples and strict blank
optional-header behavior in the previous 2026-10-28 CSV parking records.

- Blank order date/notes cells inherit the first populated value for the same order,
  including when the populated value occurs later. Populated conflicts still exclude
  the entire order. Required customer names remain required on every row.
- Sub-cent CSV quote prices are refused during validation, never silently rounded.
  Order unit-rate rounding remains the existing documented server import behavior.
- Quote acreage, rates, and unit conversions use exact decimal ratios through extended
  cent rounding. The reproduced 0.7-acre conversion boundary now sends 2.1 units and
  704 cents at 335 cents/unit, instead of 703 cents. Recurring ratios retain exact money
  calculations even where the quantity JSON must use a finite Number approximation.
- Expiry validation refuses dates after year 9999. Invalid status rows exclude their
  whole order while unrelated orders remain importable. A missing customer yields one
  accurate required-field error. Order money-range failures show correction guidance.
- User-correctable CSV syntax errors no longer report to Sentry as application bugs.
  Added parser boundary and numeric quote-group tests. The review's claim of no invalid
  unit-cost test was refuted by the existing regression; that test remains in place.
- Six new regression controls failed against the previous parked commit. All 143 focused
  tests passed, including exact import math, parser, both dialogs, grouping, and existing
  money helpers. All 28 synthetic browser checks passed for admin/sales rep, with zero
  external requests and zero page errors. Lint, typecheck, build, and code-health passed.
  Independent compliance review found no new issue.

Minor style suggestions (upload-test deduplication, helper naming, harmless negative zero,
  and the two source-line labels on multiline quoting errors) do not change correctness
  and are left out of this focused fix. No agent workflow or database changes are needed.

Sonnet's follow-up confirmed the fixes with zero BLOCKER/HIGH/MED, and found one LOW:
a missing first customer caused false conflicts on later populated rows. The group check
now compares populated customers with the first populated customer; the required-field
validator still excludes the order for its missing customer. Blank order IDs are never
grouped. Customer-name lookups also escape literal percent, underscore, and backslash,
so imported names cannot be treated as wildcard patterns. The UI states the all-blank
date fallback to today. Earlier parking entries now cross-reference this record.
Final follow-up proof: all 147 focused tests and 34 browser checks pass, with zero external
requests/page errors. All four newly added customer/group regressions fail on the prior
commit. Lint, typecheck, build, code-health, and independent compliance refresh are clean.

Remaining minor observations are recorded rather than widening this fix: case-sensitive
customer header comparison is deliberately conservative; order sub-cent rounding remains
the established server behavior; pre-existing quote-wide header consistency and duplicate
Product/Description mapping need their own focused treatment. Corrupt conversion-factor
reference data is refused safely. Upload-time quote configuration/range errors continue
to be observable through Sentry. No test or gate is waived by these scope notes.

Parked base remains a3423a812; the sole upstream commit 5b0246530 changes documentation
only, with no overlapping source files. No main merge or history rewrite was performed.
Rollback: revert this follow-up commit. No production import, migration, push, or deployment.
Final Sonnet review evidence is kept in the private local review captures; release gates
remain for a later authorized release session.
