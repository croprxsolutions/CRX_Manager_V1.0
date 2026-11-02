# Cost and margin: owner-rights function audit (KI-02, KI-74, To-Do 11.3)

**Date:** 2026-11-02. **Evidence:** live, read-only catalog reads on project `rhyzpcqhnizqbxphqdkr` (`pg_get_functiondef`,
`has_function_privilege`, `pg_policies`) and row counts only; no function was run live and no cost value was read.
**Rule audited:** Mason, 2026-10-15: cost, profit and margin are admin-only, including on a rep's own work.

## What changed

**Status: live.** Migration `20261102200000_cost_definer_leaks_closed.sql` was applied live 2026-11-02 18:39 UTC
(12:39 PM Central), ledger `20261102183928`, and the Inventory screen change shipped in PR #1290. The post-apply
read-only check was clean, and the `cost-exposure-review` sweep returned 114 rows, 0 unreviewed.

The migration, proven against the real schema by
`scripts/smoke/prove-cost-definer-leaks-closed-real-schema.mjs`, changes four functions so that only admins get cost:

| # | Function | Change |
|---|---|---|
| 1 | `get_dispatch_board_jobs` | No longer sends the job's cost field to anyone. No screen used it; admins read job cost through `get_admin_cost_fields`. |
| 2 | `manual_inventory_add` | No longer writes a purchase cost into the inventory note; the Inventory screen's "Unit Cost (optional)" box is removed. |
| 3 | `complete_job` (failed automatic draft invoice) | The activity-feed entry records only the refusal's name, not its detail. |
| 4 | `create_order_from_blend_ticket` (order total check) | The error names the totals only to an admin. |

Owner-rights (SECURITY DEFINER) functions run as the database owner, so the 2026-10-25 column lock
(`20261022101000`) cannot limit them; each must protect cost itself.

**KI-74 parts now settled:** the dispatch path is change 1. Field billing, delivery and offline-sync paths give an
applicator or driver no cost (batch D below). `blend_recipe_items` cost was closed by the column lock.

**Decided by Mason (2026-11-02):** existing inventory notes are left as they are; no new note gets a cost.
**Accepted by Mason on 2026-10-21, not re-opened:** commission amount plus rate implies profit, and below-cost
refusals let a rep narrow a cost by trial and error. `admin_set_application_service_cost` remains a retire candidate.

Lower-priority notes (none a cost leak today), review deferrals and non-cost access gaps noticed along the way are
held in Mason's private notes until they are fixed or decided; the ownership work is tracked under KI-03.

## Standing check

New predicate `scripts/db-invariant-sweeps/predicates/cost-exposure-review.sql` lists every function a signed-in
user can run that names a cost, profit or margin field (or turns a cost-bearing table row into JSON), directly or
through an owner-rights helper it calls. Each key carries a fingerprint of the cost-touching code, so any change to a
reviewed function's cost handling shows up again for review. Reviewed-safe keys live in the sweep allowlist; the five functions the fix changes are listed under their post-apply keys,
computed before the apply from the live chain plus the four fixed bodies as replayed by the proof.

## Every function traced

Verdicts: **CHANGED** (by the migration above), **SAFE** (refuses non-admins before any cost, or strips it), **NO-COST** (returns
or writes no cost). "Not callable" means signed-in users cannot run it, so it is reachable only behind a gate.

### Batch A: dashboards, reports, statements, dispatch

| Function | Who can call | Verdict | Why |
|---|---|---|---|
| get_dispatch_board_jobs | any signed-in user, filtered to visible jobs | **CHANGED 1** | see the table above |
| dashboard_summary, financial_dashboard_summary, get_bottom_line_pnl, get_field_profitability, get_gross_sales_report, get_inventory_cost_report, get_monthly_summary, get_profitability_report, get_season_comparison, get_admin_cost_fields, get_detailed_statement_data, generate_batch_statements | admin only (checked first) | SAFE | admin gate before any data |
| get_inventory_position, get_sales_detail_report, get_sales_summary_report | admin or rep | SAFE | cost, profit and margin blanked for non-admins |
| get_quote_versions | admin or rep | SAFE | snapshot cleaned of every cost/profit/margin key for non-admins |
| get_chemical_history | admin or rep | SAFE | purchase price hidden from non-admins |
| get_quote_cost_alerts | admin or rep | SAFE | yes/no flags only |
| get_customer_year_end_summary, get_batch_year_end_summaries | admin or rep | SAFE | its "cost" key is sale revenue |
| operational_dashboard_summary, get_dashboard_action_items, get_ar_reminder_candidates, get_customer_delivery_remainders, get_job_inventory_shortfalls, get_program_completion, get_receiving_log, get_dispatch_stock_status, get_expiring_planned_holds, get_inventory_forecast | various | NO-COST | counts, quantities, revenue, dates |
| _get_chemical_history_cost_step2_impl and every `_*_cost_impl_20261019` / `_cost_step2_*` helper | not callable | SAFE | reachable only behind the wrappers' gates |

### Batch B: pricing, supplier prices, purchasing, inventory

