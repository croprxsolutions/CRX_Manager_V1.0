-- Written 2026-11-22. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20270224110000_retire_per_acre_field_pricing.md.
--
-- WHY (Mason, 2026-11-22): "we never bill a flat price per acre for chemical etc, we always bill line by line".
--   A field's billing split could carry a per-acre price (field_billing_defaults.price_override_cents) and a pricing
--   note. When set, invoices billed that payer one "$X/acre" line with the chemicals at $0, and stored the rate on the
--   invoice's share row (invoice_shares.price_per_acre_cents / pricing_note). Live 2026-11-22 (read-only): 0 of 6
--   split rows and 0 of 3 invoice shares carry a per-acre price or a note, and 0 invoice lines carry per-acre
--   wording. Decision (Mason, 2026-11-22): the feature was never used, so this migration adds the two constraints
--   and does not search invoice history for per-acre invoices.
--
-- WHAT: both tables refuse a per-acre price and a pricing note (CHECK, validated):
--   - field_billing_defaults: every per-acre billing path reads its price from here, so none can be reached again;
--   - invoice_shares: no saved draft can carry (or be edited to carry) a per-acre rate into posting or the PDF.
--   This is the database step; a separate screen PR, built on this one, removes the Field Setup inputs and banners.
--   Contract: docs/plans/2026-11-22-retire-per-acre-grower-share-pricing-CONTRACT.md.
--
-- NOT CHANGED: the columns (kept, always NULL), every function, policy, grant and row. Line-by-line billing and
--   percent splits between payers are untouched.
--
-- PREFLIGHT: locks both tables in the mode the ALTERs need (no lock upgrade, so no deadlock with a save), then refuses
--   a second apply (PER_ACRE_PRICING_PREFLIGHT) and refuses (PER_ACRE_PRICING_IN_USE) while any split or invoice share
--   still has a per-acre price or a note. It never clears or changes one. A failed apply rolls back whole (the runner
--   wraps the file in one transaction) and is safe to retry.
--
-- ROLLBACK (its own reviewed migration): drop both constraints (scripts/smoke/retire-per-acre-pricing-reverse.sql).

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_splits bigint;
  v_shares bigint;
BEGIN
  -- Lock first, in the ALTERs' own mode, so nothing can add a per-acre price (or a second apply slip in) between these
  -- checks and the constraints, and no later lock upgrade can deadlock with a save. Shares before splits: the same
  -- order as the field-application draft edit (it writes invoice_shares, then reads field_billing_defaults).
  LOCK TABLE public.invoice_shares, public.field_billing_defaults IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE (conrelid = 'public.field_billing_defaults'::regclass
                     AND conname = 'field_billing_defaults_no_per_acre_price')
                 OR (conrelid = 'public.invoice_shares'::regclass
                     AND conname = 'invoice_shares_no_per_acre_price')) THEN
    RAISE EXCEPTION 'PER_ACRE_PRICING_PREFLIGHT: a no_per_acre_price constraint already exists';
  END IF;
  SELECT count(*) INTO v_splits FROM public.field_billing_defaults
   WHERE price_override_cents IS NOT NULL OR pricing_note IS NOT NULL;
  SELECT count(*) INTO v_shares FROM public.invoice_shares
   WHERE price_per_acre_cents IS NOT NULL OR pricing_note IS NOT NULL;
  IF v_splits > 0 OR v_shares > 0 THEN
    RAISE EXCEPTION 'PER_ACRE_PRICING_IN_USE: % field billing split(s) and % invoice share(s) still carry per-acre pricing; this migration never changes billing, so resolve them by hand first', v_splits, v_shares;
  END IF;
END;
$preflight$;

ALTER TABLE public.field_billing_defaults
  ADD CONSTRAINT field_billing_defaults_no_per_acre_price
  CHECK (price_override_cents IS NULL AND pricing_note IS NULL);

ALTER TABLE public.invoice_shares
  ADD CONSTRAINT invoice_shares_no_per_acre_price
  CHECK (price_per_acre_cents IS NULL AND pricing_note IS NULL);

COMMENT ON CONSTRAINT field_billing_defaults_no_per_acre_price ON public.field_billing_defaults IS
  'Per-acre field pricing is retired (Mason 2026-11-22): every invoice bills line by line.';
COMMENT ON CONSTRAINT invoice_shares_no_per_acre_price ON public.invoice_shares IS
  'Per-acre field pricing is retired (Mason 2026-11-22): every invoice bills line by line.';

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_constraint
       WHERE contype = 'c' AND convalidated
         AND ((conrelid = 'public.field_billing_defaults'::regclass
               AND conname = 'field_billing_defaults_no_per_acre_price')
           OR (conrelid = 'public.invoice_shares'::regclass
               AND conname = 'invoice_shares_no_per_acre_price'))) <> 2 THEN
    RAISE EXCEPTION 'PER_ACRE_PRICING_POSTFLIGHT: a constraint is missing or not validated';
  END IF;
END;
$postflight$;
