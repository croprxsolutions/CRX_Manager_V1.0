## 2026-11-24 - Keep rejected liquid weight drafts in history

Adds an admin-only database action to reject a waiting liquid weight draft. A different admin supplies a reason. Rejection keeps the original draft and audit trail, keeps any existing approved weight in use, and frees the draft slot. The card and workbook changes follow separately. The legacy approval path remains available until the group-review switch is opened.

- Migration: `20270307205900_reject_liquid_density_draft`
- Proof: `scripts/smoke/prove-reject-liquid-density-draft-real-schema.mjs`
