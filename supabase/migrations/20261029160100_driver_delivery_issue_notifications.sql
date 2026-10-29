-- Office report details from the committed delivery when a driver completes it with an issue.
-- No billing, inventory, delivery lifecycle, grants on existing objects, or historical rows change.
-- The deferred trigger runs after complete_delivery has saved all line quantities. A failed
-- notification insert rolls back the completion, so its existing idempotent retry remains safe.
-- Rollback: remove driver_delivery_issue_notice and _notify_driver_delivery_issue() in a new migration.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public._notify_driver_delivery_issue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_delivery record;
  v_lines text;
  v_type text;
  v_message text;
BEGIN
  -- Re-read at deferred execution: the header is completed before its items are updated.
  SELECT d.*, o.order_number INTO v_delivery
  FROM public.deliveries d LEFT JOIN public.orders o ON o.id = d.order_id
  WHERE d.id = NEW.id;
  IF NOT FOUND OR v_delivery.status <> 'completed'
     OR COALESCE(v_delivery.issue_type, 'none') = 'none' THEN
    RETURN NULL;
  END IF;

  v_type := initcap(replace(v_delivery.issue_type, '_', ' '));
  SELECT string_agg(
    COALESCE(NULLIF(btrim(p.product_name), ''), 'Product not recorded') ||
    ': planned ' || COALESCE(di.quantity::text, 'not recorded') ||
    '; delivered ' || COALESCE(di.quantity_delivered::text, 'not recorded') ||
    '; units ' || COALESCE(NULLIF(btrim(di.unit_size), ''), 'not recorded') ||
    CASE WHEN di.quantity_delivered < di.quantity
      THEN '; short ' || (di.quantity - di.quantity_delivered)::text
      ELSE '' END,
    E'\n' ORDER BY di.id
  ) INTO v_lines
  FROM public.delivery_items di LEFT JOIN public.products p ON p.id = di.product_id
  WHERE di.delivery_id = NEW.id;

  v_message := 'Delivery ' || v_delivery.delivery_number ||
    CASE WHEN v_delivery.order_number IS NOT NULL THEN ' (Order ' || v_delivery.order_number || ')'
      ELSE ' (Order not recorded)' END ||
    E'\nReported issue: ' || v_type ||
    E'\nDriver explanation: ' || COALESCE(NULLIF(left(btrim(v_delivery.issue_notes), 2000), ''), 'Not provided') ||
    E'\nDelivery lines (damage amounts and affected lines are only as described by the driver):\n' ||
    COALESCE(v_lines, 'No delivery lines recorded');

  -- Match the existing driver-issue office audience: active admins only. Trigger-only;
  -- app roles cannot call it directly. The completion status transition fires once,
  -- while complete_delivery's saved replay receipt avoids a second transition on retry.
  INSERT INTO public.notifications (
    user_id, title, message, notification_type, related_entity_type, related_entity_id, created_by
  )
  SELECT id, 'Driver issue: ' || v_type || ' — ' || v_delivery.delivery_number,
    v_message, 'delivery_issue_reported', 'delivery', NEW.id, auth.uid()
  FROM public.profiles WHERE role = 'admin' AND is_active = true;
  RETURN NULL;
END;
$$;

ALTER FUNCTION public._notify_driver_delivery_issue() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public._notify_driver_delivery_issue() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS driver_delivery_issue_notice ON public.deliveries;
CREATE CONSTRAINT TRIGGER driver_delivery_issue_notice
AFTER UPDATE ON public.deliveries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'completed'
  AND NEW.issue_type IS NOT NULL AND NEW.issue_type <> 'none')
EXECUTE FUNCTION public._notify_driver_delivery_issue();

-- Postflight: fail the whole migration if the trigger or its function is not as intended.
DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = 'public._notify_driver_delivery_issue()'::regprocedure
      AND p.prosecdef AND r.rolname = 'postgres'
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'DRIVER_ISSUE_NOTICE_POSTFLIGHT: function not SECURITY DEFINER / postgres-owned / search_path pinned';
  END IF;
  IF has_function_privilege('anon', 'public._notify_driver_delivery_issue()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._notify_driver_delivery_issue()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._notify_driver_delivery_issue()', 'EXECUTE') THEN
    RAISE EXCEPTION 'DRIVER_ISSUE_NOTICE_POSTFLIGHT: an app role can still execute the trigger function';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.deliveries'::regclass AND tgname = 'driver_delivery_issue_notice'
      AND tgenabled = 'O' AND tgdeferrable AND tginitdeferred
  ) THEN
    RAISE EXCEPTION 'DRIVER_ISSUE_NOTICE_POSTFLIGHT: deferred trigger missing or disabled';
  END IF;
END
$postflight$;
