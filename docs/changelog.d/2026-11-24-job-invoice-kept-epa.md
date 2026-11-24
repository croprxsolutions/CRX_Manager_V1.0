## 2026-11-24 - #2341: job invoices and restricted-use records use the EPA number the job kept

- Create Invoice on a sprayed job now writes, on each chemical line (priced and customer-supplied, single invoice and owner split), the EPA number saved on the job when it was sprayed (`job_product_epa`), not the product's current catalog number.
- The restricted-use capture of a line on an invoice made from a job stores that kept number, with that registration's signal word, and is Yes when that registration says Yes. The restricted-use sales record made when the invoice posts follows the capture.
- When the job kept no number for a product (none on file when sprayed, or "Not recorded"), the line and record use the catalog number, as before. Invoices not made from a job are unchanged.
- Pricing, cost, payer, owner split, locks and who may invoice are unchanged (the prover checks the transfer body is the old one with only the EPA read changed).
- Migration `20270303100000_job_invoice_kept_epa` (no row changes). Proof: `node scripts/smoke/prove-job-invoice-kept-epa-real-schema.mjs`.
