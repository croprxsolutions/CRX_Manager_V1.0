-- Deliveries and delivery items: the read rules check the reader's role once per query, not once per row.
--
-- Why: del_select and del_items_select call is_admin() and is_sales_rep() for every row they read. Each
-- is a SECURITY DEFINER plpgsql lookup of the reader's profile, so a sales rep (who fails is_admin() and
-- then passes is_sales_rep()) pays two lookups per delivery and per item. At 60,000 deliveries that was
-- most of the Deliveries list's time (Goal 4, PR #1549). Written as (SELECT is_admin()), the planner
-- runs each lookup once per query and reuses the answer, as the rules already do for auth.uid().
--
-- Who can read what does not change: each rule keeps the same three conditions, in the same order,
-- for the same role (authenticated) and command (SELECT). The role lookups are STABLE and depend only on
-- the signed-in user, which cannot change within one query. No other rule, table, row or grant changes.

DO $preflight$
DECLARE
  v_del text;
  v_items text;
BEGIN
  SELECT qual INTO v_del FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'deliveries' AND policyname = 'del_select'
     AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND roles = '{authenticated}'::name[];
  SELECT qual INTO v_items FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'delivery_items' AND policyname = 'del_items_select'
     AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND roles = '{authenticated}'::name[];
  -- The rules must still read exactly as they do live today (2026-11-06), so this rewords them and nothing else.
  IF v_del IS DISTINCT FROM '(is_admin() OR is_sales_rep() OR (assigned_driver = ( SELECT auth.uid() AS uid)))' THEN
    RAISE EXCEPTION 'READ_RULES_PREFLIGHT: del_select is not the expected rule: %', v_del;
  END IF;
  IF v_items IS DISTINCT FROM E'(is_admin() OR is_sales_rep() OR (EXISTS ( SELECT 1\n   FROM deliveries d\n  WHERE ((d.id = delivery_items.delivery_id) AND (d.assigned_driver = ( SELECT auth.uid() AS uid))))))' THEN
    RAISE EXCEPTION 'READ_RULES_PREFLIGHT: del_items_select is not the expected rule: %', v_items;
  END IF;
END;
$preflight$;

ALTER POLICY del_select ON public.deliveries
  USING ((SELECT public.is_admin()) OR (SELECT public.is_sales_rep()) OR (assigned_driver = (SELECT auth.uid())));

ALTER POLICY del_items_select ON public.delivery_items
  USING ((SELECT public.is_admin()) OR (SELECT public.is_sales_rep()) OR EXISTS (
    SELECT 1 FROM public.deliveries d
     WHERE d.id = delivery_items.delivery_id AND d.assigned_driver = (SELECT auth.uid())));

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND roles = '{authenticated}'::name[]
         AND ((tablename = 'deliveries' AND policyname = 'del_select'
               AND qual = '(( SELECT is_admin() AS is_admin) OR ( SELECT is_sales_rep() AS is_sales_rep) OR (assigned_driver = ( SELECT auth.uid() AS uid)))')
           OR (tablename = 'delivery_items' AND policyname = 'del_items_select'
               AND qual = E'(( SELECT is_admin() AS is_admin) OR ( SELECT is_sales_rep() AS is_sales_rep) OR (EXISTS ( SELECT 1\n   FROM deliveries d\n  WHERE ((d.id = delivery_items.delivery_id) AND (d.assigned_driver = ( SELECT auth.uid() AS uid))))))'))) <> 2 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: del_select and del_items_select must each check the role once per query';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.deliveries'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.delivery_items'::regclass) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: row level security must stay on for deliveries and delivery_items';
  END IF;
END;
$postflight$;
