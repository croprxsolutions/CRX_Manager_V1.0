## 2026-11-17 - Doc stamps: Last verified 2026-11-17 for the live ledger

The migration file dated 20261117 came due at midnight America/Chicago, so the freshness check
(`npm run check:docs`, CI "Documentation consistency" and the pre-push check) wanted
`docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md` stamped 2026-11-17. It failed every
staging PR (seen on #1674).

Evidence (read-only `list_migrations` on live, 2026-11-17 Central): 1,207 ledger rows, newest still
`20261113011216` (`20270109100000_delivery_receipt_brands`); nothing new since the 2026-11-16 stamp. The
due file `20261117130000_tote_fill_from_bulk` was applied live on 2026-11-06 (row `20261106065456`).
`20261229170000` is still not live. Nothing else in either page was re-certified.

This PR targets `staging` only.
