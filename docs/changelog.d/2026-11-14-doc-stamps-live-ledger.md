## 2026-11-14 - Doc stamps: Last verified 2026-11-14 for the live ledger and Edge Function versions

The two migration files dated 20261114 came due at midnight America/Chicago, so the freshness check
(`npm run check:docs`, CI "Documentation consistency" and the pre-push check) wanted
`docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md` stamped 2026-11-14. It blocked every
push of a branch carrying current `staging` (seen refreshing #1854).

Evidence (read-only `list_migrations` and `list_edge_functions` on live, 2026-11-14 Central): 1,207
ledger rows, newest still `20261113011216` (`20270109100000_delivery_receipt_brands`); no row after the
2026-11-13 stamp. Both 20261114 files were applied live on 2026-11-06:
`20261114080000_list_true_totals` (row `20261106032102`) and
`20261114200000_bind_records_replay_receipts_batch4d` (row `20261106035950`). The one migration
KNOWN_ISSUES calls not live (`20261229170000`) is still not live. All nine Edge Function versions match
the 2026-11-13 read. Nothing else in either page was re-certified.

This PR targets `staging` only; `main` fails the same check until the next release brings these lines over.
