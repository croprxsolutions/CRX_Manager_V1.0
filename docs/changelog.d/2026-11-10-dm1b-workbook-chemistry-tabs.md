## 2026-11-10 — DM-1b: Weights and Ingredients tabs on the setup workbook (database, applied live 2026-11-11)

- Migration `20270103160000_setup_workbook_chemistry_tabs.sql`; build sheet `docs/plans/2026-11-10-product-DM1b-BUILD-SHEET.md`.
- Weights tab: weight per gallon for liquid products and net weight for dry bags save as drafts (they still need
  approval in Approve weights). Every row needs a source; one stale or invalid row refuses the whole upload.
- Ingredients tab: an upload never changes live chemistry. It creates one proposal per changed product, each row
  citing its source document; an admin then applies or rejects it. A removed ingredient (`__delete`) applies only
  with "Apply with removal". Products with an EPA number are refused by name (their chemistry comes from the EPA
  lookup).
- Screens come in a follow-up PR once the database part is live.
- Proof: `node scripts/smoke/prove-setup-workbook-chemistry-tabs-real-schema.mjs`.
- Doc freshness (2026-11-11 America/Chicago): read-only `list_migrations` shows 1,192 live rows, newest
  `20261111030853` (`20270101010000_unit_spellings_remap`). The five rows after the old stamp (`20261231200000`,
  `20261231210000`, `20261231220000`, `20270101000000`, `20270101010000`) each have a `migrations.d` record marked
  applied live, so `CURRENT_STATE.md` and `KNOWN_ISSUES.md` move their ledger stamp to that row; nothing else changed.
- Applied live 2026-11-11 about 9:26 AM Central as `20270103160000` (restamped from `20270103100000`; SQL byte-identical), ledger version `20261111152650`. Live check: table RLS on with 0 rows; six public functions for signed-in users only; eight private helpers closed. Still to do: refresh the schema registry and drop the stamp from `MIGRATIONS_AWAITING_TYPE_REGENERATION`.
