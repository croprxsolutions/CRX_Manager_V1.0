# Behavior contract: job completion creates a missing stock row the way a delivery does

Read at `origin/staging` `66df4a9c1`. Live database was not readable from this session (Supabase refused the read). The function body pinned below is the one in `supabase/migrations/20270126110000_inventory_cleanup_ki161_163_150.sql`, which is the newest definition on this branch.

## Outcome

When two field jobs finish at the same time and both use a product that has never had a Main Warehouse stock row, both finish. Stock ends at the sum of what the two jobs used. One job no longer fails and has to be retried.

The smallest change is the one delivery completion already uses (`_complete_delivery_authorized_impl` in `20270203120000_inventory_edge_cases_1942.sql`). Job completion already locks existing rows in product order, in `_lock_job_stock_rows_in_order`, after the hold sync and before the deduction. This change adds the missing-row step to that same function: take the application-record number lock first (the same lock a blend ticket takes before its stock row; taking it again later in the same completion does not wait), then create each missing row in product order, ignore a row the other job just created, and lock it. The deduction in `_complete_job_replay_impl_20261015` is not rewritten. It finds the row and subtracts, which is what it already does when the row exists.

No new table, queue, or screen. Who may complete a job is unchanged. The screen still sends the job id, the applied-info note, and the idempotency key. The database still decides the actor, the chemicals, and the quantities.

## State and failure

- One job, no stock row: the row is created and the on-hand is minus what the job used. The delivery-only "made at delivery" flag stays off. One `job_applied` ledger row. A customer-supplied chemical still creates nothing.
- One job, row already there: on-hand goes down by what the job used. No second row.
- Two jobs, same new product, or two new products in opposite chemical order: both complete. One row per product. On-hand is minus both jobs. A retry of a finished job with the same key returns the saved result and does not deduct again.
- A job that is not in progress is still refused, and creates no row.
- The whole completion is one database transaction. If it fails, the new row is not left behind.
- Old rows are untouched. The app already deployed keeps calling `complete_job` the same way.

## Delivery

Database only. The screen does not change. Rollback restores the previous lock function (existing rows only). The deduction loop then inserts a missing row itself again, which is today's failure.

## Proof

- When two sessions insert a missing stock row the way the job body does, in opposite order, one fails (deadlock). Two job completions today both finish, because the application-record number is taken before that insert, and the on-hand is minus both jobs. After this change both jobs still finish with that same on-hand, and the creation itself waits in product order, including against a writer that already holds another stock row. Proof: `node scripts/smoke/prove-job-completion-missing-stock-rows-real-schema.mjs` on a local database, invented rows, rolled back or committed only inside that disposable database.
- When one job uses a product that already has stock, and a customer-supplied chemical, then only the stocked product moves, by that job's quantity.
- When the same completion key is sent again, on-hand does not move a second time.
- When the rollback runs, the old function body is back and two overlapping completions fail again.

## Open business decisions

None. This is the delivery rule Mason already accepted for the same collision, applied to job completion. The 2026-11-18 note that accepted the missing-row deadlock as a non-issue was for stopping further patches on #1940. Deliveries were fixed after that (#2045). This task asks for the same fix on jobs. Rush-order stock rows (#2121) are out of scope.

## Cold challenge

Not run. This session has no Codex CLI, so the Astra challenge in `plan-contract` could not start. The design is the delivery function's lock-then-create sequence, not a new mechanism.