| Function | Who can call | Verdict | Why |
|---|---|---|---|
| manual_inventory_add | admin or rep | **CHANGED 2** | see the table above |
| apply_product_cost_basis_change_set, approve_pricing_change_set, approve_supplier_price_import, reject_supplier_price_import, correct_supplier_price_observation, create_pricing_workbook_export, preview_product_cost_basis_changes, stage_supplier_price_import, get_product_cost_basis_workspace, get_product_price_history, get_supplier_market_evidence, get_supplier_pricing_workspace, get_supplier_price_import, get_supplier_quote_sheet, set_product_margin_floors, set_purchase_order_item_costs, create_vendor_bill, update_vendor_bill, commit_label_draft | admin only (checked first) | SAFE | feed text carries counts or no numbers |
| _pricing_change_set_warnings, _pricing_change_set_warning_set | not callable | SAFE | admin-only callers |
| save_purchase_order | admin or rep | SAFE | non-admin cost input dropped; reply is ids only |
| match_quick_receive_items | admin or rep | NO-COST | cost removed for non-admins; two yes/no hints (known, KI-74) |
| bulk_import_order, upsert_product_brand | admin or rep / admin | SAFE | no cost in reply, errors or feed |

### Batch C: quotes, orders, deliveries

| Function | Who can call | Verdict | Why |
|---|---|---|---|
| create_order_from_blend_ticket | admin or rep | **CHANGED 4** | see the table above |
| save_quote | admin or rep | SAFE | cost stripped from every reply (stored retry record unreadable) |
| create_quote_version, restore_quote_version, convert_quote_to_order, draw_down_quote, create_quick_delivery, complete_delivery, start_and_complete_delivery, cancel_order | per function (cancel_order admin only) | SAFE | ids, quantities and revenue only; cost goes to admin-only or unreadable places |
| create_quote_from_template, save_quote_template, rollover_quote_to_season, duplicate_quote, price_order, create_direct_order, create_rush_order, create_job_from_quote_section, update_order_items, cancel_delivery, batch_cancel_deliveries | admin or rep | NO-COST | ids, counts, revenue |
| _enforce_below_cost_line (trigger) | trigger | SAFE | drops cost from the refusal detail for anyone who is not an active admin |
| trg_recalc_order_totals, _insert_commissions_for_order, _assert_quote_prices_as_sent, _begin_below_cost_money_write, check_idempotency, check_idempotency_intent, save_idempotency | trigger / not callable | NO-COST | write only to locked columns or unreadable tables |

### Batch D: invoices, jobs, field billing, offline sync

| Function | Who can call | Verdict | Why |
|---|---|---|---|
| complete_job | admin, rep, assigned or fully-dispatched applicator | **CHANGED 3** | see the table above |
| get_job_proof_data | signed-in users | NO-COST | builds each field and product row by name; no cost, profit or margin field |
| save_invoice, create_invoice_from_blend_ticket, invoice_postable_version | admin or rep | SAFE | cost set server-side or stripped; version hash excludes cost columns |
| create_invoice_for_unbilled_delivery, void_invoice_group, delete_invoices, issue_return_credit, generate_finance_charges | admin only | SAFE | admin gate first; generic messages |
| create_invoice_from_order, create_split_invoices_from_order, consolidate_draft_invoices, post_invoice, batch_post_invoices, post_invoice_group, unpost_invoice_group, transfer_invoice_to_job, transfer_job_to_invoice, save_job, save_field_app_invoice, save_field_app_split_invoice, process_offline_action, stage_offline_action | various | NO-COST | ids, revenue totals, quantities, fixed texts |
| compute_application_service_fee, _enforce_billed_job_immutability, _insert_commissions_for_job, _invoice_post_version, _invoice_post_content_version, _issue_return_credit_impl, enforce_invoice_draft_on_insert | not callable / trigger | SAFE | not callable by signed-in users |

### Batch E: voids, quote close-outs, receiving

| Function | Who can call | Verdict | Why |
|---|---|---|---|
| batch_void_invoices, close_quote_as_applied, close_quote_as_short, create_application_record_from_blend_ticket, reverse_receiving_record, revert_quote_status, void_order | per function | SAFE | quantities, ids and reasons only; whole-row copies go to the admin-only audit log and carry no cost |
| batch_apply_prepayments, create_planned_holds, void_invoice, void_payment | per function | NO-COST | ids, counts, payment cents |
| check_idempotency_intent (not callable) | helper | NO-COST here | its mismatch detail repeats a stored reply; no cost-bearing reply found on this path |


## Limits

- Long admin-only bodies were read past their admin gate only by pattern search for cost words, whole-row JSON and
  error text. Batch D's 78 KB job-save body and Batch E's two long void bodies were read the same way.
- Changes 3 and 4 were found by reading code, then proven in the disposable real-schema database with the draft-invoice
  step and the order-totals trigger switched off inside the test (rolled back). They were not reproduced live.
- The sweep matches function calls by name, so a helper reached only through dynamic SQL would be missed.
