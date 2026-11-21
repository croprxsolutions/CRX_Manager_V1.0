## 2026-11-21 - Manual docs: live-ledger stamp after release #1990

- `CURRENT_STATE.md` and `KNOWN_ISSUES.md` "Last verified" stamps move to 2026-11-21 for the live ledger only.
- Evidence: read-only `list_migrations` on 2026-11-21 shows the newest live row is `20261121061349`, after the 37 release #1990 migrations were applied.
- Unblocks the main → staging back-merge (#2099), whose docs freshness check failed on the 2026-11-20 stamps.
