## 2026-10-27 — Known issue KI-81: the split-billing backfill smoke chain fails on current main

`docs/manual/KNOWN_ISSUES.md` gains KI-81 (LOW, open): `scripts/smoke/smoke-backfill-refuse-split-billing.sql`
completes a delivery by direct `UPDATE`, which 20261022075000 refuses (`COMPLETION_EVIDENCE_REQUIRED`). #1110
found this, and Mason chose to note it rather than repair it now. Documentation only.
