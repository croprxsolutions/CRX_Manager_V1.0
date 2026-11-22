-- Reverse of 20270219100000_retire_per_acre_field_pricing (prover use; a live rollback is its own reviewed migration).
-- Drops both constraints only; the migration changed no rows. A second run refuses.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.field_billing_defaults DROP CONSTRAINT field_billing_defaults_no_per_acre_price;
ALTER TABLE public.invoice_shares DROP CONSTRAINT invoice_shares_no_per_acre_price;
