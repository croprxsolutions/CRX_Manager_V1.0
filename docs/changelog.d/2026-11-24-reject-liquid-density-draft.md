## 2026-11-24 - Keep rejected liquid weight drafts in history

Adds an admin-only database action to reject a waiting liquid weight draft. A different admin supplies a reason. Rejection keeps the original draft and audit trail, leaves the approved weight in use, and frees the draft slot. The card and workbook changes follow separately.

- Migration: `20270306200000_reject_liquid_density_draft`
- Proof: `scripts/smoke/prove-reject-liquid-density-draft-real-schema.mjs`
