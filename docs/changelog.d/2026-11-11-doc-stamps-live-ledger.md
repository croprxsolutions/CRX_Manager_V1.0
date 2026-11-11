## 2026-11-11 - Doc stamps: Last verified 2026-11-11 for the live ledger

The two migration files dated 20261111 came due at midnight America/Chicago, so the freshness check
(`npm run check:docs`, CI "Documentation consistency" and the pre-push check) wanted
`docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md` stamped 2026-11-11. Every push was
failing it, the same way as #1734.

Evidence (read-only `list_migrations` on live, 2026-11-11 about 03:35 Central, Taha's OK): 1,192
ledger rows, newest `20261111030853` (`20270101010000_unit_spellings_remap`, applied 2026-11-10 about
9:08 PM Central per its record). Both 20261111 files were applied live on 2026-11-05:
`20261111100000_tiers_credit_limits_admin_only` (row `20261105225344`) and
`20261111120000_uncertain_request_cleared_message_neutral` (row `20261106005432`). Only the live ledger
was re-read: CURRENT_STATE's Edge Function versions keep 2026-11-10 and KI-30's EPA numbers keep
2026-11-09.

The same change goes to `staging` and to `main` (as `hotfix/restamp-20261111`), so both branches pass
the check and a later back-merge has nothing to resolve on these lines.
