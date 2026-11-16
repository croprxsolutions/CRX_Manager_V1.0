## 2026-11-16 - the migration hard-rules check lets a staging-only restamp through (#1868)

`scripts/check-migration-hard-rules.mjs` counts every migration stamped at or below the applied high-water
(the newest stamp in the base registry's `applied_migration_names`) as applied, and refuses its deletion.
A migration waiting on staging while main and live move past its stamp sits below that line without being
live, so Mason's restamp (byte-identical SQL, newer stamp) was refused as "DELETES an applied migration"
(#1898, the three billing migrations).

- A deleted migration is exempt only as an exact restamp pair: one added file with the same git blob, the
  same name after the stamp and a newer stamp, several pairs in the same order, and the old file **never in
  `origin/main`'s history** (what live runs; a shallow clone or a git error counts as on main). Each exemption is printed (`↻ restamp of a migration not on main`).
- No readable `origin/main` means no exemption (fail closed). A file on main, changed bytes, another name or
  an older stamp is refused as before. The staging job renames the ledger row (#1837); `db-apply.mjs
  stamp-check` applies its own restamp rules on top.

**Tested:** nine new fixture scenarios (pass, on main, once on main then removed, on a main side branch dropped by its merge, no origin/main, shallow clone, changed
bytes, another name, older stamp), 108 assertions. Against the real repo: #1898's restamp now passes with three exemptions printed (the old script
fails it), and a restamp of live's `20270106110000_invoice_brands_rup` is still refused.
