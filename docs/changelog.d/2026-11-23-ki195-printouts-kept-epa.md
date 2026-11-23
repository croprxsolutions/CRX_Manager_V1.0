## 2026-11-23 - KI-195 (#2183): printouts show the EPA number the job kept

- The Chemical Application Report (Jobs list and job page), the applicator sheet, the WPS notice and the sent spray proof email now print, per product, the EPA number saved on the job when it was sprayed (`job_product_epa`), not the product's current catalog number. A product saved with no number prints `Unknown`; an older job marked "not recorded" prints `Not recorded`, never the catalog number. A job not yet sprayed prints the catalog number as before.
- The applicator sheet gains an `EPA Reg. No.` column. The proof email and its office preview gain an `EPA Reg. No.` line per product.
- The WPS notice takes each product's re-entry (REI) and pre-harvest (PHI) intervals from the job line first, then the product, as the report, applicator sheet and proof already did, so the kept EPA number is printed beside the job's own intervals.
- If the saved numbers cannot be read, the report, sheet and WPS notice stop with the existing error instead of printing the catalog number.
- The batch reports (Master Mix, Chemical Summary, Projected Use) are loading and usage sheets, not per-job records: they keep the catalog number, unchanged.
- Migration `20270225110000_job_proof_kept_epa` (proof data function, read-only). Proof: unit tests and the real-schema prover `npm run proof:ki195-kept-epa`.
