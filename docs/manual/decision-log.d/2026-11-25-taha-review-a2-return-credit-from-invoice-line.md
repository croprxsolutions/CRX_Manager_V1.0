## 2026-11-25 — A2: a return credits the price on the exact posted invoice line

**Decision (Mason, reply to Taha's 2026-11-25 chemical-side review posted in #crx-work; "Yes, record them"):** a return's credit is priced from the exact posted invoice line it reverses (or a line staff pick), not from the order price and not from a "newest invoice" default. Build it on #2537's `priced_from`.
**Why:** today a return credits the order price, so when the invoice price was lowered after the order, the grower gets back more than they paid (Taha's A2). Guessing the newest invoice can pick the wrong price.
**What this forbids/implies:**
- No default to the newest invoice; the credit points at one posted invoice line.
- Ship A2 together with decision 17 (a return marked Damaged or opened clears "restock"; staff can tick it back on).
- Returns are Taha's lane until Dec 15.
