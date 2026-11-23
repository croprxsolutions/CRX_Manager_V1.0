## 2026-11-22 — #2248 (KI-144): existing purchase orders are not linked to a vendor

**Decision (Mason, 2026-11-22, "drop old-po linking"; confirmed "Yes, drop it"):** PR #2248 has no backfill. Existing purchase orders keep `vendor_id` NULL and the name check they have today; only POs written, or whose vendor text is edited, after the migration are linked. This replaces the bill-history backfill kept in `2026-11-22-pr2248-vendor-link-keep-design.md`.
**Why:** Live has no bills tied to purchase orders, so a backfill gave little; it was the part of the change that needed the most special cases.
**What this forbids/implies:** Renaming a vendor still breaks billing its purchase orders written before this migration (the original KI-144 problem, limited to those POs). Linking them later is a separate decision.
