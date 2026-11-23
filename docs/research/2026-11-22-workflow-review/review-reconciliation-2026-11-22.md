# Review reconciliation: chemical sales map (2026-11-22)

**Outcome:** the chemical sales sheet had one outright error (old gap 5), one stale status (gap 11), about a dozen statements that were only partly right, and a missing list of side paths. It now has 30 ranked gaps: the original 15, corrected, plus 15 new ones. All new findings were checked against the latest function bodies in `supabase/migrations/`. Live status comes from `docs/reference/migrations.d/` records only. Nothing was run against a database.

**Inputs**
- Codex accuracy audit: `chemical-sales-codex-audit-findings-2026-11-22.md` (88 claims, "39 corrections, 37 missing areas").
- Codex adversarial review: `2026-11-22-codex-chemical-sales-adversarial-review.md` (15 new gaps, owner-decision conflicts, re-rankings).
- Three Claude checks. Two were blind (they never saw the Codex output): one accuracy pass and one gap hunt. The third verifier tried to refute each Codex gap.

## Corrections to the first sheet

| Sheet claim | Verdict | Evidence | Now says |
|---|---|---|---|
| Gap 5: editing an order line re-stamps today's cost | **WRONG** (Codex and Claude agree) | `20260617123503_refresh_item_profit_on_sameproduct_order_edit.sql:221-228` (same-product branch reuses `v_old_item.cost_per_unit`), reached through the `update_order_items` wrappers in `20260714221000`, `20260812115237` and `20261103130000` | Existing lines keep their cost. The real gap is commission that is batched or paid (new gap 5 wording). |
| Gap 11: order line can be cut below an open delivery | **STALE.** The fix is built but not applied anywhere | `20270224100000_f05_order_line_quantity_guard.sql`; record says "LOCAL CANDIDATE — NOT APPLIED" | Tagged "fix built, not applied". The F05 driver block conflicts with decision 10 (Q4). |
| ④ Void blocked once an invoice is posted | **CORRECT.** Codex #29 was refuted | Trigger `zz_delivery_void_needs_invoice_void`, `20261029160000_cap_order_invoices_at_delivered.sql:240-262`, live since 2026-10-30. `void_delivery`'s "posted_invoices_exist" flag never matters because the trigger refuses first. | Kept, and Fix Delivery added. |
| ② To buy = Firm + orders + jobs + holds; Could add = Likely | PARTLY | `20270216110000_purchasing_plan_booking_reservations.sql` (allocation order; uncovered amounts; unset confidence counts as Likely; undated Firm is listed, not bought) | Reworded. |
| Ladder: Maybe and Likely "never held" | PARTLY | `_sync_planned_holds` has no confidence filter (`20260702171000…`) | "Held only if Planned is on". |
| ① Price locked until season end | PARTLY | Season end is only the default. Lowering is always allowed. Planned or part-drawn bookings don't auto-expire. | Reworded. |
| ① Hold ends 14 days after Needed-by | PARTLY | No date means it never ends. Accept/convert or a draw releases it earlier. | Reworded. |
| ④ Completion drafts the invoice | PARTLY | Bill Split drafts per payer. A field split drafts only on a full same-day delivery. Quick Delivery drafts at creation. | Reworded. |
| ⑤ Net 30 | PARTLY | Invoice terms, then customer terms, then Net 30 | Reworded. |
| ⑤ Void + re-bill loses commission | PARTLY | Only when it was the order's last active invoice (`20270116100000:318-325`, not live). Fix Delivery re-creates commission (`20261106150000`, live). | Reworded. |
| Returns restock unopened product | PARTLY | Restocks lines ticked "restock" whatever their condition | Reworded; new gap 19. |
| Gap 12: renewals need re-entry | PARTLY | Both paths copy acres, quantities and Planned. A rolled Planned draft plus the open old booking can be counted twice. | Reworded and raised to MED. |
| Sales tax "switched off" | PARTLY | Database switch is seeded off (`20270117140000:168`). Controls are hidden on live. Staging switch state is unverified. | Reworded. |
| Decisions file: "None of this is built yet" | PARTLY | Decisions 6 and 10 are already true | Reworded. |

## Severity changes

