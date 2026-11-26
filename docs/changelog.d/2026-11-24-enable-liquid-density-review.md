## 2026-11-24 - Enable reviewed liquid weights

Opens the prepared liquid weight review flow after the database and Weight card checks. Admins submit one draft at a time, a different admin reviews the active brands, and an approved weight goes back for review when a brand joins or changes its EPA registration or manufacturer.

- Migration: `20270308110000_enable_liquid_density_review`
- Proof runs through `scripts/smoke/prove-liquid-density-cutover-real-schema.mjs`. See the migration record for the staging print checks.
- Before any production rollout, review the existing approved multi-brand liquid groups. Split and reapprove confirmed mismatches before cutover.
