# Purchasing plan: held stock never reads as free — behavior contract

Read at `origin/staging` `a93fb9e85`. Fixes Sol round 2 HIGH on #1980 and two DB MEDs on #1977.

## Decision (Mason, in chat, 2026-11-18: "1")

Reverses the 2026-11-18 DECISION_LOG rule (2) "a Maybe booking's held stock follows its confidence".
**Held stock always counts as spoken for, but a hold covering its own booking's (or job's) lines never makes the plan buy on its own.** (A draft booking's hold, or one with no counted line of the product, still counts today, but only up to the stock on the
shelf; its rest counts at its booking's need date: rule 7.) If more is
held than the shelf has, the unbacked part stays as the booking line (its own date and confidence), as today.

## Outcome and authority

- `get_purchasing_plan(integer)` re-emitted in one new migration; read-only, `SECURITY DEFINER`,
  `SET search_path = public, pg_temp`, admin or active sales_rep only (unchanged), grants unchanged.
- Files: the new migration, `scripts/smoke/smoke-purchasing-plan.sql` (new proof group),
  `scripts/smoke/smoke-specs.json` (requires), changelog + migration record, `docs/manual/DECISION_LOG.md`.
- No screen change: the screen already renders `kind: 'hold'` rows.

## Rules

1. **Covered hold.** A hold is *covered* when its own source's counted lines of the product are its demand: a
   crop-program hold (active, not expired) whose booking counts a line of the product and has no set-aside line of it
   with quantity > 0; or a job hold whose active job has a convertible line of the product and none that is not.
   Other manual and crop-program holds count today as before; any other job hold is left out as before.
2. **Backed stock.** Per product, `backed = LEAST(sum covered, GREATEST(on_hand - holds counted today, 0))`. Held
   stock is only ever stock on the shelf; a hold with nothing behind it reserves nothing extra.
3. **Allocation.** A covered hold backs its own lines (booking lines after draws, or job lines) in this order: Firm
   and job lines first, then Likely/unset, then Maybe; within that need date earliest first (undated last), then
   section and line. A hold larger than its lines keeps the rest as a last line of its own (no held stock is lost).
   Each line's held part = least of its remaining, its hold's remainder, and the product's backed stock remainder
   (one total order across holds: rank, date, hold type, source, section, line).
4. **Output.** The held part of each line becomes a `hold` row: committed, dated today, with the line's booking,
   section and confidence (or its job). A hold's rest beyond its lines is a `hold` row with its source. The rest of
   each line stays as before (same class, date, bucket). Line qty = held part + rest; nothing double-counted.
5. **Unchanged:** manual holds, crop holds of non-counted bookings and of bookings with a set-aside line, draws,
   orders, POs, the review list (`rev` still uses the line's full remaining). The Firm-needs-a-date list and the
   `needs_date` reason read the lines before the hold split, so a held undated Firm line is still listed.
7. **Cap on holds that count today (Mason, 2026-11-18, "I agree cap it", after Taha's review of #1989).** A manual hold or
   a crop-program hold that is not covered counts today only up to the stock on the shelf (manual holds first, then
   by need date, source, hold). The rest of a crop-program hold counts at its booking's need date, read from the hold's
   expiry less 14 days (as `_sync_planned_holds` sets it), never before today; a manual hold's rest (and a hold with
   no expiry) stays dated today. Covered holds are backed by the shelf left after the capped part. So a draft booking's
   Firm 500 with 13 on hand holds 13 today and 487 at its need date, never "order 487 now" (smoke P28).
8. **Draw order (Taha on #1989).** A draw whose section is unknown (an order's) comes off the booking's lines earliest
   need date first (undated last), then section and line, as `_sync_planned_holds` consumes it. This replaces the
   `20270127110000` least-sure, latest-first rule, so the plan and the holds agree on which line is still open
   (Jan Firm 100 + Mar Maybe 100, 100 drawn, 13 on hand: 13 held, 87 Maybe shown, nothing to buy; smoke P28, P14).
6. **Window MEDs.** A timing window is taken from settings only when both `start` and `end` are valid month-days
   (as `parseTimingWindows` on the screen does); otherwise both fall back to that timing's default. When `end` is
   before `start` (window crosses New Year) and the needed-by month-day is on/after `start`, the window end is in
   the next year.

## Existing rows / timing / undo

Read-only function: no stored rows change, no idempotency key (no writes), no undo. The deployed screen reads the
same JSON shape (no new keys).

## Proof cases (smoke group, real migrated DB via prover, terminal rollback)

- When 100 on hand is all held for a Planned Maybe booking and a Firm order needs 100 today, then suggested = 100.
- When on hand is 0 and a Planned Maybe booking holds 100, then suggested = 0 and the Maybe 100 still shows as Maybe.
- When on hand 60 and a Maybe booking holds 100, then a `hold` row of 60 (committed, today) and 40 Maybe remain.
- When a Firm booking line dated beyond the horizon is fully held and backed, then it is a today hold row, and a
  Firm order of the same qty today is suggested for purchase.
- When a held Firm line has no date, it is still listed under Firm needs a date.
- When a manual hold already takes all stock, a covered crop hold is backed by 0 (no extra hold row).
- When a window is `{start:'11-01', end:'02-15'}` and needed-by is 2026-11-20, window_end = 2027-02-15.
- When a window start is invalid (`'02-30'`), both start and end fall back to the default.
- When a hold of 100 sits beside a Firm line of 40 and an order of 60 is due today, then 100 is held and 60 bought.
- When a job hold of 100 backs its job of 100 at +5 and an order of 100 is due today, then 100 is bought today.
- When 50 is held for one booking's Firm 50 (+30) and Maybe 50 (+10), the Firm line takes it; nothing to buy.
- Existing groups of `smoke-purchasing-plan.sql` still pass unchanged except where they assert the old Maybe rule.

## Astra challenge (gpt-6.2-astra, high): settled

46 findings. Fixed: a hold larger than its lines (surplus line), set-aside lines of quantity 0 (`bla.qty > 0`), job
holds dropped while their stock read free (job holds now covered the same way), Maybe lines taking held stock before
Firm ones (Firm first), a non-total allocation order (source and line added), the `needs_date` reason losing a held
undated Firm line. Declined with reason: draft-booking holds counting now (prior Luna decision); manual holds buying
(unchanged rule); pre-existing integrity cases the sweeps cover; behaviour that is Mason's rule; the window fixes stay
in this PR as the task asked.
