# #1989 redesign: how a booking reserves shelf and incoming-PO stock — behaviour contract (v4 — APPROVED by Mason in chat 2026-11-21: "Yes, build it")

## SCOPE FOR THE FIRST BUILD: per product, not per line (Mason, in chat, 2026-11-21: "Per product")

Mason asked whether this was over-complicated and chose the smaller version. **This section overrides R2's per-row output and the per-row proof cases below.** Every business rule (answers 1-7, R1, R3-R6) is unchanged.

- **Allocation (R2):** runs over the product's demand **groups**, not lines. The groups, in rank order:
  1. shelf-only holds;
  2. deficit;
  3. committed (orders, jobs, manual holds, Firm lines);
  4. could-add (Likely/unset);
  5. shown (Maybe).

  Supply comes in the same order as R2: shelf (floor 0), then POs by date, PO number and line. Within a group, demand is taken by need date, and late supply counts as cover (answer 4).
- **Output per product**, for each group:
  - `booked`, `on_time`, `late`, `not_covered`;
  - `pos[] {po_id, po_number, qty, expected_date, late, po_overdue, po_undated}`;
  - plus `has_late_cover`, `has_followup` (any line 14+ days past its need date) and `estimated`.
- **Booking rows** keep their existing fields plus `overdue_followup`. There is **no per-line `cover[]`**: that is a later add-on if Mason misses it.
- **Buying:**
  - `suggested` = the committed group's `not_covered`, dated where its cumulative committed demand first exceeds all supply up to that point, with late POs counted;
  - `could_add` = the could-add group's `not_covered`.
- **Proof:** the row-level parts of C1-C19 are proven at product/group level:
  - per-group on-time + late + not_covered = booked;
  - the POs' awards ≤ each PO line;
  - no PO award to shelf-only holds;
  - the input order reversed gives identical JSON.
- **Not challenged again:** this cut was not sent back to Astra (the plan allows one re-check, already used). Luna and Sol review the build against this section.

This was read at `origin/main` `00003d8a2`:
- `get_purchasing_plan` body: `supabase/migrations/20270129160000_release_fixes_1990.sql:1138-1550`, the newest definition.
- PR #1989 head `30f880e70`.

For the build, copy this to `docs/plans/2026-11-21-booking-reservations-CONTRACT.md` on #1989's branch.
- It **replaces** `docs/plans/2026-11-18-purchasing-held-stock-CONTRACT.md` entirely.
- It keeps only that contract's rule 6 (window fixes), rule 8 (safe draw guess) and rule 11 (draw lists), as implemented at #1989 head `30f880e70`. They are not in the #1990 base.

No screen calls `get_purchasing_plan` today: `grep -rln get_purchasing_plan src` is empty. #1980 adds the first one, so a change to the buy numbers reaches no user before #1980 ships.

## Why the old design failed (facts)

- A crop-program hold row stores only product, quantity, customer, booking id and `expires_at` = section need date + 14 days (`_sync_planned_holds`, `20260702171000`). It has no link to its booking line or to a PO.
- #1989 had those rows claim PO stock, so the plan had to guess which hold belonged to which line and PO. Sol raised a new HIGH on that guess in rounds 5, 6 and 7, and in the Nov 20 review.
- This design never reads a counted booking's hold rows. **The booking line itself is the reservation.**

## Mason's answers (in chat, 2026-11-21, this session)

1. **The app picks** what covers each need. It works this out fresh on every plan read. Nothing is stored, and nobody ties a booking to a PO.
2. **Firm always first.** In Q2 he first answered "first booked wins". After the PO-cut question (Q5) showed that one rule must cover both a cut and a plain shortage, he chose Firm first: orders, jobs and Firm lines take stock ahead of Likely, and Likely ahead of Maybe.
   - **Reverses 2026-11-18 decision "1" (held stock always spoken for).** A Maybe booking's stock can go to a Firm need elsewhere; the Maybe line then shows *not covered* and is not bought for.
