## 2026-11-05 — Dashboard action groups get true counts from the database (Goal 4 H36)

- New migration `20261109120000_dashboard_action_true_counts.sql` (not yet applied): `get_dashboard_action_items` now also returns the true number of records in each action group, so the dashboard can say "Overdue Invoices (37)" instead of stopping at the ten rows it shows. The rows it returns are unchanged.
- Proof script `scripts/smoke/prove-dashboard-action-counts-real-schema.mjs` (scratch container, every group seeded above ten).
- The dashboard screen change that reads the counts ships in a separate PR after this is live.
