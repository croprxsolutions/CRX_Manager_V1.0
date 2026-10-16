## 2026-10-16 — Staff photo buckets are private; records updated (migration `20261016030000`)

**Why.** PR #947 shipped `20261016030000_staff_photo_buckets_private` with migration-history row 950
still reading "not applied". It applied live at 05:19:44 UTC (ledger `20261016051944`) on Mason's
approval. A parallel session already updated the CURRENT_STATE and KNOWN_ISSUES headers; this change
finishes the record.

**What changed.**
- `docs/reference/migration-history.md`: new live ledger capture (2026-10-16 13:07 UTC: 1033 rows /
  1026 names, `max(version)` `20261016121253`, effective high-water `20261016060000`, applied by
  another session). Row 950 now reads APPLIED LIVE with its post-apply checks; the old text stays as
  the pre-apply record. Row 951's own applied record is left to that change's follow-up.
- `docs/manual/KNOWN_ISSUES.md`: the duplicate team-note photo fix is applied, and Mason's
  signed-in check (2026-10-16: a delivery photo still shows in the app) is recorded.
- `docs/manual/CURRENT_STATE.md`: ledger header, effective high-water (now `20261016060000`), applied list
  and schema-registry line, all from the 13:07 UTC read (Codex on this PR).
- `.claude/schema-registry.json`: delta only (the applied name and `migrations_high_water`
  `20261016051944`). It does not list `20261016060000` yet: doing so makes the RPC idempotency
  inventory test treat that money change as applied, which is that change's own follow-up.

**Still open.** The live chain `scripts/smoke/smoke-staff_photo_storage_access.sql` waits on Mason's
REAL-DATA-OK marker.
