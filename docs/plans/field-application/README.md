# Field application build kit

Everything an agent needs to build the field application system (scheduling → mixing → spraying → office review → per-payer invoices) without Mason watching each step.

| File | What it is |
|---|---|
| `SPEC.md` | The whole design, every decision tagged with where it came from |
| `SOL-FINDINGS-PLAN.md` | Sol's 88 design findings and what was decided for each |
| `GAP-CHECK.md` | What CRX already has, item by item, with code evidence |
| `SCENARIOS.md` + `scenarios-calc.py` | Exact-cents and stock test cases every build must prove |
| `WAVES.md` | Build order: foundation first, which lanes can run at the same time |
| `CONTRACT-batch-stock.md`, `CONTRACT-field-billing.md` | How money and stock must behave, settled before code |
| `GOALS.md` + `docs/loops/field-app-*.md` | Briefs for each goal session; launch with `/run-loop` |
| `PROGRESS.md` | Where every item stands |
| `MORNING-QUESTIONS.md` | Business questions waiting on Mason |
| `SOL-KIT-REVIEW.md` | Sol's review of this kit and what was accepted or rejected, with reasons |

Order of authority for **what to build**: Mason's latest answer → `SPEC.md` → contracts → `WAVES.md` → everything else. Current code and live read-only evidence say **what exists today**; a difference the kit does not name stops the item (`GOALS.md` rule 2).
