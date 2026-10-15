-- Written 2026-10-14. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: a sales rep turning an order into invoices names only themselves as the salesperson.
--   create_invoice_from_order and create_split_invoices_from_order (both granted to authenticated,
--   both admitting admins and sales reps) stored COALESCE(p_salesman_id, orders.salesman_id) as
--   invoices.salesman_id with no check that a rep named themselves. invoices.salesman_id is a
--   read-access key (the invoices SELECT policy and its child-table policies,
--   get_customer_balance_listing, get_field_profitability), so naming another profile gave that
--   profile read access to the invoice. Both public wrappers now refuse a non-admin caller whose
--   non-null p_salesman_id is not auth.uid(), with SALESMAN_SCOPE_DENIED (P0001), the same code
--   and test save_invoice uses (20261013220000). Admins may name anyone. A NULL p_salesman_id
--   still falls back to the order's salesperson (Mason, 2026-10-14, "Option A"): complete_delivery's
--   automatic split sends exactly that ("v_delivery.order_id, NULL, 'chemical_sale'"), and the app
--   always sends the signed-in profile. Accepted residual: a rep can create an order, or edit a
--   blend ticket an order is made from, naming another salesperson, and a direct NULL call then
--   invoices under that name; the own-name rule for orders and blend tickets is a separate
--   follow-up (KNOWN_ISSUES.md). Customer scope is NOT added: reps invoice any customer
--   (Mason, 2026-10-13, DECISION_LOG.md).
--   Error order: create_invoice_from_order runs the own-name test before its implementation's
--   authentication and role gate, so a caller with no user or a driver naming someone else now
--   gets SALESMAN_SCOPE_DENIED rather than "Not authenticated"/"Not authorized"; both refuse.
--
-- WHY (Mason): the intended rule since 2026-10-06, narrowed 2026-10-13 to "reps bill any customer,
--   but only under their own name; admins unrestricted" (KNOWN_ISSUES.md, "Order-invoice RPCs let
--   a rep name another salesperson"); Mason chose this fix in chat on 2026-10-14.
--
-- ALSO, because the split wrapper is re-emitted (KNOWN_ISSUES.md asks whichever change re-emits it
-- to carry both):
--   * the CRX-LIFE-001 type allow-list (chemical_sale or misc_charge, ORDER_INVOICE_TYPE_NOT_ALLOWED,
--     23514) right after the role gate, before the claim and before any invoice number is drawn. A
--     refused field_application split used to fail on invoices_field_application_has_no_order only
--     after its first INSERT had drawn a number, leaving a gap in invoice numbering.
--   * the idempotency key is required (IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order,
--     22023), as create_invoice_from_order already requires. Both callers always send one: the
--     Order page (OrderDetail.tsx) and complete_delivery (its key, or the delivery id, + ':autosplit').
--
-- NOT CHANGED: the role gates, every lock, the replay and provenance logic, and both implementation
--   functions (_create_invoice_from_order_idem_impl_20260721,
--   _create_split_invoices_from_order_provenance_impl_20260719). Each wrapper is the verbatim live
--   body of 2026-10-14 plus only the hunks above. No rows change. No GRANT or REVOKE:
--   CREATE OR REPLACE keeps each OID, owner and exact ACL, and the postflight proves it.
--
-- ORDERING: strict. Apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE order_invoice_own_name_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)')::oid AS single_oid,
       to_regprocedure('public.create_split_invoices_from_order(uuid,uuid,text,text)')::oid AS split_oid;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change
  -- (a client that stops on the first error, as every sanctioned apply path does, then stops).
  IF to_regclass('pg_temp.order_invoice_own_name_tx') IS NULL THEN
    RAISE EXCEPTION 'ORDER_INVOICE_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.order_invoice_own_name_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'ORDER_INVOICE_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = 'a1a91643bd8866823ae359f7e0ec290e'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_ORDER_INVOICE_WRAPPER_DRIFT: expected the exact reviewed public create_invoice_from_order';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_split_invoices_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid[]'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = '398030fbb64006b4750e7e89a61b6cb9'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_split_invoices_from_order(uuid,uuid,text,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_INVOICE_WRAPPER_DRIFT: expected the exact reviewed public create_split_invoices_from_order';
  END IF;
  -- What the own-name test relies on, pinned to its live body of 2026-10-14 (CR-insensitive: live
  -- stores one of them with CRLF): is_admin()/is_sales_rep() mean an ACTIVE admin/rep;
  -- complete_delivery's automatic split sends a NULL salesperson and a key; the private
  -- implementations keep the role gate and the COALESCE(p_salesman_id, orders.salesman_id) fallback.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.is_admin()', 'f76bf61116c3bd52bd9c6ea125079b73'),
        ('public.is_sales_rep()', 'fcb3133010fe3f4f56e3be31f709d102'),
        ('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)', 'f8de9f000e40f7bfd8f792012f04fee0'),
        ('public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)', '3d393fb8639dbcb2aa38574ca9679eee'),
        ('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)', '454e04c4e199549a4f5be9975e397e17'),
        ('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)', 'f671f1a3f5406cff52aedd8a5fb40b31')
      ) AS pin(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_DEPENDENCY_DRIFT: a role helper, complete_delivery or an order-invoice implementation differs from its reviewed body';
  END IF;
  -- Only the wrappers may reach the implementations: none may be callable by a Data API role.
  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY[
        to_regprocedure('public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)'),
        to_regprocedure('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)'),
        to_regprocedure('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)')
      ]::oid[]) AS impl
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
     WHERE has_function_privilege(api_role, impl, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_PRIVATE_IMPL_EXPOSED: an order-invoice implementation is executable by a Data API role';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.create_invoice_from_order(
  p_order_id uuid,
  p_salesman_id uuid DEFAULT NULL,
  p_invoice_type text DEFAULT 'chemical_sale',
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_from_order'
      USING ERRCODE = '22023';
  END IF;
  -- Field invoices come only from the field-application, job-transfer and blend-ticket
  -- workflows, and credit memos only from issue_return_credit (CRX-LIFE-001).
  IF p_invoice_type IS NULL OR p_invoice_type NOT IN ('chemical_sale', 'misc_charge') THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TYPE_NOT_ALLOWED: an invoice created from an order must be chemical_sale or misc_charge'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Own name (Mason, 2026-10-06, narrowed 2026-10-13): a sales rep bills any customer but names
  -- only themselves as salesperson; an admin may name anyone. A NULL p_salesman_id keeps the
  -- order's salesperson (Mason, 2026-10-14, "Option A"): complete_delivery's automatic split sends NULL.
  IF p_salesman_id IS NOT NULL
     AND p_salesman_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
  END IF;
  RETURN public._create_invoice_from_order_idem_impl_20260721(
    p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_split_invoices_from_order(
  p_order_id uuid,
  p_salesman_id uuid DEFAULT NULL::uuid,
  p_invoice_type text DEFAULT 'chemical_sale'::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_contract CONSTANT text := 'create_split_invoices_from_order_v1';
  v_request jsonb;
  v_fingerprint text;
  v_replay jsonb;
  v_invoice_ids uuid[] := '{}'::uuid[];
  v_claim_nonce uuid := gen_random_uuid();
  v_has_split_evidence boolean := false;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order'
      USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;
  -- Field invoices come only from the field-application, job-transfer and blend-ticket
  -- workflows, and credit memos only from issue_return_credit (CRX-LIFE-001). Refused here,
  -- before the claim and before any invoice number is drawn.
  IF p_invoice_type IS NULL OR p_invoice_type NOT IN ('chemical_sale', 'misc_charge') THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TYPE_NOT_ALLOWED: an invoice created from an order must be chemical_sale or misc_charge'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Own name (Mason, 2026-10-06, narrowed 2026-10-13): a sales rep bills any customer but names
  -- only themselves as salesperson; an admin may name anyone. A NULL p_salesman_id keeps the
  -- order's salesperson (Mason, 2026-10-14, "Option A"): complete_delivery's automatic split sends NULL.
  IF p_salesman_id IS NOT NULL
     AND p_salesman_id IS DISTINCT FROM v_actor
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
  END IF;

  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'order_id', p_order_id,
    'salesman_id', p_salesman_id,
    'invoice_type', p_invoice_type
  );
  v_fingerprint := md5(v_request::text);
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_bound_lifecycle_idempotency(
      p_idempotency_key,
      'create_split_invoices_from_order',
      v_contract,
      v_fingerprint,
      v_request
    );
  END IF;

  PERFORM 1
    FROM public.orders o
   WHERE o.id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  PERFORM 1
    FROM public.order_items oi
   WHERE oi.order_id = p_order_id
   ORDER BY oi.id
   FOR UPDATE;

  SELECT EXISTS (
    SELECT 1
      FROM public.order_item_field_allocations oifa
      JOIN public.order_items oi ON oi.id = oifa.order_item_id
     WHERE oi.order_id = p_order_id
  ) INTO v_has_split_evidence;

  IF v_replay IS NOT NULL THEN
    SELECT COALESCE(
             array_agg(replayed.invoice_id ORDER BY replayed.ordinality),
             '{}'::uuid[]
           )
      INTO v_invoice_ids
      FROM (
        SELECT value::uuid AS invoice_id, ordinality
          FROM jsonb_array_elements_text(v_replay) WITH ORDINALITY
      ) replayed;
  ELSE
    INSERT INTO public.split_invoice_creation_claims (
      transaction_id,
      order_id,
      claim_nonce
    ) VALUES (
      pg_current_xact_id(),
      p_order_id,
      v_claim_nonce
    );

    v_invoice_ids := public._create_split_invoices_from_order_provenance_impl_20260719(
      p_order_id,
      p_salesman_id,
      p_invoice_type,
      NULL::text
    );

    INSERT INTO public.split_invoice_provenance (
      invoice_id,
      order_id,
      invoice_group_id,
      customer_id,
      invoice_type,
      season,
      total_amount_cents,
      content_claim,
      provenance_nonce,
      created_by
    )
    SELECT
      i.id,
      i.order_id,
      i.invoice_group_id,
      i.customer_id,
      i.invoice_type,
      i.season,
      i.total_amount_cents,
      public._split_invoice_content_claim(i.id),
      gen_random_uuid(),
      v_actor
    FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
    JOIN public.invoices i ON i.id = returned.invoice_id
    WHERE i.order_id = p_order_id
      AND i.invoice_group_id IS NOT NULL
      AND v_has_split_evidence
    ON CONFLICT (invoice_id) DO NOTHING;
  END IF;

  IF EXISTS (
       SELECT 1
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
        WHERE returned.invoice_id IS NULL
     )
     OR cardinality(COALESCE(v_invoice_ids, '{}'::uuid[])) IS DISTINCT FROM (
       SELECT count(DISTINCT returned.invoice_id)::integer
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
     )
     OR cardinality(COALESCE(v_invoice_ids, '{}'::uuid[])) IS DISTINCT FROM (
       SELECT count(*)::integer
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
         JOIN public.invoices i ON i.id = returned.invoice_id
        WHERE i.order_id = p_order_id
     ) THEN
    RAISE EXCEPTION
      'SPLIT_INVOICE_IDEMPOTENCY_RESPONSE_MISMATCH: every returned invoice must belong exactly to the requested order';
  END IF;

  IF v_has_split_evidence
     AND cardinality(COALESCE(v_invoice_ids, '{}'::uuid[])) IS DISTINCT FROM (
       SELECT count(*)::integer
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
         JOIN public.invoices i ON i.id = returned.invoice_id
         JOIN public.split_invoice_provenance p ON p.invoice_id = i.id
        WHERE i.order_id = p_order_id
          AND i.invoice_group_id IS NOT NULL
          AND p.order_id = i.order_id
          AND p.invoice_group_id = i.invoice_group_id
          AND p.customer_id = i.customer_id
          AND p.invoice_type = i.invoice_type
          AND p.season = i.season
          AND p.total_amount_cents = i.total_amount_cents
          AND p.content_claim = public._split_invoice_content_claim(i.id)
          AND p.contract_version = 'split_invoice_provenance_v1'
     ) THEN
    RAISE EXCEPTION
      'SPLIT_INVOICE_PROVENANCE_REPLAY_MISMATCH: returned split invoice content does not match its exact private claim';
  END IF;

  IF v_replay IS NULL THEN
    DELETE FROM public.split_invoice_creation_claims
     WHERE transaction_id = pg_current_xact_id()
       AND order_id = p_order_id
       AND claim_nonce = v_claim_nonce;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_INVOICE_CREATION_CLAIM_LOST';
    END IF;

    PERFORM public._bind_completed_lifecycle_idempotency(
      p_idempotency_key,
      'create_split_invoices_from_order',
      v_contract,
      v_fingerprint,
      v_request,
      to_jsonb(v_invoice_ids)
    );
  END IF;

  RETURN v_invoice_ids;
END;
$function$;

DO $postflight$
BEGIN
  IF to_regclass('pg_temp.order_invoice_own_name_tx') IS NULL THEN
    RAISE EXCEPTION 'ORDER_INVOICE_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.order_invoice_own_name_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'ORDER_INVOICE_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)')::oid
       IS DISTINCT FROM (SELECT single_oid FROM pg_temp.order_invoice_own_name_tx)
     OR to_regprocedure('public.create_split_invoices_from_order(uuid,uuid,text,text)')::oid
       IS DISTINCT FROM (SELECT split_oid FROM pg_temp.order_invoice_own_name_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_INVOICE_WRAPPER_IDENTITY: the replace must preserve both function OIDs';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = '16239bedc5004930b6daee0ce0c0bcea'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_INVOICE_WRAPPER_CONTRACT: public create_invoice_from_order body, signature or access drifted';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_split_invoices_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid[]'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = '1d94676468aa7319308190b0e1786090'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_split_invoices_from_order(uuid,uuid,text,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_INVOICE_WRAPPER_CONTRACT: public create_split_invoices_from_order body, signature or access drifted';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: order invoices name only the calling rep as salesperson (admins unrestricted); split invoices refuse other types and a missing key before any number is drawn';
END
$postflight$;
