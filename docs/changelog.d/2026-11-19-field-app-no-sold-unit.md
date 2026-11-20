## 2026-11-19 — Field-application invoices refuse a product with no sold unit (#1990 Sol)

- New migration `20270129171000_field_app_refuses_product_without_sold_unit.sql` (not applied live; record in `docs/reference/migrations.d/`).
- Field-application invoices: a chemical whose product has no sold unit set is refused (`FIELD_APP_UNIT_UNCONVERTIBLE`) by the single-owner save and the split-bill save, and the invoice screen's preview shows it at $0. Before, a $32/gal quote on such a product could bill the applied ounces as if each were a gallon (160 oz billed $5,120.00 instead of $40.00). The grower-share line already refused these. Live has no such product today, so nothing that saves now stops saving.
- A sold unit of only spaces or tabs counts as none. The apply stops if an unposted field-application invoice already has a product line (none live today), so no draft priced the old way can post.
- The single-owner save's "someone else's name" check now says `ACTOR_MISMATCH` like every other save (the offline sync already reads it that way).
- Proof: container prover `scripts/smoke/prove-field-app-no-sold-unit-real-schema.mjs` (before and after; rollback restores the three previous bodies). Not yet verified on staging.
