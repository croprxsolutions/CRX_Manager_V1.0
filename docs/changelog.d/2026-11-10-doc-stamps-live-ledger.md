## 2026-11-10 - Doc stamps: Last verified 2026-11-10 for the live ledger

The five migration files dated 20261110 came due at midnight America/Chicago, so the freshness check
(`npm run check:docs`, CI "Documentation consistency" and the pre-push check) wanted
`docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md` stamped 2026-11-10. Every push and
PR was failing it.

Evidence (read-only `list_migrations` on live, 2026-11-10, Taha's OK): 1,186 ledger rows, newest
`20261110061547` (`20261229160000_convert_to_gl_lb_dry_oz`). The five 20261110 files were all applied
live on 2026-11-05: `20261110110000` (row `20261105203216`), `20261110120000` (`20261105205727`),
`20261110140000` (`20261105213209`), `20261110150000` (`20261105224006`), `20261110160000`
(`20261105225320`). Only the live ledger was re-read; KI-30's EPA numbers keep their 2026-11-09 date.
