## 2026-11-24 - PAR-1 7.7: EPA correction refuses while a draft would lose its restricted-use record

- Correcting a product parent's EPA number to a restricted-use number is refused while a draft or unposted invoice line of one of its sizes is saved under a number that is not restricted-use (`PRODUCT_PARENT_EPA_RUP_DRAFT`, on save and preview). Such a line keeps its saved number and restricted-use capture, so posting it after the correction would have made a restricted-use sale with no restricted-use record (Taha review of #2381 at 78c34a1f3).
- The refusal tells the admin not to post that draft: delete it or remove that line, correct the number, then add the line again (posting it first would also make no restricted-use record; Sol r9).
- Same migration, `20270302150000_parent_epa_correction_on` (NOT APPLIED). Proof: `node scripts/smoke/prove-parent-epa-correction-on-real-schema.mjs` (new draft case).
