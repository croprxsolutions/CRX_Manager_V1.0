## 2026-11-16 — Billing fixes from Sol on staging (#1904 findings)

- New migration `20270109100500_billing_sol_fixes_staging.sql` (not applied live; record in `docs/reference/migrations.d/`).
- A return of quantity delivered but never billed no longer fails because of the sales-tax freeze.
- Turning sales tax on no longer fails for a whole sale when one draft is a field split or a Bill Split sliver: those drafts keep their tax until redrafted, and the toast says so. Changing such a draft's discount is refused in plain words.
- "The customer's rate" on a draft's discount goes back to the rate it was drafted at, not the customer's current rate.
