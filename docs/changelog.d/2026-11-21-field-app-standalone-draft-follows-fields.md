## 2026-11-21 — A standalone field-application draft follows its fields' payers (#2058)

- New migration `20270202100000_field_app_standalone_draft_follows_fields.sql` (not applied live; record in `docs/reference/migrations.d/`).
- Editing a single-payer field-application draft so its fields now belong to another farm cancels the old draft (totals 0, an `invoice_orphan_cancelled` activity row) and saves a new draft for the new farm. Before, the old farm stayed on the invoice and would have been billed for the new farm's work.
- Editing it so the fields split across several farms reuses it for its own farm inside the new group. Before, it stayed a live draft with its old total and no lines.
- Only a plain draft is cancelled this way. An unposted invoice, or one made from a job or blend ticket, is refused `FIELD_APP_PAYER_CHANGED` instead, whether its fields move to another farm or split over several (void it or change the job), so no job is left pointing at a cancelled invoice.
- The invoice screen opens the new draft when the edited one was cancelled, and a lost-reply retry saves onto the new draft.
- Live 2026-11-21: neither shape exists (3 field-application invoices). Proof: `node scripts/smoke/prove-field-app-standalone-draft-real-schema.mjs`. Not yet verified on staging.
