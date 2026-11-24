## 2026-11-24 — #2324: proof binding still ships separately

**Decision (Mason, 2026-11-24):** Mason confirmed that the 2026-11-23 decision for PR #2324 still stands after #2324 caught up with staging. #2324 lands without binding a delivery's signature or paper ticket to the exact products signed for. That binding ships as its own database PR, then a screen PR.
**Why:** unchanged from 2026-11-23: holding #2324 for the binding would delay the delivery line checks that land here.
**What this implies:** until the binding PRs ship, a delivery completed after an empty-load refusal may carry proof captured before products were added. #2324 still needs Taha's OK before merge.
