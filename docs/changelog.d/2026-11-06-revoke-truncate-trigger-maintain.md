## 2026-11-06 — Browser roles lose table-maintenance rights (KI-07 follow-up, database)

- New migration `20261123130000_revoke_truncate_trigger_maintain.sql` (APPLIED LIVE 2026-11-06 11:09 AM Central, ledger `20261106170917`; record in
  `docs/reference/migrations.d/`). Signed-in and signed-out app users no longer hold the TRUNCATE, TRIGGER or
  MAINTAIN rights on any app table or view, and tables created by later migrations no longer get them. No screen,
  Edge Function or scheduled job uses them. Every other grant is unchanged; the migration checks that itself and
  rolls back if anything else moved.
- Known limit: tables owned by `supabase_admin` (Supabase platform and extension objects) still get Supabase's default
  rights; every app table is owned by `postgres`, and the migration refuses to run if any app table has another owner.
  The new live sweep `browser-table-maintenance` reports any table or view where the rights come back.
- Proof: `scripts/smoke/prove-revoke-truncate-trigger-maintain-real-schema.mjs` (local Docker copy of the real schema)
  shows the rights present before and gone after, order and delivery functions still working as a signed-in user,
  and the reviewed rollback restoring every grant. The signature-storage smoke gained malformed file-name cases.
  Repo guard `src/__tests__/browserTableMaintenanceGrants.test.ts` fails any later migration that grants these back.
