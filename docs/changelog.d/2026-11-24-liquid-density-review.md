## 2026-11-24 - Prepare liquid weight review by brand

Adds an admin draft and second-admin review flow for liquid weights. The reviewer confirms the exact active brands and SDS links. Prepared database safeguards prevent overwrite, close the old liquid approval paths, and return a group's approved weight for review when a brand joins. The switch stays closed until the Weight card and staging proof are ready.

- Migration: `20270305160000_liquid_density_review`
- Proof: `scripts/smoke/prove-liquid-density-review-real-schema.mjs`
