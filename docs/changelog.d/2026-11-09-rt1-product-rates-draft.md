## 2026-11-09 - RT-1: draft application rates per product parent (database half)

Migration `20261229110000_product_rates_draft.sql`, applied live 2026-11-09 (ledger `20261110032302`). It adds draft rates per product
parent: a fixed unit list (`product_rate_units`), the rates themselves (`product_rates`, exact to 6 decimals, one row
for each parent, source and basis pair, so a parent can have several) and an append-only history (`product_rate_draft_events`). Four admin calls save, delete,
read and derive draft rows; derive copies today's per-size `products.rate` fields into draft rows and records a note
for everything it cannot read. A house rate above a linked EPA label maximum needs a written reason. Nothing in the app
reads these tables yet (RT-4), and no existing table, row or function changes. Types in `src/types/index.ts`; calls in
`docs/reference/rpc-functions.md`; the four old-data problems it copies as they are are KI-114.

Proof: `node scripts/smoke/prove-product-rates-draft-real-schema.mjs` replays the real schema in a scratch container,
applies the migration, runs the build sheet's cases R1-R18 (including R11, a save racing a parent rate edit and a label
change, in three orders) and checks that every quote, quote item, product price and rate-lock reader is unchanged
before and after.

Not verified: the live apply and the read-only live check after it.
