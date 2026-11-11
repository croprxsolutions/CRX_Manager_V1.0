# KI-142 — Close a partly received purchase order short: behavior contract

Read at `origin/main` 17ba96fbe and live (read-only) on 2026-11-10.

## Facts (with source)

- `purchase_orders.status` CHECK: draft, submitted, partially_received, fully_received, cancelled (live `pg_constraint`).
- On order is derived, never hand-kept: `_recompute_po_on_order_for_products` sums `quantity_ordered - quantity_received`
  over POs whose status is `submitted` or `partially_received`; the AFTER UPDATE OF status trigger
  `trg_po_status_recompute_on_order` reruns it on every status change (live bodies). Any new status drops out of on order.
- `_section9_cancel_purchase_order_serialized` refuses any PO with a received quantity ("Use partial receive workflow
  instead", which does not exist) (live body).
- `_enforce_po_status_transition` (BEFORE UPDATE OF status) allows draft→submitted/cancelled,
  submitted→partially/fully_received/cancelled, partially_received→fully_received/cancelled, and receipt reversals
  back; an admin override (`app.admin_override`) skips it. `reverse_receiving_record` sets the override and
  recomputes the status (submitted/partially/fully) for any PO not cancelled; so does the `receiving_records` delete
  trigger.
- `receive_po_items` refuses draft/cancelled POs and then sets status partially/fully_received.
- `_guard_po_delete` refuses submitted/partially/fully_received POs. `delete_purchase_order` also refuses any receipt.
- `create_vendor_bill` locks the PO `FOR UPDATE` and accepts only submitted/partially/fully_received POs (KI-143 owns
  that function; it is being changed in a sibling session).
- `purchase_orders` and `purchase_order_items` have no table grants to `authenticated` or `anon`: every write goes
  through SECURITY DEFINER functions.
- Almost every reader that lists open POs filters `IN ('submitted','partially_received')` (receiving hub, dashboards,
  forecast, inventory position, quick-receive matching, `src/pages/InventoryPage.tsx`, `ReceivingHubPanel.tsx`), so a
  closed PO leaves all of them. Exception (drift review): the PO list's Outstanding tab
  (`src/pages/PurchaseOrders.tsx`) excludes only cancelled and fully_received; PR 2 fixes it before any PO is closed. Readers that exclude only `cancelled` (cost basis, price history, supplier evidence,
  vendor link proposals) keep a closed PO's received lines as real purchase evidence, which is right.
- Live: 10 open POs, 7 partly received; none has a vendor bill.

## Outcome and authority

- An admin or sales rep can mark a **partly received** PO "closed short" with a reason. The rest of that order stops
  counting as on order; what was received stays received.
- Who: active admin or sales rep (the same people who can cancel a PO today). Drivers and others: refused.
- Smallest change, reusing the existing paths:
  1. Migration: status value `closed`; columns `closed_at`, `closed_by` (→ profiles), `close_reason`; new RPC
     `close_purchase_order_short(p_po_id uuid, p_reason text, p_idempotency_key text)`; the status-transition trigger
     allows partially_received→closed and treats closed as final; a new guard trigger on PO lines; `_guard_po_delete`
     and the cancel message learn `closed`.
  2. Screens (second PR): `POStatus` type, status badge/filter label, a Close Short button with `ConfirmModal` and a
     reason on `src/pages/PurchaseOrderDetail.tsx`, a "Closed short" banner like the cancelled one, Edit hidden for
     closed.
- The screen sends only the PO id, the reason and the key. The server derives the actor (`auth.uid()`), checks role,
  status, received quantity and bills itself.

## Rules that always hold

1. Only a `partially_received` PO can be closed short. Submitted with nothing received → use Cancel (refused with
   `PO_CLOSE_NOTHING_RECEIVED`). Draft/fully received/cancelled → refused. Already closed → the call answers
   `already_closed` and changes nothing.
2. Refused while active (not voided, not deleted) vendor bills on the PO total more than the received value
   (Σ per line round(quantity_received × unit_cost_cents)): `PO_CLOSE_BILLED_OVER_RECEIVED` — void or correct the bill
   first. Bills at or under received value are fine.
3. Closing sets status, closed_at, closed_by, close_reason in one transaction with an activity-feed row
   (`po_closed_short`, with the reason and the units released); on order for every product on the PO is recomputed by
   the existing trigger in the same transaction.
4. `closed` is final: no status change out of it, admin override included, with one exception — a receipt reversal on
   a closed PO (admin-only `reverse_receiving_record`, which sets `app.reversal_rpc_active`) keeps the PO `closed`
   instead of reopening it, so a wrong receipt can still be fixed without bringing the remainder back on order.
5. On a closed PO's lines: no new lines, no deleted lines, no change of product, PO or ordered quantity, and no
   increase of received quantity (`PO_CLOSED`). A decrease of received quantity (reversal) and a cost raise are
   allowed; a cost cut is refused (`PO_CLOSED_COST_CUT`, Mason 2026-11-11). So receiving into a closed PO is refused, and editing it is refused.
6. A closed PO cannot be cancelled (`already closed short`) or deleted (`_guard_po_delete`).
7. Cancel's message for a received PO now says "close it short instead".

## Existing rows

No existing row changes at apply. New columns are NULL on every old PO. The already-deployed app never sends `closed`
and has no Close Short button, so nothing changes for it until the screen PR ships. The old app shows a closed PO's
status as the raw word, and hides the Receive button (it shows only for submitted/partially_received) — acceptable for
the window between the two PRs (no PO will be closed before Mason picks them, To-Do decision 23).
Query before/after apply: `select status, count(*) from purchase_orders group by 1` — same counts, no `closed`.

## Timing

- Double click / retry after timeout: the key is created once per confirm dialog opening; the server binds it to
  caller + PO + reason (`check_idempotency_intent`); a matching retry returns the first saved answer (closing is final,
  so the saved answer stays true); a different caller or request with the same key is refused.
- Two users at once: the PO-derived-state advisory lock (73492009, the same one cancel, receive and on-order recompute
  take) then `FOR UPDATE` on the PO: the second caller sees `closed` and gets `already_closed`.
- Close vs receive at once: receive locks the PO line and PO `FOR UPDATE`; whichever commits first wins; a receipt after
  the close is refused by rule 5; a close after the receipt sees the new quantities (and if that receipt completed the
  PO it is now fully_received and the close is refused).
- Close vs new vendor bill: both lock the PO `FOR UPDATE`; a bill created after the close is accepted (the closed PO
  is billable) and checked by KI-143's billed-vs-received rule once that is live.

## Undo and history

- No reopen in this change (see decision 1). The activity feed and the PO columns record who closed it, when and why.
  `trg_po_status_change` also logs "status changed to closed".

## Delivery

DB first: PR 1 is the migration (+ prover test, ledger record, types/registry if needed), applied live before merge. PR 2
is the screens, merged after PR 1 is live.

## Proof cases (prover / local DB with test data; never live data)

1. When an admin closes a partly received PO with reason "vendor discontinued", then status=closed, closed_by=admin,
   on order for its products drops by exactly the unreceived remainder, other POs' on order is unchanged, and one
   `po_closed_short` activity row exists.
2. When a sales rep does it, it succeeds; when a driver or an unauthenticated caller does it, it is refused and nothing
   changes.
3. When the PO is submitted with nothing received → `PO_CLOSE_NOTHING_RECEIVED`; draft, fully received, cancelled →
   refused; already closed → `already_closed`, no second activity row.
4. When an active bill exceeds the received value → refused; when a bill equals the received value, or a voided bill
   exceeds it → allowed.
5. When the same key is retried by the same caller → same answer, no second row; same key with another PO → refused.
6. When `receive_po_items` targets a closed PO's line → refused with `PO_CLOSED`, stock unchanged.
7. When an admin reverses a receipt on a closed PO → stock goes down, the line's received drops, the PO stays closed and
   on order stays without the remainder.
8. When `save_purchase_order` edits a closed PO's lines, `cancel_purchase_order` or `delete_purchase_order` targets it →
   refused.
9. When cancel targets a partly received PO → refused with the new "close it short" message.

## Open business decisions

1. **Reopen.** Options: (a) closed is final — a late shipment goes on a new PO; (b) add an admin "Reopen" that puts the
   remainder back on order. Recommendation: (a) now; reopen is easy to add later if a vendor ever ships after a close.
   Consequence of (a): a PO closed by mistake cannot be undone; the office re-orders the remainder on a new PO.

## Cold challenge (gpt-6-astra high, 2026-11-10, FINDINGS 68) — how each material point was settled

- **Save could close a PO or edit a closed one (#9, #10, #15, #18).** Corrected: `purchase_orders_closed_fields_check`
  makes `closed` require closed_at/by/reason, which only the close RPC writes (save and insert set listed columns only),
  so save can neither move a PO into closed nor insert one closed; new `trigger_0_guard_closed_po` freezes every header
  column of a closed PO except status (transition rules), updated_at and the cost total. Proof cases 8 and 10.
- **Override ordering (#11, #13).** Corrected: the closed checks run before `_is_admin_override()` in both the
  transition and delete guards.
- **Received decrease broader than reversal (#12, #6, #14).** Corrected: a decrease on a closed PO's line is allowed only
  while `app.reversal_rpc_active` is set; only `_section9_reverse_receiving_record_serialized` sets it (live search of
  every function body), as a transaction-local `set_config`, and clients have no table writes. A direct
  `receiving_records` delete on a closed PO is refused (authenticated has SELECT only on receiving_records).
- **Moved lines (#16) and line/close race (#34).** Both parents are checked, under `FOR SHARE`.
- **Lock order (#33).** Live bodies: `receive_po_items`, `reverse_receiving_record`, `save_purchase_order`,
  `set_purchase_order_item_costs`, cancel, submit, delete all take advisory 73492009 first, as close does.
  `create_vendor_bill` takes no advisory lock and only the vendor then the PO row, so it cannot wait on close's
  advisory while holding the PO.
- **Eligibility (#24, #25, #26).** Corrected: besides status, the RPC requires received > 0 and at least one line with a
  remainder (`PO_CLOSE_NOTHING_OUTSTANDING`); the released remainder uses the recompute's per-line formula.
- **"Units released" across units (#27).** Corrected: the answer carries `lines_released` per line (product, unit,
  quantity); the activity text gives the line count.
- **already_closed (#39).** Corrected: it returns the winning close's who/when/why.
- **Readable columns (found while settling #19).** `purchase_orders` is read through column grants; the migration
  grants SELECT on the three new columns to authenticated only.
- **Billing a closed PO (#2, #58).** Not a dead end: live has 0 of 6 vendor bills linked to a PO, and a bill can be
  entered without one; KI-143's session was asked to accept `closed` like `fully_received`. Post-close bill edits
  (#31, #32) belong to KI-143's billed-vs-received rule.
- **Update 2026-11-10 (KI-143 session):** KI-143 re-creates only the public bill wrappers, so this change adds
  `closed` to the private billable-status list (`_section9_create_vendor_bill_intent_impl_20260826`, live body re-emitted
  with that one change, md5-pinned). Received value uses KI-143's formula, Σ round(quantity_received × unit_cost × 100).
  Proof: a closed PO can be billed; a cancelled one still cannot.
- **Sol round 1 (2026-11-10), two HIGHs on bills after a close.** (1) New or edited bills above what arrived: this
  migration now sorts after KI-143 (`20270103110000`) and its preflight refuses unless KI-143 is applied; KI-143's
  public `create_vendor_bill` / `update_vendor_bill` hold every PO's bills, closed included, to the received value
  (+5% only with an admin's confirmed reason, Mason's KI-143 rule). (2) A cost cut after the close: the line guard
  refuses a cost change on a closed PO that would put its active bills above the received value. Proof: both cases.
- **Sol round 2 (2026-11-11), same HIGH: KI-143's confirmed overage and a receipt reversal could still leave a closed
  PO billed above what arrived.** One rule now, no override: a closed PO's active bills never total more than its
  received value. A new trigger on `vendor_bills` (any write path, under the PO row lock the close and KI-143 take)
  refuses a bill that would break it; the line guard refuses a cost cut or a reversal that would. The close itself
  already applied this rule; a vendor's claim above what arrived is settled outside the closed PO (correct the bill,
  or bill the extra separately).
- **Sol round 3 (2026-11-11): two cost cuts at once on different lines could each pass the check.** Mason decided
  (option A): a closed PO's line costs never go down; a price mistake is fixed on the bill or with a vendor credit.
  The line guard refuses any cost cut on a closed PO outright (`PO_CLOSED_COST_CUT`), so no race is left. A raise only
  adds received value, so it cannot break the bill rule. Deferred (Sol MED): a direct line edit racing a close can end
  in a deadlock abort; one of the two fails cleanly and nothing is half-saved.
- **Bill value vs merchandise (#29, #30).** Kept as a conservative aggregate ceiling: freight on a PO-linked bill could
  block a close until the bill is corrected; acceptable at today's volume (no PO-linked bills).
- **Reversal limits (#3, #4, #7, #54).** Existing reversal rules (admin only, no active bill, open period) still apply.
  A wrong receipt on a closed PO is fixed by reversal plus an inventory adjustment or a new PO; reversing every receipt
  leaves a closed PO with nothing received, shown as "Closed short".
- **Screens (#40–#45, #53).** PR 2 hides Edit, Cancel and Receive on a closed PO, keeps receipt history and reversal
  reachable, says the close does not notify the vendor, and lists the remainder per line in the confirmation.
- **Rollback (#60).** In the migration header: forward repair only once a PO is closed.
- Declined: one coordinated release (#68) — the repo rule is database first, screens second; separate concurrency
  test per pair (#63) beyond close-vs-receive and close-vs-close; forced failure injection (#66) — one transaction.
