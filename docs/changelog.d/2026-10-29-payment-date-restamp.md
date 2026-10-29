## 2026-10-29 - Prepare Chicago payment dates for protected landing

- Merge current main and reconcile the dated status notes with current production evidence.
- Re-stamp the unapplied payment-date migration as `20261029160200_chicago_payment_business_date.sql`, after the live migration ordering high-water; keep its payment and retry behavior unchanged.
- Update the disposable PostgreSQL proof to load the new filename. Live apply and merge still require every release gate.
