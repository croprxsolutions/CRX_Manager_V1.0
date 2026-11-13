## 2026-11-13 - Doc stamps: Last verified 2026-11-13 for the live ledger and Edge Function versions

The two migration files dated 20261113 came due at midnight America/Chicago, so the freshness check
(`npm run check:docs`, CI "Documentation consistency" and the pre-push check) wanted
`docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md` stamped 2026-11-13. It blocked
every push of a branch carrying current `staging` (first seen merging `staging` into #1674).

Evidence (read-only `list_migrations` and `list_edge_functions` on live, 2026-11-13 Central): 1,207
ledger rows, newest `20261113011216` (`20270109100000_delivery_receipt_brands`). Both 20261113 files
were applied live on 2026-11-06: `20261113110000_paged_read_tiebreakers` (row `20261106021109`) and
`20261113140000_delivery_receipt_queue` (row `20261106023253`). Every row after the 2026-11-11 stamp
(`20261111140313`) was checked against both pages: each is either recorded as applied or not
mentioned, and the one migration KNOWN_ISSUES calls not live (`20261229170000`) is still not live.
Edge Function versions: `epa-lookup` v10, `send-email` v31 and `send-delivery-receipts` v4 moved
since 2026-11-10 and are now recorded; the rest are unchanged. KI-30's EPA numbers keep 2026-11-09.

This PR targets `staging` only. `main` holds the same migration files and fails the same check until
the next release (or a `hotfix/` restamp that Taha or Mason merges) brings these lines over.
