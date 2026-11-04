**APPLIED LIVE 2026-11-03 19:15:30 UTC (1:15 PM Central)**, ledger version `20261103191530` carrying name `20261104180000_vendor_link_proposals` (match on the name, the B7 rule; no rename); applied before the merge through `scripts/apply-migration-file.mjs` with every gate passed (Sol clean on head `63c410ba9`, both apply-proof reviewers CLEAN, Codex GitHub App no findings, all checks green). Post-apply: smoke chain `smoke-vendor_link_proposals_admin_only.sql` PASS (`SMOKE_PASS_ROLLBACK`), `npm run db-sweeps:live` ok and complete. PR #1372 merged as `508b9ab0b`. Pre-apply record: `20261104180000_vendor_link_proposals.sql` (LF SQL sha256: `037d5e863989489467a8595bee89304db68e5aeefdce34f3df373a7da35459c8`). WP-PM-15a / DATA-11. This routine migration adds one new read-only, admin-only report function, `get_vendor_link_proposals()`. It is STABLE and SECURITY DEFINER with `search_path = public, pg_temp`, and grants EXECUTE to `authenticated` only, revoked from PUBLIC, anon and service_role. It changes no data, no existing grants and no policies, and enables no vendor enforcement.

Rollback: `DROP FUNCTION public.get_vendor_link_proposals();`. Nothing else depends on it.

Proof: `node scripts/smoke/prove-vendor-link-proposals-real-schema.mjs` prints `VENDOR_LINK_PROPOSALS_PROOF_PASS`. The live read-only run of the final query (2026-11-03) gave 596 active products: 583 proposed, 10 linked with no preferred, 1 unresolved, 2 no vendor.

Live ledger preflight (CHECK 6), read 2026-11-03 about 12:30 PM Central with read-only `execute_sql` on `supabase_migrations.schema_migrations`, computed row by row (the 14-digit name stamp when the name has one, otherwise the version):
- **Total:** 1,106 rows; 479 names carry a stamp, and the highest version among the 627 unstamped rows is `20260905185938`.
- **Effective high-water:** `20261104150000` (`20261104150000_product_forms_seed_each`, ledger version `20261103172003`). The highest raw version is `20261103172003`.
- **This migration:** no row has an effective stamp at or above `20261104180000`, and no function of this name exists.

So `20261104180000` sorts above everything applied. Read the ledger again at apply time.
