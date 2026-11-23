## 2026-11-23 — Job screen: a refused write locks the page until Reload (#2188 / #2174)

**Decision (Mason, 2026-11-23, in the session and relayed: "yes I agree with all"):** on branch `fix/job-detail-deleted-2188` (the job-screen PR for #2188 and #2174), all four recommended answers apply:
1. If part of a save is refused while the user was typing, keep the typed text on screen but lock the page with "Reload to continue".
2. If a Cancel is refused because the job changed elsewhere, lock the page the same way. Invoice, customer notices and print stay hidden until Reload.
3. If the reply to a Cancel is lost, the screen does not guess who cancelled. The database will record the cancel itself (#2334).
4. A deleted job saved from a tab opened earlier is accepted for this PR. A follow-up migration will refuse it (#2335).

**Why:** Sol round 1 found five HIGHs, and the "keep typing after a refused save" mechanism had drawn a HIGH in three rounds (Luna r2, Luna r3, Sol r1). Under the AGENTS.md round cap, patching stopped and Mason chose the trade-off. A locked page cannot save, invoice or email from out-of-date details. The cost is that text typed during a refused save must be copied out before Reload.

**What this forbids/implies:**
- The job screen never lets a user keep editing, or act, from a form the server has refused as stale.
- Unsaved text stays visible but read-only until Reload.
- Never log a lost-reply cancel from the screen.
- Server-side refusal of deleted-job writes, and the server-side cancel log, belong to #2335 and #2334.
