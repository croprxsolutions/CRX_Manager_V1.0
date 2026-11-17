# Behavior contract: Bookings Phase A, timing, confidence and the purchasing view (v3)

Read at origin/staging 2bf18b3ef (2026-11-17).
- Design: `docs/research/2026-11-17-bookings-flow-audit/design-review-combined.md` (Mason's answers at the bottom).
- Challenge: Astra (gpt-6-astra high). v1 had 105 findings; the v2 re-check had 33. The settlement is in section 5.
- Mason, 2026-11-17: "we need to make it simpler." v3 cuts server-computed windows, the window-end column, and per-delivery dating.
- Live facts are read-only queries run on 2026-11-17.

## 1. Outcome and authority

**Business result.**
- Each booking section carries a **timing** (Pre-plant, In season or Late summer), a **confidence** (Firm, Likely or Maybe) and its existing **needed-by date**.
- A new read-only **Purchasing** tab under Inventory shows, per product:
  - what is still needed and when;
  - what stock and incoming POs cover;
  - a running balance;
  - "Order N by <date>" for each uncovered committed need;
  - exception lists;
  - a review list of booking sections within 2 weeks of the end of their timing window.
- Reps can save bookings that have a spray job scheduled from them.
- **Reserving stock does not change.** Holds, the Planned switch, auto-expire, Convert, Partial Order, Schedule Job and the Forecast tab behave as today.

**Smallest change.**
1. **Migration (additive).**
   - Add to `quote_sections`:
     - `timing text NULL CHECK (timing IN ('pre_plant','in_season','late_summer'))`
     - `confidence text NULL CHECK (confidence IN ('firm','likely','maybe'))`
   - Make `jobs_quote_section_id_fkey` `DEFERRABLE INITIALLY DEFERRED`, still NO ACTION. This is the same fix 20260816120000 used for `order_items_quote_item_id_fkey`: the check runs at COMMIT, after save_quote has re-inserted the section under the same id.
   - Seed two `app_settings` rows with `ON CONFLICT DO NOTHING`:
     - `booking_timing_windows`, default `{"pre_plant":{"start":"03-01","end":"05-15"},"in_season":{"start":"05-16","end":"07-15"},"late_summer":{"start":"07-16","end":"09-15"}}`;
     - `purchasing_lead_days`, default `14`.

     There is no Settings editor in Phase A; an admin changes these rows later through a small follow-up.
2. **save_quote impl re-emit** (`_save_quote_below_cost_impl_20260810`, current body in 20261204100000). Only the section insert changes; every other line is unchanged.
   - **a. Opt-in marker.** The new screen sends `p_quote_payload.section_ids_v1 = true`. Without the marker (an old screen), the save runs exactly as today, except for rule c.
   - **b. Validate the ids (with the marker).** A payload section's `id` must be one of this quote's prior sections and must appear once; otherwise refuse `SECTION_ID_INVALID` before any change. A section with no id gets a new one.
   - **c. Sections with jobs (always).** If a prior section that is not reused is referenced by any job (any status, soft-deleted too), refuse `SECTION_HAS_JOB` with the job number. Old screens get this message instead of today's raw FK error.
   - **d. Old screens and planning data.** If there is no marker and any prior section has timing or confidence set, refuse `PLANNING_RELOAD_REQUIRED`, so an old screen cannot wipe planning data. A new screen replacing every section is allowed, because the guard keys on the marker, not on ids.
   - **e. Planning fields.** `timing` and `confidence` are written straight from the payload. With the marker, an omitted key keeps the prior value. `needed_by_date` behaves as today. The server computes no dates.
   - **f. Returned map.** The result adds `section_ids`, keyed by the section's `client_key`, the same way items are mapped today. If a result has no `section_ids` (a replay stored before the upgrade), the screen reloads the quote. *As built (PR 1a):* the screen drops its section ids instead of reloading, and Schedule job on such a section says to save and reload; a replay without the map only happens for a retry of a save stored before the upgrade.
3. **New read-only `get_purchasing_plan(p_months_ahead int DEFAULT 6)`.**
   - SECURITY DEFINER, `SET search_path = public, pg_temp`.
   - Gate: active admin or sales_rep, the same as `get_inventory_forecast`.
   - EXECUTE is revoked from PUBLIC and anon and granted to authenticated.
   - It is one SQL statement, so it reads one snapshot.
4. **Screens.**
   - **QuoteBuilder:** Timing and Confidence picks per section.
     - Picking a timing fills the needed-by date with the window start for the quote's season only when the date is empty; the rep can always change it. Season mapping: October to December fall in year `season-1`; the rest in `season`.
     - It sends the marker and the persisted section ids. Duplicates and templates strip ids.
     - Confidence is never printed on the PDF.
     - A section with a scheduled job shows "Job J-n was scheduled from this section; edit the job separately."
     - A Rewind FK error is shown as "This booking has a spray job; Rewind isn't available."
   - **InventoryPage:** a new Purchasing tab beside Forecast.

**Planning edits** on a sent booking go through the normal **Revise, then Save**, which reuses save_quote's ownership rule, `row_version` conflict check and idempotency. There is no separate setter.

**Who may act.**
- **Save:** unchanged. Active admin, the owning sales_rep, or the existing non-owner price-only path. That path passes the screen's own `p_sections` (20261104130000:938), so it carries the marker and ids; proof P8.
- **Purchasing view:** active admin or sales_rep. The drill-down shows booking, order and job numbers, customer, section, date, quantity and confidence, which both roles can already open.
- **Direct writes to `quote_sections`:** none. `authenticated` has only SELECT and REFERENCES (live).

## 2. Purchasing rules (stock units, one snapshot, today = Chicago date)

1. **Demand, each unit once.**
   - **Booking remaining.** Lines of quotes that are not deleted and are `sent` or `revised`. Also `accepted` quotes that **no order has ever referenced** (`orders.quote_id`, any status, including deleted). Draft and terminal quotes count nothing.
     - Draws are `quote_product_draws` (UNIQUE quote, product) plus `job_product_draws`, summed per quote and product.
     - If the draws exceed the product's booked total on that quote, the excess goes to **Over-drawn**.
     - Otherwise the draws are allocated to lines in `_sync_planned_holds` order: `needed_by_date ASC NULLS LAST, section sort_order, item sort_order, item id`.
     - Quote quantities are in stock units.
     - The date is the section's `needed_by_date`; a NULL date goes to **Needs date**.
   - **Open orders.** Status `confirmed` or `partially_fulfilled`, not deleted: `quantity_remaining > 0`, dated **today**. Sold product counts as needed now. Order lines are in stock units: the 20270121110000 trigger plus data fix 20270121100000.
   - **Active jobs.** Status `scheduled` or `in_progress`, not deleted, on `job_chemicals` lines where `customer_supplied` is not true.
     - The date is `jobs.job_date`; a NULL date goes to Needs date.
     - A line whose unit fails `_unit_matches_stock_unit` goes to **Check units**.
2. **Classes.**
   - **Committed:** Firm booking rows, every order row and every job row.
   - **Could-add:** Likely and unset booking rows.
   - **Shown only:** Maybe.
3. **Supply.**
   - On hand is `inventory.quantity_available` at Main Warehouse: physical stock, unique per product and location, and a missing row counts as 0. Live there is one location.
   - POs: `quantity_ordered - quantity_received > 0` on `submitted` or `partially_received` POs, dated by `expected_delivery_date`.
     - A **Late** PO (past date) counts at today and is flagged.
     - An **Undated** PO is listed and not counted.
4. **Horizon.** `p_months_ahead` is clamped to 1–12 (NULL = 6). It runs from today to the end of the month `p_months_ahead-1` months on. Later rows go to **Later**, which is listed and not counted. Earlier rows are dated today and marked overdue.
5. **Walk, per product.**
   - Aggregate committed rows and supply by date. On each date, supply comes before demand. Start at on hand.
   - Each date where the balance is below zero adds a suggestion for the **new** shortage only: "Order N by D", where D = date − lead days (an integer 0–120, else 14). If D is before today, it reads "Order now".
   - An opening balance below zero gives a suggestion at today.
   - "Could add M" is the extra suggested total from the same walk with could-add rows included.
   - Monthly figures summarise the same rows.
6. **Not complete flag.** A product shows "not complete" when it has any of:
   - a committed or Firm row in Needs date, Check units or Later;
   - an Over-drawn amount;
   - a Late or Undated PO.
7. **Product list:** every product with a demand row, an open PO line, or negative on hand.
8. **Review list.**
   - Which sections: booking sections eligible under rule 1, with remaining greater than 0 and timing set.
   - Window end: computed at read time from today's `booking_timing_windows` for the section's timing and the quote's season.
   - When: the section is listed once today ≥ window end − 14.
   - A standing queue: the section leaves when the rep changes its timing, the product is drawn or delivered, or the booking closes. Nothing is released automatically (Mason answer 4).
   - Changing the windows moves only this list, never quantities.

## 3. Existing rows, timing, history, delivery

- **Existing rows.** All live sections start unset and count as could-add, so they never drive a suggestion until marked Firm. Live: 1 open sent booking, 0 jobs linked to sections, and 1 of 10 open POs undated. After release, the rep classifies that booking and purchasing dates that PO.
- **Copies and Rewind.** Duplicate, Roll over, templates and Rewind come out unset.
- **Accepted bookings with no order.** These count as could-add and cannot be reclassified in Phase A, because there is no accepted-to-revised path. Live count: 0.
- **Timing.** save_quote is unchanged: `row_version` conflicts and idempotency replay.
  - Schedule Job and Save both lock the quote row, so they run one after the other. If the job wins, the save gets `SECTION_HAS_JOB`; if the save wins and dropped the section, scheduling gets a section-not-found error.
  - A stale screen scheduling from a reused section id gets the section's **current** data, which is correct for the job.
  - The purchasing view is read-only, with a refresh.
- **History and undo.** These use the existing `quote_updated` activity row and the `quote_versions` snapshot on send. Undo means Revise and edit again.
- **PR 1 (database, to staging).** Migration, prover and ledger record. It is compatible with the deployed app: without the marker, saves behave as today plus the two clear refusals.
- **PR 2 (screens).** Merges after PR 1 is live on staging.
- **Production.** Both go through `release/next`.
- **Recovery.** Roll back the screens only; the database part is backward compatible and stays. Restoring the old save_quote body would wipe planning fields on the next save. That counts as deleting data and needs Mason's explicit OK.

## 4. Proof cases

Run on the local prover database as the real caller via a JWT. Today = 2027-02-01, season 2027, lead time 14 days.

| # | When … | Then … |
|---|---|---|
| P1 | A booking has a job from section S. The owner saves with the marker and S's id. | **First reproduce the failure on today's body.** Then the save succeeds, S keeps its id, and the job still points at S. |
| P2 | The same save leaves S out. Repeat with the job cancelled, and with it soft-deleted. | `SECTION_HAS_JOB`, and nothing changes. |
| P3 | The payload carries another quote's section id, or the same id twice. | `SECTION_ID_INVALID`. Neither quote changes. |
| P4 | An old payload (no marker) saves a quote with no planning data and no job. | Identical to today: lines, prices, totals and item ids (existing save_quote prover). |
| P5 | An old payload saves a quote whose sections have timing or confidence set. | `PLANNING_RELOAD_REQUIRED`. A marked payload that replaces every section succeeds. |
| P6 | Session A schedules a job on S while session B saves without S. | Run both orders. The job-first order gives `SECTION_HAS_JOB`; the save-first order gives section-not-found. |
| P7 | A marked save omits `timing`. A second save sends it as null. | The first keeps the prior value. The second clears it. |
| P8 | A non-owner rep uses the price-only path on a booking with planning data and a job. A non-owner rep tries a normal save. An applicator or anon calls `get_purchasing_plan`. | The price-only save succeeds. The other two are refused. |
| P9 | X has 100 on hand. Firm 80 needed 2027-03-01, an open order of 50, Firm 80 needed 2027-04-01. | The order counts today, leaving 50. Then −30 on 03-01, giving "order 30 by 02-15". Then −110 on 04-01, giving "order 80 by 03-18". Total suggested: 110. |
| P10 | No stock. Firm 100 on 03-02. A PO of 100 due 03-28. Likely 100 on 04-01. | One suggestion: "100 by 02-16". Could add 0, because the PO covers the Likely. |
| P11 | On hand is −10, with no rows at all. | "Order 10 now". |
| P12 | A late PO, and an undated PO. | The late PO counts today, flagged. The undated PO is listed but not counted. The product shows "not complete". |
| P13 | A booking line of 100. A Partial Order draws 60. A job draws 40. Then the job completes, and separately the order is cancelled. | Active state: 0 + 60 + 40 = 100. After each transition, the total equals what is still owed. **Must pass before build.** |
| P14 | A March line (sort 1) and an August line (sort 2) of X. 60 is drawn. | The March line is reduced first, matching the holds. Draws of 150 against 100 booked put 50 in Over-drawn. |
| P15 | A draft, a closed_short quote, an accepted quote with a cancelled order, and an accepted quote never ordered. | Only the last one counts. |
| P16 | Late summer, season 2027, window end 09-15. Run on 09-01, then on 08-31. | Listed on 09-01, not listed on 08-31. |
| P17 | Firm with no date. A job line in a foreign unit. An undated job. | Each lands in its bucket and flags "not complete". None of them drives a suggestion. |
| P18 | A short delivery leaves a `delivery_remainders` row. | Demand equals the order line's `quantity_remaining` only. |
| P19 | Browser on staging after PR 2. | Picks persist after reload. Purchasing totals match the drill-down. The PDF shows no confidence. The job notice shows. |

## 5. Astra settlement

**v1 (105 findings).**
- The setter was removed: 36, 49–52, 61–73.
- Fixed by rules 1–8 and section 1: 3–13, 16, 21–23, 26, 27, 30–32, 34, 41–46, 74, 75, 81–83, 88, 89, 91, 101–103, 105.
- Disproved from live data or code: 1, 17, 24, 33, 38, 40, 85, 86.
- Settled by Mason's answers: 19, 28, 53, 54, 79.
- Cut together with the window column: 55–60, 100.
- Covered by proof cases: 6, 14, 15, 18, 37, 39, 77, 78, 87, 90, 92–96.
- Declined: 47, 48 and 97 (job stays separate, Phase B), 76 (a standing queue is intended), 80 (copies come out unset), 84 (prover replay).

**v2 (33 findings).**
- 1: opening-deficit rule.
- 2: over-draw is checked at the quote and product total.
- 3 and 4: orders are dated today (simpler; no delivery dating).
- 5: the job `quote_id` bypass was removed; every line is unit-checked.
- 6: disproved by the 20270121110000 trigger and data fix.
- 7: P13 must pass before build.
- 8: "never referenced by any order".
- 9: disproved by UNIQUE (quote_id, product_id).
- 10 and 11: the flag and could-add are defined; P10 proves them.
- 12: Late POs count at today, flagged (Mason default 2).
- 13: one location live.
- 14: per-date aggregation.
- 15–22 and 26: cut, because no server-computed dates and no window column.
- 23: documented, with a live count of 0.
- 24: P8.
- 25: the marker replaces the id-based guard.
- 27 and 28: ids keyed by `client_key`; duplicates strip ids.
- 29: declined. The job takes the section's current data, which is correct.
- 30: the explanation was corrected; see P6.
- 31: the Rewind FK error is mapped to a clear message, with no data change.
- 32: recovery is screens-only, and rolling back the database body needs Mason.
- 33: the screen reloads when `section_ids` is missing. *As built:* it drops the ids; Schedule job explains (QuoteBuilder test).

## Defaults applied, for Mason to see
1. A sold order counts as needed **now**.
2. A late PO counts as arriving today, flagged. An undated PO is listed but not counted.
3. Copies and Rewind come out unset until Phase B.
4. The timing windows are fixed defaults in Phase A. Changing them is a small follow-up.

## v4 amendments (independent Opus review, 19 findings; these override the sections above)
Checked against code or live data before adopting. The Opus review confirmed several facts:
- P13 holds:
  - completed and invoiced job draws are kept (20261107070000:207-211);
  - order cancel returns only the undelivered part (20260620130000:136-153);
  - void returns the full amount (20261019235000:633-645).
- The price-only path passes the screen's sections (20261104130000:937-939).
- Save and Schedule Job both lock the quote row.
- Only save_quote and restore_quote_version delete sections.
- Booking-draw orders are locked against edits.

**Delivery split (simpler).**
- **PR 1a, the job-save fix only:**
  - the deferred jobs FK, using `ALTER CONSTRAINT`, so the FK name embedded at `JobDetail.tsx:1887` keeps working;
  - section-id reuse, with the `section_ids_v1` marker and rules b, c and f;
  - the screen echoing ids.

  It fixes the live bug on its own. Rules b and c run after the quote row lock and the `row_version` check and before the DELETE.
- **PR 1b:** the columns, rules d and e, `get_purchasing_plan` and the settings seeds.
- **PR 2:** the picks and the Purchasing tab.

**Changed rules.**
1. **No season needed.** All 7 live quotes have `season` NULL, and save_quote never writes it. Instead:
   - Picking a timing fills an empty needed-by date with the **next** occurrence of the window start on or after today.
   - Window end = that timing's end month-day in the needed-by date's year.
   - A section with a date but no timing uses its needed-by date as its window end, so it also reaches the review list (Mason answer 4).
2. **Job demand uses the reservation engine's own expression,** `COALESCE(field_app_priced_quantity(jc.quantity, normalize_rate_unit(jc.unit), p.inventory_unit, p.product_form), jc.quantity)` (20261107070000:229). A line goes to Check units only when that conversion is NULL **and** the unit does not match. (Schedule Job labels lines with `price_unit`, e.g. '2.5 GL'.) New proof P20 uses '2.5 GL' and 'qt' job lines.
3. **Job draws are applied to the job's own section** (`jobs.quote_section_id`) first, then by date, in the purchasing view only; holds are unchanged. New proof P21: a 100 March Firm section, a 100 August section, and an August job drawing 100. March still needs 100.
4. **Late-PO duplicate.** When a shortage date is covered by an open PO arriving **after** it, the suggestion reads "PO <n> arrives <date>, after the need: expedite it, or order N." It is shown, not doubled (P10 is updated to expect this).
5. **Draft POs** appear as "drafted N" beside a suggestion. They are not counted as supply.
6. **Manual holds count as committed demand dated today:** `hold_type = 'manual'`, and `crop_program` holds whose `source_id` is not a live quote.
7. **Settings parsing is defensive.** Invalid JSON, or a missing or impossible month-day, falls back to the defaults per timing. The tab never errors on settings.
8. **Accepted quotes never referenced by an order** are classed by confidence like sent ones, because the grower committed. Admin `revert_quote_status` (accepted to sent, 20261016140000:1086) is the edit path.
9. **Could-add** assumes each committed suggestion arrives on its need date before the could-add rows are walked.
10. **Suggestions show the product's container size;** there is no rounding in Phase A.
11. **Non-owner reps** see the Timing and Confidence picks read-only. Changing them on the price-only path would trip `QUOTE_PRICE_ONLY_FOR_OTHER_REPS`.
12. **Rewind** clears the picks (accepted and documented) and still fails on a booking with a job. The screen maps that FK error to a clear message.

**Declined.**
- **#6 (past-window Firm rows stop driving buys):** Mason's D5 says they stay counted. They stay committed, and the review list flags them.
- **#19 (blend tickets):** blend tickets no longer make orders (INVENTORY_RULES:87, KI-93).

**Dependency.** 20270121100000 and 20270121110000 (stock-unit order lines) are on staging and not yet applied to production (live `schema_migrations` check). Phase A reaches production only in a release that includes them.

**Mason, 2026-11-17: "Revise is fine."** Changing the picks on a sent booking uses Revise; the status becomes "revised" and the re-send banner shows.
