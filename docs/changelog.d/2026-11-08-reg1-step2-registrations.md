## 2026-11-08 — REG-1 Step 2: EPA registrations become the one source of label facts (database, not applied)

- Three migrations (`20261229180000`, `20261229190000`, `20261229200000`): the registration edit tool,
  restricted-use posting from what was captured when each sale line was saved (Mason, 2026-11-10, "Capture it at
  save": the answer is Yes when any Yes says so: the product's tick, its number's registration, or the number saved on
  the line; the record goes under the product's own number at save; a product with no number records with the number
  blank), Sales to check, and the one-time seed with its preview, which also captures every existing line. Everything
  stays off until Mason runs the seed.
- New private table `invoice_line_rup_captures` (RLS on, no app access) and trigger `trg_zz_capture_invoice_line_rup`.
- Q7: app users can no longer write invoice lines directly (the app never does).
- Simplified 2026-11-09 (Mason: "Yes, simplify", then "Drop them"): no product-master guards: sizes and brands keep their own label facts and stay directly editable; the registration list sits beside
  them. Label drafts, product setup and brand tools are unchanged.
- Proof: `node scripts/smoke/prove-epa-registration-step2-real-schema.mjs`.
