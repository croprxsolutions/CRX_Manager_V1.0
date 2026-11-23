## 2026-11-21 - A job and a blend ticket finishing together no longer deadlock

- New migration `20270226120000_job_completion_missing_stock_rows.sql`. Not applied anywhere. Staging applies it after the merge.
- When a field job finishes while a blend ticket's application record is being created for the same products, PostgreSQL no longer cancels one with "deadlock detected". The job now takes the application-record number lock before any stock row (including a quote-linked job's hold update), the same order the blend ticket uses, and creates a missing warehouse stock row (at 0) in product order. Only a real job completion creates that row; a direct status change by an admin creates none, as today. Two jobs finishing together already both finished, because that number lock lines them up, and they still do. Each product gets one stock row, and stock ends at the sum of what both used.
- One job on its own still deducts the same amount, including a product with no stock row yet, and a customer-supplied chemical still does not touch stock.
- Proof: `node scripts/smoke/prove-job-completion-missing-stock-rows-real-schema.mjs`.
- Rollback: `scripts/smoke/job-completion-missing-stock-rows-reverse.sql`.
