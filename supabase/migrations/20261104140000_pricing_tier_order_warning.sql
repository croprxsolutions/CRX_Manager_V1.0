-- Written 2026-11-02. STATUS: NOT APPLIED.
-- ROUTINE: adds a tier-order warning to the private pricing preview function.
-- No data, grants, policies, or other functions change.
-- ROLLBACK: re-create it from 20261027050000 (~228-334) as CREATE OR REPLACE.

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid =
      to_regprocedure('public._pricing_change_set_warnings(uuid)'))
      IS DISTINCT FROM '2197e2c7410aeda9fed177c4046c3b32'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid =
      to_regprocedure('public._pricing_change_set_warning_set(uuid)'))
      IS DISTINCT FROM '52f7938fe4019436d861cd257fe2b217'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid =
      to_regprocedure('public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)'))
      IS DISTINCT FROM '15dd6f1bce81c8c26022acf190e8e5a6'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid =
      to_regprocedure('public.approve_pricing_change_set(uuid,text,jsonb,jsonb,uuid,text)'))
      IS DISTINCT FROM 'eccd562fd43c8f6ebe1946b26929dcba'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid =
      to_regprocedure('public.apply_product_cost_basis_change_set(uuid,text,uuid,text)'))
      IS DISTINCT FROM 'ac5b75bd83c3c98c2420c93849804ada' THEN
    RAISE EXCEPTION 'PRICING_TIER_ORDER_PREFLIGHT: pricing warning bodies differ from the pinned live versions';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._pricing_change_set_warnings(p_change_set_id uuid)
