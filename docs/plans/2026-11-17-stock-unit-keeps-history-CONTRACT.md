# Behavior contract: once a product has history, its stock unit is fixed (2026-11-17)

Follow-up to the units batch (`docs/plans/2026-11-15-product-master-steps-1-3-CONTRACT.md`, #1896, migration
`20270121110000`). Sol (gpt-6-sol high, on #1879's head) HIGH at `20270121110000_line_unit_is_stock_unit.sql:248`. Read at
`origin/staging` 86942997c.

## Facts

- `a1_product_unit_keeps_open_lines` refuses a stock-unit change while a PO/order/delivery line is OPEN in another unit
  or any stock row holds a quantity (`20270121110000:228-301`). It ignores everything closed.
- `_receive_return_impl_20260714` (live body `20260827041100:449-610`) restocks an approved return line only when the
  stock row's unit equals (lowered) the source unit: the order line's `COALESCE(unit_size,'ea')`, or the return line's
  own `unit` with no order line; else `RETURN_CREDIT_INVENTORY_UNIT_MISMATCH` (line 589). After a change the stock row is
  relabelled to the new unit, so a pending return in the old unit is stuck.
- `_section9_reverse_receiving_record_serialized` (`20260831160000`) subtracts the receipt's quantity and lowers the PO
  line in any PO status, closed included (`20270103180000` item 3). `a1_line_unit_is_stock_unit` re-checks that line
  (`LINE_UNIT_NOT_STOCK_UNIT`), or fills a blank line with the new unit while the old quantity is subtracted.
- `void_delivery` restores stock from a completed delivery, and a new return can be raised from any delivered order
  line: both read old quantities.
- The product setup guard (`guard_product_setup_fields`, `20261102102000`, prover case 2b: "can't change on a saved
  product yet") refuses any stock-unit change on a saved product. Screens cannot change a stock unit today.
- Data corrections disable the guards they must pass, then re-enable them (`20270121100000`; prover M1 checks both are
  back on).

## Outcome and rule

One more BEFORE UPDATE trigger on `products`, `a2_product_unit_keeps_history` (`_refuse_stock_unit_change_with_history`,
SECURITY DEFINER, `search_path = public, pg_temp`, no grants). When the stock unit changes other than in case or outer
spaces, it refuses `PRODUCT_UNIT_HAS_HISTORY` if the product has ANY order, delivery, purchase-order or return line,
receiving record, stock transaction (jobs, blend tickets, adjustments, counts) or active hold, whatever its status or unit
(blank included). The decision is `EXISTS`; the message names up to 5
records (number, else id). A product sold, bought, delivered or returned in one unit keeps it; another unit is a new
product. This is the screens' existing rule, now also holding for a data correction unless that correction disables it
explicitly (and then owns relabelling or converting the history, a reviewed business decision of its own).

Not a new business decision: it equals what the setup guard already enforces for every user, and matches Mason's strict
choice for stock (2026-11-16). Files: the new migration, `scripts/smoke/stock-unit-history-guard-reverse.sql`, the
units-batch prover, `src/lib/errorSanitizer.ts` (+ test), ledger and migration record.

## State, timing, rollout

- No data changes; old rows are only read (indexed by product: `idx_recv_records_product`; the line tables' product
  indexes). Unit changes are rare, admin-only and in reviewed migrations.
- Concurrency: order, delivery and PO line inserts read the product FOR SHARE (a1 line trigger), and a second new
  trigger, `a2_return_line_locks_product`, does the same for return lines. A unit change waits for an uncommitted line
  and then sees it; a line written after the change waits and then meets the new unit. Stock transactions move stock
  rows, which a1 already locks.
- Rollout: the deployed app cannot change a stock unit, so nothing on screen changes.

## Proof cases (units-batch prover, real migrated schema in Docker)

- H0 before: with history in Gal, Gal -> Qt saves; then an approved Gal return refuses receipt
  (`RETURN_CREDIT_INVENTORY_UNIT_MISMATCH`) and undoing a received Gal PO line refuses (`LINE_UNIT_NOT_STOCK_UNIT`).
  Without the change the return restocks 2 Gal.
- H1 after: Gal -> Qt is refused, naming the record, for a requested, approved, restocked, received or Qt return; a
  received PO line; a receipt alone (names its PO); a stock movement alone; an active hold; a fulfilled order line in Gal or blank; a completed delivery line in Gal or blank. With no history (an ended hold does not count) it
  saves and relabels the empty stock row; "GAL" (case only) saves over history; open lines still report
  `PRODUCT_UNIT_HAS_OPEN_LINES` first; while another session holds an uncommitted return line the change waits (lock
  timeout), and without it does not; both functions are private; a second apply refuses.
- R: the reverse script drops both triggers and functions; the units-batch reverses still pass after it.

## Challenge (Astra, gpt-6-astra high, 2026-11-17, 25 findings) and how each settled

The first draft refused only history in a different non-blank unit and pending returns. Corrected after the challenge:
blank-unit history slipped through (#1), "relabel history first" fought the line guard (#2), normalisation differed from
receive_return (#8), Unit/Ea aliases (#10), NULL labels could hide a refusal (#16), receiving records unscanned (#12),
a weak preflight (#20). The "any history" rule (#25, Astra's smaller design) settles all of them and #4, #9, #11 (a
correction disables the guard and owns its own conversion decision, #3). #5/#18 (return race): narrowed to a product with
no other history, accepted above. #6/#7 (return paths and admin override reopening a return): moot, any return line
blocks regardless of status. #13 (existing mismatched history): unchanged by this guard, which only reads. #14: setup
guard proven by prover case 2b. #15: owner bypasses RLS so nothing is hidden; only admins (product writers) see the
numbers. #17: sanitizer keeps the sentence (unit test). #19 deadlocks: unchanged lock order from a1. #21: migrations
apply in one transaction. #22-#23: reverse script and prover output are in the PR. #24: EXISTS on indexed columns.

## Reviews after the build (2026-11-17)

- Luna (gpt-6-luna xhigh) MED: return lines were not serialized -> fixed with `a2_return_line_locks_product` and a
  two-session lock case. LOW: a receipt alone was not named -> its PO is now named.
- rls-security-reviewer MED: stock transactions and holds were not history -> added (every stock movement writes a
  transaction). LOWs: tab/NBSP and first-unit-on-a-blank-product refuse (fail closed, 0 such products live); wording.
- migration-drift-reviewer: no drift; live order is re-checked by the staging apply job.

## Open business decisions

None.
