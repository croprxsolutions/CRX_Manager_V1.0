## 2026-11-12 - Mason's restamp works through staging

Mason's restamp rule (ship.md, 2026-11-04): when a newer migration went live first, the waiting file gets a
new, newer stamp, with byte-identical SQL and the same name after the stamp, in one commit. Until now the
staging database job couldn't take that rename. The stamp check refused the "deleted" old file, and the
staging job would have run the SQL a second time under the new name.

- **Stamp check (PR into staging):** a deleted migration plus an added one with the same git blob, the same
  name after the stamp and a newer stamp is a restamp, not an edit (`restampPairs`). The new stamp must
  still be newer than every migration on the base branch. Anything else (changed bytes, another name, a
  plain delete) is refused as before.
- **Staging apply (`RENAME_RESTAMPS=1`, staging only):** a file the ledger lacks whose sha256 matches
  exactly one ledger row with no file left, the same name after the stamp and an older stamp is a restamp.
  That row is renamed in one transaction that proves the new name holds that exact SQL and the old name is
  gone (`planRestamps`, `restampSql`). The SQL never runs twice. Anything that looks like a restamp but isn't
  clean blocks the whole run before anything is written (Mason, 2026-11-12): different SQL from what ran
  on staging, a row that holds no SQL, or two rows or files that could match (`unmatchedRestamps`).
  Live never renames.
- **Drift check:** unchanged. After the rename there is no row without a file.

First use: M4b `20261231110000` and M4a `20261231120000`, already applied on staging, sit below migrations
already live, so they are restamped above live's newest before the first release.

**Tested:** unit tests (27), plus an end-to-end run against a throwaway Postgres 17 (Docker):
- apply, restamp, apply: the row was renamed and the table created once;
- drift came out at 0, and a second apply had nothing to do;
- with `RENAME_RESTAMPS` off: refused loudly; with changed bytes: STOPPED before anything ran, ledger untouched;
- the stamp check on real git history: a restamp passes; edited bytes, another name, an older stamp or a
  plain delete are refused.
