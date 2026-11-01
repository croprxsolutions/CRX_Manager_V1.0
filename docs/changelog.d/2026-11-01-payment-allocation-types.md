## 2026-11-01 - Payment allocation types match the live database

`AllocationSet` now accepts `payment` and the nullable payment totals and `updated_at`, and `InvoiceLineAllocation` is added from the generated row. `FinancialAuditLog` already matched. Types only; no app behavior changes.
