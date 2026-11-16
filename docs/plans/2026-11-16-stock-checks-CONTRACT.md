# Stock checks (repair step 5, part 1): behavior contract

Read at `origin/staging` 0f79a2355 and live (read-only) on 2026-11-16. Covers KI-139, KI-141, KI-162. C-13 is a
business decision (end of file) and is not built here.

## 1. Outcome and authority

- **KI-139.** "Reconcile negative inventory" only fixes a row whose on-hand is below zero. A row at 0 or above is
  refused, so the tool can no longer overwrite good stock with a number nobody counted.
- **KI-141.** Retiring an inventory row is refused while it still has stock on order on an open purchase order.
  Today the delete runs, the on-order total puts back a zero row, and the PO points at retired stock.
- **KI-162.** The Receiving Log's From/To date filter uses the Central (America/Chicago) business day, not UTC:
  `received_at >= From 00:00 Chicago` and `< (To + 1 day) 00:00 Chicago` on the `timestamptz` column (index kept). Today a
  receipt after about 6-7 PM Central files under the next day.

Smallest change: one migration, `20270113100000_stock_checks_negative_onorder_chicago.sql`, that runs
`CREATE OR REPLACE` on three existing functions with one added check or one changed expression each. There are no
new tables, columns, grants, flags or screens. Files touched: the migration, its real-schema prover
`scripts/smoke/prove-stock-checks-real-schema.mjs`, `scripts/db-invariant-sweeps/allowlist.json` (get_receiving_log
re-key), a ledger record, and `docs/manual/KNOWN_ISSUES.md`.

Who may act is unchanged. Retire and reconcile stay admin-only (`is_admin()` inside the impl; the public
wrappers from `20261016140000` are not touched). The Receiving Log stays admin or sales rep. All three are
`SECURITY DEFINER` with `search_path = public, pg_temp`, and that is kept. The only value the screen sends that the
new checks use is the inventory row id, which is just a locator: the server reads on-hand and on-order itself
under `FOR UPDATE`.

## 2. State and failure

- **Rules that always hold:**
  - Reconcile changes a row only if its locked `quantity_available` is below 0.
  - Retire deletes a row only if its locked `quantity_on_order` is 0 (or null).
  - Each check runs after the impl's own idempotency check and row lock, inside the one transaction, so a refusal
    writes nothing (no ledger row, no idempotency record).
- **Existing rows (live 2026-11-16):**
  - 19 rows are negative and stay reconcilable. 98 rows are 0 or above, and reconcile now refuses them; the
    cleanup panel already lists only negative rows.
  - 18 rows have `quantity_on_order > 0`, and every one has an open (submitted or partially received) PO for its
    product (query: `on_order_without_open_po = 0`). So the retire refusal matches real open orders today.
  - No stored data changes.
- **Timing:**
  - Same-key retry after a success: the impl's `check_idempotency` returns the first answer before the new check,
    so the retry still returns the original success. This is wanted: the action already happened.
  - Two admins at once: the second waits on `FOR UPDATE`, then re-reads the row. A reconcile that made the row
    non-negative makes the second reconcile refuse.
  - On-order is set by `_recompute_po_on_order_for_products` (global advisory lock `73492009`, then the
    `Main Warehouse` row) and lowered by receiving under the row lock; the old submit trigger function is attached
    to no trigger (live, 2026-11-16). A recompute part-way through (after its insert, before its update) could lose
    its update to a retire's delete, leaving an open PO with no row. So retire, holding the row lock, *tries* the
    advisory lock and refuses ("a purchase order is being saved, try again") if it is taken. It never waits, so it
    cannot deadlock with a recompute that waits for the row. While retire holds it, a new recompute waits until the
    retire commits and then inserts a fresh row, which is correct for a PO saved after the retire. Retire also takes
    the row itself with `FOR UPDATE NOWAIT` and refuses ("this stock is being changed by someone else, try again")
    if another session holds it, so retire never waits on any lock.
  - Screen: the refusal is a plain P0001 message, which `sanitizeError` passes through as a toast. This is a
    definitive rejection, so the screen's uncertain-retry guard clears.
- **Undo and history:** unchanged. A refusal leaves no trace; a success logs exactly what it logs today.
- **Rollout:** the deployed app needs no change. Screens that already only offer negative rows keep working.
  Retire now shows a refusal toast where it used to succeed silently.

- **Reconcile input:** `NaN` and `Infinity` are refused (`NaN < 0` is false in PostgreSQL, so today they pass).

## 3. Delivery

