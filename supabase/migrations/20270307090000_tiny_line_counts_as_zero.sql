-- A delivered line under 0.01 beside real lines counts as zero (Taha, #2324 review 2026-11-24; Mason, Slack
-- 2026-11-23: under 0.01 must not make an invoice). Known issue 2026-11-24-2324-tiny-line-beside-real-lines.
-- Contract: docs/plans/2026-11-25-tiny-line-counts-as-zero-CONTRACT.md.
--
-- WHAT: the completion body _complete_delivery_authorized_impl_20270122 (20270227110000) is renamed, unchanged, to
--   _complete_delivery_body_impl_20270307. A thin wrapper takes the old name and signature: every line whose figure
--   (the clamped figure sent for it, or its scheduled quantity when no figures are sent) is above 0 and under 0.01
--   is passed to the body as 0, exactly as if the driver had typed 0 (no stock, order-line or invoice effect; the
--   line's quantity becomes a remainder). When nothing is tiny the call is passed through unchanged.
-- NOT CHANGED: #2324's step _complete_delivery_authorized_impl (it still refuses a load where every line is under
--   0.01, and still compares the figures as sent), complete_delivery, start_and_complete_delivery, existing rows.
-- caller-analysis: _complete_delivery_authorized_impl_20270122 :: same name and signature; its only caller,
--   _complete_delivery_authorized_impl, keeps calling it by name. EXECUTE stays revoked from every client role.
-- actor-binding-check: exempt -- internal _impl, EXECUTE revoked from every client role; reached only through
-- _complete_delivery_aggregate_impl, which binds p_performed_by to auth.uid() (ACTOR_MISMATCH).
-- idempotency-body-check: exempt -- this wrapper passes the key through; the renamed body checks and saves it.

-- No table lock: renaming and creating functions takes none.
DO $preflight$
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM 'bbe9c44f7ade7d12f86bfe1c039d16ac'
     OR to_regprocedure('public._complete_delivery_body_impl_20270307(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)') IS NOT NULL THEN
    RAISE EXCEPTION 'TINY_LINE_PREFLIGHT: _complete_delivery_authorized_impl_20270122 is not the reviewed 20270227110000 body (or this is already applied)';
  END IF;
END
$preflight$;

ALTER FUNCTION public._complete_delivery_authorized_impl_20270122(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone)
  RENAME TO _complete_delivery_body_impl_20270307;

CREATE FUNCTION public._complete_delivery_authorized_impl_20270122(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_zero jsonb;
  v_quantities jsonb := p_quantities;
BEGIN
  -- Only a figure the body would use as a number: no figures (the scheduled quantity), or a JSON number for a line
  -- of this delivery. Anything else is left for the earlier checks and the body, as today.
  IF p_quantities IS NULL OR jsonb_typeof(p_quantities) = 'object' THEN
    SELECT jsonb_object_agg(di.id::text, 0) INTO v_zero
      FROM (SELECT di.id,
                   CASE WHEN p_quantities IS NULL OR NOT (p_quantities ? di.id::text) THEN di.quantity
                        WHEN jsonb_typeof(p_quantities -> di.id::text) = 'number'
                          THEN GREATEST(0, LEAST((p_quantities ->> di.id::text)::numeric, di.quantity))
                   END AS figure
              FROM public.delivery_items di
             WHERE di.delivery_id = p_delivery_id) di
     WHERE di.figure > 0 AND di.figure < 0.01;
    IF v_zero IS NOT NULL THEN
      v_quantities := COALESCE(p_quantities,
                               (SELECT jsonb_object_agg(di.id::text, di.quantity)
                                  FROM public.delivery_items di WHERE di.delivery_id = p_delivery_id)) || v_zero;
    END IF;
  END IF;
  RETURN public._complete_delivery_body_impl_20270307(
    p_delivery_id, p_signed_by, p_performed_by, v_quantities, p_issue_type, p_issue_notes, p_idempotency_key, p_completed_at);
END;
$function$;
ALTER FUNCTION public._complete_delivery_authorized_impl_20270122(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._complete_delivery_authorized_impl_20270122(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._complete_delivery_body_impl_20270307(uuid, text, uuid, jsonb, text, text, text, timestamp with time zone) FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public._complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)',
    'public._complete_delivery_body_impl_20270307(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = to_regprocedure(v_sig)
                      AND p.prosecdef
                      AND p.proconfig = ARRAY['search_path=public, pg_temp']
                      AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                      AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'TINY_LINE_POSTFLIGHT: % security, search_path or grants are not as reviewed', v_sig;
    END IF;
  END LOOP;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public._complete_delivery_body_impl_20270307(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM 'bbe9c44f7ade7d12f86bfe1c039d16ac'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
          WHERE oid = to_regprocedure('public._complete_delivery_authorized_impl_20270122(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
        IS DISTINCT FROM '9a674fe5d2d569fb8202efe2886e104d' THEN
    RAISE EXCEPTION 'TINY_LINE_POSTFLIGHT: the renamed body or the wrapper is not as reviewed';
  END IF;
END
$postflight$;
