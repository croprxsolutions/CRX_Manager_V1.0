## 2026-11-25 — A1: an edited order keeps each existing line's booked cost (decision 6 reaffirmed)

**Decision (Mason, reply to Taha's 2026-11-25 chemical-side review posted in #crx-work; "Yes, record them"):** decision 6 (2026-11-22) stands and goes further than Taha's A1 proposal: an existing order line keeps its booked cost even when someone edits that line. Only a new product line or a product swap takes today's cost. The kept cost is held on the server, not by the screen.
**Why:** today saving an order edit re-reads today's catalog cost for every line (Taha's A1, proven with a test), which moves profit and pending commission on lines nobody changed. See `docs/research/2026-11-25-workflow-review-decision-6-correction.md`.
**What this forbids/implies:**
- Changing quantity or price on an existing line never re-stamps its cost; only adding a product or swapping one does.
- The server decides which cost to keep; a cost sent by the screen for an existing line is not trusted.
- Orders are Taha's lane until Dec 15; A1 is in his before-Dec-15 list.
