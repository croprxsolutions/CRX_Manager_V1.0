## 2026-10-29 - Prepare Chicago payment dates for protected landing

- Merge current main and reconcile the dated status notes with current production evidence.
- Re-stamp the unapplied payment-date migration as `20261029160200_chicago_payment_business_date.sql`, after the live migration ordering high-water; keep its payment and retry behavior unchanged.
- Update the disposable PostgreSQL proof to load the new filename. Live apply and merge still require every release gate.
- Row 1004 now carries the `LOCAL CANDIDATE - NOT APPLIED` token and the SQL sha256 `91119fc1759d66785f25cc4fc0bc7cdb97a4dd4a9990a65fa85802dbc837f553` (the file's two status-comment lines changed in the restamp, so earlier `5ced6a5e...` references are historical). `.gitattributes` pins the new filename as LF. The migration-history row was renumbered from 1001 (taken live by the order-edit migration) to 1004.
- Review-round fixes only touched documentation and `.gitattributes`; the SQL bytes above are unchanged.
