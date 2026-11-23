## 2026-11-23 - #2237: the database refuses impossible quantities and dates

- Migration `20270225130000_refuse_impossible_quantities_and_dates` (not applied): job chemical lines, stock rows, order lines and delivery lines can no longer store a quantity that is not a real number (NaN or infinity), and a job or delivery date must be between 2000-01-01 and 2099-12-31 (the window Mason set for the purchasing plan). Nothing a screen sends today is affected; production holds no such values. The purchasing plan's skip-and-flag guards stay as a second line of defence.
- The purchasing-plan reservations smoke now proves each of its impossible-value cases is refused once the constraints exist (and keeps the old cases where they do not).
- Proof: `node scripts/smoke/prove-refuse-impossible-quantities-and-dates-real-schema.mjs`.
