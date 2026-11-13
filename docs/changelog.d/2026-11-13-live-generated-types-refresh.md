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

The refresh also removed old applied migrations from the awaiting-type set, emptied the no-longer-needed migration-only idempotency bucket, pruned 23 exemptions that the refreshed mutator inventory no longer uses, and advanced the live function fixture. The five newly visible private helpers remain narrowly exempted with current catalog ACL evidence.
