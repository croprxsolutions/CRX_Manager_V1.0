## 2026-11-25 — Shared-field job invoices can total a cent or two off the job

**Severity:** MED (money). **Area:** Create Invoice on a job whose field has more than one payer
(`transfer_job_to_invoice`, latest body `20270303100000_job_invoice_kept_epa.sql`). **Status:** OPEN, MUST FIX.
**Owner:** Mason will fix it (Mason, 2026-11-25: "LOG AS ISSUE THAT HAS TO BE FIXED and i will fix it later"),
after 2026-12-15 because job invoices are in Taha's lane until then. **Found:** FP-1 follow-up proof (Sol r6).

Create Invoice splits each product line's quantity between the payers by acre share (to 4 decimals, the
leftover to the largest remainder) and then rounds each payer's dollar amount on its own. The payers' invoices
can therefore add up to a cent or two more or less than the job line. The existing check only refuses a
difference over 50 cents (Mason, 2026-11-22, "Allow up to 50c").

- Seen in the proof: a field saved as 50.01% / 50.00% (older splits that total near, not exactly, 100% are kept
  as saved since FP-1). A $100.00 job (10 Gal at $10.00) bills 5.0005 Gal = $50.01 and 4.9995 Gal = $50.00, so
  $100.01 in total.
- An exact 100% split can also drift by a cent. By arithmetic, not yet run: thirds on 10 Gal at $12.34 bills
  three times $41.13, $123.39 instead of $123.40.
- FP-1 did not cause this. The billing copy holds the same shares as before, so Create Invoice billed the same
  way before FP-1.

**Workaround until fixed:** for a field saved near 100% (for example 50.01 / 50.00), retype the split in Field
Setup so it totals exactly 100%. Check shared-field job invoices against the job total before sending.

**Fix direction:** give each line's leftover cent to one payer (largest remainder on cents, not only on
quantity), so the payers' invoices always add up exactly to the job line. Prove it with the real Create Invoice
on near-100% and exact-thirds splits (`scripts/smoke/prove-field-split-versions-real-schema.mjs` has the
$100.00 job set-up).
