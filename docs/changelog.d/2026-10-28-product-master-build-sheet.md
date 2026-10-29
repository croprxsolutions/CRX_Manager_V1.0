## 2026-10-28 - Product Master build sheet, reviewed by Sol

Added `docs/plans/2026-10-28-product-master-BUILD-SHEET.md`, the game plan for the 43 Product Master backlog items. It groups them into 16 work packages, each with an approach, a "Done when" checklist, its size and database impact. The weight-per-gallon and active-ingredient steps follow.

An advisory `gpt-6-sol` review returned 36 findings, all folded in. The main changes:
- business rules are enforced in the database from the start;
- write paths are proven on a schema-matched local database;
- the unit field is audited before any back-fill (the one BLOCKER);
- change history comes first;
- several packages are split.

The backlog now points to the sheet.

Documentation only; no application, database or business-data changes. Nothing is built.
