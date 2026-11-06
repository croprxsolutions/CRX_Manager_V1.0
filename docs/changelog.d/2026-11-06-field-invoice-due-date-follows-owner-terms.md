## 2026-11-06 — Field-application invoices are due on their own owner's terms (KI-14, database half)

- New migration `20261117100000_field_invoice_due_date_follows_owner_terms.sql` (not yet applied):
  - `parse_payment_terms_days` reads "Net N" first, so "2/10 Net 30" is 30 days (was 2). Every other value parses as before.
  - New column `invoices.due_date_is_custom` (default false; readable by the app, also through `invoices_postable`): true when the due date was typed by hand.
  - New trigger `zzz_field_invoice_due_date_follows_terms` on field-application drafts and unposted invoices: blank terms are filled from the customer (blank customer: Net 30), and a due date that was not typed by hand is always the invoice date plus those terms. Posted, paid, voided and cancelled invoices are never touched; a later change to the customer's terms never moves an existing invoice.
  - The job transfer no longer stamps "today + 30" on every invoice; each owner of a split gets its own terms' date.
  - `update_field_app_invoice_billing` takes `p_terms_by_invoice` (one terms/due date per invoice) so split owners keep their own terms. An app tab opened before this change still saves, but is refused with "reload the page" when the invoices' terms differ or when it would move a typed due date.
  - Existing editable field invoices are touched once so they carry their own terms (live: one invoice, its date unchanged).
- Proof script `scripts/smoke/prove-field-invoice-due-date-follows-terms-real-schema.mjs` (scratch container; never live). `scripts/smoke/undo-paths/harness.mjs` gains `buildContainer({ stopBefore })` so a proof can seed rows before its candidate applies.
- The field-application screen's per-owner terms pickers ship in a separate PR after this is live.
