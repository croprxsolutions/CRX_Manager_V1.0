# Field application build kit

Everything a session needs to build field application (scheduling → loading → spraying → office review → per-payer invoices). **Master copies only: each file holds Mason's newest answers; older answers live in git history.** This kit must be in `origin/staging` before any build session starts (`BUILD-PLAN.md` › Slice 0).

| File | What it is |
|---|---|
| `SPEC.md` | What Mason wants, stage by stage, and the decisions register |
| `CONTRACT-who-pays.md` | Field splits, payer notes, the Chem Man import, billable acres, archiving, jobs carrying splits (FP-1 to FP-4); grants and retry rules for every contract |
| `CONTRACT-batch-stock.md` | Loads and stock |
| `CONTRACT-field-billing.md` | Invoices, rounding (same as chemical sales), posting, corrections, switches |
| `SCENARIOS.md` + `scenarios-calc.py` | Exact-cents and stock cases every build must prove (`python -I scenarios-calc.py --check`), and the first-job hand-check list |
| `BUILD-PLAN.md` | Go-live order, slices, PR order, lanes, brief outlines, gates, what moved to spring |
| `PROGRESS.md` | Where every item stands, and Mason's batch of asks per slice |

When files disagree: Mason's latest answer → `SPEC.md` → contracts → `BUILD-PLAN.md`. A new answer from Mason replaces the old one in the same PR; never keep both.
