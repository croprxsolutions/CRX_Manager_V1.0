## 2026-11-10 — REG-1 Step 2: EPA registrations, and restricted-use records that name their invoice line (database, not applied)

- Replaces PR #1688 (parked after 13 Sol rounds). Three migrations (`20261231200000`, `20261231210000`,
  `20261231220000`): the registration edit tool, restricted-use posting, Sales to check, and the one-time seed with
  its preview. Everything stays off until Mason runs the seed.
- New: each restricted-use record points at the invoice line it records (`rup_sales_records.invoice_item_id`), one
  active record per line. Posting writes one record per line captured as restricted use; nothing is matched by number,
  unit, price or customer any more.
- Mason, 2026-11-10: return credits never create or need a record; voiding an invoice voids its records (the database
  does this for any way an invoice leaves posted, paid or overdue); field-application invoices get records under the
  invoice's own customer; sales from before the switch-on are out of scope.
- Kept from #1688: the answer captured when each sale line is saved (private table `invoice_line_rup_captures`,
  trigger `trg_zz_capture_invoice_line_rup`), "a Yes always wins", the registration tools, the seed.
- App users can no longer write invoice lines or restricted-use records directly (the app never does).
- Contract: `docs/plans/2026-11-10-reg1-step2-record-line-link-CONTRACT.md`.
- Proof: `node scripts/smoke/prove-epa-registration-step2-real-schema.mjs`.
