## 2026-11-26 — Commission payouts are switched off until commission-on-payment (M16) is live

- Mason, Slack 2026-11-25: "Move M16 to January, and please make sure no payout batch can run until it's live."
- Commission Payments › Create Payment, Post, and Reports › mark commissions paid: the database refuses with
  `COMMISSION_PAYOUTS_OFF_UNTIL_M16`, and the screen shows "Nothing was created or paid. Commission payouts are
  switched off until commission-on-payment (M16) is live. Voiding an existing payment still works".
- Voiding an existing payout batch still works. Commission reports and exports are unchanged.
- A retry of a payout created or posted before the switch went off still returns its original result.
- Migration `20270308180000_commission_payouts_off_until_m16.sql` (one switch, `_commission_payouts_enabled()`, false, plus
  a `commission_payments` trigger backstop); M16 turns it back on with its own migration.
