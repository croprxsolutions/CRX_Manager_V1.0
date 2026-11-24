# Field application build kit

Everything a session needs to build field application (scheduling → mixing → spraying → office review → per-payer invoices). **Master copies only: each file holds Mason's newest answers; older answers were removed on 2026-11-24 and live in git history.**

| File | What it is |
|---|---|
| `SPEC.md` | What Mason wants, stage by stage, and the decisions register |
| `CONTRACT-who-pays.md` | Field splits, billable acres, archiving, jobs carrying splits (FP-1 to FP-4) |
| `CONTRACT-batch-stock.md` | Loads and stock |
| `CONTRACT-field-billing.md` | Invoices, rounding (same as chemical sales), posting, corrections |
| `SCENARIOS.md` + `scenarios-calc.py` | Exact-cents and stock cases every build must prove (`python -I scenarios-calc.py --check`) |
| `BUILD-PLAN.md` | Slices, order, lanes, gates, what moved to spring, open questions |
| `PROGRESS.md` | Where every item stands |

When files disagree: Mason's latest answer → `SPEC.md` → contracts → `BUILD-PLAN.md`. A new answer from Mason replaces the old one in the same PR; never keep both.
