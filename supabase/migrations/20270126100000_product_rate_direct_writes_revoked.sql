-- RT-4b: the app can no longer write a product's per-acre rate columns directly. Contract:
-- docs/plans/2026-11-18-product-RT4b-writers-CONTRACT.md. Mason, 2026-11-18: "Yes, remove it".
--
-- * REVOKE INSERT and UPDATE on products.rate_per_acre, rate_unit and suggested_rate from every API role. Every
--   rate writer left is a SECURITY DEFINER function owned by postgres (set_product_rates, correct_product_rates,
--   set_parent_rates, correct_parent_rates, add/move a size, parent grouping, product import, the price workbook
--   apply, commit_parent_rate_cutover), so they keep working. Table-level INSERT/UPDATE was already revoked from
--   authenticated (20260718190000); the three columns came back through its column grant.
-- * RT-4a tidy-up (#1958): metabase_ro is named in the REVOKE of RT-4a's two RPCs (it had no EXECUTE: the default
--   function privileges never include it).
-- * The price workbook's rate refusal now names the rate tools instead of the product page's rate boxes.
-- * The rate-writing helpers stay internal (postflight: no API role can execute them).
-- No data changes. Every other column privilege on products is unchanged (postflight).

SET LOCAL lock_timeout = '10s';

CREATE TEMP TABLE rt4b_products_column_grants ON COMMIT DROP AS
  SELECT a.attname::text AS column_name, r.role, p.priv
    FROM pg_attribute a
   CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro']) r(role)
   CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p(priv)
   WHERE a.attrelid = 'public.products'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege(r.role, 'public.products', a.attname, p.priv);

REVOKE INSERT (rate_per_acre, rate_unit, suggested_rate), UPDATE (rate_per_acre, rate_unit, suggested_rate)
  ON public.products FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- Same refusal as 20261107060000; only the message changes, since the product page's rate boxes are now read-only.
CREATE OR REPLACE FUNCTION public.refuse_price_workbook_rate_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
BEGIN
  IF NEW.changes ?| ARRAY['rate_per_acre', 'rate_unit', 'suggested_rate'] THEN
    RAISE EXCEPTION 'PRODUCT_RATES_READ_ONLY_IN_PRICE_WORKBOOK: rates are read-only in the price workbook; change them with Correct rates on the product page, Parent rates, or the Setup Workbook''s Rates tab'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.refuse_price_workbook_rate_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_price_workbook_rate_change() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

REVOKE ALL ON FUNCTION public.preview_parent_rate_cutover(uuid, text) FROM metabase_ro;
REVOKE ALL ON FUNCTION public.commit_parent_rate_cutover(uuid, text, jsonb, text, text) FROM metabase_ro;

DO $postflight$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(format('%s %s %s', r.role, p.priv, c.col), ', ') INTO v_bad
    FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro']) r(role)
   CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE']) p(priv)
   CROSS JOIN unnest(ARRAY['rate_per_acre', 'rate_unit', 'suggested_rate']) c(col)
   WHERE has_column_privilege(r.role, 'public.products', c.col, p.priv);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_RATE_DIRECT_WRITES_STILL_GRANTED: %', v_bad;
  END IF;

  -- Everything else on products is as it was: only the revoked entries are gone.
  SELECT string_agg(format('%s %s %s', role, priv, column_name), ', ') INTO v_bad FROM (
    (SELECT column_name, role, priv FROM rt4b_products_column_grants
      WHERE NOT (priv IN ('INSERT', 'UPDATE') AND column_name IN ('rate_per_acre', 'rate_unit', 'suggested_rate'))
     EXCEPT
     SELECT a.attname::text, r.role, p.priv
       FROM pg_attribute a
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro']) r(role)
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p(priv)
      WHERE a.attrelid = 'public.products'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND has_column_privilege(r.role, 'public.products', a.attname, p.priv))
  ) lost;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_RATE_DIRECT_WRITES_OTHER_GRANT_LOST: %', v_bad;
  END IF;

  IF has_function_privilege('metabase_ro', 'public.preview_parent_rate_cutover(uuid,text)', 'EXECUTE')
     OR has_function_privilege('metabase_ro', 'public.commit_parent_rate_cutover(uuid,text,jsonb,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preview_parent_rate_cutover(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.commit_parent_rate_cutover(uuid,text,jsonb,text,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.preview_parent_rate_cutover(uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.commit_parent_rate_cutover(uuid,text,jsonb,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.preview_parent_rate_cutover(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.commit_parent_rate_cutover(uuid,text,jsonb,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_RATE_CUTOVER_GRANTS_WRONG';
  END IF;

  -- Matched by schema and exact name (every overload), and each name must exist, so the check cannot pass empty.
  SELECT string_agg(f.name, ', ') INTO v_bad
    FROM unnest(ARRAY['_write_product_rates', '_apply_parent_rates', '_copy_parent_to_size', 'apply_product_pricing_change_set']) f(name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f.name);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_RATE_HELPER_MISSING: %', v_bad;
  END IF;
  SELECT string_agg(format('%s %s', r.role, p.oid::regprocedure), ', ') INTO v_bad
    FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro']) r(role)
   CROSS JOIN pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('_write_product_rates', '_apply_parent_rates', '_copy_parent_to_size', 'apply_product_pricing_change_set')
     AND has_function_privilege(r.role, p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_RATE_HELPER_EXECUTABLE: %', v_bad;
  END IF;
END;
$postflight$;
