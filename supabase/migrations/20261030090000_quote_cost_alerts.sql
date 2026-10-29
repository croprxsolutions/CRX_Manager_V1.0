-- Written 2026-10-30. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (placeholder row; the landing session assigns the final row).
--
-- WHAT: sales reps are warned when a quote line's cost has gone up since it was quoted, without
--   seeing any cost number (Mason 2026-10-26: "must show a warning that cost has gone up so a rep
--   confirming 20 days later knows and can discuss a big increase"; cost and margin stay
--   admin-only, 2026-10-15). Admins already see both costs on the line (QuoteLineCost).
--   New public.get_quote_cost_alerts(p_quote_id) returns, per saved line of the quote, two
--   yes/no flags and nothing else:
--     cost_rose  - today's product cost is above the cost recorded when the line was quoted;
--     below_cost - the line's price is below today's cost (Convert needs an admin's below-cost
--                  approval, which the rep already meets as a refusal today).
--   Read-only, SECURITY DEFINER (cost columns are revoked from every API role), and only for an
--   active admin or sales rep, the same people quote_items' select policy lets read quote lines.
--
-- NOT CHANGED: every table, policy, grant and existing function; no rows change.
--
-- ROLLBACK (its own reviewed migration): DROP FUNCTION public.get_quote_cost_alerts(uuid).

DO $preflight$
BEGIN
  IF to_regprocedure('public.get_quote_cost_alerts(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: get_quote_cost_alerts already exists; re-read live first';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL OR to_regprocedure('public.is_sales_rep()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: is_admin() / is_sales_rep() missing';
  END IF;
END
$preflight$;

CREATE FUNCTION public.get_quote_cost_alerts(p_quote_id uuid)
RETURNS TABLE (quote_item_id uuid, cost_rose boolean, below_cost boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- The readers of quote lines (qitems_select): active admins and sales reps.
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE' USING ERRCODE = '42501';
  END IF;
  -- Whole cents, as QuoteLineCost compares them. Flags only: no cost leaves this function.
  RETURN QUERY
  SELECT qi.id,
         COALESCE(round(p.current_cost * 100) > qi.cost_at_quote_cents, false),
         round(p.current_cost * 100) > 0 AND round(qi.price_per_unit * 100) < round(p.current_cost * 100)
    FROM public.quote_items qi
    JOIN public.quotes q ON q.id = qi.quote_id AND q.deleted_at IS NULL
    JOIN public.products p ON p.id = qi.product_id
   WHERE qi.quote_id = p_quote_id
     AND p.current_cost IS NOT NULL
   ORDER BY qi.sort_order, qi.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_quote_cost_alerts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_quote_cost_alerts(uuid) TO authenticated;

DO $postflight$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.get_quote_cost_alerts(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_quote_cost_alerts(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: get_quote_cost_alerts must be callable by signed-in users only';
  END IF;
END
$postflight$;
