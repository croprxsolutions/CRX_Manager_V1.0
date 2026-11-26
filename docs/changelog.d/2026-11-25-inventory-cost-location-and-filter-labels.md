## 2026-11-25 — Inventory Cost shows barns; report filters get names

- Reports › Operational › Inventory Cost: a Location column names the barn for each stock row, the count reads
  "Products: 2 (3 stock rows)" (distinct products), and the CSV gains Location. Migration
  `20270309150000_inventory_cost_report_location` adds `location` to `get_inventory_cost_report()`; access unchanged.
- Inventory Cost is current stock, so its date boxes are replaced by "Current stock as of now. Dates don't apply to
  this report." Other report tabs keep their dates.
- Sales Reports (Start Date, End Date, Sales Rep, Category, Season) and Program Tracker (Season, Customer, Status)
  filters announce their captions to screen readers.
- Source: free-screens audit `C:\CRX_wt\codex-reports\free-screens-crawl.md` (2026-11-25).
