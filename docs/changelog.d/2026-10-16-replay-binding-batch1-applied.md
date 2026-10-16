## 2026-10-16 — Money retry binding, batch 1, is live; records and types updated (migration `20261016060000`)

**Why.** PR #942 shipped `20261016060000_bind_money_replay_receipts_batch1` with its records still
reading "not applied", because they were written before the apply. It applied live at 12:12:53 UTC
(ledger `20261016121253`, no B7 rename) on Mason's approval, and PR #942 merged as `982bc0dda`. This
change brings the records and the generated types in line with the live database.

**What changed.**
- `docs/reference/migration-history.md`: new live ledger capture (2026-10-16 13:42 UTC: 1033 rows /
  1026 names, `max(version)` `20261016121253`, effective high-water `20261016060000`). Row 951 now
  reads APPLIED LIVE with its post-apply checks; the old text stays as the pre-apply record.
- `docs/manual/CURRENT_STATE.md`: ledger header and effective high-water.
- `docs/manual/KNOWN_ISSUES.md`: ledger header; the replay-binding entry says batch 1 is live and
  batches 2–4 are open.
- `src/types/supabase.ts`: regenerated from live. Additions only: the nine
  `_<name>_replay_impl_20261015` bodies, the helpers `_replay_fingerprint_20261015` and
  `_bind_replay_receipt_20261015`, and `_customer_has_open_invoice_20261013` (live since PR #907,
  missed by the last regeneration). No public function's arguments changed.
- `.claude/schema-registry.json`: delta only (the applied names `20261016030000_staff_photo_buckets_private`
  and `20261016060000_bind_money_replay_receipts_batch1`, `migrations_high_water` `20261016121253`).
  The migration added functions and a trigger, which the registry does not track.

**Still open.** Replay-binding batches 2–4 (KNOWN_ISSUES.md).
