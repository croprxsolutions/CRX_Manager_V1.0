# Behavior contract: the database refuses impossible quantities and dates (#2237)

Read at `origin/staging` 42039d705 (2026-11-23).

## 1. Outcome and authority

- **Outcome.** A quantity that is not a real number (NaN, plus or minus infinity) or a job/delivery date outside 2000-01-01 to 2099-12-31 can no longer be stored in the field, stock and order tables the purchasing plan reads. The plan's skip-and-flag guards (#1989) stay as a second line of defence.
- **Range rule.** 2000-01-01 to 2099-12-31 is the window Mason already set for the purchasing plan (DECISION_LOG 2026-11-22); reused, not new.
- **Smallest change.** One migration adding CHECK constraints, in the same `x > '-Infinity' AND x < 'Infinity'` form the money columns already use (NaN sorts above Infinity in PostgreSQL, so `< 'Infinity'` also refuses NaN):
  - `job_chemicals.quantity`
  - `jobs.job_date` (date window)
  - `inventory.quantity_available`, `quantity_prebooked`, `quantity_on_order`
  - `order_items.quantity_remaining`, `total_units_needed`, `quantity_delivered`
  - `deliveries.scheduled_date` (date window)
  - `delivery_items.quantity`, `quantity_delivered` (NULL still allowed)
- **Out of scope (Taha's lanes until 2026-12-15).** `quote_items`, `quote_sections`, `quote_product_draws`, `job_product_draws`, `inventory_holds`, `purchase_orders`, `purchase_order_items`. Production has 0 bad values in each (read-only check 2026-11-23); left for Taha, noted on the issue.
- **Who may act.** Unchanged. A CHECK binds every writer (browser, RPC, `SECURITY DEFINER`, replica mode).

## 2. State and failure

- **Existing rows.** None change. Production read-only check 2026-11-23: 0 rows break any of these rules. The migration counts breakers first and refuses to apply (naming table, column and count) if any exist, so nothing is fixed silently; fixing them would need Mason.
- **New writes.** A write with such a value fails with a check violation (`23514`) and the whole transaction rolls back. No screen can produce these values today (inputs parse to finite numbers; existing RPC guards refuse NaN/infinity on stock moves), so no user-visible change is expected.
- **Existing guards keep their messages.** The F05 order-line trigger (`ORDER_LINE_QUANTITY_NOT_FINITE`) runs before the CHECK and still raises first; RPC input guards still refuse first.
- **Timing.** `ADD CONSTRAINT` scans each table once under a brief exclusive lock; `lock_timeout` 5s so a busy table makes the apply fail cleanly rather than queue the app.
- **Undo.** Rollback script drops exactly these constraints.

## 3. Delivery

Database only, one migration, compatible with the deployed app. Test fixtures that deliberately stored NaN/infinity in these tables to exercise the plan's second line of defence are updated: they lift the constraint inside their own rolled-back transaction and also prove the database now refuses the value.

## 4. Proof cases (real migrated database, Docker; never live)

1. When the migration is applied, each listed column refuses NaN, +Infinity and -Infinity (dates: before 2000-01-01, after 2099-12-31, `infinity`, `-infinity`) from a privileged writer and in replica mode; ordinary finite values and the window edges are accepted; `delivery_items.quantity_delivered` NULL is accepted.
2. When a breaking row already exists, the migration refuses to apply and names it; nothing changes.
3. When run outside one transaction, or a second time, the migration refuses.
4. The purchasing-plan smoke and the affected provers still pass.
5. Rollback removes exactly these constraints.

## Open business decisions

None (the date window is Mason's 2026-11-22 rule; Taha's tables are left to Taha).

## Status: BUILT (2026-11-23 overnight), not ready to merge

- Mason answered the date question 2026-11-23: "Yes, refuse them" (job and delivery dates outside 2000-2099 are refused everywhere).
- Astra cold challenge (gpt-6.2-astra high): 19 findings; taken into the migration: lock all six tables up front in the order completions take them, so the count and the constraints see the same rows and no live completion deadlocks. Unconstrained `numeric` on every target column confirmed (no `22003` path).
- `scripts/smoke/smoke-purchasing-plan-reservations.sql` cases C21, C21D, C22B, C22C, C23A, C23D, C24A and C24B now assert the table refuses the value when the constraints exist (inline blocks; the old cases still run where they do not). Note: on current staging (without this migration) that smoke already fails at C23D, because `20270224100000_f05_order_line_quantity_guard` refuses its second delivery of the same 10; with this migration C23D makes only the good delivery, so the smoke passes again.
- Out of scope until Taha's lanes reopen (2026-12-15): quote_items, quote_sections, quote_product_draws, job_product_draws, inventory_holds, purchase_orders, purchase_order_items (all 0 bad values on production 2026-11-23).
