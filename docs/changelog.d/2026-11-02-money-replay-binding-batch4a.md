## 2026-11-02 — replay-binding batch 4a: invoices, accounting periods and rebates (KI-10 / KI-75)

- New migration `20261102110000_bind_money_replay_receipts_batch4a.sql` (not yet applied): eleven
  functions now hand back a saved retry answer only to the same person for the exact same request —
  `unpost_invoice`, `unpost_invoice_group`, `close_accounting_period`, `reopen_accounting_period`,
  `transfer_invoice_to_job`, `save_field_app_invoice`, `update_field_app_invoice_billing`,
  `consolidate_draft_invoices`, `update_blend_ticket_billing_status`, `create_rebate_claim` and
  `transition_rebate_claim`. A retry key reused for a different invoice, period, order, ticket,
  claim or edited value is refused with nothing changed, instead of reporting a false success. Each
  now requires a retry key, and runs its permission check before any saved answer is returned.
- Screens: Month-End Close (reopen now keys each period and reason apart), Order Detail
  (consolidate), Rebates, Invoice Detail, the Posted field-invoice list and the field-application
  invoice editor retire a refused key and reload when the server proves nothing ran under it. The
  editor and Rebates use the refusal's saved result so an edit after a lost reply never creates a
  second invoice or claim.
- Proof: `scripts/smoke/prove-money-replay-binding-batch4a-real-schema.mjs` with the new chain
  `scripts/smoke/smoke-money-replay-binding-batch4a.sql`; six existing chains now pass retry keys,
  and the blend-billing gauntlet chain now expects a key reused for a different status to be refused.
