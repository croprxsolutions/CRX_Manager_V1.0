## 2026-11-22 — Per-acre field pricing is retired (database step)

- New migration `20270207142500_retire_per_acre_field_pricing.sql` (not applied live; record in `docs/reference/migrations.d/`).
- A field's billing split can no longer carry a flat per-acre price or a pricing note. The database refuses both.
- Mason, 2026-11-22: "we never bill a flat price per acre for chemical etc, we always bill line by line."
- Unchanged:
  - percent splits between payers;
  - line-by-line billing of every chemical and fee for each payer;
  - quoted prices.
- Live 2026-11-22 (read-only): 0 of 6 split rows had a per-acre price or a note, and no invoice was ever billed per acre.
- Until the screen PR lands, typing a per-acre price in Field Setup is refused, and nothing is saved. The screen PR removes the box, the note and the related banners.
- Proof: `node scripts/smoke/prove-retire-per-acre-pricing-real-schema.mjs`. Not yet verified on staging.
