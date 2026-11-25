## 2026-11-23 — #2324: delivery proof binding to signed-for products ships separately

**Decision (Mason, 2026-11-23):** PR #2324 (F05b delivery line checks) lands without binding a delivery's signature or paper ticket to the exact products the screen showed. After an empty-load refusal, Mark Delivered can still reuse that earlier proof once dispatch adds products. Mason skipped Sol's findings on this in earlier rounds and in round 7 (owner-accept ref 565311 at `bd06a4d1ac26`).
**Why:** that binding is its own change: a database PR first, then a screen PR, owned by the "Tie delivery proof to the products signed for" work. Holding #2324 back for it would delay the line checks that do land here.
**What this implies:**
- Until those follow-up PRs ship, a delivery completed after an empty-load refusal may carry proof captured before the products were added.
- #2324 still needs Taha's OK before merge, because it redefines the completion step that creates chemical-sale invoices.
