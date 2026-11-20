# KI-119 — Page Access locks report data (behavior contract)

Read at `origin/staging` e4e6e11fa, live read-only 2026-11-19 (Central). Challenged once by Astra (`gpt-6.2-astra` high, 50 findings); settlements below.

## Decisions (Mason, 2026-11-19, in chat)

- Page Access is a **real security control**, not menu tidiness (To-Do decision 16).
- Scope: **actions + reports**. A hidden page blocks that person's ready-made report data and money actions. They still see invoice, job and field information on the screens they keep (Orders, Deliveries, Customers, including the Customer page's year-end summary).
- **Reports now, money later.** This change locks only the Reports Library and Sales Reports data. The invoice and payment actions (Invoices, Record Payments) go to Taha after 2026-12-15, because billing is his area until then.
- KI-120: reps keep access to payment terms, finance-charge settings, parent customer and default application service. Close as accepted; no code.
- OPEN (asked 2026-11-19): logbook reports refuse every role except admin and sales rep, and refuse signed-out callers.

## Facts (live, 2026-11-19)

- `profiles.denied_pages text[] NOT NULL DEFAULT '{}'`. Only admins change it through the app; `admin_update_profile` clears it when the role becomes admin. One active sales rep has 9 keys denied, including `reports` and `sales-reports`.
- Today only the screen router reads it (`src/lib/pagePermissions.ts` `hasPageAccess`: admin passes; otherwise the role must be allowed for the page and the key must not be denied).
- Report functions reachable by a rep, and what this change does:

| Function | Live access today | This change |
|---|---|---|
| `get_profitability_report`, `get_inventory_cost_report`, `get_gross_sales_report`, `get_bottom_line_pnl` | `require_admin()` | none (already admin-only) |
| `get_commission_history_report` → `get_commission_balance_report` / `get_commission_payment_detail_report`; `create_commission_payment` | `require_admin()` / admin check | none (already admin-only) |
| `get_customer_balance_listing`, `get_chemical_history` | DEFINER, admin or sales_rep | add page check `reports` |
| `get_batch_year_end_summaries` | DEFINER, no own check; inner `get_customer_year_end_summary` allows reps, so a rep can pull every customer's summary at once | add page check `reports` (the only other caller, Month-End Close, is admin; admins always pass) |
| `get_customer_year_end_summary` (one customer) | admin or sales_rep | none: the Customer page uses it (Mason's scope) |
| `get_logbook_faa`, `_by_field`, `_by_customer`, `_by_applicator` | SQL INVOKER; EXECUTE to PUBLIC, `anon`, `authenticated`; rows limited by table RLS | wrap with a check (see Authority); revoke PUBLIC/`anon` |
| `get_sales_summary_report`, `get_sales_detail_report` | DEFINER; impl allows admin or sales_rep | add page check `sales-reports` |

- **Known limit (part of Mason's scope):** a denied rep can still read the orders and invoice rows RLS gives them on their own screens, and could add them up by hand. The lock removes the ready-made reports, not the rows.

## Outcome and authority

- New internal helper `public._require_page_access(p_page text)`. It runs `SECURITY DEFINER` with `search_path = public, pg_temp` and reads the caller's own profile (`auth.uid()`). It raises `PAGE_ACCESS_DENIED: <page>` when there is no signed-in user, no profile, an inactive profile, a role not allowed for that page (`reports`, `sales-reports`: admin and sales_rep), or the key in `denied_pages`. Admins always pass. It mirrors `hasPageAccess`, including the legacy aliases (none exist for these two keys).
- Grants: the helper is revoked from PUBLIC and `anon` and granted to `authenticated`. The INVOKER logbook functions must be able to call it. It only reveals the caller's own access.
- The DEFINER report functions call `PERFORM public._require_page_access('<key>')` first. Each is re-emitted from the **live** body (`pg_get_functiondef`, captured in the PR), not copied from an old migration. Only the guard line is added.
- The logbook SQL functions keep their INVOKER bodies, so RLS still limits rows. Each becomes a `plpgsql` INVOKER wrapper: call the guard, then return the same query. Identical columns and ordering.
- Precedence: the page check runs first, and the function's own existing checks are unchanged after it.
- The caller passes no page key or actor; the server derives both. Calls are read-only, so no idempotency key, receipt or undo applies. To undo a lock, an admin removes the page from the person's deny list (existing Settings screen), and the next call succeeds.

## State and failure

- Existing rows: an empty list means no lock. Unknown or legacy keys are ignored. Switching a person to admin clears their list (existing behavior, unchanged); switching them back to rep starts with an empty list, so the admin must re-hide pages.
- Timing: each call reads the deny list committed when the call starts. A report already on screen stays visible until the next load; the next load is refused, and the screen shows the existing error toast. Acceptable for a read-only report.
- Rollout: the deployed app already hides both pages from the denied rep, and admins and other reps keep their results. The change is one database migration in one transaction with a postflight that asserts every guarded function contains the guard call and the helper's grants. Rollback is a follow-up migration that re-emits the captured pre-change bodies.

## Delivery

- One migration PR to `staging` (Sol required: database), plus the ledger record and KI-119/KI-120/To-Do 16 and 18 doc updates. It merges only after release #1990 is live (staging freeze). No screen PR.
- Invoice and payment actions for denied pages: a new KI item for Taha after 2026-12-15.

## Proof cases (local migrated database, signed in as each role)

1. When a rep with `reports` denied calls `get_customer_balance_listing`, `get_chemical_history`, `get_batch_year_end_summaries` and each logbook function, then each refuses `PAGE_ACCESS_DENIED: reports`.
2. When a rep with only `sales-reports` denied calls both sales functions, then they refuse; that rep's `reports` functions succeed.
3. When the denied rep calls `get_customer_year_end_summary` for one customer and reads that customer's invoices, then both succeed as before.
4. When an admin with an empty list, and a rep with nothing denied, call every guarded function, then the results equal the pre-migration results on the same data. Cost columns stay hidden from the rep.
5. When a driver or applicator calls a logbook function, then it refuses *(depends on the OPEN decision)*.
6. When a signed-out caller calls a logbook function or the helper, then it is refused.
7. When an inactive rep's session calls a guarded function, then it refuses.
8. When an admin removes `reports` from the rep's list, then the rep's next call succeeds.
9. Postflight: every guarded function's live body calls the helper; no PUBLIC or `anon` execute remains on the helper or the logbooks.
10. Browser: an admin's Reports and Sales Reports load every report. A rep without denials loads both pages. The denied rep is redirected away from both.
