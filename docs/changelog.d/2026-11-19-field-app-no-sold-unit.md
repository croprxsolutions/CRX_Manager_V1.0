## 2026-11-19 — Every product needs a sold unit; field-application invoices refuse a product without one (#1990 Sol)

- New migration `20270129171000_field_app_refuses_product_without_sold_unit.sql` (not applied live; record in `docs/reference/migrations.d/`).
- Every product must now have a sold unit (inventory unit) containing a letter or digit; blank, spaces, tabs or invisible characters are refused by the database (Mason, 2026-11-19). Creating or editing a product without one is refused; before, it could be left blank and showed "setup incomplete". Live has no product without one today.
- Field-application invoices: a chemical whose product has no sold unit is refused (`FIELD_APP_UNIT_UNCONVERTIBLE`) by the single-owner save and the split-bill save, and the invoice screen's preview shows it at $0. Before, a $32/gal quote on such a product could bill the applied ounces as if each were a gallon (160 oz billed $5,120.00 instead of $40.00).
- The single-owner save's "someone else's name" check now says `ACTOR_MISMATCH` like every other save (the offline sync already reads it that way).
- Local seed fixtures (`scripts/local-app/seed.sql`, `scripts/local-app/sales-checks.mjs`) now give their products a sold unit.
- Proof: container prover `scripts/smoke/prove-field-app-no-sold-unit-real-schema.mjs` (before and after; rollback lifts the rule and restores the three previous bodies). Not yet verified on staging.