Database-only PR into `staging`, with no screen changes. Sol is required (inventory and database). The
preflight pins the three live bodies (md5 below) and refuses a second apply. The postflight checks the new
bodies plus unchanged owner, ACL, config, security mode, return type, volatility and arguments.

| Function | Live md5 (2026-11-16) |
|---|---|
| `_reconcile_negative_inventory_replay_impl_20261015(uuid,numeric,text,uuid,text)` | `f74d57e251dba616fa18376f6c65955a` |
| `_retire_inventory_item_replay_impl_20261015(uuid,uuid,text)` | `e3a007fd59454bcc53c879c391ae6c3c` |
| `get_receiving_log(integer,integer,text,text,uuid,date,date)` | `e9ca68d79929a513433eb6359a44268c` |

Recovery: re-emit the three prior bodies (from this file's preflight sources: `20261016140000` and
`20261113110000`) in a new migration.

## 4. Proof cases

All run in the real-schema prover (local Docker, network off, test data only), as the real caller through the
public wrappers.

1. When an admin reconciles a row at -10 to 0, the row becomes 0 and a RECONCILIATION ledger row is written.
2. When an admin reconciles a row at 0 or at +5, the call is refused, and the row and ledger are unchanged.
3. When the same key is retried after case 1, it returns the first result, even though the row is now 0.
4. When an admin retires a row with on-order 0 (no holds or prebooked stock), the row is deleted, as today.
5. When an admin retires a row with on-order 4, the call is refused with the on-order message and the row stays.
6. When a non-admin calls reconcile or retire, it is still refused.
7. When retire runs while another session holds the on-order lock, it is refused with the try-again message and
   nothing changes; once that session commits, the same call succeeds (or is refused for on-order).
7b. When retire runs while another session holds the row itself, it is refused at once with the try-again message
   and nothing changes; afterwards the same call succeeds.
8. When reconcile is sent `NaN` or `Infinity`, it is refused.
9. When a receipt is saved at 2026-11-02 01:30 UTC (Nov 1, 7:30 PM Central), filtering From/To = Nov 1 includes it
   and Nov 2 excludes it.
10. A second apply is refused by the preflight. Owner and grants are unchanged (postflight).

## Challenge (Astra, gpt-6-astra high, 2026-11-16): 65 findings, settled

- **Fixed:** deadlock in the first lock design (1-4, 63): retire now only tries the lock. Non-finite reconcile input
  (20). Index-friendly Chicago bounds (64).
- **Disproved with live read-only evidence (2026-11-16):**
  - The on-order cache equals the exact open-PO remainder for every Main Warehouse row, in both directions: 0
    mismatches, 0 open POs without a row, 0 non-Main rows with on-order, 0 nulls. The column is NOT NULL DEFAULT 0
    (7, 8, 10, 11, 12).
  - Only one location exists (13).
  - The writers are the recompute and receiving (9, 15).
  - `received_at` is `timestamptz NOT NULL` (37, 41, 43).
- **Out of scope:**
  - Existing behavior this change does not touch: retire deleting stock, undo, other write paths, the pagination
    comment, the vendor list, joins (14, 16-18, 25, 44-46).
  - Stale-target reconciles (21-24, 34): the brief settles "refuse rows not below zero". A count-backed reconcile
    is the KI-139 alternative and stays open in KNOWN_ISSUES.
  - Refusals leave no audit row (36), as every other refusal does today.
- **Covered by proof cases** (49-55): the prover runs the real wrappers as the real caller, with two sessions for the
  lock case. Rollback = re-emit the prior bodies (59).
- **Not changed:** the screens. A refusal is a P0001 RAISE, which `sanitizeError` passes through, so the user sees
  the message (32).

**Targeted re-check (Astra, lock mechanism, round 2): 1 HIGH, fixed.** Two retires in one transaction: the first
keeps the advisory lock, the second waits for a row that receiving holds while receiving waits for the advisory
lock. No caller does this today (the app retires one row per request, and no database function calls retire), but
the row lock is now `NOWAIT`, so retire never waits on anything and the cycle cannot form (proof case 7b). No
further challenge round on this mechanism.

## Open business decisions

**C-13 (not built here).** `adjust_inventory` refuses any result below zero, so a row at -10 cannot be partly fixed
with +5; it must jump to 0 or above.
- Options:
  - (a) Allow an adjustment that moves a negative row toward zero without going further negative (+5 on -10
    gives -5).
  - (b) Keep it as it is.
- Consequence: (a) lets staff record a real partial delivery against a shortage; (b) forces a guessed jump to 0.
- **Recommendation: (a).** Waiting on Mason.
