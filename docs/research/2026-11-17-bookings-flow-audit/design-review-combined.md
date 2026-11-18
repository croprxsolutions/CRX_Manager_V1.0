# Combined review: booking timing, confidence and purchasing design (2026-11-17)

Reviewed: `design-booking-timing-purchasing.md`. Reviewers: Sol (gpt-6-sol, high; raw output `sol-design-review.md`, 44 findings) and an independent Opus reviewer (24 findings, summarised below). Both were run separately and neither saw the other's review. Load-bearing claims were then checked against staging code (1e55ea039) and the live schema (read-only).

## Verdict
Both reviewers say the goal is right but the design should not be built as written. They agree on the main reasons:

- Today the app tracks bookings per **product**, not per section.
- The current Forecast reads booking dates from hold expiry.
- Retiring the "Planned program" switch touches six database paths, not just one screen.

## Verified against code
| Claim | Result | Evidence |
|---|---|---|
| Draws are per product, not per section | **Confirmed** | `quote_product_draws` UNIQUE (quote_id, product_id), 20260610145253:50-57 |
| Saving a quote deletes and re-creates every section with new ids | **Confirmed** | save_quote impl: `DELETE FROM quote_sections`, re-insert `gen_random_uuid()` |
| Therefore a booking with a scheduled job may fail to save | **Likely (not reproduced)** | Live `jobs_quote_section_id_fkey` delete rule = NO ACTION. The delete is refused while a job points at the section. This is a bug in today's app, not only in the design. |
| Auto-expire spares only bookings flagged Planned | **Confirmed** | `auto_expire_quotes` (20261029100000): `AND q.is_planned = false`. It counts Partial Order draws but not jobs. |
| Forecast and expiring-holds list derive needed date from hold expiry minus 14 days | **Confirmed** | `get_inventory_forecast` / `get_expiring_planned_holds` use `expires_at - INTERVAL '14 days'`. Removing expiry empties the Forecast. |
| Schedule Job accepts drafts | **Confirmed** | `create_job_from_quote_section` refuses only closed statuses and accepted. It requires is_planned. |
| Convert takes the whole booking and releases its holds | Confirmed in the earlier audit (B-series) | |
| D7 is money work | **Agreed** | It creates invoices. The design's "money untouched" line was wrong. |

## Findings both reviewers raised (merged)
1. **Section identity (BLOCKER).** Draws, holds and job draws can't say which section or window they came from. "Keeps its timing" can't work until they record the source section or line.
2. **Forecast rollout (BLOCKER).** Removing the 14-day expiry before the new view exists makes booking demand vanish from the Forecast.
3. **One demand count (BLOCKER).** Booking, then order, then job must be counted once. A forecast built from holds can count twice or miss demand. Demand should come from **what is left on each line**, plus open orders dated by delivery, plus jobs dated by job date. Holds are for reserving stock only.
4. **Firm holds vs walk-in sales (HIGH).** Holds sit above shelf stock all winter, so a warning on every sale would be noise. Warn only when a sale makes an **earlier window short after counting incoming POs**.
5. **Scheduled job = committed (HIGH).** A job holds its full amount whatever the section's confidence.
6. **Past-window and season-end expiry clash (HIGH).** Once Planned is retired, auto-expire would end every undrawn booking at season end.
7. **Close short per section (HIGH).** Today it closes the whole booking and ignores open Partial Orders.
8. **Retiring Planned (HIGH).** Six DB paths need changes: hold sync, job reservations, Schedule Job, the save guard, auto-expire and the inventory position.
9. **Window changes in Settings (MED/HIGH).** These move every existing booking. Snapshot a needed date on each section instead.
10. **"Order X by" precision (MED/HIGH).** Needs an exact date when known, per-supplier lead time, pack rounding, per-PO expected date and unit normalisation.
11. **Renewals drop fields (MED).** Roll over, Duplicate, Rewind and templates will drop timing and confidence too.
12. **Partial sprays look finished (MED).** Completion uses the planned amount (audit E3).
13. **D7 separately (HIGH).** It inherits invoice gaps (E3–E10) and needs idempotent one-invoice-per-job.

Found by only one reviewer, still valid:
- **Opus:** return deadlines should show beside each product and sort the past-window list.
- **Opus:** product bought for "Likely" is unprotected.
- **Opus:** keep confidence off the grower's PDF.
- **Sol:** returns are separate from booking need.
- **Sol:** product swaps touch only the undrawn balance.
- **Sol:** compute per warehouse.
- **Sol:** block manual release of booking holds.

## Revised plan (replaces Step 1 / Step 2)
**Phase A: purchasing view, read-only.** No change to how stock is reserved.
- Each section gets a Timing pick and a Confidence (Firm/Likely/Maybe).
  - Timing fills in a stored **needed-by date**, defaulting to the start of its window. The rep can overwrite it.
  - Confidence stays internal: it never appears on the grower's copy, and changing it never forces a re-send.
- A new purchasing screen reads **what is left on each sent booking line**, plus open orders (by delivery date) and jobs (by job date), against stock and POs by expected date. It shows:
  - Firm and Firm+Likely need per window
  - a running balance carried month to month
  - an overdue bucket (counted once)
  - a "needs date" bucket
  - each product's return deadline
- The old Forecast tab is replaced by this screen, or reads from the same source.
- **Also fixed:** saving a booking that has a scheduled job (keep section ids stable). This is a real bug today.

**Phase B: reservation changes.** Done after Phase A is used for a while.
- Partial Order and Schedule Job record their source section. The rep picks it; it defaults to the earliest window.
- Retire "Planned" across the six DB paths with an explicit open-booking expiry rule.
- Firm holds, with a warning only when a sale makes an earlier window short.
- Close short per section.
- Scheduling a job makes its section Firm.
- Roll over and Duplicate carry timing.

**Phase C: D7, applicator jobs draft an invoice.** Its own PR on the money path. Bill actual applied quantity, one invoice per job.

Out of scope still: auto-drafting POs, learning from past seasons, prepay and price lock.

## Mason's answers (2026-11-17)
1. A Partial Order or Schedule Job draws from a section the **rep picks**, defaulting to the earliest window.
2. Scheduling a spray job makes its section **Firm**.
3. "Order X" is based on **Firm only**; Likely is shown beside it as "could add".
4. A section still undelivered or unsprayed is **flagged for review 2 weeks before its timing window ends**. Its held stock never releases on its own.
5. Reps may enter an **exact needed-by date**; otherwise the window start is used.
