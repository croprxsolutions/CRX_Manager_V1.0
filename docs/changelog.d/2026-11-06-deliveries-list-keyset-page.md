## 2026-11-06 — The Deliveries list can page by bookmark, so no delivery is skipped (Goal 4 follow-up, database half)

- New migration `20261202100000_deliveries_list_keyset_page.sql`: read-only `get_deliveries_keyset_page` returns the Deliveries list page after a bookmark of the last row shown (`p_after` = the previous page's `next_cursor`). Paging by position skipped a delivery whenever one left the list between pages (cancelled, voided, or edited out of the filter), the same bug the Orders list had. `get_deliveries_page` keeps its arguments and now calls the new function, so screens already loaded and full reads keep working. SECURITY INVOKER, so each role still sees exactly what it saw. Nothing calls the bookmark yet.
- Proof: `scripts/smoke/prove-deliveries-page-real-schema.mjs` section 11; new live smoke chain `smoke-goal4-deliveries-keyset-page.sql`.
- The Deliveries screen switches to the bookmark in a separate PR after this is live.