- **Gap 8** (Close-Short ignores open orders): MED → HIGH. This matches the 11-17 audit (D1). It also needs gap 16 fixed first.
- **Gap 15** (Month-End $0 payments): LOW → HIGH while the fix is not live (KI-129 is HIGH).
- **Gap 4** (prepay not tied to a booking): HIGH → MED. It is a policy gap; the money still pays only that customer's invoices.
- **Kept at MED:** gap 9 (Codex wanted HIGH; it is a visible staff edit on a draft, and the increase rule is Q3) and gap 11 (Codex wanted HIGH; Order Detail already blocks edits on partly delivered orders and booking draws).

## Codex adversarial review: the 15 new gaps

No finding was refuted outright. Most were rated lower than Codex proposed.

| Codex # | Verdict | Severity used | Sheet gap |
|---|---|---|---|
| 1 Short invoice hides underbilling | CONFIRMED | MED | 17 |
| 2 Voided prepay credit editable | CONFIRMED (admin only, logged) | LOW | 25 |
| 3 Same check in both payment screens | CONFIRMED | MED | 18 |
| 4 Bounced check in a closed month | CONFIRMED (reopen workaround) | MED | 22 |
| 5 Damaged return restocked | CONFIRMED | MED | 19 |
| 6 Split-payer fractional return | CONFIRMED, known trade-off | LOW | 29 |
| 7 Quick Delivery invoice date | CONFIRMED (editable) | MED | 23 |
| 8 Month-End ignores unbilled deliveries | CONFIRMED | MED | 21 |
| 9 Voided orders in Month-End order $ | CONFIRMED (display only) | LOW | 26 |
| 10 Purchasing earliest load date | CONFIRMED but intentional (it buys early, never late) | dropped | — |
| 11 Quick Delivery tax only by admin | CONFIRMED, staging only | MED | 24 |
| 12 Cancel Remaining refused after a credited return | CONFIRMED; a blind Claude check found it too and found a second trigger | HIGH | 16 |
| 13 Quick Delivery price race | CONFIRMED | LOW | 28 |
| 14 Month-End counts deliveries by scheduled date | CONFIRMED | LOW | 27 |
| 15 Quick Delivery retry key optional | CONFIRMED, no current exposure | LOW | 30 |

**Found only by the Claude checks**
- **Gap 16, second trigger:** `ORDER_COMMISSION_STATE_UNSAFE` refuses Cancel Remaining when any commission row is not pending, including a cancelled row left by void + re-bill or by Fix Delivery (`20260817120000_carry_allocated_line_cents_through_lifecycle.sql:941-946`).
- **Gap 20:** Cancel Remaining cancels `in_progress` loads too (`20260817120000…:985`). The driver's completion then fails, so product leaves the yard without being deducted or billed.
- **Gap 5 (new wording):** an order edit rescales only commission that is pending and not in a batch. Batched or paid commission is left alone, so a payout batch can pay on profit that no longer exists.
- **Q1:** a write-off, prepay or credit memo also marks an invoice "paid", so decision 1 must count cash applied, not status.
- **Gap 12 double count:** a rolled-over Planned draft counts in Purchasing while last year's booking stays open.

## Codex owner-decision conflicts

All accepted as design inputs; they became Q1-Q8 in the decisions file.
- **1 + 2:** signed commission corrections are needed once payment drives payout.
- **1 + 7:** paid commission blocks Cancel Remaining today (Q2).
- **6 + 11:** name which cost basis commission uses once average cost arrives (for the costing plan).
- **8:** price increases (Q3).
- **7 + 9:** prepay is part of the open prepay brainstorm.
- **10 vs F05:** Q4.
- **12:** Q8.

## Codex accuracy audit: other rows

- Rows not listed above were confirmed or are wording refinements now in the sheet.
- The Codex "missing areas" list (37 rows) is covered in the new side-doors section as one card per path that moves stock or money: rush orders, bulk import, cancel and void, Fix Delivery, billed outside CRX, from-scratch invoices, write-offs, credit memos, finance charges, PO receiving alternatives, vendor bills and stock corrections.
- Report-only areas were left out: aging, statements, farm groups, rebates, restricted-use register.

## What source reading could not settle

- Whether the staging database has the STAGING-tagged migrations. The records only say "not applied live".
- How often gaps 16, 17 and 18 have already happened live. Each needs one read-only live query, which was not authorized in this review.
- Whether the driver app queues a completion offline and later fails silently after Cancel Remaining (gap 20).
- Which roles can receive returns (gap 19).
