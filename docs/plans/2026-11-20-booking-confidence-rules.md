# Booking confidence rules — agreed by Mason, Nov 20, 2026

Published at Mason's request (Nov 20, 2026). Decided in a brainstorm session (Q1–Q7, then "Yes, save it").
Replaces draft assumption A3 and Nov 20 decision 1 in the inventory plan (`docs/plans/2026-11-20-inventory-purchasing-and-bookings-PLAN.md`, now v5).

## Rules

1. **Three choices per booking section:** Firm, Maybe, or blank (shown as "Just quoting"). **Likely is removed.**
2. **Firm** = the grower said yes ("I'm using it, have it here"). The rep sets it on judgment; no signature or prepay needed. Firm drives suggested buys and sets stock aside (holds).
3. **Maybe** = possible, not promised. It never buys and never holds. The Purchasing tab shows a **grand total of Maybe per product** (and per month) for planning.
4. **Blank = Just quoting.** It counts nothing anywhere (stock, buying, holds), even after the quote is sent or emailed. Reps can mass-make quotes before meeting growers.
5. **Returnability no longer affects buying.** Only Firm buys. The Nov 20 rule "a product is returnable unless labelled no-return" stays on record but has no role in purchasing.
6. **Changes take effect at once.** Any rep can change a level via Revise; every change is logged (who, when, from, to).
   - Firm → Maybe or blank: the hold is released right away and the amount leaves the buy (stock already bought shows as surplus).
   - Maybe or blank → Firm: the hold is created right away. If stock is short, the soonest-needed grower gets it first and the gap shows as a buy.
   - Scheduling a spray job still makes its section Firm.
7. **Switch-on, one time:** **sent or revised** bookings with the old Planned Program switch on become Firm (they already hold stock). Other sent or revised bookings become Maybe. Drafts stay blank. Only blank sections that still have something owed are marked; a level someone already chose is kept. Each auto-marked section is tagged "set at switch-on" so reps can review it. The Planned Program switch is retired.
8. **What reps see:** a badge on each section (Firm / Maybe / Just quoting). On Send or Revise with blank sections, a reminder says "These sections are just a quote and won't reserve or buy stock" and lets them continue (never blocks). Admins get a "sent, still just quoting" list on Purchasing.
9. **Follow-on rules (decided by Claude, consistent with the above):**
   - A duplicated booking starts **blank** (was: Maybe), so the same grower is never counted twice, including in the Maybe total. Phase B's send-time "is this additional?" check on a duplicate stays. Roll over keeps the level; the old booking stays open and counted until the new one is **sent** (Phase B B7, unchanged).
   - Season-end **expiry** (not "close": nothing is marked delivered) applies to sent bookings whose sections are all Maybe or blank, with nothing still drawn and no live jobs. Phase B's prepay exception stays.
   - Unknown draws come off blank and Maybe lines first (one tier, latest-needed first), then Firm. A draw that names its line always comes off that line.
   - Any staging-only "Likely" sections become Maybe. Live has none (the confidence column is not live yet).

## Clarifications after Sol review (Nov 20, gpt-6.2-sol high, 57 findings; raw review kept in private working notes)

These sharpen the rules above. None changes what Mason chose.
- **C1 [Sol 1].** "Only Firm buys" means Firm is the only *booking level* that buys. Open orders, scheduled spray jobs, manual holds and negative stock still create buys as today.
- **C2 [Sol 11].** Firm sets stock aside only on a booking that can hold: sent, revised, or accepted with no order (Phase B). A Firm section on a draft is saved but holds nothing until the booking is sent.
- **C3 [Sol 17–20].** A spray job can be scheduled from a Firm, Maybe or blank section of a sent, revised or accepted booking. Scheduling makes it Firm in the same save. If a Firm section with a live job is later set to Maybe or blank, only the rest not on the job is released; the job's own amount stays counted.
- **C4 [Sol 7, 9, 10].** The Maybe grand total = every open Maybe amount after draws. Undated, past-window and wrong-unit amounts are shown on their own lines, not hidden. Blank sections leave the timing review list and appear only on the admin "sent, still just quoting" list, one row per section, admins only (enforced by the server, not just the screen).
- **C5 [Sol 3, 4, 5, 27, 28, 29, 33].** Unchanged from settled plans and carried forward as-is: soonest-needed Firm gets scarce stock first, ties go to the booking sent first, holds are never refused; "Firm, needs a date" list; wrong-unit lines never count; manual holds need a date; "use the held stock" on same-customer orders; D5 with the Oct 1 release (Q7).

## What this changes in waiting work

**Plan A PR 3 (Likely rule): CHANGED.**
- Remove the Likely rule. Only Firm (plus orders, jobs and holds) counts toward `suggested`. Blank sections count nothing, and Maybe is shown only.
- Assumptions A2 (no-return classification for the Likely rule) and A3 (unset counts as Likely) are both dropped. PR 3 needs no returnability logic.
- The "Likely column" becomes a **Maybe total column**: per product and per need month, after draws, "shown only".
- Proof case 3 in the Definition of done is rewritten: Maybe 100 never changes `suggested`, and the column shows 100. A blank section shows nowhere.
- T1a's cap note [C30] ("June Likely that A3 makes buy-eligible") no longer applies. The cap still covers all classes.
- #1989 rebuild notes [B72, C13] about "Likely" become "Maybe": a held receipt keeps the line's class and is never upgraded to committed.

**Taha's T2 (Firm-only holds): rule KEPT, details CHANGED. Recommendations for Taha, not builds.**
- Firm-only holds stand, as do level changes syncing holds at once on save.
- T2's reconcile must run the one-time auto-mark (rule 7) **before** deactivating holds. Otherwise today's Planned-program holds on sent bookings would be wrongly released. Drafts lose their holds as planned.
- "Deactivates Likely, Maybe and draft holds" becomes "Maybe, blank and draft holds".
- The `quote_sections.confidence` CHECK drops `likely`, with staging rows mapped to Maybe. The save writer and the #1980 picker (Firm / Maybe / Just quoting) change with it. The quote save writer is Taha's through Dec 15.
- Phase B plan items that change: B7 Duplicate copies as **blank**, not Maybe. Season-end auto-close follows rule 9. The draw order (Maybe/blank before Firm) is unchanged in effect.
- Rule 8's Send reminder and "sent, still just quoting" list are quote-screen work (Taha's area, or after Dec 15).

**Order of landing [Sol 43, BLOCKER]: the one-time switch-on marking must run before (or together with) Plan A PR 3.** PR 3 stops showing blank sections. If it lands first, today's Planned bookings (still blank) would vanish from Purchasing until T2 marks them. Recommendation: split the switch-on marking out of T2 into its own small step placed before PR 3 in the shared queue. It writes quote sections, so it is Taha's area through Dec 15; Taha decides.

**Hold drops need Mason's approval at apply [Sol 45].** Drafts losing their Planned holds is a drop in active holds. Under plan v4's T2 gate, Mason's `I approve` is needed. The before/after list is kept per grower, booking, line and product, not just per product total.

**Pre-existing plan conflicts Sol found, not caused by these rules (for Taha):** manual release of a booking hold is "blocked" in Phase B but T2's proof releases one [Sol 29]; Phase B v3 vs the release code on unknown draws [Sol 23]; late POs in T3's warning [Sol 56]. The rest of Sol's 57 are build details already in T2/PR 3's own contracts, or carry-forwards listed in C5.

**Unchanged:** D3 (only Firm holds), D5/D6, the Q4–Q7 answers, and orders, jobs and manual holds.
