## 2026-11-10 — DM-1b: Weights and Ingredients tabs on the setup workbook (database, not applied)

- Migration `20270103100000_setup_workbook_chemistry_tabs.sql`; build sheet `docs/plans/2026-11-10-product-DM1b-BUILD-SHEET.md`.
- Weights tab: weight per gallon for liquid products and net weight for dry bags save as drafts (they still need
  approval in Approve weights). Every row needs a source; one stale or invalid row refuses the whole upload.
- Ingredients tab: an upload never changes live chemistry. It creates one proposal per changed product, each row
  citing its source document; an admin then applies or rejects it. A removed ingredient (`__delete`) applies only
  with "Apply with removal". Products with an EPA number are refused by name (their chemistry comes from the EPA
  lookup).
- Screens come in a follow-up PR once the database part is live.
- Proof: `node scripts/smoke/prove-setup-workbook-chemistry-tabs-real-schema.mjs`.
