## 2026-11-23 — Job screen: a refused write reloads at once and keeps the typed text (#2188 / #2174)

**Decision (Mason, 2026-11-23, two rounds, both in the session):** applies to branch `fix/job-detail-deleted-2188`, the job-screen PR for #2188 and #2174.

**Round 1 ("yes I agree with all"):** four answers.
1. When part of a save is refused while the user was typing, keep the typed text.
2. When a Cancel is refused because the job changed elsewhere, nobody acts from the stale page.
3. When the reply to a Cancel is lost, the screen does not guess who cancelled; the database will record the cancel itself (#2334).
4. A deleted job saved from an earlier tab is accepted for this PR; a follow-up migration will refuse it (#2335).

**Round 2 ("Yes, simpler design"):** this replaces the round-1 "lock the page until Reload" design. Sol round 2 found that a late reply could clear that lock, and that dialogs already open ignored it.
- **On a refused save or cancel:** the job reloads at once and shows the job as saved.
- **Text that was typed but not saved:** read when the reload lands, so typing done during the reload is kept too. It is shown in a copyable "not saved" box until dismissed.
- **A job found deleted:** it locks at once, and any open dialog closes.

**Why:** the stale-page mechanism drew a HIGH in Luna r2, Luna r3, Sol r1, Luna r5 and Sol r2. Under the AGENTS.md round cap, Mason chose the trade-off each time. With no lock left, there is nothing for a late reply to undo, and the page never acts from out-of-date details. The cost is that typed text must be copied from the box and entered again.

**What this forbids/implies:**
- The job screen never keeps an out-of-date form editable after the server refused it as stale.
- Unsaved free text is never silently discarded on that path.
- Never log a lost-reply cancel from the screen.
- Server-side refusal of deleted-job writes (including completing a job, which deducts stock) belongs to #2335. The server-side cancel log belongs to #2334. Reloads after an ordinary save that overwrite typing belong to #2342.
