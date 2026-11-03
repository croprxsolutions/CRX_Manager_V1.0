**LOCAL CANDIDATE — NOT APPLIED.** `20261104180000_vendor_link_proposals.sql` (LF SQL sha256: `037d5e863989489467a8595bee89304db68e5aeefdce34f3df373a7da35459c8`). WP-PM-15a / DATA-11. This routine migration adds one new read-only, admin-only report function, `get_vendor_link_proposals()`. It is STABLE and SECURITY DEFINER with `search_path = public, pg_temp`, and grants EXECUTE to `authenticated` only, revoked from PUBLIC, anon and service_role. It changes no data, no existing grants and no policies, and enables no vendor enforcement.

Rollback: `DROP FUNCTION public.get_vendor_link_proposals();`. Nothing else depends on it.

Proof: `node scripts/smoke/prove-vendor-link-proposals-real-schema.mjs` prints `VENDOR_LINK_PROPOSALS_PROOF_PASS`. The live read-only run of the final query (2026-11-03) gave 596 active products: 583 proposed, 10 linked with no preferred, 1 unresolved, 2 no vendor.

Live ledger preflight, read 2026-11-03 from `supabase_migrations.schema_migrations`: the greatest 14-digit name stamp is `20261104150000`, out of 1,106 rows. No row starts with `20261104180000`, and no function of this name exists. Read the ledger again at apply time.
