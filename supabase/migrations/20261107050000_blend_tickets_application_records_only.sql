-- Written 2026-11-04. KI-93. Ledger record:
-- docs/reference/migrations.d/20261107050000_blend_tickets_application_records_only.md. Stamp sits above the
-- live high-water read 2026-11-04 (name 20261106233000) and every open PR's stamp (20261107030000).
-- Re-read the live ledger first.
--
-- ROUTINE: three RPC bodies replaced by a refusal (same signatures, owner, settings and grants), one new
-- trigger function and one trigger on an existing table. No grant, policy or row changes.
--
-- idempotency-body-check: exempt -- the three replaced RPCs no longer write anything: each refuses before
--   reading its arguments, so there is nothing for a retry key to protect (a saved success from before this
--   file must not replay either). _blend_ticket_orders_disabled() is a trigger function no API role may run.
--
-- WHY (KI-93): one blend ticket could take its products out of stock twice, through its application record
--   (job_applied) and through delivery of an order made from or linked to it. Five designs that kept both
--   paths were broken by reopen, edit, move, Unlink and void paths. Mason, 2026-11-04: blend tickets go
--   through application records only; a ticket is billed by a direct invoice (create_invoice_from_blend_ticket,
--   which already refuses a linked ticket).
--
-- WHAT:
--   create_order_from_blend_ticket, link_blend_ticket_to_order, unlink_blend_ticket_from_order: refuse
--     BLEND_TICKET_ORDERS_DISABLED first thing, before any replay, validation or write.
--   _blend_ticket_orders_disabled() on blend_ticket_to_order_items (BEFORE INSERT OR UPDATE): refuses every
--     link row from any writer (the internal create-order impl, owner rights, a future function). It ignores
--     app.admin_override. Deleting a link row stays possible (there are none; a delete only frees a ticket).
--   A ticket cannot be updated to order_link_status = 'linked': trg_linked_blend_ticket_header_lock
--     already refuses it without link rows (BLEND_TICKET_LINK_STATE_INVALID). Signed-in users cannot insert
--     tickets directly (create_blend_ticket writes the 'unlinked' default); an owner-rights insert of a
--     linked ticket could only strand that ticket, never move stock.
--   Not covered (business rule, not detectable): someone typing an ordinary order for the same products.
--
-- ROLLBACK: forward repair only. Never restore the old bodies or drop the trigger without first building the
--   KI-93 "one-way paths" guards (option 2 in the design notes): the old paths take stock out twice.

SET LOCAL lock_timeout = '5s';

-- Nothing may already be on the order path (0 live, 2026-11-04). Stop rather than strand a linked ticket.
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.blend_ticket_to_order_items)
     OR EXISTS (SELECT 1 FROM public.blend_tickets WHERE order_link_status = 'linked') THEN
    RAISE EXCEPTION 'PREFLIGHT_BLEND_TICKET_ORDERS_IN_USE: a blend ticket is linked to an order; settle it before switching the order path off';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.create_order_from_blend_ticket(p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'BLEND_TICKET_ORDERS_DISABLED: blend tickets are recorded through application records only; create an application record and bill it with a direct invoice.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.link_blend_ticket_to_order(p_blend_ticket_id uuid, p_order_id uuid, p_item_mappings jsonb DEFAULT NULL::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'BLEND_TICKET_ORDERS_DISABLED: blend tickets are recorded through application records only; create an application record and bill it with a direct invoice.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.unlink_blend_ticket_from_order(p_blend_ticket_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'BLEND_TICKET_ORDERS_DISABLED: blend tickets are recorded through application records only; create an application record and bill it with a direct invoice.';
END;
$function$;

CREATE FUNCTION public._blend_ticket_orders_disabled()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $function$
BEGIN
  RAISE EXCEPTION 'BLEND_TICKET_ORDERS_DISABLED: blend tickets are recorded through application records only; create an application record and bill it with a direct invoice.';
END;
$function$;
ALTER FUNCTION public._blend_ticket_orders_disabled() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._blend_ticket_orders_disabled() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TRIGGER trigger_a_blend_ticket_orders_disabled
  BEFORE INSERT OR UPDATE ON public.blend_ticket_to_order_items
  FOR EACH ROW EXECUTE FUNCTION public._blend_ticket_orders_disabled();

DO $postflight$
DECLARE
  v_sig regprocedure;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.create_order_from_blend_ticket(uuid,text,date,text,uuid,text)'::regprocedure,
    'public.link_blend_ticket_to_order(uuid,uuid,jsonb,uuid,text)'::regprocedure,
    'public.unlink_blend_ticket_from_order(uuid,uuid,text)'::regprocedure] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_sig
         AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
         AND p.proconfig = ARRAY['search_path=public, pg_temp']
         AND position('BLEND_TICKET_ORDERS_DISABLED' IN p.prosrc) > 0
         AND position('INSERT' IN upper(p.prosrc)) = 0
         AND position('UPDATE' IN upper(p.prosrc)) = 0
         AND position('DELETE' IN upper(p.prosrc)) = 0)
       OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_BLEND_TICKET_ORDERS_RPC: %', v_sig;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public._blend_ticket_orders_disabled()'::regprocedure
       AND (p.prosecdef OR pg_get_userbyid(p.proowner) <> 'postgres'
            OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
            OR has_function_privilege('anon', p.oid, 'EXECUTE')
            OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR has_function_privilege('service_role', p.oid, 'EXECUTE')))
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
       WHERE t.tgname = 'trigger_a_blend_ticket_orders_disabled' AND NOT t.tgisinternal AND t.tgenabled = 'O'
         AND t.tgrelid = 'public.blend_ticket_to_order_items'::regclass
         AND t.tgfoid = 'public._blend_ticket_orders_disabled()'::regprocedure
         AND (t.tgtype & 3) = 3 AND (t.tgtype & 4) <> 0 AND (t.tgtype & 16) <> 0) THEN  -- BEFORE, FOR EACH ROW, on INSERT and UPDATE
    RAISE EXCEPTION 'POSTFLIGHT_BLEND_TICKET_ORDERS_TRIGGER';
  END IF;
  IF EXISTS (SELECT 1 FROM public.blend_ticket_to_order_items)
     OR EXISTS (SELECT 1 FROM public.blend_tickets WHERE order_link_status = 'linked') THEN
    RAISE EXCEPTION 'POSTFLIGHT_BLEND_TICKET_ORDERS_IN_USE';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
