## 2026-11-07 — Product weights on loader worksheets (DM-2 screens, part 3)

- The selected loader worksheet shows, for each load, every product's amount with its weight in pounds
  and the load's total product weight. A refused amount or weight shows the reason by product name.
- The loader worksheet PDF (single job and bulk) prints the same weights under each amount and a
  "Product weight" row per load. The screen and both PDFs read the job's lines, acres, settings and
  weights in one database read, so an amount and its weight always come from the same moment.
- Caption: "Weights saved with this worksheet" (or "... except lines marked current") on a saved
  worksheet; "Weights use the current approved weights." for a job with no saved worksheet.
- A job amount that is not a plain number, is negative, or rounds badly per load prints its reason
  instead of a misleading 0. A new job's print keeps a row that has an amount but no product.
- Batch (master mix) summary weights follow in a later PR.
