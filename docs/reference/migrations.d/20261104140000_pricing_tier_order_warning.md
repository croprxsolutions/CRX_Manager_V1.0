**APPLIED LIVE 2026-11-03 16:02:27 UTC (10:02 AM Central)**, ledger version `20261103160227` carrying name `20261104140000_pricing_tier_order_warning` (match on the name, the B7 rule); PR #1345 merged as `7a4ddc33f`. Read-only ledger check 2026-11-03. Pre-apply record: `20261104140000_pricing_tier_order_warning.sql` (LF SQL sha256: `662149f4abb30f296711c3ef0582ad6fd48109e23170093f0de94c6d2a88d07e`). This routine migration replaces the private pricing-warning function to add the final-price `TIER_ORDER` warning. It changes no data, grants, or policies.

The preflight pins the live warning function, warning-set helper, and three consumer bodies as read on 2026-11-02. Rollback: re-create it from 20261027050000 (~228-334) as CREATE OR REPLACE. The existing five warning codes and their details must remain unchanged on the same previews. A stated $0 is a real final tier price.

Live migration high-water read 2026-11-03 (after the restamp from `20261103230000`): `20261104130000_any_rep_changes_booked_prices`; the five preflight md5 pins re-checked against live the same day and match. Re-check before apply.

Live ledger preflight, read 2026-11-03 at about 10:00 AM Central from `supabase_migrations.schema_migrations`:
- **Effective high-water:** the greatest 14-digit name stamp is `20261104130000`.
- **Top row:** `20261104130000_any_rep_changes_booked_prices`, ledger version `20261103132202`.
- **`max(version)`:** `20261103132202`.
- **Total:** 1,104 rows.
- **This migration:** no row starts with `20261104140000`, by name or by version.

So `20261104140000` sorts above everything applied. Read the ledger again at apply time.
