## 2026-10-15 — Goal 4 step 1: a list of every place that stops at a row limit

New audit: `docs/audits/2026-10-15-goal4-row-limit-inventory.md`. This is the first step of Goal 4 ("Complete, correct numbers at any volume") in `docs/plans/2026-10-13-direction-and-goals.md`. It lists every list, picker, report, export, dashboard and integrity check that stops at a row limit. That includes database functions, Edge Functions, the 200-row payment history, and queries cut off by the server's 1,000-row ceiling.

For each one, the audit gives the file and line, the cap, whether the screen warns, whether a money total is affected, and a severity. It ends with a suggested fix order.

The main findings:
- 28 money totals are summed from a list that gets cut off.
- 9 integrity checks read only part of the data, along with several compliance records.
- One problem is live today: 595 active products, but four product lists load only 500.

Nothing was fixed. The live database was read with SELECT only, and Codex (`gpt-6-luna`, xhigh) cross-checked the list as an advisor. The fixes come in later Goal 4 pull requests.
