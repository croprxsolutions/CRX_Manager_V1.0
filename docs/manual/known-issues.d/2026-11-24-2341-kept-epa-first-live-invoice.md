## 2026-11-24 — Check the first real job invoice after #2341 goes live

**Severity:** LOW. **Area:** field billing / restricted-use records. **Status:** UNVERIFIED.
**Owner:** Mason. **Tracked:** #2341, #2457.

Migration `20270303100000_job_invoice_kept_epa` makes Create Invoice on a sprayed job use the EPA number
the job was sprayed with (and the restricted-use record follow it), not today's catalog number. On staging
a sprayed job's invoice, an added line and the posted restricted-use records all came out right
(PR #2457 staging proof), but live has no job invoices yet. After the release that carries it, open the
first real job invoice made from a sprayed job and check that each chemical line shows the number the job
was sprayed with and, once posted, that the restricted-use record shows the same.

The case it exists for (the catalog number corrected after spraying) cannot happen yet: no screen can
change a product's EPA number until the EPA correction work is switched on. It is proven only in the
rebuilt-schema prover (`scripts/smoke/prove-job-invoice-kept-epa-real-schema.mjs`); when EPA corrections
go live, repeat the check with a corrected product. Delete this file once both are seen.
