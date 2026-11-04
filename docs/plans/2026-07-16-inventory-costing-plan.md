# Inventory Costing (Average Recorded PO Cost) — Scoped Plan

> **STATUS 2026-11-04 — still PARKED, never built. Refreshed 2026-11-04; building any phase needs Mason's
> separate go-ahead.** The recommended first step is **Phase 1 (reporting only)**; its detailed build plan is
> `docs/plans/2026-11-04-inventory-costing-phase1-build-plan.md` (one small owner-estimate table, decision D10).
> The engine below is Phase 2 and stays parked until Mason un-parks it (section 12).
>
> **Mason's planning decisions, 2026-11-04** (full list in section 12; he asked to plan the whole thing before
> building anything): admins only see the new cost numbers; holding rate a flat **10%** a year, adjustable later;
> aged-stock flag at **270 days**; **no lots** (estimated age is enough); **no freight or rebates for now**
> (Phase 3 dropped); special orders **show both** the booked and the corrected margin; build order **Phase 1 →
> 2 → 4 → 5**; purchases go **back through CRX POs** (since June they were made by phone and email, outside
> CRX), and Phase 2 **starts fresh** from a stock count with confirmed starting costs **before busy season**,
> with no back-entry of past purchases. Totes are mostly stocked already filled; there is no bulk chemical
> storage, only fertilizer.
>
> **What changed in the 2026-11-04 refresh** (against current `main`, the live database and the research report
> `docs/research/2026-11-03-inventory-cost-valuation/README.md`, draft PR #1428, reviewed by Sol in three rounds):
> 1. The engine's number is renamed **"average recorded PO cost"** (it was "on-hand average purchase cost").
>    It is provisional until vendor bills are matched; it is never called "average paid" or "true cost".
> 2. The report's **Phase 1 (reporting only)** is now this plan's first step (section 3). The old C1-C4 become
>    Phase 2. Freight and rebates (Phase 3), the sell-then-buy true-up (Phase 4) and pricing hooks (Phase 5) are
>    added as later phases, each with its own plan and review. Each phase names its Sol-required paths.
> 3. The report's design corrections are folded in: a cost status on **every receipt** (section 6), the initial
>    snapshot-vs-receipt difference recorded at allocation (section 9), a deterministic cost-forwarding process
>    for late costs (section 7), quantity-based order ↔ PO ↔ receipt allocation with ordered, received, delivered,
>    invoiced and credited limits (section 9), rebate eligibility and receipt-allocation records (section 8),
>    freight allocation (section 8), coverage and partial-total rules (section 3.2), and a verified common unit
>    for both receipt and inventory quantities (Gate 0, section 5).
> 4. Section 2 was re-grounded on 2026-11-04 with read-only live queries. The C1 writer list (section 4.3) was
>    re-checked against live `pg_proc`: 25 live functions write physical stock, up from about 10 named in July.
> 5. Corrections to July facts: `booked` is **not** dead (295 live rows; it is a reservation, not a movement);
>    the returns-COGS defect was **fixed** on 2026-08-27 (`20260827041100`), so old section 8 is closed;
>    Gate 0 is **half built** (the conversion columns exist since supplier-pricing Phase 1b, `20260718225511`,
>    but receiving does not use them); PO cost became admin-only (`20261021140000`, `20261021141000`,
>    `20261022101000`); below-cost approvals exist (`20260812115237`); a price-list cost history exists
>    (`20261026140000`) but no per-unit stock cost history.
> 6. The grand plan's BLK-1b (`docs/plans/2026-10-29-product-GRAND-PLAN.md`, overlap 14) depends on Phase 2:
>    a shop fill moves Bulk's average recorded PO cost into the tote. BLK-1a (quantities only) does not.
> 7. Open decisions are listed as `NEEDS MASON - DECISION REQUIRED` items in section 12.
>
> Earlier status (2026-09-26): parked; the supplier-pricing gate (Phases 1a, 1b, 2 and 3 Stage C) was met.
> Tracked in `docs/manual/TO_DO_LIST.md` ("Later features": true average purchase cost, decision 12; and the
> 2026-10-30 product-plan note above row 2.9).

**Date:** 2026-07-16 (refreshed 2026-11-04)
**Original advisors:** Claude (grounding + synthesis) + Codex "Sol 5.6" at extra-high reasoning (its five
disagreements are kept below). **Refresh sources:** the 2026-11-03 research report (sections 1, 4, 5.1-5.6, 7, 8)
and read-only live SELECTs on 2026-11-04.

---

## 1. The problem (Mason's ask)

"We don't have a way of tracking our average cost of product based off inventory." Still true on 2026-11-04:
`inventory`, `inventory_transactions` and `receiving_records` carry **no cost columns**. CRX knows the cost
recorded on each PO line, not what the stock on the shelf cost, how old it is, or what it costs to hold it.
CRX also sells a lot of product before buying it (sell-then-buy), and the margin on those sales is frozen at
the quote or order cost even when the PO comes in higher.

Four separate cost facts, never merged:

| # | Fact | Source | Used for |
|---|---|---|---|
| 1 | Replacement cost (supplier offers) | `supplier_price_observations` (10 rows live) | advisory only |
| 2 | Price-list cost (the pricing basis) | `products.current_cost` ← `product_cost_basis` | pricing, today's valuation, sale snapshots |
| 3 | Recorded PO-line cost | `purchase_order_items.unit_cost` / `unit_cost_cents` | not a matched vendor bill; can come from the catalog |
| **4** | **Average recorded PO cost** (NEW, Phase 2) | **this engine** | inventory value, provisional until bills are matched |

**Label honestly.** Fact 4 is an **average recorded PO cost**. It stays *provisional* until vendor bills,
freight and rebates are matched (Phases 3-4); only then may it be called an **invoiced net acquisition cost**.
It is never "average paid" or "true cost". It never writes `products.current_cost` (the 2026-03-13 doctrine:
the pricing basis is an owner decision). These are management numbers; the books stay in QuickBooks Desktop
and use the cost basis the accountant approves.

## 2. Verified current state (re-grounded 2026-11-04, read-only)

- **Ledger is unsigned:** `inventory_transactions.quantity` is a magnitude; direction lives in
  `transaction_type`. Allowed types (CHECK): `received`, `booked`, `delivered`, `returned`, `adjusted`,
  `transferred`, `job_applied`, `cancelled_delivery_reversal`, `void_delivery_reversal`, `prebooked`,
  `released`, `prebook_reconciliation`. Live counts: booked 295, delivered 204, received 136, adjusted 37,
  prebook_reconciliation 32, prebooked 22, released 21, job_applied 6, void_delivery_reversal 5; `returned`,
  `transferred` and `cancelled_delivery_reversal` have 0 rows. `booked`, `prebooked`, `released` and
  `prebook_reconciliation` move `quantity_prebooked` (a reservation), not physical stock. `job_id` is set on
  1 of 6 `job_applied` rows. Ledger rows are immutable (`trg_guard_inventory_transactions_immutable`).
- **One location:** every `inventory` row is `Main Warehouse`. Columns are quantities only
  (`quantity_available`, `quantity_prebooked`, `quantity_on_order`), plus `unit_size` and
  `manufactured_at_delivery`.
- **No lot data:** `receiving_records.lot_number` is filled on 0 of 130 receipts. Only spray applications trace
  to receipts (`application_record_lots`).
- **Receipts stopped:** the last receipt is 2026-06-10, while deliveries continue (last 2026-11-03). 13 of the
  66 products with stock have no receipt history (report section 1.3).
- **Negative stock is policy** (warn, not block): 19 rows negative now; deliveries and jobs seed phantom rows at
  negative quantity (`manufactured_at_delivery`).
- **Units are not verified at receiving (Gate 0 half built).** Supplier-pricing Phase 1b (`20260718225511`)
  added `product_supplier_links.inventory_units_per_supplier_unit` (filled on 10 of 596 links) and the PO-line
  snapshots `purchase_order_items.inventory_units_per_supplier_unit_snapshot`, `inventory_unit_snapshot` and
  `product_supplier_link_id` (snapshot filled on 55 of 194 lines). The live receiving body
  (`_section9_receive_po_items_serialized`) does **not** read them: it adds the entered quantity as-is.
  Inventory quantities themselves were never checked against a common unit either (product unit clean-up is
  in flight, for example `20261104200000_product_unit_backfill`, not applied).
- **Cost data:** all 194 PO lines have a recorded cost; PO cost columns are admin-only
  (`20261021140000`, `20261021141000`, `20261022101000`). Rep-added PO lines are priced at catalog cost and
  flagged for review, so a recorded PO cost is **not** proof of a vendor bill.
- **Cost history is price-list only.** `cost_history` holds 627 rows: 587 are a one-time starting snapshot
  (`20261026140000`) and only 28 are real cost changes. `purchase_order_item_cost_changes` logs PO-line cost
  edits. There is **no per-unit stock cost history**; that is exactly what `inventory_cost_events` adds.
- **Vendor bills, freight, rebates:** `vendor_bills` has 6 rows and **no bill-line table**; nothing matches a
  bill to a receipt. Freight on purchases is untracked (freight exists only as a customer invoice charge).
  `rebate_programs` and `rebate_claims` are empty and never touch cost; `rebate_claims` link only to orders and
  customers.
- **Sell-side snapshots unchanged:** `quote_items.cost_at_quote_cents` → `order_items.cost_per_unit` /
  `cost_at_time_cents` → `invoice_items.cost_cents`, with below-cost admin approval
  (`20260812115237`) and the quote cost-rise alert (`20261030090000`). This plan never changes them.
- **Returns-COGS: fixed.** Return credits reverse the original sale cost since 2026-08-27
  (`invoice_items.return_credit_cogs_cents`, `20260827041100`). The July "separate lane" is closed.
- **No repack, transfer or blend-to-stock movement exists.** No live function writes `transferred`; bulk and
  tote are separate product rows with no link. BLK-1a (grand plan overlap 14) will add the first one.
- **A weighted-average auto-update on receipt was removed on 2026-03-13** because it mixed purchase cost with
  the pricing basis. This engine keeps them apart by construction.
- **Today's valuation** (`get_inventory_cost_report`, latest body `20261103100000`; Inventory page total) is
  `quantity_available × products.current_cost`: a **pricing-basis valuation**, not book value.

## 3. Phase 1 — Reporting only (FIRST STEP; needs Mason's go-ahead)

**Detailed build plan:** `docs/plans/2026-11-04-inventory-costing-phase1-build-plan.md`. It adds decision
D10 (a bulk estimated-date entry), so Phase 1 now has one small append-only table and one admin write function.

No new tables, no change to any inventory writer, no change to prices, orders, invoices or commissions.
New read-only, admin-only RPCs (`SECURITY DEFINER` with `SET search_path = public, pg_temp`, explicit grants,
role check inside) and **one setting row** for the annual carrying rate (a small, non-destructive migration).

### 3.1 What it shows

1. **Rename** today's Inventory Cost report and Inventory page total to **"Pricing-basis valuation"**. Never
   silently change what an existing report means.
2. **Estimated aging report:** on-hand quantity allocated to the newest receipts first (oldest assumed sold
   first), from `receiving_records.received_at`, in buckets 0-90 / 91-180 / 181-365 / 366+ days and
   **"age unknown"**. It counts a product only where receipt **and** inventory quantities are verified in a
   common unit and reconcile to recorded movements (Gate 0's check, read-only here); everything else is
   "age unknown". Past quantities are never silently repaired inside a report. It stays an **estimate** in
   every phase; exact age needs lots tracked through every movement (decision D6). A row with zero or negative
   on-hand is never allocated to receipts: it shows 0 aged quantity, no holding charge, and is listed as
   **"negative stock — not aged"** (never a negative bucket or a negative charge).
3. **Estimated holding charge** for receipt-attributed stock only: annual rate × days held ÷ 365 × cost
   basis, with the assumed age and cost basis shown; unmatched stock shows "unknown". It is a period expense
   for decisions, never added to inventory value.
4. **Replacement-cost and price-exposure columns** only where a current, unit-matched supplier price exists:
   price exposure = units on hand × (pricing-basis cost − replacement cost). A replacement-cost drop is a
   review signal, not a write-down test.
5. **Dead-stock list:** pricing-basis cost and holding charge side by side, never summed.

### 3.2 Coverage and partial-total rules (apply to every phase's reports)

- Every column shows its **coverage**: the share of eligible product-location rows, and of unit-normalized
  quantity, that it can measure.
- Any sum over incomplete coverage is labelled **"partial"**, with the excluded rows and their likely
  materiality listed beside it. An unqualified total appears only at **complete, reconciled** coverage.
- Age-bucket dollars appear only labelled *quantity × stated valuation basis*; neither cost basis identifies
  the cost of each surviving receipt.
- Footnote on every view: "These are management views. The books use the cost basis the accountant approves,
  reconciled to QuickBooks, after any write-downs."

### 3.3 Phase 1 proof

Run each report against live data (read-only) and show the coverage numbers; prove a non-admin caller gets
nothing; prove the renamed report's totals equal the old ones to the cent.

**Sol-required paths:** yes — `supabase/` (RPCs and the setting migration) and `src/pages/Reports.tsx`
(also `InventoryPage` if its file name carries a money word; run the classifier).

## 4. Phase 2 — The average-cost engine (PARKED; the original C1-C4)

**Perpetual moving weighted-average pool per product + location, value in integer cents, event-sourced,
T0-forward, reporting-only screens.**

- **Pool math:** state = physical on-hand quantity `Q` + total on-hand value `V` (integer cents). Displayed
  average = `V ÷ Q` when `Q > 0`, derived at read time. **Never store a rounded average** (Sol disagreement
  #2). Issues remove a proportional share of `V`. **Rounding rule:** an issue of quantity `q` from a pool
  (`Q`, `V`) removes `round_half_away_from_zero(V × q ÷ Q)` whole cents, computed in exact PostgreSQL
  `numeric` (never float) and stored as bigint; an issue that empties the pool (`q = Q`) removes exactly `V`, so
  no cent is stranded. The rule is a pure function of posting order, so replay reproduces every cent. Receipts
  add their exact receipt total.
- **Event-sourced:** the physical ledger stays authoritative for quantity. A parallel append-only
  `inventory_cost_events` stream carries the money; state is a projection rebuildable from openings + events.
- **Companion-event rule (Sol disagreement #3):** every function that changes physical stock inserts its cost
  event **in the same transaction** as its ledger row, passing the source facts it already holds. Two
  **deferred constraint triggers** close both doors: one rejects any physical-movement ledger insert that commits
  without a matching cost event; the other rejects any change to `inventory.quantity_available` whose net change
  in the transaction does not equal the net of that transaction's physical-movement ledger rows for the same
  product and location. So no writer, present or future, can move stock without a ledger row and a cost event.
  (Writers that touch only reservations or `quantity_on_order`, or only metadata such as
  `_mark_inventory_row_verified_replay_impl_20261015`, do not move `quantity_available` and pass.) React flows
  stay unchanged.
- **T0-forward only:** no reconstruction of history before the owner-approved opening (section 4.4).

### 4.1 Negative-stock policy (Sol disagreement #1)

*"While stock is negative, cost is provisional. Receipts first repair the deficit. A real average resumes only
when stock becomes positive."*
- An issue driving stock negative uses the last valid average provisionally; if none ever existed it is an
  **unresolved** event (never a silent $0).
- A receipt while negative covers the deficit first; the provisional-vs-actual difference is recorded as
  `negative_variance_cents`; only the remainder above zero establishes value.
- Events process in **posting order**; late-posted receipts are flagged `posted_late` and never rewrite history.

### 4.2 Per-event costing policies

| Ledger situation | Cost event policy |
|---|---|
| `received` | Exact PO line + receiving record + **verified conversion** snapshot; add exact receipt cents; receipt starts **provisional** (section 6) |
| `delivered` / `job_applied` (every path) | Remove value at the current average; carry the source IDs the function already holds |
| Customer return (post-T0) | Restore the cost the engine assigned when those goods left — **not** `order_items.cost_per_unit` (Sol disagreement #4) |
| Pre-T0 return | Fall back to the invoice cost snapshot, marked **estimated** |
| Return cancellation | Reverse the exact preceding return event |
| Negative adjustment / retire / shrink | Remove at the current average; structured reason required |
| Positive count adjustment / manual add | Add at pool average, marked **estimated**; with no average → explicit admin cost or confirmed pricing-basis fallback |
| Delivery cancel / void reversal | Restore the exact cents the original issue removed |
| Receiving reversal (RPC or row delete) | Reverse the exact receipt event, including any later cost adjustments forwarded from it (section 7) |
| Application-record reversal | Restore the exact cents the original `job_applied` event removed |
| Phantom negative seed | Outbound with provisional/unresolved cost; product stays "needs review" |
| Reservations (`booked`, `prebooked`, `released`, `prebook_reconciliation`) | No cost event (no physical movement) |
| Repack / shop fill (BLK-1a/1b), future `transferred` | Paired, correlated out/in events moving exact attributable cents; no value created or lost |

### 4.3 C1 writer list (re-verified against live `pg_proc`, 2026-11-04)

Every function below inserts a physical-movement ledger row or changes `quantity_available`, and must gain the
companion cost event. The public entry point is listed first; the body that writes is in brackets. Re-run this
check at build time: the list grows as features ship.

| Area | Entry point [writing body] | Ledger types |
|---|---|---|
| Receiving | `receive_po_items` [`_section9_receive_po_items_serialized`] | received |
| Receiving reversal | `reverse_receiving_record` [`_section9_reverse_receiving_record_serialized`]; delete trigger `_receiving_records_before_delete` | adjusted |
| Delivery | `complete_delivery` (also called by `start_and_complete_delivery`) [`_complete_delivery_replay_impl_20261015` → `_complete_delivery_period_preflight_impl` → `_complete_delivery_aggregate_impl` → `_complete_delivery_authorized_impl`] | delivered (plus phantom seeds) |
| Delivery cancel | `cancel_delivery` [`_cancel_delivery_replay_impl_20261015`, also via `_batch_cancel_deliveries_replay_impl_20261015`] | cancelled_delivery_reversal, released |
| Delivery void | `void_delivery` [`_void_delivery_replay_impl_20261015`] | void_delivery_reversal |
| Order void | [`_void_order_impl_20260714` via `_void_order_replay_impl_20261015`] | void_delivery_reversal |
| Jobs | `complete_job` [`_complete_job_replay_impl_20261015`] | job_applied |
| Blend-ticket application | `create_application_record_from_blend_ticket` [`_create_app_record_from_bt_replay_impl_20261015`] | job_applied |
| Application reversal | `reverse_application_record` | job_applied / adjusted |
| Customer returns | `receive_return` [`_receive_return_intent_impl_20260812` → `_receive_return_impl_20260714`] | returned |
| Return cancel | `cancel_return` [`_cancel_return_intent_impl_20260812`] | returned (reversal) |
| Adjustments | `adjust_inventory`; `manual_inventory_add` [`_manual_inventory_add_replay_impl_20261015`]; `retire_inventory_item` [`_retire_inventory_item_replay_impl_20261015`]; `reconcile_negative_inventory` [`_reconcile_negative_inventory_replay_impl_20261015`] | adjusted |
| Cycle counts | `complete_cycle_count` [`_complete_cycle_count_impl`]; `reverse_completed_cycle_count` [`_reverse_completed_cycle_count_impl`] | adjusted |
| Repack / shop fill | none live yet; BLK-1a adds it | (new) |

**Reservation-only writers** (no cost event; the guard must recognise them): `bulk_import_order`,
`create_direct_order`, rush orders, `convert_quote_to_order`, `draw_down_quote`, `create_order_from_blend_ticket`,
`create_quick_delivery` and `_prebook_quick_delivery_inventory`, `update_order_items`, cancel-order and
close-remainder paths, and the `quantity_on_order` recomputes (`_recompute_po_on_order_for_products`,
`trg_po_submitted_update_on_order`). `_receive_return_impl_before_inventory_seed_20260825` is a retired body
with no caller and no API grant; confirm it stays unreachable or drop it in a reviewed migration.

### 4.4 Opening valuation (T0)

Dedicated **Inventory Valuation Opening** workbook (same parser, validation, row_version, preview and
change-set machinery as the pricing workbook, separate workflow): a frozen export of every inventory row
(positive and negative); suggested cost = most recent **received** PO cost after verified conversion, else the
price-list cost labelled "pricing-basis estimate"; Mason confirms every nonzero row; products with no receipt
history need explicit values; negative rows collect a **provisional deficit cost**. Quantity-only shop fills
recorded by BLK-1a before T0 are listed, never given an invented history. Apply is atomic; any quantity drift
since export rejects the workbook. The same transaction writes `inventory_cost_openings`, initializes state
and activates costing at exact T0. Opening values stay marked **owner-established**.

### 4.5 Confidence model

Per product: **Confirmed** (every remaining cent from receipts whose cost status is *settled*, or exact
reversals) / **Provisional** (from receipts not yet settled) / **Estimated** (opening declaration, pricing-basis
fallback, pre-T0 return, count gain; tracked as `estimated_value_cents`, removed proportionally) / **Needs
review** (negative stock, unverified unit, unresolved cost, unpaired event, state mismatch) / **No stock**.
Display: last receipt date, % of value from settled receipts, late-posting count. One exception list; cost
prompts appear only at actions that create unpriced value.

### 4.6 Custom fill / repack (C4) and BLK-1b

**Narrowed by D8 (2026-11-04):** chemical totes are stocked already filled and keep their own receipt cost;
the only chemical repack is the occasional custom partial fill from a full tote. Bulk storage exists only for
fertilizer. The text below still applies, read as "full tote → partial fill" for chemicals and "bulk → container"
for fertilizer only.

Until a bulk → tote movement exists, affected rows show **"Not valued — bulk/custom-fill movement is not
recorded."** BLK-1a (grand plan overlap 14) records quantities only. BLK-1b, after this engine is active: one
idempotent movement that locks both pools in a stable order, writes two ledger rows and two correlated cost
events, moves Bulk's average recorded PO cost per gallon (exact attributable cents, one rounding point, nothing
added for the tote), keeps provisional/estimated status, and creates no P&L. A vendor-filled tote keeps its own
receipt cost. A safe undo restores the exact cents. No container, labor or yield allocation.

### 4.7 Phase 2 sub-steps

- **Gate 0 (section 5)** — verified common unit. Must pass before C1 can value any receipt.
- **C1 — Dark foundation:** tables, private cents-pool engine, negative-stock variance, companion events in
  every writer in 4.3, deferred completeness guard, append-only/concurrency/replay/rebuild proof. No UI.
  **Proof: state rebuilds exactly from openings + events.**
- **C2 — Opening and activation:** section 4.4; reconcile every state row to `inventory.quantity_available`;
  stay hidden if any product mismatches unexplained.
- **C3 — Reporting-only UI:** product page shows the four facts with labels; a new **"Average recorded PO cost
  valuation"** report beside the pricing-basis one; confidence and coverage on every column (section 3.2).
- **C4 — Custom-fill coverage:** classify tote rows (decision D8), then BLK-1b.

**Sol-required paths:** yes — `supabase/` (every writer body), `src/components/receiving/`,
`src/pages/Receiving.tsx`, `src/pages/ProductDetail.tsx`, `src/pages/Reports.tsx`, and any inventory or money
file under `src/`.

## 5. Gate 0 — A verified common unit for receipts **and** inventory

Converting receipts alone is not enough: if inventory quantities are in a different unit, the pool and aging
disagree with on-hand.
- Use the existing directional field `product_supplier_links.inventory_units_per_supplier_unit` (example: 1 tote
  × 265 = 265 gal) and the PO-line snapshots already built in Phase 1b. Do not add a second, generic factor.
- Receiving computes inventory quantity = supplier quantity × the PO line's **snapshotted** conversion, and
  refuses to finalize a mismatched unit without an approved conversion or an explicit admin confirmation.
- Each inventory row's unit is verified against the product's inventory unit (the WP-PM-6a unit audit), with
  per-row owner approval for any correction.
- A product counts as **unit-verified** only when both sides pass. Phase 1 reports and the Phase 2 engine read
  this one status; unverified products are "age unknown" / "needs review", never guessed.
- Historical receipts are never rewritten; an opening workbook row may record a confirmed conversion.

**Sol-required paths:** yes — `supabase/`, `src/components/receiving/`, `src/pages/Receiving.tsx`.

## 6. Cost status on every receipt

Each receiving record carries a cost status, whether or not it serves an order:
- **provisional** — valued at the recorded PO-line cost;
- **partially matched** — some vendor-bill lines or charges matched to part of its quantity;
- **settled** — bill lines, freight and credits matched for its whole quantity.

This is separate from `purchase_order_items.cost_needs_review` (which only means an admin entered a cost).
Bills, credits and freight arrive separately, so one status per PO line is too coarse; matching is by receipt
quantity. A later credit after settlement posts as a further adjustment. An order allocation's "pending final
cost" status is derived from the receipts it uses. Status lives in PostgreSQL and changes only through
idempotent, admin-only RPCs.

## 7. Deterministic cost forwarding for late costs

A late bill difference, freight charge, credit or rebate cannot simply be split by the original receipt's
remaining units: the pool has since mixed with later receipts, issues, returns and negative-stock repairs.
Phase 2's design must specify one deterministic forwarding process (the idea of Business Central's separate
cost-adjustment run), covering:
- the share of the difference still in the pool versus already issued, computed from the event stream in
  posting order;
- what happens when the pool has since gone negative, been emptied, or been repacked;
- one rounding rule, with every cent assigned (no stranded value);
- replay: running it twice changes nothing (`p_idempotency_key`).

Effects post as new, append-only, linked adjustment events dated in an **open** period. Posted invoices and
closed periods are never rewritten. The pool and the issued costs reconcile after every run.

## 8. Phase 3 — Freight and rebates (NOT PLANNED for now — Mason, 2026-11-04, decision D7)

Kept as the design record if freight or rebates are revisited.

- **Freight:** a freight line on the PO or vendor bill, allocated to receipt lines by cost (or another stated
  basis), entering receipt cost and the pool through section 7.
- **Rebates:** each program is first classified (purchase-price reduction versus the ASC 705-20 exceptions).
  New **program-to-purchase eligibility records** and **receipt-allocation records** tie each qualifying
  rebate to the receipts that earn it. Estimate, actual and catch-up adjustments are kept separate and split
  between stock on hand and stock already sold. Estimates need accountant approval. Today's `rebate_claims`
  (orders and customers only) are not enough.
- Needs a vendor-bill line table matched to receipt quantities (section 6).

**Sol-required paths:** yes — `supabase/`, `src/pages/Rebates.tsx`, `src/components/receiving/`.

## 9. Phase 4 — Sell-then-buy true-up (PARKED)

1. **Quantity-based allocation table** linking order line ↔ PO line ↔ receiving record with a quantity, so one
   PO fills several orders and several receipts fill one order. PostgreSQL enforces separate limits for
   **ordered, received, delivered, invoiced and credited** quantities in unit-verified quantities, checked in
   aggregate under row locks; every write takes `p_idempotency_key`.
2. **Initial difference at allocation:** when a receipt is allocated, record the difference between the sale's
   snapshot cost and the allocated receipt cost as the first append-only adjustment. Otherwise a sale booked at
   $100 and filled at $110 is never corrected even when the bill equals the PO.
3. **Later adjustments** (bill, credit, freight, rebate) post as further linked rows and flow through the pool
   by section 7.
4. **Three margin views, never mixed:** *snapshot margin* (today's reports, unchanged); *adjusted order margin*
   (snapshot + initial difference + later adjustments; "pending final cost" until its receipts are settled);
   and the *inventory-cost view* from the engine. Each report states which it uses; period reports place
   adjustments by effective date and reconcile to QuickBooks before going live.
5. Unlinked historical sales get a read-only "likely next PO" variance report, labelled an estimate.

**Sol-required paths:** yes — `supabase/`, money reports and any `src/` file with a money word.

## 10. Phase 5 — Pricing hooks (PARKED)

The existing below-cost approval against `products.current_cost` stays exactly as it is. Added as **advisory**
warnings only (never a new floor): below average recorded PO cost; below replacement cost; an aged-stock flag
(threshold decision D3). Clearance below price-list cost goes through the existing approval. Who sees these
numbers is decision D2.

**Sol-required paths:** yes — `supabase/`, `src/pages/ProductDetail.tsx`, quote screens.

## 11. Minimal schema and Hard Rules (Phase 2 onward)

- **`inventory_cost_openings`** (immutable): change_set_id, product_id, location, opening_quantity,
  opening_value_cents, basis_quantity + basis_value_cents, source_type, source_purchase_order_item_id,
  conversion snapshot, confidence_class, notes, confirmed_by/at.
- **`inventory_cost_events`** (append-only): posting_sequence, product_id, location, inventory_transaction_id
  (UNIQUE when non-null), event_type, quantity delta/before/after, value delta/before/after cents,
  estimated_value_delta_cents, negative_variance_cents, cost_status, source FKs (PO item, receiving record,
  return item, order item, allocation, adjustment), reverses_cost_event_id, correlation_id, effective_at,
  posted_at, performed_by, idempotency key, notes.
- **`inventory_cost_state`** (rebuildable projection): on_hand_quantity, value_cents, estimated_value_cents,
  provisional_value_cents, negative_provisional_value_cents, unresolved_quantity, last basis qty/value,
  last_event_id, last_receipt_at, late_posting_count, row_version.
- **Receipt cost status** (section 6), **allocation** and **cost-adjustment** tables (Phase 4), **freight** and
  **rebate eligibility / allocation** tables (Phase 3): each designed in its own phase plan.

**Hard Rules for every phase:**
- Money is integer cents (bigint) in storage and arithmetic; averages are derived, never stored rounded.
- Invariants (pool balance, allocation limits, completeness, append-only) live in PostgreSQL: RPCs,
  triggers and constraints, not React.
- Every mutating RPC accepts and enforces `p_idempotency_key text DEFAULT NULL`. Every **new** costing RPC
  (opening apply, receipt cost status, allocation, adjustment, cost forwarding, repack) **refuses a null key**,
  so a retry cannot post twice. Keys are scoped by operation name and actor (the existing `idempotency_keys`
  pattern): a key reused for a different operation is refused, never answered with another operation's cached
  result. Existing writers keep their current key contract; their companion cost events cannot duplicate
  because `inventory_cost_events.inventory_transaction_id` is UNIQUE.
- Every new table has RLS and policies in the same migration; no anon; no client DML policies; append-only
  triggers reject UPDATE/DELETE.
- **Admin-only cost access:** reads go through admin-role RPCs; views use `security_invoker = true`; the
  engine function is private (fully revoked from API roles). `SECURITY DEFINER` functions set
  `search_path = public, pg_temp` with deliberate grants.
- Frontend uses `src/lib/db.ts`, `assertRpcResult()` and `checkMutationResult()`.

## 12. Owner decisions

Taken from report section 7, plus this plan's own. Mason answered D2-D9 in a planning session on 2026-11-04;
he asked to plan the whole thing before anything is built. Live check that day: the last receipt in CRX was
2026-06-10 and no PO has been created in the last 60 days.

- **NEEDS MASON - DECISION REQUIRED (D1): approve building Phase 1** (reporting only, no new tables). Still open:
  Mason wants the full plan settled first.
- **D2 — DECIDED: admins only.** The new cost numbers (holding charge, replacement cost, stock age) follow
  today's rule: only admins see any cost. Reps see nothing new.
- **D3 — DECIDED: 270 days.** Stock older than 270 days is flagged (Phase 1 dead-stock list; Phase 5 quote
  warning).
- **D4 — DECIDED: flat 10% a year for now, adjustable later.** Mason: "set it to a flat 10% for now but make this
  adjustable in future." Phase 1's one setting row defaults to 10% and is an admin-editable setting.
- **D5 — DECIDED (order only): Phase 1 → Phase 2 → Phase 4 → Phase 5.** Phase 3 is dropped (D7). Each phase still
  needs its own build go-ahead, plan, Luna and Sol review.
- **D6 — DECIDED: no lots.** Estimated age is enough. Age stays an estimate in every phase.
- **D7 — DECIDED: no freight or rebates for now.** Phase 3 is not planned. Cost stays the vendor price on the PO;
  sections 7 and 9 keep freight and rebate hooks out of scope until revisited.
- **D8 — DECIDED: totes are stocked already filled.** Totes are mostly bought and kept filled on the shelf, so
  they keep their own receipt cost. Occasionally a customer wants a custom amount, filled from a full tote into
  a partial container. There is **no bulk chemical storage, only fertilizer**. So C4 becomes a narrow "full tote →
  partial fill" movement (and fertilizer bulk, if needed), not a general bulk → tote flow; BLK-1b's bulk-to-tote
  design applies only to fertilizer.
- **D9 — DECIDED: purchases go back through CRX, and Phase 2 starts fresh.** Since June, product was bought by
  phone and email outside CRX; Mason will use CRX POs and receiving again. Phase 2 opens from a stock count with
  owner-confirmed starting costs (section 4.4), held **before busy season**, with **no back-entry** of past
  purchases; stock with no receipt since the fresh start shows "age unknown" in Phase 1 until new receipts build
  up.
- **D10 — DECIDED: gap stock shows "age unknown", with a bulk date entry.** Mason (2026-11-04): "show age
  unknown but allow a bulk edit add a date etc". Stock CRX cannot date because of the June gap shows "age
  unknown"; admins can select many products and enter an estimated received date (optionally the quantity it
  covers and a note), shown as an "owner estimate". Details: the Phase 1 build plan, section 4.
- **Special-order margin — DECIDED: show both.** Phase 4 keeps the margin booked at the sale and shows the
  corrected margin beside it once the bill lands; invoices never change (section 9, view 4).
- **Ask the accountant:** which cost basis QuickBooks should carry once CRX can produce a complete one, and
  whether carryover stock needs a write-down to net realizable value. (Rebate booking is moot while D7 stands.)

## 13. Explicitly NOT building

FIFO/LIFO/lot depletion; lot-level remaining quantities (unless D6); pre-T0 reconstruction; rewriting posted
invoices or closed periods; automatic writes to `products.current_cost`; changes to sale-time cost snapshots,
commissions or tax; GL journal posting; container, labor or yield costing; manufacturing/BOM; multi-warehouse
transfer costing (one location exists); AI/OCR; editing ledger rows; carrying cost inside inventory value.

## 14. Advisory record

Sol 5.6 (xhigh, July): *"Your core direction is right: moving average, T0-forward, derived layer,
reporting-only."* Its five disagreements (negative-stock rule; no stored rounded averages; companion events
required; returns not at sell-side snapshot cost; custom fill can't quietly participate) are kept above.
The 2026-11-03 research report's three Sol rounds (73 findings, all fixed or answered; report section 8) added
the corrections listed in the status header. Round-3 fixes were not re-checked by Sol; Phases 2-4 each need
their own plan with full Luna and Sol review before any build.
