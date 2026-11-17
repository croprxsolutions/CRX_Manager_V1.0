## 2026-11-17 — Sales tax and standing discounts: switched off in the database too, until commission

- New migration `20270117140000_billing_m4_db_switch.sql` (not applied live; record in `docs/reference/migrations.d/`).
- While the switch is off (live, until commission ships), the database refuses ticking a sale's sales tax and any standing discount above 0, whatever calls it. Turning them off always works. The app's switch already hid the controls on live.
- A new invoice drafted while the switch is off never gets tax or a discount, whatever its sale or customer holds; invoices that already have them keep them.
- The switch starts off everywhere. Staging is switched on by hand once after this applies; the local rebuild switches it on.
- The standing discount smoke now expects "the customer's rate" to go back to the rate the sale was drafted at.
