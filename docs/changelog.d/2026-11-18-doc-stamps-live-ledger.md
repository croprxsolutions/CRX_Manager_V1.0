## 2026-11-18 - Doc stamps: Last verified 2026-11-18 for the live ledger

The migration file dated 20261118 came due at midnight America/Chicago, so the freshness check
(`npm run check:docs`, CI "Documentation consistency" and the pre-push check) wanted
`docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md` stamped 2026-11-18. It failed #1946.

Evidence (read-only query of the live migration ledger, 2026-11-18 Central): 1,207 ledger rows, newest still
`20261113011216` (`20270109100000_delivery_receipt_brands`); nothing new since the 2026-11-17 stamp. The
due file `20261118110000_sale_line_vendor` was applied live on 2026-11-06 (row `20261106135401`).
`20261229170000` is still not live. Nothing else in either page was re-certified.

This PR targets `staging` only.
