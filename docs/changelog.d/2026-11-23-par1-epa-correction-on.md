## 2026-11-23 - PAR-1 7.7: admins can correct a product parent's EPA number

- **Correct identity** on a product parent can now change its EPA number (admin only, with a reason and evidence; one logged event). Every size takes the new number, and so do jobs not sprayed yet. Old invoices, statements, sprayed jobs' printouts and spray proof, restricted-use records and delivery brand picks keep the number they were made with.
- The customer year-end summary now shows each invoice line's own saved EPA number (the product's number only for a line with none), so an old season prints what was sold even after a correction.
- The preview lists each size's current number and the new one before saving.
- An EPA number can be corrected but not cleared, and a correction that would drop a size's restricted-use status is refused until the size is marked restricted-use. Records made after a correction (a logbook record when an earlier-sprayed job is completed, a reposted split field invoice, a return credit) take the corrected number (Mason, 2026-11-23).
- Migration `20270302150000_parent_epa_correction_on` (NOT APPLIED; apply after `20270201100000`, `20270225193000` and KI-195's app deploy). Proof: `node scripts/smoke/prove-parent-epa-correction-on-real-schema.mjs`. Its `cost-exposure-review` allowlist entries carry the post-apply keys, so they show until the apply.
