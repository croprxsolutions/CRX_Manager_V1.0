## 2026-10-29 - Product Master work saved for later: START HERE and the build loop

Added `docs/plans/2026-10-29-product-master-START-HERE.md`. It is the one place to restart the Product Master work, and holds:
- the list of plan documents;
- a summary of Mason's decisions;
- the checks to do before starting;
- a ready-to-paste prompt for the build session.

Added the overnight build loop as `docs/plans/2026-10-28-product-master-loop-MISSION.md`. It passes the mission-doc validator, and is marked "ready, not started" because Mason chose not to start the build yet. It now creates a dated coordinator branch at start and checks for changes on `main` since the plan was written. It supersedes the first draft on the unmerged `loop/product-master-2026-10` branch.

Documentation only; no application, database or business-data changes. Nothing is built.
