**LOCAL CANDIDATE, not applied.** `20261105130000_month_end_deliveries_skip_cancelled.sql` (LF SQL sha256: `9ce525a161304b3fd2b70c90e356bac59df2107419d20a6d6915a7d3b57a80ea`). To-do 3.9.

What it does:
- `get_monthly_summary(date, date)`: `deliveries.count` now leaves out `cancelled` and `voided` deliveries (status values from `.claude/schema-registry.json`), so a month whose only unfinished deliveries were cancelled or voided shows "Deliveries completed" as done on Month-End Close. `completed_count` and every other key are unchanged.
- Signature, SECURITY DEFINER, VOLATILE, `search_path = public, pg_temp`, owner `postgres`, the `require_admin()` gate and the ACL (authenticated and service_role EXECUTE, no anon/PUBLIC) are unchanged. There are no GRANT/REVOKE lines: CREATE OR REPLACE keeps the ACL, and the postflight asserts it.
- Preflight pins the live body from `20260827041000` (sha256 `c90c1037…8330`, read live 2026-11-03); postflight pins the new body (`079f77c1…6c10`). Read-only report function, writes no rows.

Rollback: re-run the `get_monthly_summary` CREATE OR REPLACE block from `20260827041000_align_recognized_invoice_report_statuses.sql` in a new migration.

Proof: `node scripts/smoke/prove-month-end-deliveries-real-schema.mjs` prints `MONTH_END_DELIVERIES_PROOF_PASS`. Live smoke chain: `issue_return_credit` (container-only, `scripts/smoke/verify-return-credit-real-schema.mjs`), which reads this function's invoice keys.

Live ledger preflight, read 2026-11-03 with read-only `execute_sql`: effective high-water `20261105090000` (`20261105090000_vendor_only_product_links`, ledger version `20261103204943`); open PR stamps `20261105100000` (#1385) and `20261104160000` (#1362); unmerged local stamps up to `20261105120000`. Read the ledger again at apply time.

After the apply: the `cost-exposure-review` allowlist key `get_monthly_summary(p_period_start date, p_period_end date)#4d5de755b0e0` (`scripts/db-invariant-sweeps/allowlist.json`) hashes this body, so re-read it live and re-key it with `rekey-allowlist.mjs` in a follow-up, as for #1383. Not changed here: `close_accounting_period` still stores `deliveries_count` as every non-deleted delivery in its period snapshot.
