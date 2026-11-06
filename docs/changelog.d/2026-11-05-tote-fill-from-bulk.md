## 2026-11-05 — Fill a fertilizer tote from its Bulk (BLK-1a, database)

- New migration `20261117130000_tote_fill_from_bulk.sql`: an admin previews, then records, filling
  one or more fixed fertilizer totes from the parent's Bulk size. The Bulk loses the gallons in its
  own stock unit (quarts if stocked in quarts) and the tote gains whole totes, as two signed ledger
  rows (`tote_fill_out`, `tote_fill_in`) and one append-only `tote_fills` record. A fill larger than
  the Bulk on hand still records and is flagged for review. The fill is refused if anything in the
  preview changed before confirm. Undo works only while neither product has moved since.
- Quantities only: no cost, price or valuation is written (purchase cost is BLK-1b, parked).
- The app's ledger check (`src/lib/reconciliation.ts`) treats both new types as signed.
- Proof: `scripts/smoke/prove-tote-fill-real-schema.mjs`.
