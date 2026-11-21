## 2026-11-21 — A field-application invoice refuses a save that would change which farm it bills (#2058, #2070)

- New migration `20270204100000_field_app_refuses_payer_change.sql` (not applied live; record in `docs/reference/migrations.d/`).
- Editing a single-farm field-application invoice so its fields now belong to another farm, or to several farms, is refused with `FIELD_APP_PAYER_CHANGED` and a plain sentence: what changed, which farm the invoice bills, and what to do (make a new invoice for these fields, then delete or void this one). Before, the old farm stayed on the invoice and would have been billed for the new farm's work, or a split left the old invoice live with no lines.
- Mason's decision (2026-11-21): refuse and explain, rather than move the draft automatically.
- The invoice screen shows the sentence without the code.
- Live 2026-11-21: neither shape exists (3 field-application invoices). Proof: `node scripts/smoke/prove-field-app-refuses-payer-change-real-schema.mjs`. Not yet verified on staging.
