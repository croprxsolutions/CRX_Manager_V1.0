## 2026-11-23 — F06 / KI-187: PR #2366 closed; the chemical application rebuild must fix it

**Decision (Mason, in chat, 2026-11-23):** close PR #2366 (F06: a linked spray job and blend ticket take stock once) without merging, because Mason is about to rebuild chemical application. KI-187 / #2178 stays open, and every gap below stays on the to-do list (To-Do row 5.8) so the rebuild covers it. Mason: "yes do that and note and record all of this for reasoning and keep items on to do list so we know the gaps".

**Why:** the rebuild replaces the job-completion and blend-ticket posting steps that #2366 guarded with triggers. The trigger design took 6 Sol rounds, and every round found new edge cases in the same rule ("only one of the linked job and ticket takes the stock"), which points to the design rather than the code. Production has 0 blend tickets (read-only check, 2026-11-23), so the double deduction cannot happen live until the office starts linking blend tickets to jobs.

**What this implies:** do not ship blend-ticket-to-job linking for real use until the rebuild (or a replacement for #2366) closes KI-187. The branch `claude/f06-single-stock-deduction` (last head `5982f5431`) is kept for reuse: its real-schema prover `scripts/smoke/prove-f06-job-owns-linked-blend-stock-real-schema.mjs` (cases 0-10, races A-E) passed there and is a ready-made test list. The design contract is `docs/plans/2026-11-23-f06-job-blend-stock-once-CONTRACT.md` on that branch.

### Mason's F06 decisions to reuse or revisit in the rebuild

- (A) When a spray job has a linked blend ticket, the **job** takes the chemicals out of stock; the ticket never takes them again. Rejected: (B) the ticket takes them; (C) whichever records first.
- Decision 3: a ticket unlinked before its job completes is treated as never linked (accepted gap); the office can still correct a wrong link. Rejected: remembering past links.
- Decision 5: the job's own chemical list always counts, even an empty one.
- Decision 6: a job's customer cannot change while a ticket for another customer is linked.
- Consequences accepted with (A): stock comes out at the job's amounts, not the ticket's measured amounts; ticket lot numbers are not copied to the spray record; a ticket linked to the wrong completed job needs an admin to fix it by hand.

### Gaps the rebuild must cover (from the audit, Luna and Sol rounds 1-6)

1. **Core (KI-187):** a linked job's completion and its ticket's Create App Record each deduct stock for the same spray.
2. **Unlink, then both post:** unlinking a ticket before either side posts lets both deduct (Sol r6 #10; accepted gap in decision 3).
3. **Lot trace:** ticket lot numbers never reach the spray record, so Lot Trace can miss the spray; a job-sourced record also shows "Invoiced: No" after direct blend billing (Sol r6 #7 and MED).
4. **Ticket product corrected after the job completes:** the invoice bills the new product while the spray record and stock ledger keep the old one (Sol r6 #8).
5. **Job amounts differ from the ticket:** a short or empty job chemical list leaves stock overstated by the difference (Sol r5/r6 #4).
6. **Deleted job completed from a stale screen:** `complete_job` still completes a soft-deleted job and takes its stock (Sol r3, r6 #9; GitHub #2376).
7. **Deleted ticket posted from a stale screen:** the ticket posting step does not check `deleted_at` (Sol r6 #5).
8. **Job forced to completed without a record:** a job set to completed by a direct update leaves a billed ticket with no stock posting and no ordinary fix (Sol r6 #2).
9. **Completed job moved to another customer:** the old customer's spray record can block the new customer's ticket (Sol r6 #1).
10. **Wrong completed job chosen:** the link cannot be corrected and only ticket-sourced records can be reversed (Sol r6 #3).
11. **Billed ticket on an abandoned job:** no ordinary action can post, cancel or unlink it (Sol r6 #6).
12. **Old cross-customer links:** a pre-existing link to another farm's ticket can block a job's completion (Sol r6 #11; none exist in production).
13. **Complete button:** the office Complete action saves "Start" in a separate request, so a refused completion leaves the job in progress (Sol r6 MED).
14. **Bulk ticket delete:** two people bulk-deleting tickets on the same two jobs can deadlock; PostgreSQL aborts one and a retry works (Sol r1/r6 MED).
15. Taha's review LOWs on #2366 (GitHub #2374) and Sol round 5 MEDs (GitHub #2375).
