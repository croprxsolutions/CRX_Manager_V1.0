## 2026-11-25 — Record Payments: Pay full balance never fills in the check amount (#2438)

**Decision (Mason, 2026-11-25, in chat: "no autofill"):** on Record Payments, "Pay full balance" no longer fills a blank check amount with the balance owed. The user types the amount from the paper check first; the button then fills every open invoice with its balance, and any extra becomes prepay credit. It stays off until an amount is typed.
**Why:** the auto-fill raised a Sol HIGH in three rounds on #2438 (rounds 1, 3 and 4). The last one: a check already posted for $400 could be re-entered blank, filled with the $600 still owed, and booked again, because the duplicate warning matches the check number and the amount together. Mason chose removing the auto-fill over warning on any reused check number.
**What this forbids/implies:** no screen fills a check or payment amount from a balance owed; the amount always comes from the user. Sol round 5 on #2438 runs to check this change. A new BLOCKER/HIGH there goes back to Mason before another round.

**Also decided 2026-11-25 (Sol rounds 10-11):** Record Payments shows the picked customer's account number under the box, and switching to a different customer clears the typed check amount, reference and notes, so one farm's check is never posted to another. Mason: "Yes, fix it" and "Yes, clear them".