RETURNS TABLE (product_id uuid, warning_codes text[], details jsonb)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  WITH changed AS (
    SELECT r.product_id,
           round(p.current_cost * 100)::bigint AS cost_before,
           r.output_cost_cents AS cost_after,
           -- What each tier's customer pays, as quotes price it (getQuoteTierPrice, save_quote): only a
           -- blank tier 2/3 price falls back to tier 1; a stated $0 is a real price, so a move to $0 warns.
           ARRAY[
             round(p.tier1_price * 100)::bigint,
             COALESCE(round(p.tier2_price * 100)::bigint, round(p.tier1_price * 100)::bigint),
             COALESCE(round(p.tier3_price * 100)::bigint, round(p.tier1_price * 100)::bigint)
           ] AS price_before,
           ARRAY[
             r.output_tier1_price_cents,
             r.output_tier2_price_cents,
             r.output_tier3_price_cents
           ] AS price_after,
           -- The stored net margin the floor is defined against (20261025210000: under when
           -- tierN_margin < floor), not one recomputed from cent-rounded prices, which would flag a
           -- tier set exactly at its floor. Final prices are NOT NULL, so each tier keeps its own margin.
           ARRAY[
             r.output_tier1_margin,
             r.output_tier2_margin,
             r.output_tier3_margin
           ] AS margin_after,
           f.margin_floor
    FROM public.pricing_change_set_rows r
    JOIN public.products p ON p.id = r.product_id
    LEFT JOIN public.product_margin_floors f ON f.product_id = r.product_id
    WHERE r.change_set_id = p_change_set_id
  ), tiers AS (
    SELECT c.product_id, c.cost_before, c.cost_after, c.margin_floor, t.tier,
           c.price_before[t.tier] AS before_cents,
           c.price_after[t.tier] AS after_cents,
           c.margin_after[t.tier] AS margin_after
    FROM changed c CROSS JOIN generate_series(1, 3) AS t(tier)
  ), flags AS (
    SELECT t.product_id,
           max(t.cost_before) AS cost_before,
           max(t.cost_after) AS cost_after,
           max(t.margin_floor) AS margin_floor,
           -- More than 10% up or down, or a price appearing from nothing (exact numeric, no rounding or overflow).
           bool_or(t.after_cents IS DISTINCT FROM t.before_cents AND (
             COALESCE(t.before_cents, 0) = 0
             OR abs(COALESCE(t.after_cents, 0)::numeric - t.before_cents) * 10 > t.before_cents)) AS price_move,
           bool_or(t.after_cents IS NOT NULL AND t.after_cents < t.cost_after) AS below_cost,
           bool_or(t.margin_floor IS NOT NULL AND t.margin_after < t.margin_floor) AS under_floor,
           bool_or(t.after_cents IS DISTINCT FROM t.before_cents) AS price_changed,
           -- Cents go out as text, like the rest of the pricing boundary: a JSON number above 2^53 loses digits.
           jsonb_agg(jsonb_build_object(
             'tier', t.tier, 'before_cents', t.before_cents::text, 'after_cents', t.after_cents::text,
             'margin', t.margin_after
           ) ORDER BY t.tier) AS tiers
    FROM tiers t
    GROUP BY t.product_id
  ), tier_order AS (
    -- Check final cent prices only. Every final tier is stated, including $0.
    SELECT c.product_id,
           jsonb_agg(jsonb_build_object(
             'lower_tier', v.lower_tier, 'higher_tier', v.higher_tier,
             'lower_cents', v.lower_cents::text, 'higher_cents', v.higher_cents::text
           ) ORDER BY v.higher_tier)
             FILTER (WHERE v.higher_cents < v.lower_cents)
             AS violations
    FROM changed c
    CROSS JOIN LATERAL (VALUES
      (1, 2, c.price_after[1], c.price_after[2]),
      (2, 3, c.price_after[2], c.price_after[3])
    ) AS v(lower_tier, higher_tier, lower_cents, higher_cents)
    GROUP BY c.product_id
  ), open_quotes AS (
    -- The quotes that still re-price on their next save. A quote with a sent version keeps each saved
    -- line's price (the sent-quote price lock, 20261027040000: save_quote's v_price_locked), so it is out.
    -- save_quote prices a line at the quote's tier (CASE v_tier: 1, 2, anything else tier 3; blank = 1),
    -- so only a quote whose own tier's price moves counts: a tier 2 change cannot reach a tier 1 quote.
    SELECT qi.product_id,
           count(DISTINCT q.id) AS quote_count,
           (array_agg(DISTINCT q.quote_number ORDER BY q.quote_number))[1:10] AS quote_numbers
    FROM public.quote_items qi
    JOIN public.quotes q ON q.id = qi.quote_id
    JOIN tiers t ON t.product_id = qi.product_id
                AND t.tier = CASE COALESCE(q.tier, 1) WHEN 1 THEN 1 WHEN 2 THEN 2 ELSE 3 END
                AND t.after_cents IS DISTINCT FROM t.before_cents
    WHERE q.deleted_at IS NULL
      AND (q.status IN ('sent', 'revised') OR (q.status = 'accepted' AND q.is_planned))
      AND qi.price_override IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.quote_versions qv WHERE qv.quote_id = q.id)
    GROUP BY qi.product_id
  ), coded AS (
    SELECT f.*, q.quote_count, q.quote_numbers, o.violations AS tier_order,
           array_remove(ARRAY[
             CASE WHEN f.cost_after IS DISTINCT FROM f.cost_before AND (
                    COALESCE(f.cost_before, 0) = 0
                    OR abs(f.cost_after::numeric - f.cost_before) * 10 > f.cost_before)
                  THEN 'COST_MOVE_OVER_10_PERCENT' END,
             CASE WHEN f.price_move THEN 'PRICE_MOVE_OVER_10_PERCENT' END,
             CASE WHEN f.below_cost THEN 'PRICE_BELOW_COST' END,
             CASE WHEN f.under_floor THEN 'MARGIN_UNDER_FLOOR' END,
             CASE WHEN f.price_changed AND COALESCE(q.quote_count, 0) > 0 THEN 'OPEN_SENT_QUOTE' END,
             CASE WHEN o.violations IS NOT NULL THEN 'TIER_ORDER' END
           ], NULL) AS codes
    FROM flags f
    LEFT JOIN open_quotes q ON q.product_id = f.product_id
    LEFT JOIN tier_order o ON o.product_id = f.product_id
  )
  SELECT c.product_id, c.codes,
         jsonb_build_object(
           'cost_before_cents', c.cost_before::text,
           'cost_after_cents', c.cost_after::text,
           'margin_floor', c.margin_floor,
           'tiers', c.tiers,
           'open_quote_count', COALESCE(c.quote_count, 0),
           'open_quote_numbers', COALESCE(to_jsonb(c.quote_numbers), '[]'::jsonb)
         ) || CASE WHEN c.tier_order IS NOT NULL
                   THEN jsonb_build_object('tier_order', c.tier_order) ELSE '{}'::jsonb END
  FROM coded c
  WHERE cardinality(c.codes) > 0
  ORDER BY c.product_id
$function$;
REVOKE ALL ON FUNCTION public._pricing_change_set_warnings(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname = '_pricing_change_set_warnings') <> 1
     OR (SELECT p.prosecdef FROM pg_proc p WHERE p.oid =
         'public._pricing_change_set_warnings(uuid)'::regprocedure)
     OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid =
         'public._pricing_change_set_warnings(uuid)'::regprocedure)
        IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT p.provolatile FROM pg_proc p WHERE p.oid =
         'public._pricing_change_set_warnings(uuid)'::regprocedure) <> 's'
     OR (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid =
         'public._pricing_change_set_warnings(uuid)'::regprocedure) <> 'postgres'
     OR EXISTS (SELECT 1 FROM (VALUES ('anon'), ('authenticated'), ('service_role'),
                ('metabase_ro')) AS r(role_name)
         WHERE has_function_privilege(r.role_name,
           'public._pricing_change_set_warnings(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'PRICING_TIER_ORDER_POSTFLIGHT: function signature or access is wrong';
  END IF;
END;
$postflight$;
