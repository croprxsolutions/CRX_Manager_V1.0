## 2026-11-13 - Refresh generated Supabase types from live

src/types/supabase.ts was regenerated from the production Supabase schema. The read-only live ledger ended at version 20261113011216, migration 20270109100000_delivery_receipt_brands. The checked-in public-function snapshot now contains 1,192 names; its MD5 is 3dc2f08b92db2db4ed0e2fb8ec667e85.

The delivery-receipt migration record now reflects that same ledger row; it had incorrectly remained marked as a local candidate.

The staging branch carries M4 declarations that production has not applied, so they remain as a source-verified overlay. Read-only catalog output from the disposable full-schema replay confirms:
- customers.standing_discount_pct is numeric(5,2) NOT NULL DEFAULT 0; orders.sales_tax is boolean NOT NULL DEFAULT false.
- invoice_sales_tax_rates has invoice_id uuid as its primary key and an ON DELETE CASCADE foreign key to invoices, rate_pct numeric(5,3) constrained to 0 <= rate < 100, and set_at timestamptz NOT NULL DEFAULT now().
- invoice_standing_discount_rates has invoice_id uuid as its primary key and an ON DELETE CASCADE foreign key to invoices, rate_pct numeric(5,2) constrained to 0 <= rate <= 100, nullable set_by uuid referencing profiles, and set_at timestamptz NOT NULL DEFAULT now().
- set_order_sales_tax accepts (p_order_id uuid, p_sales_tax boolean, p_idempotency_key text); set_invoice_standing_discount accepts (p_invoice_id uuid, p_pct numeric, p_idempotency_key text).
The pending M4 migration timestamps remain registered until those migrations apply live.

Three semantic type adjustments are documented at their declarations; they come from catalog/function semantics rather than MCP output:
- invoices_postable.invoice_postable_version: string | null is a computed PostgREST field backed by invoice_postable_version(p_invoice invoices_postable) RETURNS text; it is not a physical view column.
- get_quote_versions preserves nullable raw outputs notes, pdf_url, restore_trusted_at, and sent_method: the live quote_versions columns are nullable and the function returns those raw columns.
- set_invoice_standing_discount.p_pct accepts null; 20261231110000_standing_grower_discount.sql deletes the per-invoice override on that path and restores the customer's rate.

Additional raw RPC nullability is retained where the checked-in SQL proves it:
- get_ar_aging and get_customer_balance_listing return flagged customers with NULL balance fields, and normal rows with NULL unavailable_reason (20261104120000_balance_reports_flag_unrebuildable_customers.sql). The customer-balance screen now narrows those rows before rendering amounts.
- get_chemical_history returns NULL unit_price and total_amount for non-admin Purchase rows (20261019230000_cost_margin_admin_only_screens_step2.sql).
- The get_bill_split_payers fields narrowed from the older nullable snapshot remain non-null after source review: invoice_number and total_amount_cents are NOT NULL invoice columns, while farm_name is reached through invoices.customer_id's NOT NULL foreign key to customers.id and customers.farm_name is NOT NULL.

The live registry intentionally describes production metadata. The pending M4 additions listed above are source-verified overlays in the TypeScript schema/test fixtures until M4 is applied live; this record identifies them, and the generated declarations do not carry individual staging-overlay comments. Preserve those listed additions when regenerating from production before M4 applies. The M4 migration files expand the invoice_items CHECKs before writing their computed lines; the app passes those lines through save_invoice, and no TypeScript direct table write sends either M4 charge_type. The status-enum hook skips a table whose SQL migration alters its CHECK constraint, but a later staging migration that reissues M4 charge values without changing that constraint can still be refused against the production-only registry. Verify the actual target constraint and follow the documented review procedure before resolving such a refusal. The registry remains a live production inventory, not a staging migration target.

The refresh also removed old applied migrations from the awaiting-type set, emptied the no-longer-needed migration-only idempotency bucket, pruned 23 exemptions that the refreshed mutator inventory no longer uses, and advanced the live function fixture. The five newly visible private helpers remain narrowly exempted with current catalog ACL evidence.

### Final local verification and delivery hold

The final frozen code at `f5327f19` passed 600 test files and 8,243 tests, with 123 skips, using `GITHUB_BASE_REF=staging` for the actual PR target. That target is required for the live-RPC fixture to recognize the two registered M4 RPCs pending production apply; a plain local run without the staging target rejects those premature production names. The semantic type-drift and compliance rechecks are clean; focused report coverage, typecheck, lint, build, code-health and documentation checks passed. The commit-scoped Luna review of the nullable-contract correction was clean, following the prior full-branch review and documented live-registry refutation.

This unit remains unpublished. `Reports.tsx` is a Sol-required path; no Sol proof is claimed. The inherited billing rollout blocker recorded in #1868 must be resolved before final protected delivery. No PR merge, database apply or production deployment occurred.
