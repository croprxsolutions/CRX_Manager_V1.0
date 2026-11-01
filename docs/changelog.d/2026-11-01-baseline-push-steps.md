## 2026-11-01 - Baseline README push steps now work as written

`supabase/baselines/README.md` now holds a push block that runs as written. The old steps failed on a
real run. A table says which parts a real disaster recovery needs and which apply only to the empty test
copy.

- Ran the block from the README text on a throwaway stack built from the test app's compose file, restored
  from the baseline: 172 migrations applied, 3 one-shots recorded, 1,089 ledger rows, all 13 fingerprints
  identical to the `scripts/local-app/` build. A held transaction stopped it at `20260816120000` with
  `DRAW_DOWN_CUTOVER_NOT_QUIET`; rerunning the same block finished the rest.
- The block refuses the production project and any ledger that is not this baseline's. Both refusals were
  run. The last tightening of that ledger check came after the full push run, so it was proven on the part
  of the block before the first push: a clean baseline and a correct row pass, a row under the wrong
  version and a missing baseline row stop it. The password comes from `PGPASSWORD`, out of the process list.
- The CRLF function body is needed on every restore. The baseline holds that body with LF, and
  `20260817120000` pins the CRLF text. The block converts the body in place from the database.
- One-shots are now recorded during the push, because `20261010120000` refuses to run without
  `20261007150200` in the ledger. A real restore proves those corrections after loading data and before
  allowing writes. That order has only been run on an empty database.
- The proof ran with `supabase --version` 2.109.1 forwarding to a `supabase-go` binary at 2.106.0.
- No migration, no baseline artifact and no live database access.
