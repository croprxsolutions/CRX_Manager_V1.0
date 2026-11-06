## 2026-11-06 — A rep can only unpost invoices under their own name

- New migration `20261123140000_unpost_invoice_rep_scope.sql` (not applied). Unposting now follows the same rule as posting: admins can unpost any invoice, reps only their own. A group needs every member under the rep's name. Refused with `INVOICE_SCOPE_DENIED`. The screens already only offer a rep their own invoices.
