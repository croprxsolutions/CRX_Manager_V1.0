## 2026-11-26 — Undone application record numbers are never reused; Sol round 7 allowed on #2679

**Decision (Mason, 2026-11-26, in chat: "yes fix and run 7"):** On #2679, a legal application record number freed by Undo Filing is retired and never given to another filing; the next filing takes the next number. The cheap Sol round 6 items are fixed (Undo can only act on the ticket on screen; a ticket that moved no stock says so). Cross-device retry replay, a cycle count between a wrong filing and its undo, undo/invoicing deadlock, the deploy window and the database-only rollback window stay accepted limits. Sol may run round 7 on #2679.
**Why:** Sol round 6 found that the number generator takes the highest surviving number, so undoing the newest filing let another farm's filing reuse a number already on exported paperwork.
**What this forbids/implies:** this covers round 7 only. A round 8 needs a new decision from Mason.
