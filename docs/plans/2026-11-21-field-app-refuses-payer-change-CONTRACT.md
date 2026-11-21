# Behavior contract: a standalone field-application invoice refuses a payer change (#2058, #2070)

Read at `origin/staging` (2026-11-21). Live checked read-only the same day.

## Facts

- `_save_field_app_invoice_impl_20260714` (newest body: `supabase/migrations/20270129171000_field_app_refuses_product_without_sold_unit.sql`, live md5 `1a4a2655e43392d867b195289df9b9a1`, matches the file).
- The payers come from the selected fields (`derive_customer_shares_from_fields`), never from the screen.
- Editing a **standalone** invoice (one payer, no group):
  1. fields now owned by a different farm: the invoice is reused for the new payer but its header UPDATE never sets `customer_id`, so the old farm is billed for the new farm's work (#2070: header and pricing disagree);
  2. fields now split across several payers: every payer gets a new draft and the original stays live with its old total and no lines.
- Live 2026-11-21: 3 field-application invoices; neither shape exists.

## Decision (Mason, 2026-11-21)

An earlier version moved the draft automatically (cancel the old one, make a new one for the new farm). Sol found new HIGH findings in two rounds, all from the move (copied PO number, notes and negotiated prices; another rep's draft cancelled; stale Void on a new group; the screen losing the new draft). Mason chose: "refuse the save and warn explain problem", so the office knows why and what to do, rather than a bare "error, can't save".

## Outcome

Saving a standalone invoice whose fields now bill a different farm, or several farms, is refused with `FIELD_APP_PAYER_CHANGED` and this sentence (farm names and invoice number filled in):

> Nothing was saved. These fields bill <farm(s)>, but this invoice bills a different farm, and an invoice cannot change which farm it bills. Put back the original fields, or have an admin delete this invoice (void it if it was posted) first, then make a new field application invoice for these fields.

An invoice made from a job ends instead:

> … Put back the original fields, or, if the job itself is wrong, have an admin delete this invoice (void it if it was posted), correct the job, and invoice it again from Scheduling.

The sentence names only the farm(s) of the fields the user sent, never this invoice's own number or farm (a rep may not be able to see that invoice; Sol r3), and it puts the admin step first so a rep never leaves two live drafts. A job-made invoice is re-billed from its job so the job is not billed twice (Sol r3).

The invoice screen shows that sentence as is (no raw code). Nothing is written: no cancel, no new draft, no group.

Unchanged: a new invoice (no id), an edit whose fields still bill the same single farm, every grouped-invoice rule, who may save, posted/voided refusals, grants, idempotency.

## Proof cases (real migrated database, prover)

1. A standalone draft for farm A re-saved with only farm B's field: before, it stays A with B's lines; after, refused with the sentence naming B, the invoice number and A; the database is unchanged.
2. Re-saved with A's and B's fields: before, the original stays live with no lines; after, refused naming both farms; unchanged.
3. Re-saved with A's fields only: same id, number and customer (regression).
4. A grouped edit ends exactly as before.
5. An unposted invoice and a job-made draft are refused the same way.
6. A deleted draft is refused `Invoice not found` before and after; a second apply stops at the preflight; grants unchanged.

## Open business decisions

None (decided above).
