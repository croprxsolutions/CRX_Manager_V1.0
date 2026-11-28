## 2026-11-24 — A product with no EPA number prints a dash, not "Unknown" (KI-195 follow-up)

**Decision (Mason, 2026-11-23, Slack reply to Taha):** "a dash for products that never had an EPA number." Spray-job printouts are field application, Mason's area.
**Why:** after #2330 a sprayed job printed "Unknown" (and the customer email "EPA Reg. No. Unknown") for every adjuvant or fertilizer, which never has a number; before the spray the same product prints a dash.
**What this forbids/implies:** `jobEpaText` (`src/lib/jobEpa.ts`) prints "—" for a product the job kept with no number, on the Chemical Application Report, applicator sheet, WPS notice and proof email. "Not recorded" (jobs sprayed before numbers were kept) is unchanged.
