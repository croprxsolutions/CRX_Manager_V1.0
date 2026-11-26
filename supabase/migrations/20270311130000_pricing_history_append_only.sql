-- STATUS: NOT APPLIED
-- Keep product cost and sent-quote price history append-only. Existing insert paths continue to work.
-- A hard delete of a quote with history is refused (quote_id ON DELETE CASCADE).
-- A delete of a pricing change set with cost history is refused (change_set_id ON DELETE SET NULL).
--
-- Rollback in a new reviewed migration (drops only the guards; no rows or foreign keys change):
--   DROP TRIGGER trigger_cost_history_append_only ON public.cost_history;
--   DROP TRIGGER trigger_cost_history_no_truncate ON public.cost_history;
--   DROP TRIGGER trigger_quote_price_changes_append_only ON public.quote_price_changes;
--   DROP TRIGGER trigger_quote_price_changes_no_truncate ON public.quote_price_changes;
--   DROP FUNCTION public._cost_history_append_only();
--   DROP FUNCTION public._quote_price_changes_append_only();

SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regclass('public.cost_history') IS NULL OR to_regclass('public.quote_price_changes') IS NULL THEN
    RAISE EXCEPTION 'PRICING_HISTORY_APPEND_ONLY_PREFLIGHT: both pricing history tables must exist';
  END IF;
END;
$preflight$;

CREATE FUNCTION public._cost_history_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'COST_HISTORY_APPEND_ONLY: product cost history cannot be changed or deleted';
END;
$function$;
REVOKE ALL ON FUNCTION public._cost_history_append_only() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TRIGGER trigger_cost_history_append_only
  BEFORE UPDATE OR DELETE ON public.cost_history
  FOR EACH ROW EXECUTE FUNCTION public._cost_history_append_only();

CREATE TRIGGER trigger_cost_history_no_truncate
  BEFORE TRUNCATE ON public.cost_history
  FOR EACH STATEMENT EXECUTE FUNCTION public._cost_history_append_only();

CREATE FUNCTION public._quote_price_changes_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'QUOTE_PRICE_HISTORY_APPEND_ONLY: quote price history cannot be changed or deleted';
END;
$function$;
REVOKE ALL ON FUNCTION public._quote_price_changes_append_only() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TRIGGER trigger_quote_price_changes_append_only
  BEFORE UPDATE OR DELETE ON public.quote_price_changes
  FOR EACH ROW EXECUTE FUNCTION public._quote_price_changes_append_only();

CREATE TRIGGER trigger_quote_price_changes_no_truncate
  BEFORE TRUNCATE ON public.quote_price_changes
  FOR EACH STATEMENT EXECUTE FUNCTION public._quote_price_changes_append_only();

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.cost_history'::regclass, 'trigger_cost_history_append_only'),
      ('public.cost_history'::regclass, 'trigger_cost_history_no_truncate'),
      ('public.quote_price_changes'::regclass, 'trigger_quote_price_changes_append_only'),
      ('public.quote_price_changes'::regclass, 'trigger_quote_price_changes_no_truncate')
    ) AS expected(table_id, trigger_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = expected.table_id AND t.tgname = expected.trigger_name AND t.tgenabled = 'O'
    )
  ) THEN
    RAISE EXCEPTION 'PRICING_HISTORY_APPEND_ONLY_VERIFY: expected four enabled pricing history triggers';
  END IF;
END;
$verify$;
