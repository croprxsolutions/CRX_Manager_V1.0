-- Written 2026-11-22. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270207142500_retire_per_acre_field_pricing.md.
--
-- WHY (Mason, 2026-11-22): "we never bill a flat price per acre for chemical etc, we always bill line by line".
--   A field's billing split could carry a per-acre price (field_billing_defaults.price_override_cents) and a pricing
--   note. When set, invoices billed that payer one "$X/acre" line with the chemicals at $0. Live 2026-11-22
--   (read-only): 6 split rows, none with a per-acre price or a note; no invoice share was ever billed per acre.
--
-- WHAT: field_billing_defaults refuses a per-acre price and a pricing note (CHECK, validated). Every per-acre billing
--   path reads its price from this table only, so none can be reached again. The screens stop offering the inputs
--   in the same PR. Contract: docs/plans/2026-11-22-retire-per-acre-grower-share-pricing-CONTRACT.md.
--
-- NOT CHANGED: the columns (kept, always NULL), every function, policy, grant and row. Line-by-line billing and
--   percent splits between payers are untouched.
--
-- PREFLIGHT: refuses (PER_ACRE_PRICING_IN_USE) if any row still has a per-acre price or a note (never clears one),
--   and refuses a second apply (constraint already present).
--
-- ROLLBACK (its own reviewed migration): ALTER TABLE public.field_billing_defaults
--   DROP CONSTRAINT field_billing_defaults_no_per_acre_price; (scripts/smoke/retire-per-acre-pricing-reverse.sql).

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_rows bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.field_billing_defaults'::regclass
                AND conname = 'field_billing_defaults_no_per_acre_price') THEN
    RAISE EXCEPTION 'PER_ACRE_PRICING_PREFLIGHT: field_billing_defaults_no_per_acre_price already exists';
  END IF;
  -- Lock first so no save can add a per-acre price between this count and the constraint.
  LOCK TABLE public.field_billing_defaults IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO v_rows FROM public.field_billing_defaults
   WHERE price_override_cents IS NOT NULL OR pricing_note IS NOT NULL;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'PER_ACRE_PRICING_IN_USE: % field billing split(s) still have a per-acre price or pricing note; clear them in Field Setup first', v_rows;
  END IF;
END;
$preflight$;

ALTER TABLE public.field_billing_defaults
  ADD CONSTRAINT field_billing_defaults_no_per_acre_price
  CHECK (price_override_cents IS NULL AND pricing_note IS NULL);

COMMENT ON CONSTRAINT field_billing_defaults_no_per_acre_price ON public.field_billing_defaults IS
  'Per-acre field pricing is retired (Mason 2026-11-22): every invoice bills line by line.';

DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.field_billing_defaults'::regclass
                    AND conname = 'field_billing_defaults_no_per_acre_price'
                    AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION 'PER_ACRE_PRICING_POSTFLIGHT: constraint missing or not validated';
  END IF;
END;
$postflight$;
