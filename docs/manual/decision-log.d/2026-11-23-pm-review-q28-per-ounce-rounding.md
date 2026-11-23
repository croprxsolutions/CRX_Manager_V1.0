## 2026-11-23 — Product Master review Q28: accept per-ounce price rounding

**Decision (Mason, in chat, 2026-11-23: "Accept rounding"):** job lines keep pricing per rate unit in whole cents, so a per-gallon price that does not divide evenly rounds (for example $40/gal = 31.25¢/oz).
**Why:** the rounding is under a cent per ounce; storing a separate sell-unit price is not worth it now.
**What this forbids/implies:** do not add a sell-unit price store for this. Revisit only if a customer questions a bill.
