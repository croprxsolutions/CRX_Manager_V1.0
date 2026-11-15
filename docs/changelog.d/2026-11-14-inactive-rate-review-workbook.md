## 2026-11-14 - Inactive product rate history in review workbooks

- Rate Review now downloads an explicit v3 workbook with a validated active/inactive label on both sheets. Inactive groups remain history and cleanup only: approved rates may be reopened, drafts deleted, and existing outcomes cleared; values and fresh outcomes cannot be changed.
- New rates typed by name resolve against active groups only. Existing v2 workbooks remain uploadable with their original headers, hidden identity records, row counts, and server-side checks.
- The modal keeps active readiness totals separate and summarizes inactive history counts. The server remains authoritative for activity and every submitted action.
- The v3 screen explicitly calls `get_rate_review_workbook(p_include_inactive := true)` and depends on the paired database signature. Do not serve this frontend before the migration providing that signature is applied and verified; release order remains governed by the staging and protected migration gates.
- Upload errors follow #1888: each bad cell on a v3 row (activity label, decision, outcome, Reconfirm, inactive-history rules) is reported beside the others instead of one hiding the rest.
