## 2026-11-25 — Blend-ticket reader: land the simpler version (#2530)

**Decision (Mason, 2026-11-25):** after Sol round 4 on #2530, land the blend-ticket line reader with the round-3 parser patches undone and a blank unit when the matched product has a number the scanned name lacks. A rep confirming each scanned product line before filing is a follow-up.
**Why:** each review round found a new OCR layout case, and two round-3 patches created new ones. The blank unit (2026-11-24 strict rule; 2026-11-25 the rep fixes the whole line) is what stops a guessed line from being filed or deducted.
**What this implies:** an exact line (rate and total, each with a known unit) imports the total; every other line arrives with a blank unit that the filing function refuses until a rep sets it. Contract: `docs/plans/2026-11-24-blend-ticket-total-not-rate-CONTRACT.md`.
