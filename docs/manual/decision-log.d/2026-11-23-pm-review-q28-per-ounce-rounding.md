## 2026-11-23 — Product Master review Q28: accept per-ounce price rounding

**Decision (Mason, in chat, 2026-11-23: "Accept rounding"):** job lines keep pricing per rate unit in whole cents, so a per-gallon price that does not divide evenly rounds (for example $40/gal = 31.25¢/oz).
**Why:** Mason accepts whole-cent per-ounce rounding: at most half a cent per ounce, but on every ounce billed, and it can go either way. $40/gal bills at 31¢/oz, $39.68 a gallon (0.8% under); cheap bulk products round hardest (up to ±10.7%, F-B in `docs/audits/2026-08-19-chem-unit-findings-and-plan.md`). Storing a separate sell-unit price is not worth it now.
**What this forbids/implies:** do not add a sell-unit price store for this. Revisit only if a customer questions a bill.
