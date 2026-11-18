# Behavior contract: inventory clean-up (KI-161, KI-163, KI-150), To-Do 0.17 part 5

Read at `origin/staging` 7fd51366/a08a8c70 plus #1896 head `7c10fa32` (`claude/pm-units-batch`); live checks read-only, 2026-11-17.
Builds on #1896 (delivery, order and PO lines in the stock unit). One PR to `staging`, one new migration.

## 1. Outcome and authority

### KI-161: a delivery line always matches its order line
- **Result.** Every delivery line names an order line on the delivery's own order, for that line's product and unit, and an
  order line appears at most once per delivery. Enforced by the database for every writer, not just the edit screen.
- **Smallest change.** One BEFORE trigger on `delivery_items` (INSERT, and UPDATE OF `order_item_id`, `product_id`,
  `unit_size`, `delivery_id`), named to sort after #1896's `a1_line_unit_is_stock_unit`:
  - the order line must exist and belong to the delivery's order (`DELIVERY_LINE_NOT_ON_ORDER`);
  - a missing or different product is refused (`DELIVERY_LINE_PRODUCT_MISMATCH`); not filled, because #1896's stock-unit
    trigger has already run and skips a line with no product (Astra 1);
  - the unit must match the order line's unit (`_unit_matches_stock_unit` from #1896; `DELIVERY_LINE_UNIT_MISMATCH`);
  - a second line for the same order line on the same delivery is refused (`DELIVERY_LINE_DUPLICATE`), backed by a
    unique index on `(delivery_id, order_item_id)` for two writers at once;
  - it holds the delivery `FOR SHARE` and the order line `FOR UPDATE` (Taha, #1940: follow-ups queue), so the existing order-line product guard
    (`guard_order_item_delivery_lineage`) and this check cannot pass each other in a race.
  - `order_item_id` must be set (live: 0 lines without one; every creating RPC sets it; the column is NOT NULL).
- **Parent side (Astra 4).** A second BEFORE UPDATE OF `order_id` trigger on `deliveries` refuses moving a delivery
  that has lines to another order (`DELIVERY_ORDER_LOCKED`). No writer does this; signed-in users could (live:
  `authenticated` may update `deliveries.order_id`). The order-line side is already guarded live by
  `guard_order_item_delivery_lineage` (order or product change with delivery lines) and #1896 (unit = stock unit).
- **Direct writes.** Revoke INSERT, UPDATE, DELETE on `delivery_items` from `authenticated` (table and every column).
  Facts (live 2026-11-17): the screens never write `delivery_items` directly (grep of `src/`); all six functions that
  write it are `SECURITY DEFINER` and keep working. Reads are unchanged.
- **Who may act:** unchanged (the RPCs' role checks). `edit_delivery` is not re-emitted; it now gets the trigger's
  refusals, which reach the screen through `errorSanitizer`.

### KI-150: no deadlock between two stock-moving completions
- **Receipt reversal vs vendor bill (the KI headline): no change; closed with evidence.** Live source, 2026-11-17:
  `create_vendor_bill`, `update_vendor_bill`, `_section9_create_vendor_bill_intent_impl_20260826` and the vendor-bill
  triggers lock the vendor/bill and the PO, read PO lines without a lock, never update `purchase_orders` or its lines,
  and never take advisory lock 73492009. So a reversal (PO line, then PO) only waits for a bill; no cycle exists.
  Flipping the reversal to PO-first would create a real inversion with `apply_product_cost_basis_change_set`
  (vendor, PO line, PO; no 73492009).
- **Delivery and job completion (C-12): fix.** Today each locks the Main Warehouse stock row of each line in line
  order, so two completions sharing two products in opposite order can deadlock.
  - **Delivery:** rename `_complete_delivery_authorized_impl` (body untouched, md5-pinned) and put a thin wrapper of
    the same name, signature and defaults in front: lock the delivery, then its products' Main Warehouse stock rows in
    product order (then row id), the order the quote-linked job hold sync `_sync_quote_job_reservations` already
    uses (Sol r1: row-id order could disagree with it), then call the original. Its only caller is `_complete_delivery_aggregate_impl`, after the
    role and idempotency checks, and it calls by name, so every completion goes through the wrapper.
  - **Job (changed during the build; Astra 22/23 agree):** the job body updates the job's status, which runs the hold
    sync (`trg_release_job_holds_on_lifecycle` -> `_sync_job_holds`) before its stock loop, so a wrapper in front
    would move stock locks ahead of the hold sync. Instead an AFTER UPDATE OF status trigger `trg_zz_lock_job_stock_rows`
    (sorts after the hold sync's trigger) locks the job's chemicals' stock rows (quantity > 0, not customer-supplied)
    in that same product order, right after the hold sync and before the body's stock loop. The hold sync's own order is unchanged.
  - **Guarantee, stated narrowly:** completion vs completion over stock rows that exist. A product with no Main
    Warehouse row is created by the body as today (live: 0 such products on open deliveries; Astra 25-27 kept as a
    known limit). Other writers' lock orders (order edits, cancels, receipts) are unchanged (Astra 35).

### KI-163: stock-history gaps
1. **Quick-delivery cancel** logs the amount it really released: `LEAST(release, prebooked before)`, not the full
   amount, and skips the row when nothing was released. Re-emit `_cancel_delivery_replay_impl_20261015` with that one
   change.
2. **Count rounding.** Widen `cycle_count_items.expected_qty`, `counted_qty`, `variance` from numeric(10,2) to
   numeric(14,4) and round to 4 places in `update_cycle_count_item`, so completing a count lands exactly on the
   counted figure. It also refuses a not-a-number or infinite count (`CYCLE_COUNT_QTY_INVALID`; Luna r3), which
   would otherwise reach on-hand at Complete. Live: 1 stock row has more than 2 decimals; no view depends on the table; values convert exactly.
3. **Return / application-reversal rows linked only by note text: deferred.** It needs a new link column on
   `inventory_transactions` and its readers; low value, no figure is wrong. Stays open in KI-163.
4. **One PO header 1 cent off its lines: not a defect; closed with evidence, no change.** Live 2026-11-17: the one
   fully received PO's header (stored in cents) equals the sum of its 39 line totals each rounded to whole cents; only
   the unrounded sum is 1 cent lower. Whole cents per line is the house money rule, so the header is right. It has no
   vendor bill, and the bill cap uses the larger figure. No business decision is needed.

## 2. State and failure
- **Always true after the migration:** every delivery line matches its order line (checked with `deliveries` and
  `delivery_items` locked, before the triggers go in: 0 mismatches, 0 duplicates, 0 lines without an order line, and
  every open line in its order line's unit; live today all 0); `authenticated` has no write privilege on
  `delivery_items`.
- **Existing rows:** delivery lines are only checked when inserted or when those columns change, so completion (which
  writes `quantity_delivered`) and history are untouched. Count rows widen in place. Old `released` rows stay as written.
- **Timing:** two edits of one delivery are serialized by the delivery row lock (unchanged); two inserts of the same
  order line hit the unique index. Two completions sharing products now lock stock in the same order, so one waits.
  Retries keep their idempotency receipts (the public wrappers are unchanged).
- **Rollout:** the deployed app sends consistent lines, so nothing it does is refused.
- **Undo:** none needed; rollback script drops the trigger, index and wrappers (renames back), restores the grants,
  the old cancel and count bodies (column widening stays; harmless).

## 3. Delivery
One DB-only PR to `staging` (no screen depends on it) plus error messages in `src/lib/errorSanitizer.ts`.
Cut after #1896 merges; stamp above everything on staging (claim in the shared stamp-claim note).

## 4. Proof cases (real-schema prover in Docker, test data)
- When `edit_delivery` sends a line whose product differs from its order line, then it is refused, nothing changes.
- When it sends an order line from another order, then refused.
- When it sends the same order line twice, then refused (and a concurrent duplicate insert hits the unique index).
- When any writer sends a line with no product, then refused; when a delivery with lines is moved to another order,
  then refused.
- When a normal edit and a completion run, then they still succeed (the other creators are SECURITY DEFINER functions
  owned by `postgres` (live), so the revoke cannot reach them, and they insert lines from their own order's lines).
- When an `authenticated` admin inserts/updates/deletes `delivery_items` directly, then permission denied; select works.
- When two completions sharing two products in opposite line order run at once, then both finish (one waits), no
  deadlock (and the same pair deadlocks before the migration); a completing job holds the lower-id stock row while
  it waits for the other.
- When a quick delivery is cancelled with prebooked lower than the release, then the `released` row equals what
  `quantity_prebooked` actually dropped.
- When a 4-decimal stock row (12.3456) is counted at 12.35 and the count completes, then on-hand is 12.35 exactly.
- Rollback script restores the old state and the prover passes it.

## Cold challenge (Astra, gpt-6-astra high, 2026-11-17): settled
65 findings. Changed the build: 1 (no product fill; refuse a missing product), 4 (delivery cannot move order once it
has lines; delivery read FOR SHARE), 9 (screen also maps the unique index's error), 22/23 (job lock by AFTER trigger,
not a wrapper). Already covered by the build: 7 (both columns NOT NULL; FKs live), 17 (postflight checks effective
table and column privileges incl. PUBLIC), 19/33 (all new and renamed functions SECURITY DEFINER, search_path set,
no execute for signed-in users, postflight-checked; wrapper keeps the signature and defaults), 31/32 (wrapper sits
behind the role and idempotency checks; sole caller resolves by name), 40/41 (release read under the stock row lock;
prebooked has a >= 0 check live, 0 negative rows), 43 (the note uses the clamped amount), 46/49 (complete adds the
stored variance to current on-hand, 20270103170000; 0 open counts live), 48 (0 stock rows beyond 4 decimals live),
58/65 (md5 preflight pins; the rollback refuses unless the three bodies come back exactly), 59/60 (one transaction,
delivery_items locked SHARE ROW EXCLUSIVE before the lineage check, lock_timeout 5s), 56/57 (PO header: not a defect).
Disproved or out of scope: 2 (a blank order-line unit means the stock unit; #1896 fills it), 3/11/12/13/14/16/36
(existing `edit_delivery`/completion behaviors not changed here; 13 and 36 listed as follow-ups), 15 (totes and brand
picks live in the picks table, not extra delivery lines; 0 duplicates live), 25-27 (rows that do not exist yet: known
limit, 0 live), 35/37-39 (other writers' lock orders unchanged; vendor-bill side read from live source, KI-150 part 1),
44/45 (old released rows stay as written; the KI says so), 50 (KI-134 settled: completion adds the variance to current
stock), 51 (screen uses the server's expected figure), 61/62 (old sessions finish before the migration's locks; the
error messages ship in the same PR).

## Reviews during the build (Luna r1-r4, Sol r1)
Fixed: TRUNCATE revoked too; the lineage check runs with `deliveries` locked; an open line in another unit refuses
the migration; a not-a-number count is refused; stock locks follow product order, as the quote-linked hold sync does
(the prover now seeds row ids opposite to product ids, and replays 20261217100000's current job completion body).
Kept as stated limits: a stock row that does not exist yet (0 live); a count against on-hand with more than 4
decimals (0 live); completed or cancelled delivery lines are history and are not re-checked for unit; the existing
`app.admin_override` escape in `guard_order_item_delivery_lineage` is unchanged (follow-up).

## Open business decisions
None. (The PO 1-cent question was answered by the data: see KI-163 item 4.)
