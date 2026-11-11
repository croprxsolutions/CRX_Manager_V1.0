## 2026-11-10 — KI-108: five products' stored stock set to match their history (migration, not yet applied)

- New data-only migration `20270102100000_ki108_stock_matches_history.sql`. Mason decided on 2026-11-10 to
  trust the transaction history: Black Strap Molasses Tote 2000 → 675, Start Right 2.0 Tote 670.19 → 140.19,
  2,4D Amine Bulk 55 → 0, Start Right 2.0 2.5G 290 → 280. For 2,4D Amine 2.5 Gal (history −70) he chose to keep
  the stored 25 and add the missing +95 opening-stock `adjusted` row. Black Strap Bulk (−1,325) already
  matches its history and is not touched. No function, policy or screen change.
- The migration binds the exact 2026-11-10 state (row ids, stored and pre-booked stock, each product's ledger
  total, row count and newest movement) and refuses with `KI108_PREIMAGE_DRIFTED` if anything moved since.
  It also refuses if any product has a second inventory row or an in-progress cycle count, and locks the
  inventory, ledger and cycle-count tables while it runs so a count cannot start mid-correction (Luna round 1).
  A database without the five products is a no-op.
- Proof: `node scripts/smoke/prove-ki108-stock-matches-history.mjs` (offline container, live rows copied
  read-only) — no-op on empty, eight refusals with nothing changed (including a failure after writing), exact apply, integrity check passes
  for every row, second run refused. Not verified: the live apply (pending the gates and Mason's yes).
- Contract: `docs/plans/2026-11-10-ki108-stock-matches-history-CONTRACT.md`.
