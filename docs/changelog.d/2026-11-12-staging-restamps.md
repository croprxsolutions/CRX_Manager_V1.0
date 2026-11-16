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

First use: M4b `20261231110000`, M4a `20261231120000` and the sales-tax rep fix `20270103190000`, already
applied on staging, sit below main's newest (`20270109100000`), so they are restamped to `20270109100100`,
`20270109100200` and `20270109100300` (#1868).

**Tested:** unit tests (27), plus an end-to-end run against a throwaway Postgres 17 (Docker):
- apply, restamp, apply: the row was renamed and the table created once;
- drift came out at 0, and a second apply had nothing to do;
- with `RENAME_RESTAMPS` off: refused loudly; with changed bytes: STOPPED before anything ran, ledger untouched;
- the stamp check on real git history: a restamp passes; edited bytes, another name, an older stamp or a
  plain delete are refused.

### 2026-11-16 - fixes from Mason's review and Sol's second opinion

- **HIGH (Mason): no restamp exemption into `main`, or for a file already on `main`.** The stamp check treats
  a delete plus an add as a restamp only on a PR into `staging`, and only when the deleted file isn't on
  `main` (`migrationChanges`). A live migration's delete is refused as before.
- **BLOCKER (Sol): a restamped one-shot stays a one-shot.** Restamping a file named in
  `one-shot-migrations.json` is refused unless the new name is listed too, so live never runs it.
- **HIGH (Sol): the staging rename comes from git, not ledger likeness alone.** A row is renamed only if git
  shows its old file deleted from `staging`'s history holding the same bytes (the job now checks out the
  full history). A fileless row that was never a file in the repo blocks instead of being silently renamed.
- **Anything unclean blocks:** a new file holding the exact SQL of any ledger row (a copy, or a new slug), and
  a backward restamp (MED 1 and 2).
- **Smaller:** the `changed` computation is a pure, tested function (MED 4); deleted files are read at the
  merge-base and added ones at HEAD (LOW 1); all restamps commit in one transaction (LOW 2); the stop
  message says how to fix a row holding no SQL (LOW 4); several restamps must keep their order (LOW 6).
  LOW 5 (newer than `main`'s newest) was already on `staging`. Docs (MED 3) landed with #1838.

**Tested:** unit tests (29); the stamp check on real git history (the three billing restamps into `staging`
pass, a restamp of main's `20270109100000` is refused); and a throwaway Postgres 17: apply, restamp, apply
renamed both rows in one transaction with drift 0 and nothing left to run, and a fileless row that was
never in git plus the same bytes under a newer stamp stopped the run with the ledger untouched.
