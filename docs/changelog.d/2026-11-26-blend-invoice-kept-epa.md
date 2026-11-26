## 2026-11-26 - Blend-ticket invoices use the EPA number the job kept (Taha audit Q1)

- An invoice made from a blend ticket now writes, on each chemical line, the EPA number saved on the ticket's job when it was sprayed (`job_product_epa`), not the product's current catalog number, as Create Invoice already does (#2341).
- The restricted-use capture and record of such a line follow it: the capture now finds the job through the blend ticket.
- When the job kept no number for a product, or the ticket has no job, the catalog number is used as before. A line added by hand keeps today's number. Split Billing is unchanged.
- Migration `20270311210000_blend_invoice_kept_epa.sql`; proof `node scripts/smoke/prove-blend-invoice-kept-epa-real-schema.mjs`.
