## 2026-11-02 — Receiving accepts only Main Warehouse until transfers exist (KI-85 Part A)

Receiving could put stock at Secondary, Cold or Field Storage, but every outbound path ships from Main Warehouse
only and no transfer exists, so that stock would be stranded. Now:

- The Purchase Order receive modal, Quick Receive and the Inventory page's Add Inventory form list active
  `warehouses` rows (today only Main Warehouse) instead of a hard-coded list or free text
  (`src/hooks/useActiveWarehouses.ts`).
- Migration `20261102220000_receive_po_items_active_warehouse_only` makes `receive_po_items` and
  `manual_inventory_add` refuse any location but an active Main Warehouse with `UNKNOWN_STORAGE_LOCATION` instead of
  storing it, even if another `warehouses` row is activated, because stock elsewhere cannot ship until a transfer
  function exists (DECISION_LOG 2026-11-02); the migration that adds transfers must lift this guard. A missing
  location still means Main Warehouse. The check runs after the replay lookup, so a request that already committed
  still replays its saved answer and neither fingerprint changes. Grants are untouched (CREATE OR REPLACE keeps the
  ACL; the postcondition re-checks it). `receive_po_items`' actor-mismatch text gains the canonical `ACTOR_MISMATCH:`
  prefix; offline sync recognises both forms.
- Receipts print what was sent, and the server now stores exactly that or refuses, so printouts show the real stored
  location.
- Quick Receive's "Over-receive the last matched PO" option is removed: it always failed, because over-receiving needs
  an admin, `p_allow_over_receive` and a reason, none of which Quick Receive sends. Extra units are skipped; an admin
  over-receives on the PO page. The price-variance PO choice likewise sent the whole quantity to the picked line
  and was refused whenever that line had fewer left; it now receives at most what that line has left, the review
  shows how many units are skipped, and the user must confirm skipping them before Confirm works.
- Both checks share-lock the Main Warehouse row they accept (`FOR SHARE` inside the check itself; the live plan shows
  `LockRows` in the sub-plan), so it cannot be deactivated or renamed before the receipt commits.

Proof (2026-11-02): live read-only, the `warehouses` table holds only Main Warehouse (active) and every receiving
record is at Main Warehouse. The migration ran on live inside a rolled-back transaction as an admin: Cold Storage,
blank and mixed Main/Field Storage items were refused with `UNKNOWN_STORAGE_LOCATION`; Main Warehouse and a missing
location reached the normal "PO item not found" check; Add Inventory at Cold Storage was refused while Main Warehouse
and a missing location reached "Product not found"; a forged actor got `ACTOR_MISMATCH`. The locked version was re-run the same way with the
same results, plus a non-array `p_items` still refused by the inner body. Afterwards both live functions were
confirmed unchanged. A rolled-back Add Inventory replay on live (same key and payload twice) created
one stock row of 1 unit and returned the same answer both times, so the saved-replay path does not add stock twice. The Main-only version was re-run the same way with a temporary active Cold Storage row: Cold Storage, blank and
mixed items, Add Inventory at Cold Storage and Add Inventory after Main was deactivated were all refused; Main
Warehouse and a missing location reached the inner checks. Not yet applied to production when written.
