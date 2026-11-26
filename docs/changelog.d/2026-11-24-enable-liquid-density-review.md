## 2026-11-24 - Enable reviewed liquid weights on staging

Opens the prepared liquid weight review flow on staging after the database and Weight card checks. Admins submit one draft at a time, and a different admin reviews the active brands. An approved weight goes back for review when an active brand joins or changes its name substantially, its EPA registration, or its manufacturer. Capitalization and spacing edits keep approval. A migration replay without the staging database job marker leaves the switch closed.

- Migration: `20270311230000_enable_liquid_density_review`
- Proof runs through `scripts/smoke/prove-liquid-density-cutover-real-schema.mjs`. See the migration record for the staging print checks.
- Before any production rollout, review the existing approved multi-brand liquid groups. Split and reapprove confirmed mismatches before cutover.