3. **A reservation lasts while the booking is open.** Hold expiry does not end it. A line 14 or more days past its need date is flagged *overdue, follow up*.
4. **A late PO keeps its claim and adds no second buy.** The need is flagged *PO arrives late*.
   - **Decision 1: this applies to everything:** orders, jobs, manual holds and bookings.
   - **Reverses the current rule** (`20270127110000`/#1990) that buys for a need whose only PO lands after it.
5. **A PO cut or cancel** gets no special handling. The next read re-allocates under answer 2.
6. **Each booking line claims on its own**, at its own date and confidence.
7. **Decision 2: a draft Planned booking counts exactly like a sent one.**
   - **Reverses the 2026-11-18 "cap it" rule** for draft holds (a draft hold counted as must-buy, even for Maybe).

## Rules

**R1. Demand rows.** Each row carries its source id: booking item, order item, job chemical, hold, or deficit.
- **Open booking lines, after draws.** An open booking is one whose quote has `deleted_at IS NULL` (this applies to every path) and whose status is:
  - `sent` or `revised`;
  - `accepted` and not converted (#1990 test unchanged);
  - `draft` with `is_planned = true` (new: decision 2).
- **Rank by confidence:**
  - Firm → *committed*: bought for.
  - Likely or unset → *could add*.
  - Maybe → *shown*: never bought.
- Orders, active jobs and manual holds → *committed* (unchanged).
- **Negative on-hand:** `deficit = max(-on_hand, 0)` becomes a *committed* "stock deficit" row, dated today. Shelf supply is `max(on_hand, 0)` (Astra re-check 1).
- **Shelf-only holds** reserve shelf stock and nothing else (R3). These are every other active (`is_active`), positive, unexpired crop or job hold whose booking or job is not counted above.
- **A counted booking's or active job's own crop/job hold rows are ignored entirely, with no exception.** That includes:
  - a hold larger than the line;
  - a hold beside a set-aside line;
  - holds next to zero-quantity lines;
  - an active job's hold on a unit-problem line. That job line goes to Check units and reserves nothing (known limit below).

  This settles Sol r7 HIGH 3, Astra 31-33 and 39, and re-check items 2-3.

**R2. One allocation produces both coverage and buying.** This replaces the separate `ev/walk` buy math (Astra 1-5, 64).

Per product:
- **Supply:**
  - shelf (on hand, today);
  - every open non-draft PO line's unreceived quantity (`po_line_id` kept) on its expected date, with no horizon limit (Astra 16);
  - a PO whose date has passed counts on today and is flagged `po_overdue` (Astra 18);
  - an undated PO is late supply after every dated PO, flagged `po_undated`. Like any late cover, it adds no buy (answer 4).
- **Supply order:** shelf, then PO date, PO number, line id. When a row takes "the latest supply by its need date", it takes the latest eligible date. Within that date it takes the first entry in this order, so shelf beats a PO arriving today (re-check 6).
- **Order of demand rows:**
  1. shelf-only holds (they take shelf only, against one shared shelf balance; Astra 24-25);
  2. stock deficit;
  3. committed rows;
  4. could-add rows;
  5. shown rows.
- **Within one rank:** need date first, then source type (manual hold, job, order, booking), then booking created, section, line, then id.
  - A row's need date is its original date, clamped to today when past (as the base `need_date` does); undated rows go last.
  - Shelf-only holds are all dated today and ordered by hold created, then id (re-check 4).
- **Assignment:** in that order, each row takes the latest supply arriving on or before its need date. Once that is used up, it takes the earliest remaining later supply (`late`). Whatever is left is `not_covered`.
  - Higher rank chooses first, even if that makes a lower-rank line late (answer 2; accepted consequence below).
  - Within a rank, earlier need chooses first.
- **Output per row:**
  - `cover[] {source: shelf|po, po_id, po_number, po_line_id, qty, expected_date, late, po_overdue, po_undated}`;
  - `on_time_qty`, `late_qty`, `not_covered_qty`;
  - `status`, by first match: `excluded` (undated or check-units), `not_covered` (any `not_covered_qty`), `late` (any `late_qty`), `covered`. The separate quantities show both the late and the missing parts (re-check 9).
  - Shelf-only holds instead output `held_qty` and `hold_unbacked`. They are never `not_covered` and never buy.
- **Buying:**
  - per product, `suggested` = sum of `not_covered_qty` over committed rows whose need date is in the selected horizon, dated at each row's need date. For a past-due row that is today. Order-by = need date minus lead time, as now (re-check 10-11).
  - `could_add` = the same sum over could-add rows.
  - Late cover never adds a buy (answer 4). Excluded rows never buy.
  - A product where any row was reduced by a draw guess carries `estimated = true` on the product, so its suggestion reads as uncertain (re-check 19).
- **Horizon** filters which suggestions and rows are displayed and summed. It never changes the allocation.
- **Finding flags:** product-level `has_late_cover` and `has_followup`, so the screen can sort and filter them (re-check 18).

**R3. Shelf-only holds** never take a PO and never add a buy. Their unbacked part is reported as `hold_unbacked` for Integrity Cleanup, not as demand.

**R4. Overdue flag.** `overdue_followup` is true when the Chicago business date ≥ the original section need date + 14 days (Astra 19). The line keeps its rank and cover.

**R5. Undated lines** reserve nothing and stay on the Firm-needs-a-date list. Check-units lines also reserve nothing (Astra 17). A rep can promise stock only on a dated line.

**R6. Carried over unchanged:** the safe draw guess, the draw lists, the window fixes and the estimated flag on rows reduced by a guess (old rules 6, 8, 11, from #1989 head `30f880e70`). Security definer, `search_path`, grants and the admin / active sales_rep gate are also unchanged. Every rep already sees the warehouse-wide plan, booking rows and PO list; cover adds no new kind of data (Astra 52).

## Accepted consequence of answer 2 (Astra 7/16, shown to Mason)

Firm gets first pick of the timing too. Example: a Firm need on day 10, a Likely need on day 12, and POs arriving on days 11 and 20. Firm takes the day-11 PO (1 day late) and Likely gets day 20 (8 days late). Swapping them would get Likely there on time, but Firm would be 10 days late. Within Firm, the earlier need picks first.

## Known limits (accepted, not fixed here)

- A job line in a unit that cannot be converted goes to Check units. Its hold then reserves nothing until someone fixes the unit (Sol Nov 20 HIGH 5, now closed by this rule; the hold's units could not be trusted anyway, Astra 38).
- When a booking or job stops counting while its hold is still active, that hold becomes shelf-only and moves first in line. So closing work can briefly raise buying until the hold is released (re-check 15; fixture C17).
- Rollback restores the #1990 body. Buys or promises made while this version was live stay as they are. The PR names the rollback order: hide #1980's cover columns first, then the function, then re-run the smoke (Astra 57).

- The plan is advice. It does not stop a manual hold or an order from taking shelf stock that the plan gave to a booking (Astra 47-48). The Inventory page still deducts crop holds and still ends them 14 days after the need date. Making Inventory match is a follow-up.
- Two buyers can act on the same shortage before either PO is submitted, because draft POs are not supply (Astra 54). This is unchanged.
- One order dated by its first scheduled delivery takes all its remaining stock on that date (Astra 23). A job with one bad chemical line drops its booking draw for that product (Astra 37). Both are pre-existing and listed for a follow-up.

## Existing rows / timing / undo / delivery

- Read-only, with one snapshot per read, so there is no stored state, idempotency key or undo.
- **DB first:** #1989 is rebuilt on its branch. One migration re-emits `get_purchasing_plan`; its preflight is pinned to the body live at build time, re-verified at build (Astra 58), and its rollback restores that body. No screen reads it yet.
- **#1980 next:** it shows cover, late, overdue and not-covered, and treats missing keys as `excluded` (old server).

## Proof cases (real-schema prover, local DB, rollback; today = T, horizon 12 months, lead time 14)

- C1. Firm 100 at T+20, shelf 40, PO 60 at T+7 → shelf 40 + PO 60 on time, suggested 0.
- C2. Same with the PO at T+30 → 40 on time, 60 `late`, suggested 0 (answer 4).
- C3. Shelf 100, Maybe booking 100 at T+10 (created first), order 100 at T → order covered by shelf, Maybe `not_covered` 100, suggested 0.
- C4. Firm A 100 at T+30, Maybe B 100 at T+10, shelf 100, PO 100 at T+20 → A takes the PO and B the shelf, both covered.
- C5. Shelf 0, PO cut from 100 to 40 at T+10, Firm X 60 at T+20, Maybe Y 40 at T+15 → X 40 covered + 20 `not_covered`, suggested 20; Y `not_covered` 40.
- C6. One booking with Firm 40 at T+30 and Maybe 60 at T+90, shelf 40, PO 60 at T+60 → Firm takes the shelf, Maybe takes the PO.
- C7. Firm 10 at T+1, Firm 10 at T+9, PO 10 at T+5 → the first is `late` on the PO, the second `not_covered` 10, suggested 10 dated T+9.
- C8. Shelf −5, no other rows → deficit 5 `not_covered`, suggested 5. Shelf −5 with a PO of 5 at T and an order of 5 at T → the deficit takes the PO, the order is `not_covered` 5, suggested 5.
- C9. A partial line of 10.5 with shelf 2, PO 3 at T+1, PO 4 at T+60, need T+10 → 5 on time, 4 late, 1.5 not covered.
- C10. A Firm line needed T−20, not drawn → `overdue_followup` true and cover kept. At T−13 it is false.
- C11. A draft Planned booking with a dated, unit-valid, undrawn Maybe line of 500 at T+30, its own active crop hold of 500, shelf 13, and an order of 13 at T:
  - the order takes 13, the Maybe is `not_covered` 500, suggested 0;
  - the same after the quote is sent, and after the hold's expiry passes while it stays open;
  - as Likely, 500 goes to `could_add`; as Firm, suggested 500 at T+30;
  - a soft-deleted draft gives nothing.
- C12. A closed booking's active, unexpired hold of 10, shelf 0, PO 20 at T → the hold takes nothing, suggested 0. With shelf 10, the hold takes 10 and an order of 10 at T gets the PO.
- C13. Two shelf-only holds of 10 (created at T−2 and T−1) and an order of 10 at T, shelf 10 → the older hold takes 10, the newer has `hold_unbacked` 10, the order is `not_covered` 10, suggested 10.
- C14. A Firm line on the 1-month horizon's last day, with its PO the next day → the same late cover under a 1-month and a 12-month horizon.
- C15. Conservation, two reads with the input order reversed giving identical JSON:
  - demand rows: on-time + late + not_covered = remaining;
  - shelf-only holds: held + unbacked = quantity, with no PO award;
  - each supply (per `po_line_id`): awards ≤ quantity;
  - excluded rows: no award, no buy.
- C16. The existing #1990 smoke groups: each changed expectation is listed by group number in the PR, with its reason (answers 4 and 7, R2).
- C17. A draft Maybe holding 10, shelf 10, an order of 10 at T → suggested 0. Close the draft with the hold left active → suggested 10.
- C18. Shelf, PO 100 and PO 101 each 10 at T, with a Firm 10 at T → the Firm takes the shelf.
- C19. An order of 10 at T whose only supply is an undated PO of 10 → `late`, `po_undated`, suggested 0.
- P-PB. Prebooked reconciliation before relying on the shelf: a real order with prebooked stock shows its quantity once, as an order row against shelf = `quantity_available` (Astra 49).
- Perf. Plan read time and JSON size on a copy with live-sized data, before and after.
- Denied. A driver, anon and an inactive rep are refused. Nested cover has no cost fields.

## Open business decisions

None. Answers 1-7 are Mason's. The build records the three reversals in `DECISION_LOG.md`: 11-18 decision "1", 11-18 "cap it", and buying for a late PO.
