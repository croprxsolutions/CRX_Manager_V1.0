## 2026-11-21 - Two jobs finishing together can both create a first stock row

- New migration `20270220120000_job_completion_missing_stock_rows.sql`. Not applied anywhere. Staging applies it after the merge.
- When two field jobs finish at the same moment and both use a product that has never had a stock row at the warehouse, one job no longer fails and asks to be retried. Both finish, and the stock ends at the sum of what the two jobs used. This is the same wait-your-turn rule deliveries already got.
- One job on its own still deducts the same amount, including a product with no stock row yet, and a customer-supplied chemical still does not touch stock.
- Proof: `node scripts/smoke/prove-job-completion-missing-stock-rows-real-schema.mjs`.
- Rollback: `scripts/smoke/job-completion-missing-stock-rows-reverse.sql`.
