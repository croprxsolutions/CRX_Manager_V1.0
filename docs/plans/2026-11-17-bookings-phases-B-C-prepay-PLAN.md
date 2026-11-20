# Plan: Bookings Phase B (reserving stock), Phase C (applicator invoices), Prepay and price lock

Status: whole plan settled at v3 (2026-11-17); each phase still gets its own plan-contract before build. Originally drafted 2026-11-17, read at origin/staging 2bf18b3ef.
- Builds on Phase A (`2026-11-17-bookings-phase-a-CONTRACT.md`, settled).
- The gap IDs (A1–F3) refer to the audit `docs/research/2026-11-17-bookings-flow-audit/README.md`.
- Mason asked to plan everything before any build, with the agent's recommended answers applied ("change all"). Each one is marked **[default]**, and Mason can override any of them.
- Mason decisions already made: D1–D7, Phase A answers 1–5, and "Revise is fine" (design-review-combined.md).

Order of delivery: Phase A, then B, then Prepay (v2: Prepay needs B's expiry rules).

**Phase C is ON HOLD (Mason, 2026-11-17).** Applicator auto-invoicing (D7) waits for the future field-application redesign. All Phase C text below (v1, v2, v3) is kept only as input to that redesign; it is not part of this build. Until then:
- jobs are invoiced by the office as today (`transfer_job_to_invoice`, plus the existing auto-draft setting, unchanged);
- Phase B's "Completed, not billed" list still ships, so finished jobs waiting on an office invoice are visible, and "ready to close" still requires an active invoice;
- Phase C items that Phase B or Prepay would have reused (actual-use records, applicator overage pricing) are not built. Prepay P4's "applicator overage priced by the office" is dropped; extra product on jobs is priced by the office when it invoices, as today.

---

## Phase B: reserving stock for bookings

**Outcome.** Firm booking sections set stock aside, dated by when it is needed. Orders warn when they would leave an earlier Firm need short. Bookings stay open until they are resolved, and the "Planned program" switch goes away.

**B1. Draws remember their section.**
- New table `quote_item_draws(id, quote_id, quote_item_id, source_type 'order'|'job', source_id, quantity, created_at)`, with RLS (select for staff; writes only through SECURITY DEFINER functions).
- **Partial Order:** the rep picks the section each drawn product comes from. The default is the earliest-dated section still owed (Mason answer 1). A product booked in only one section needs no pick.
- **Jobs:** draws go to the job's own section (`jobs.quote_section_id`) first.
- `quote_product_draws` and `job_product_draws` stay as per-product totals. They must equal the sum of `quote_item_draws`, which a constraint or check sweep enforces.
- **Existing draws:** backfilled to lines earliest-first. Live has 0 draw orders and 0 booking jobs.

**B2. Holds.**
- Only **Firm** sections hold stock, one hold per booking line. The hold equals what is still owed on the line, and its date is the section's needed-by date.
- Holds have no expiry. They last until the line is drawn, delivered, sprayed or closed (D5 and Mason answer 4).
- Likely, Maybe and unset sections hold nothing.
- Scheduling a job makes its section Firm (Mason answer 2).
- **Scarce stock [default]:** when Firm holds exceed what is on hand plus POs arriving in time, the **soonest-needed date gets the stock first**, and later needs show as shortfalls on the Purchasing screen. Holds are never refused; they can exceed stock, and the shortage is shown.
- **Manual release of a booking hold is blocked** (audit B5). The rep changes the confidence, the quantity, or closes the section instead.

**B3. The order warning (D6: warn, allow).**
- Every order-creating path checks whether the order leaves an earlier-dated Firm need short, after counting POs due in time. Those paths are convert, direct order, rush order, quick delivery, bulk import and partial order.
- If it would, the warning names the grower, booking, date and shortfall, and the order is still allowed.
- There is no warning when the held stock is covered in time, so walk-in sales in winter don't trip it.

**B4. Retire the Planned switch.** These six database paths stop reading `is_planned`:
- `_sync_planned_holds`, which uses confidence;
- `_sync_quote_job_reservations`;
- `create_job_from_quote_section`, which accepts any **sent, revised or accepted-with-no-order** booking. It refuses drafts, which closes audit A3: there is no billing without a sent price.
- the save_quote unplan guard (removed);
- `auto_expire_quotes` (B5 below);
- the inventory position `planned_quotes` figure.

The column stays for history and the screen hides the switch.

**B5. Booking expiry and closing.**
- **Season-end auto-expire [default]** expires a sent booking only when every section is Maybe or unset and it has no draws and no jobs. Any other booking stays open and goes to the review list.
- **Close short per section:** "drop the rest of this section" sets the lines to what was drawn and releases their holds.
- **Close short for the whole booking** is refused while partial orders are still open (audit D1).
- **Auto-close [default]:** a booking closes itself (`closed_by_application` or fulfilled) when every line's remainder is 0, every job is completed or invoiced, and every order is fulfilled (audit E2).
- **Close as applied** requires at least one completed job and no scheduled ones (audit E1).

**B6. Jobs.**
- A cancelled job no longer blocks rescheduling the section (audit E9).
- Several jobs per section are allowed, each drawing from what the section still owes.
- A field-application job requires a field.

**B7. Next season.** Roll over and Duplicate carry timing, confidence, field and needed-by date, moved forward one year, plus quantities. Roll over also closes the old booking's remaining balance as short, after asking the rep (audits F1 and F2).

**B8. Purchasing.**
- The Phase A Purchasing tab reads holds and section-tagged draws, so job and order demand keep their source section's dates (audit C3).
- The old Forecast tab and `get_expiring_planned_holds` are retired. The Phase A review list replaces them.

**Proof cases (B).**
- Two Firm growers, 100 needed in March and 100 in May, with 100 in stock: the March grower is covered and May shows a shortfall of 100.
- A walk-in order of 50 in January with 300 in stock: no warning.
- An order that leaves March short by 20: the warning names the grower, and the order is allowed.
- A Partial Order picking the August section reduces August, not March.
- The rep releases a booking hold by hand: refused.
- Close short while a partial order is open: refused.
- A cancelled job, then reschedule: allowed.
- Roll over: dates move +1 year and are kept.
- All lines drawn and all jobs invoiced: the booking closes itself.
- A booking with only Maybe sections at season end: expired. A booking with a Firm section: stays open.

---

## Phase C: draft invoices when an applicator finishes a job (D7)

**Outcome.** Every completed spray job gets exactly one draft invoice, whoever completes it, billed at what was actually applied.

**C1.** Applicator completion creates a draft invoice through the same function as office completion. It is one transaction with one invoice per job (unique `invoices.job_id` for non-void invoices), and a retry returns the same invoice.

**C2. Actual applied quantity [default].**
- The completion form shows each chemical's planned amount, prefilled at planned × applied acres ÷ planned acres. The applicator can adjust it.
- Stock is deducted at the actual amount, and the invoice bills the actual amount (audit E3).
- Any unused part goes back to what the booking section still owes. It is not deducted.

**C3.** The invoice date is the actual application date, not the scheduled date (audit E10).

**C4. Price** is the job's copied booked price, as today. A booking price change made after scheduling reaches the job only when the rep edits the job (audit E4 stays a known issue in Phase C).

**Out of Phase C:**
- the application fee on bookings (E5);
- per-field price overrides (E7);
- splitting chemicals per field owner (E8).

These go to separate billing work. Also check `gh pr list --author TahaKhanAbdalli` for overlap with Taha's billing plan before building.

**Proof cases (C).**
- An applicator completes 60 of 100 acres: stock −60%, the invoice is at 60%, and the booking still owes 40%.
- A completion retried twice: one invoice.
- An office completion and an applicator completion of the same job racing: one invoice.
- Postponed spray: the invoice date is the sprayed date.

---

## Prepay and price lock

**Mason's stated wishes** (audit Q2 answer, verbatim in the README):
- prepay can be applied to any of the grower's charges;
- money down locks the booked product prices;
- extra product in season can be priced at the booked price or today's price, or matched;
- when a grower swaps products, he usually honors the prepay benefit on the replacement.

**Today:**
- `prepay_credits.quote_id` exists but is never set, because the earmark engine was shelved on 2026-06-14.
- `apply_prepay_to_invoice` checks only the customer.
- The sent price is locked until the booking's season-end expiry, whatever has been paid.
- Partial Order already offers booked or today's price on extra quantity (`extra_price`, 20261029110000).

**P1. Link [default].** When a prepay is recorded, the office may pick one of the grower's open bookings, which sets `prepay_credits.quote_id`. Prepays already on file stay unlinked. The booking's settlement card shows the linked prepay amounts and what has been used.

**P2. Spending stays flexible (Mason).** A prepay, linked or not, can still be applied to any posted invoice of the same customer. When a linked prepay is applied to an invoice that is not from its booking, the screen warns "this prepay was for booking Q-n" and allows it.

**P3. Price protection [default].** A booking with a linked prepay keeps its sent prices **until the booking closes**, even past the quote's season-end expiry. Without a prepay, today's rule stays: sent prices last until expiry.

**P4. Extra product.** The existing Partial Order choice (booked or today's price) also applies to spray jobs that use more than was booked: the rep picks when scheduling or completing the job. Default: booked price when the booking has a linked prepay, otherwise today's price.

**P5. Product swaps [default].**
- On a prepaid booking, swapping product X for Y offers "keep the prepay benefit". It prices Y at the price Y had on the booking's sent date if it was quoted then; otherwise the rep types the price.
- It is recorded in `quote_price_changes` with the reason "prepay swap" and goes through the existing grower-confirmation trail.
- There is no automatic repricing.

**P6. Out of scope:** an automatic earmark that blocks spending, interest or discounts on prepay, and splitting a prepay across bookings.

**Proof cases (P).**
- A prepay linked to Q-1, applied to an unrelated invoice: warns, allowed, and the balances are right.
- A prepaid booking past its expiry: the sent prices still apply to Partial Order and the job.
- A job uses 10% more than booked on a prepaid booking: the default is the booked price.
- A swap with keep-benefit: the price change is recorded with its reason, and the sent version is unchanged until the grower confirms.
- A prepay that is not linked: behaves exactly as today.

---

## Risks and gates
- **Phase B:** touches stock holds and order creation, both on the Sol list. Database first, then screens (several PRs). It is the largest phase; split by path if a PR grows.
- **Phase C:** money (invoices) and stock. It gets a Sol review and a check for overlap with Taha's billing work.
- **Prepay:** money. Sol review. P3 changes how long price protection lasts, which customers will see.
- Every phase gets `plan-contract` (a detailed contract and a cold challenge) before its build.

## Defaults Mason can change
1. Scarce stock goes to the soonest-needed Firm grower.
2. Season-end expiry only for bookings with nothing Firm or Likely, nothing drawn and no jobs.
3. A booking closes itself when everything is drawn, sprayed and billed.
4. Applicators enter the actual amount used; billing and stock follow it.
5. A prepay may be linked to one booking and is still spendable anywhere, with a warning.
6. Prepaid bookings keep their prices until closed.
7. Extra product on a prepaid booking defaults to the booked price.
8. A swap on a prepaid booking can keep the benefit at the replacement's original quoted price, or the rep sets the price.

---

## v2 revisions after Sol's whole-plan review (2026-11-17)

Sol (gpt-6-sol, high) returned 83 findings: `docs/research/2026-11-17-bookings-flow-audit/sol-whole-plan-review.md`. The blocker-level claims were checked against the current SQL, and each one was confirmed:
- transfer role gate;
- auto-draft setting gate and swallowed errors;
- one invoice per owner, finished as `unposted`;
- `_assert_quote_prices_as_sent` has no expiry test;
- `quote_price_changes` has no reason column;
- `inventory_holds` has no line, date or warehouse;
- `release_inventory_hold` blocks only job holds;
- `create_planned_holds` and `close_quote_as_applied` require `is_planned`;
- `_sync_planned_holds` releases holds on accepted bookings;
- draw-down walks price tiers in document order;
- "booked" extra price takes the last line;
- the Phase A "next window start" rule.

The rules below **replace** the matching v1 text; where they conflict, v2 wins.

### Phase A changes (amend contract v4)
- **A-R1 (Sol 1):** picking a timing fills an empty needed-by date with the **current** window's start if today falls inside the window, otherwise the next one. The rep sees the filled year and can change it. *Amended (Sol on PR #1980):* never a past date. Inside a window that already began it fills today, because a past needed-by date would end a Planned booking's stock hold at once.
- **A-R2 (Sol 2):** a section qualifies for the review list if it has a needed-by date, whether or not it has a timing. Proof: a section with a date and no timing.
- **A-R3 (Sol 3):** undated Firm demand is shown at the top of Purchasing as "Firm, needs a date: N units". The buy plan reads "incomplete" until it is cleared.
- **A-R4 (Sol 4):** an open order line's need date is its delivery date when set, otherwise today. B8 keeps the same rule.
- **A-R5 (Sol 5):** in Phase A, which section a draw came from is estimated earliest-first and labelled "estimated", never shown as fact.
- **A-R6 (Sol 78):** while A runs without B, the old Forecast tab is labelled "Reservations (old view)", and buying uses Purchasing.

### Phase B changes
- **B1 ledger (Sol 6, 7, 11, 12, 14–17):**
  - `quote_item_draws` keys each draw to its source **line**: `order_item_id` or `job_chemical_id`, with real foreign keys and exactly one source set. It stores the quantity in stock units, plus the original unit and quantity.
  - It is the **single source of truth**. `quote_product_draws` and `job_product_draws` become totals derived from it, maintained in the same transaction, with a sweep that reports drift.
  - Every cancel, void, remainder-close and short-delivery path reverses the matching ledger rows in the same transaction (`cancel_order`, `_close_undelivered_order_remainder_20260718`, `complete_delivery`, job cancel and delete).
  - The backfill runs at deploy time from the source lines that still exist, and stops if any allocation is ambiguous.
- **B1 draw pricing (Sol 8, 69):** when the rep picks a section, the draw uses **that line** for quantity, price, cost and provenance. It never walks tiers in document order. Extra product at "booked price" uses the selected line's price.
- **B1 save (Sol 9, 10):** save_quote checks each line's drawn amount against that line, and refuses to shrink a line below what has been drawn from it. A line or section with draws is never deleted and re-created.
- **B1 jobs (Sol 13, 17, 26):**
  - `_sync_quote_job_reservations` allocates per section line, capped at what the line still owes, with fixed rounding.
  - A second job on a section requires the rep to enter that pass's acres. Chemicals scale to those acres, and the total across all jobs is capped at the section's remainder.
- **B2 holds (Sol 19, 20, 24):**
  - Holds stay per booking and product. They reserve stock and are not used to date demand.
  - Dates and section shares come from the ledger plus the section's needed-by date.
  - Hold expiry is not removed until every reader of `get_inventory_forecast` and `get_expiring_planned_holds` is replaced.
  - Hold eligibility matches the job engine: sent, revised, and accepted-with-no-order.
- **B2 release (Sol 21):** `release_inventory_hold` also refuses `crop_program` holds on an open booking.
- **B2 Firm on scheduling (Sol 25):** `create_job_from_quote_section` sets its section's confidence to Firm in the same transaction, checks the quote version, and records the change in the activity log.
- **B3 warning (Sol 27–31):**
  - The warning runs the same committed-demand walk as Purchasing: Firm remainders, open orders, active jobs, manual holds, and Phase A's PO eligibility rules.
  - The booking being drawn has its own demand moved once, not counted twice.
  - Ties on the same day go to the booking sent first. Undated Firm needs are shown as "at risk".
  - It is checked under a per-product lock at commit. The warning stays advisory: it is shown and recorded, never a block.
- **B4 (Sol 22, 23):** **eight** paths stop reading `is_planned`: the six already named, plus `create_planned_holds` (retired or redefined) and `close_quote_as_applied` (it requires a completed job instead).
- **B5 closing (Sol 32–37, 79): the auto-close default is replaced.**
  - Bookings do not close themselves. When every line is drawn and every job is completed **and has an active invoice**, the booking appears on the review list as "ready to close". The rep closes it with one click. This is simpler and avoids closing before billing.
  - Close short stores a separate `closed_short_qty` per line instead of editing quantities, so billed history and acres × rate are never rewritten.
  - The checks for open partial orders and for "close as applied needs a completed job and no active job" go into the database status-transition trigger, not only into the screen's function.
  - Season-end expiry ignores cancelled jobs.
- **B6 warehouse (Sol 42):** the app has one warehouse today. B states that assumption and adds a check that refuses a second active warehouse until location rules exist.
- **B7 next season (Sol 38–41):**
  - Roll over moves dates to the target season, not a fixed +1 year. Feb 29 becomes Feb 28.
  - The old booking stays open, counted, until the new one is **sent**. Only then does the rep confirm closing the old remainder.
  - Rollover-close is refused while orders or jobs are open.
  - Duplicate copies confidence as **Maybe**, so the same grower is never counted twice.
- **B8 (Sol 43):** the job-shortage and dispatch stock screens use the same committed-demand walk. One fixture proves all three give the same numbers.

### Phase C changes
- **C1 (Sol 44–47, 57):**
  - Completion calls an internal invoice builder (not the public transfer function), so applicators gain no general billing power.
  - The `auto_draft_invoice_on_job_completion` setting goes away: under D7, invoicing always happens.
  - An invoice failure no longer silently completes the job. The job completes and lands on a **"Completed, not billed"** list that blocks the booking's "ready to close" until it is cleared.
  - "One per job" means one **invoice group**: one invoice per field owner, as today.
  - The resulting status is `unposted` (ready for office review), the same as the office path.
  - Void and rebill clears `jobs.invoice_id`, puts the job back on the not-billed list, and uses a fresh retry key.
- **C2 (Sol 48–53, 58):**
  - A new per-chemical **actual-use record** (`job_chemical_actuals`) is saved before the job status changes. Stock, the legal application record, owner shares, the per-acre fee, and the invoice all read it, along with actual acres per field.
  - Units are converted once, using the same expression as the reservation engine.
  - Use above the booked amount is split: the booked part draws from the booking, and the extra part becomes a separate line flagged for office pricing (Sol 70).
  - Blend-ticket-billed jobs stay excluded.
- **C3 (Sol 55, 56):** the invoice's application date comes from the legal record (Chicago time). The invoice season follows the application date.
- **C4 (Sol 54):** if a booking price changed after the job was scheduled, invoicing stops with "price changed since scheduling". The office picks the new price or confirms the old one.

### Prepay changes
- **Ordering (Sol 65, 66): Prepay now ships after Phase B, not after A.**
  - The price lock does not come from extending the price check. It comes from expiry: a booking with a **qualifying** linked prepay is never season-expired.
  - Its sent prices therefore stay in force until the rep closes it.
- **P1 (Sol 59, 60, 61, 68):**
  - Price protection requires a link. An unlinked prepay is labelled "no booking price protection".
  - The link is added to the path the screen actually uses (`create_prepay_check_splits`), and to its retry receipt.
  - The linked booking's customer must match the prepay, and changing the customer on a booking with a linked prepay is refused.
  - An admin may link an existing prepay later, with a logged reason.
- **P2 (Sol 62, 63, 64, 77):**
  - Spending elsewhere returns a server-side warning, which must be acknowledged in the same request and is logged. It is still allowed.
  - Invoices record their source booking, so the warning and the settlement card know where money went.
  - The card shows: linked, spent on this booking, spent elsewhere, remaining.
  - A reversal or void path proves the card, customer balance and invoice balance agree.
- **P3 (Sol 67):** a prepay qualifies only while its remaining balance plus its amount spent on this booking is above 0. A fully refunded or reversed prepay stops protecting the booking.
- **P4 (Sol 69–71):** extra product defaults to the selected line's booked price, but never below cost (existing guard). Applicator overage is priced by the office before the invoice is posted.
- **P5 swaps (Sol 72–76): simplified.**
  - A swap removes only X's **undrawn** remainder and adds Y as a new line at a price the rep types, which can be X's booked price to honour the deal.
  - The booking is then re-sent, using the existing sent-version trail, so the grower sees and accepts the change.
  - A new `reason` column on `quote_price_changes` records "prepay swap".
  - The "Y's price on the sent date" rule is dropped.

### Proof additions (Sol 80–83)
- A lifecycle matrix asserting booked = remaining + surviving draws, plus stock, invoice and prepay balances, after each of: cancel, void, short delivery, follow-up delivery, return, price-tier change, save after draw, job resync, invoice void and rebill, prepay reversal.
- One combined Phase C case: 16 pints planned, 2 gallons used, 60 acres across two owners, plus extra product.
- Clock cases: Chicago midnight, season rollover, Feb 29, an overdue Firm need, late and undated POs, a prepaid booking past season end.
- Each PR names its compatibility window, backfill check and rollback.

### Defaults Mason can change (v2)
1. Scarce stock goes to the soonest-needed Firm grower; on ties, the booking sent first.
2. Bookings never close themselves; a "ready to close" list plus one click.
3. Applicators enter the actual amount; anything over the booking waits for office pricing.
4. Every completed job is invoiced; failures land on a "Completed, not billed" list. The auto-draft on/off setting is removed.
5. Prepay price protection needs the prepay linked to a booking, and it keeps that booking from expiring.
6. Swaps on a prepaid booking: the rep types the replacement's price, and the booking is re-sent to the grower.
7. A duplicated booking starts as Maybe.
8. One warehouse only until location rules are built.

---

## v3 revisions after Sol's re-check (2026-11-17)

Sol re-checked v2: `docs/research/2026-11-17-bookings-flow-audit/sol-whole-plan-recheck.md`.
- 49 of the 83 findings were resolved, 34 were partly resolved or still open, and there were 46 new findings.
- Spot-checked against the SQL and confirmed:
  - the admin-override early return in `_enforce_quote_status_transition`;
  - `release_holds_on_quote_status_change` firing on `accepted`;
  - transfer refusing `invoiced` jobs;
  - `accepted` meaning fully order-drawn (`enforce_quote_accepted_fully_drawn`).
- v3 wins over v2 and v1. Numbers in brackets are re-check findings (`N`) and prior findings still open (`pN`).

### Core accounting identity (applies everywhere) [17, 43, p80]
For each booking line: **booked = drawn (surviving ledger rows) + closed_short_qty + remaining**.
- Every reader uses `remaining` from this one identity: holds, Purchasing, the warning, settlement, rollover, save and proof.
- One SQL helper `quote_line_remaining(quote_item_id)` is the only implementation.

### Phase A
- **[1, 4, p4] Order-line date.** An open order's remainder is dated by its **earliest scheduled, undelivered delivery's** `scheduled_date`. With no scheduled delivery it is dated today, which is Phase A's existing rule and stays the fallback. Rescheduling a delivery moves the date. Proof: an order with two deliveries on different dates.
- **[2, p3]** The "Firm, needs a date" box lists each grower, booking and quantity.
- **[3, p5]** In Phase A, the part of a booking already drawn whose section is unknown is shown in a separate **"drawn, section unknown"** line. It is not assigned to March or August. The buy math counts every Firm section's full remainder, minus only draws whose section is known, so it errs toward buying, not short. Phase B then records the real section.

### Phase B
- **[4, 5, p15] Ledger reversal rule.**
  - A ledger row is reduced **only when its source obligation ends without use**: an order line is cancelled or its remainder closed, a job is cancelled or deleted **before completion**.
  - Delivery progress never changes the ledger; an order with 60 of 100 delivered still holds its 100 draw.
  - A completed job's draw is permanent. Corrections use an explicit adjustment entry.
- **[7, p12] Totals.** Screens and functions read draw totals **from the ledger** through a view. The legacy `quote_product_draws` and `job_product_draws` tables stay only for old callers, filled by a trigger on the ledger in the same transaction; they are dropped after cutover.
- **[8, p17] Rounding.** Job amounts are allocated to lines in order: section needed-by, then line sort, then id. Each line gets its amount rounded to 0.01 except the last, which takes the residual. A resync with unchanged inputs must produce identical rows, which the proof checks.
- **[9] Backfill.** Legacy draws with no surviving source go to a quarantine table and are listed for the office. Ledger reads are not switched on until the quarantine is empty or signed off.
- **[6] Save.** Phase A's save (reuse ids, delete and re-insert lines that are not referenced) changes in B to **update in place** any line or section that has ledger rows, a job or a hold. Only unreferenced lines may be deleted. Proof: a save after a draw keeps the line id and its draws.
- **[46] Multi-pass jobs.** For each chemical line, the rep enters this pass's quantity (prefilled from that line's own acres × rate × pass acres ÷ line acres). Each line is capped at its own remaining amount.
- **[10] Holds.** Each Firm line's hold equals `quote_line_remaining` (the identity), not ledger rows.
- **[11, p24] One eligibility rule.** A single function `booking_holds_eligible(quote)` decides whether a booking may hold stock. Both `_sync_planned_holds` and `release_holds_on_quote_status_change` use it, so `accepted` with no order and an open Firm section keeps its holds.
- **[12, p21] Direct writes.** A trigger on `inventory_holds` refuses deactivating an active `crop_program` hold on an eligible booking unless it is called from the sync function (session flag, the same pattern as `crx.price_only_quote_save`).
- **[13, 45, p83] Cutover order for holds.**
  1. Ship the new readers (Purchasing, the warning, dispatch and shortage screens).
  2. Switch every screen to them.
  3. Then, in one migration, set booking holds' `expires_at` NULL and drop the old expiry-based readers.
  - Each Phase B PR states which old screens still work and its rollback.
- **[14] Warehouse.** The check is "inventory rows for a product exist at more than one `location`". The Purchasing view shows a red banner, and the order warning refuses to run silently (it shows "multi-location not supported"), until location rules exist.
- **[15, p31] Overdue POs.** For the **warning**, an overdue PO that has not been received counts as **not arriving**, so the warning errs toward warning. Purchasing keeps Phase A's "late, expedite" display.
- **[16, p18] Lock order.** Every writer takes locks in this order: idempotency key, quote (`FOR UPDATE`), job, order, then inventory rows by product id ascending. Paths that touch no quote skip that step. A proof runs two opposing writers concurrently.
- **[18, p33, p36] Admin override.** The invariant checks (no open partial orders on close-short; a completed job and no active job on close-as-applied; an invoice on close-as-applied) move **above** the `_is_admin_override()` return in `_enforce_quote_status_transition`.
- **[19, 20, 21, p34, p35] Closing statuses.**
  - **Order-only, fully drawn and every order delivered or closed:** status `accepted`, using the existing meaning and `enforce_quote_accepted_fully_drawn`.
  - **Any job work:** `closed_by_application`, which requires every completed job to have an active invoice group (draft, unposted or posted; not void) and every order resolved.
  - Each rule is enforced in the status-transition trigger, so the one-click button and direct writes get the same answer.
- **[22] Rollover handoff.**
  - When the new booking is **sent**, the old booking's remainder is moved out of demand in the same transaction. Only the part not tied to an open order or job is moved, and it is recorded as `closed_short_qty` with the reason "rolled to Q-n".
  - Remainders tied to open work stay counted on the old booking.
  - Nothing is counted twice and no click is needed.
- **[23, p41] Duplicate.** A copy records `duplicated_from_quote_id`. Purchasing excludes a duplicate's demand while its source is still open, unless the rep marks it "additional, not a replacement" when sending.
- **[44, p79] Unbilled list in B.** The "Completed, not billed" list, with a "Create invoice" retry button for office staff, ships in Phase B, not C.

### Phase C
- **[24, p47] Status.** Applicator invoices are created as **draft**, as Mason asked (D7), so the office reviews and finishes them. The office path keeps its current behaviour. Proof checks the exact status.
- **[25, p45] Durable billing.**
  - Completion writes a `job_billing_queue` row (job, state, last error, attempts) in the same transaction as the completion.
  - The invoice is then built in the same call. On failure the row stays `pending` with the error, an in-app alert goes to admins, and the "Completed, not billed" list shows it.
  - Retry is idempotent on the job id, and a booking can't close until the row is `done`.
- **[26] Builder.** The invoice-building core is split out as an internal function with no role check, executable only by other SECURITY DEFINER functions and no client role. The public `transfer_job_to_invoice` keeps its admin and sales-rep check and calls the core.
- **[27, p57] Void and rebill.** Voiding every invoice in a job's group sets the job back to `completed`, clears `invoice_id`, and re-opens its queue row. Exactly one non-void invoice group per job is enforced by a check in the builder under the job lock.
- **[28] Actuals drive sync.** On completion, `_sync_quote_job_reservations` reads `job_chemical_actuals` (not `jc.quantity`) for completed jobs. Proof: planned 100 and used 60 gives a booking draw of 60 and a remainder of 40.
- **[29, p52] Units.** Each actual stores the entered quantity and unit, the stock-unit quantity, and the **priced-unit** quantity, converted once with `field_app_priced_quantity`. The invoice multiplies the priced-unit quantity by the price, in whole cents with one rounding per line.
- **[30] Customer-supplied** chemicals are recorded in actuals and on the legal record, but never deduct CRX stock, and bill $0 as today.
- **[31] Per-field use [default].** Version 1 assumes each chemical is applied at a uniform rate across the job's fields, so per-field shares follow actual acres per field. The completion form says so, and a field with different chemicals needs its own job.
- **[32] Unpriced extra.** Over-booking use creates the draft invoice with the extra line marked `pricing_pending`. The invoice can't leave draft until the office prices it.
- **[33, p55, p56] Dates.** `invoice_date`, `application_date` and `season` all come from the legal record's Chicago application date. A spray dated in a closed accounting period lands on the next open day, with a note.
- **[34] Price conflict.** It doesn't stop billing. The draft invoice is created at the job's price, with a "price changed since scheduling" flag that keeps it in draft until the office picks the price.
- **[p49] Correcting actuals.** Actuals are locked once the invoice leaves draft. Before that, the office can correct them, which re-syncs stock and the draw and is logged.
- **[p58]** Jobs already billed through a blend ticket mark their queue row `done, billed by blend ticket`. The application fee uses the booking's fee if one exists, otherwise the current rate, flagged for review.

### Prepay
- **[37, p67] Protection after spending elsewhere (Mason, 2026-11-17: yes, until refunded).** Once a linked prepay is recorded, the booking stays protected even if the money is spent elsewhere, and protection ends only if the prepay is **refunded or voided**.
- **[38, p77] Refunds.** A refund or void is recorded as a reversal row on the prepay, and the balance = original − applications − refunds. Qualification is "has a linked prepay that is not fully refunded or voided". The reversal proof checks the card, customer balance and invoice balance.
- **[35, p68] Historical link.** An admin can link an old prepay to an expired booking and **reopen** it to `sent` with a logged reason (an admin-only function). It then follows normal rules.
- **[36] Extra-order source.** Extra-product orders store `source_quote_id`, carried onto the order and invoice lines, so where money went is known.
- **[39] Extra-product default.** Restored to v1: booked price on a prepaid booking, today's price otherwise.
- **[p71] Booked-price cap.** Extra product at booked price on a prepaid booking is limited to 20% of that line [default]. Beyond that, the rep must choose today's price or enter a reason.
- **[40, 41, 42, p76] Swaps** use a dedicated `quote_line_swaps` record (from line, to line, quantity moved, price, reason, approver). The steps:
  1. The rep proposes the swap, which saves X's `closed_short_qty` += the moved amount and adds Y.
  2. The booking re-sends.
  3. Y can't be drawn or scheduled until the grower's acceptance is recorded, using the existing "Grower agreed" tick with who and when.
  - X's acres and rate stay untouched.

### Proof additions
- The lifecycle matrix uses the identity above, including closed-short.
- The combined C case adds a customer-supplied chemical.
- The clock cases assert that Purchasing, the warning and invoice dates agree.

### Defaults Mason can change (v3)
1. Scarce stock goes to the soonest-needed Firm grower; on ties, the booking sent first.
2. No automatic closing; a "ready to close" list plus one click.
3. Applicator invoices are created as draft. Extra product or a changed price keeps the invoice in draft until the office prices it.
4. One chemical rate per job across its fields. A different mix needs a separate job.
5. Extra product at the booked price on a prepaid booking is limited to 20% over that line.
6. Rollover moves the free remainder automatically when the new booking is sent.
7. A duplicate isn't counted while its source booking is open, unless marked "additional".
8. A linked prepay keeps protecting the booking's prices even after the money is spent on another charge, until it is refunded or voided (Mason decided, 2026-11-17).
