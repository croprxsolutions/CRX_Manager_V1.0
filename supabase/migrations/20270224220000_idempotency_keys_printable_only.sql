-- #1912 follow-up: the same weak idempotency-key check fixed in adjust_inventory (20270201140000) is in 19 more
-- functions: `p_idempotency_key COLLATE "C" !~ '[!-~]'` needs only ONE printable character, so a key such as 'abc' followed by
-- a newline (or by a tab, a control character or a space) was accepted and stored. Each now refuses a
-- key with ANY character outside printable ASCII ('!' to '~'). App keys are '<operation>:<user uuid>:<uuid>'
-- (src/lib/idempotency.ts) or built from such keys and record ids, so no app call changes.
--
-- Functions: _section9_create_vendor_bill_cumulative_impl(uuid,uuid,text,date,date,text,bigint,bigint,text,text), _section9_receive_po_items_intent_impl_20260831(jsonb,uuid,text,boolean), _section9_record_vendor_payment_intent_impl_20260831(uuid,bigint,date,text,text,text,text), _section9_update_vendor_bill_intent_impl_20260831(uuid,bigint,bigint,date,date,text,text), _section9_void_vendor_bill_intent_impl_20260831(uuid,text,text), approve_return(uuid,uuid,text), cancel_return(uuid,text,uuid,text), create_commission_payment(uuid[],text,text,date,text,uuid,text), create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text), create_return(jsonb,jsonb,text), create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text), issue_return_credit(uuid,uuid,text), post_commission_payment(uuid,uuid,text), receive_return(uuid,uuid,text), reject_return(uuid,uuid,text), reverse_receiving_record(uuid,text,uuid,text), soft_delete_customer_document(uuid,uuid,text), void_commission_payment(uuid,text,uuid,text), void_vendor_payment(uuid,text,text).
--
-- Each body is the current one (newest migration that defines it, as replayed) with that one condition changed
-- and nothing else. CREATE OR REPLACE keeps each function's OID, owner, grants, SECURITY DEFINER, search_path,
-- arguments and return type. No table, row, grant or owner changes.
-- Plan: docs/plans/2026-11-19-adjust-inventory-key-printable-CONTRACT.md (follow-up section).
--
-- Safety: the preflight refuses unless every live body is exactly the expected current body (md5, carriage returns
-- removed), so a drifted body or a second apply is refused; the postflight checks each new body, that owner, grants,
-- security mode, settings, return type, volatility and arguments did not move, and that no public function still
-- holds the weak check.

CREATE TEMP TABLE idem_key_printable_1912_attrs ON COMMIT DROP AS
SELECT p.oid AS fn_oid, p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner,
       p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
       pg_get_function_arguments(p.oid) AS args,
       pg_current_xact_id()::text AS transaction_id
  FROM pg_proc p
 WHERE p.oid IN (
   to_regprocedure('public._section9_create_vendor_bill_cumulative_impl(uuid,uuid,text,date,date,text,bigint,bigint,text,text)'),
   to_regprocedure('public._section9_receive_po_items_intent_impl_20260831(jsonb,uuid,text,boolean)'),
   to_regprocedure('public._section9_record_vendor_payment_intent_impl_20260831(uuid,bigint,date,text,text,text,text)'),
   to_regprocedure('public._section9_update_vendor_bill_intent_impl_20260831(uuid,bigint,bigint,date,date,text,text)'),
   to_regprocedure('public._section9_void_vendor_bill_intent_impl_20260831(uuid,text,text)'),
   to_regprocedure('public.approve_return(uuid,uuid,text)'),
   to_regprocedure('public.cancel_return(uuid,text,uuid,text)'),
   to_regprocedure('public.create_commission_payment(uuid[],text,text,date,text,uuid,text)'),
   to_regprocedure('public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)'),
   to_regprocedure('public.create_return(jsonb,jsonb,text)'),
   to_regprocedure('public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)'),
   to_regprocedure('public.issue_return_credit(uuid,uuid,text)'),
   to_regprocedure('public.post_commission_payment(uuid,uuid,text)'),
   to_regprocedure('public.receive_return(uuid,uuid,text)'),
   to_regprocedure('public.reject_return(uuid,uuid,text)'),
   to_regprocedure('public.reverse_receiving_record(uuid,text,uuid,text)'),
   to_regprocedure('public.soft_delete_customer_document(uuid,uuid,text)'),
   to_regprocedure('public.void_commission_payment(uuid,text,uuid,text)'),
   to_regprocedure('public.void_vendor_payment(uuid,text,text)')
 );

DO $preflight$
DECLARE
  v_expected constant jsonb := jsonb_build_object(
    '_section9_create_vendor_bill_cumulative_impl(uuid,uuid,text,date,date,text,bigint,bigint,text,text)', 'd98445470b661f45f88effb1be7f7262',
    '_section9_receive_po_items_intent_impl_20260831(jsonb,uuid,text,boolean)', '67b35865c45c3e62fb86e0ac5f2c06f3',
    '_section9_record_vendor_payment_intent_impl_20260831(uuid,bigint,date,text,text,text,text)', 'e502bde6d133d1ffdc86310a1a83448c',
    '_section9_update_vendor_bill_intent_impl_20260831(uuid,bigint,bigint,date,date,text,text)', 'ddc8523ec32acbb637922c7a04b03410',
    '_section9_void_vendor_bill_intent_impl_20260831(uuid,text,text)', '3604715c5549658236caabe5ff366047',
    'approve_return(uuid,uuid,text)', '2117d01a701b0882c8d9dc3b442b6dba',
    'cancel_return(uuid,text,uuid,text)', '2c48338d74c9e5567807a1ea164ee47c',
    'create_commission_payment(uuid[],text,text,date,text,uuid,text)', 'ce2a3bf50a9ff55488c7977e5c90b408',
    'create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)', '8ed5e594f1136517678fe3e6387979b6',
    'create_return(jsonb,jsonb,text)', 'd535f68ffd3ee478d0516a0eb65830f9',
    'create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)', '85f67906b0746cd992eefe4e76e0d953',
    'issue_return_credit(uuid,uuid,text)', 'f3fcab7980d1640501fc038b0c8ac902',
    'post_commission_payment(uuid,uuid,text)', '786fde67537c52f8594f9cf0c54f1d14',
    'receive_return(uuid,uuid,text)', 'bd4c4e9975c059301e0b3ee21678012f',
    'reject_return(uuid,uuid,text)', '14a8151217c16336eab09d601cf4f708',
    'reverse_receiving_record(uuid,text,uuid,text)', 'cc3c6e95dbce2c1856509f28ba79624a',
    'soft_delete_customer_document(uuid,uuid,text)', 'e8e2c43fe4a747d23044b467b4eb3a05',
    'void_commission_payment(uuid,text,uuid,text)', '1952e3242db17858ffbe08910e3c99b2',
    'void_vendor_payment(uuid,text,text)', '82c69e11f8403612b0d3b56b7314cbb0');
  v_row record;
BEGIN
  -- A saved answer is replayed only after the key check, so a stored receipt under a key the new rule refuses could
  -- never be replayed: the caller's retry would be refused, and a retry under a new key could repeat the write.
  -- Receipts last 24 hours (a NULL expiry never expires), so apply only when no live receipt holds such a key.
  -- The lock waits for every in-flight write that is saving a receipt and holds new ones back until this commits,
  -- so no old-code write can save a bad-key receipt between the scan below and the new bodies going live.
  SET LOCAL lock_timeout = '15s';
  LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys WHERE (expires_at IS NULL OR expires_at >= now()) AND idempotency_key COLLATE "C" ~ '[^!-~]') THEN
    RAISE EXCEPTION 'IDEM_KEY_PRINTABLE_1912_WEAK_RECEIPT: % unexpired receipt(s) hold a key with a non-printable character; apply after they expire (24 hours)',
      (SELECT count(*) FROM public.idempotency_keys WHERE (expires_at IS NULL OR expires_at >= now()) AND idempotency_key COLLATE "C" ~ '[^!-~]');
  END IF;
  IF (SELECT count(*) FROM pg_temp.idem_key_printable_1912_attrs) <> 19 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: expected 19 functions, found %', (SELECT count(*) FROM pg_temp.idem_key_printable_1912_attrs);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_temp.idem_key_printable_1912_attrs WHERE transaction_id IS DISTINCT FROM pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  FOR v_row IN
    SELECT a.sig, md5(replace(p.prosrc, chr(13), '')) AS body_md5
      FROM pg_temp.idem_key_printable_1912_attrs a JOIN pg_proc p ON p.oid = a.fn_oid
  LOOP
    IF v_row.body_md5 IS DISTINCT FROM v_expected ->> v_row.sig THEN
      -- Already applied, or live drifted from the expected current body.
      RAISE EXCEPTION 'IDEM_KEY_PRINTABLE_1912_BASELINE_DRIFT: % body md5 %', v_row.sig, v_row.body_md5;
    END IF;
  END LOOP;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._section9_create_vendor_bill_cumulative_impl(p_vendor_id uuid, p_purchase_order_id uuid DEFAULT NULL::uuid, p_bill_number text DEFAULT ''::text, p_bill_date date DEFAULT CURRENT_DATE, p_due_date date DEFAULT NULL::date, p_payment_terms text DEFAULT NULL::text, p_subtotal_cents bigint DEFAULT 0, p_adjustment_cents bigint DEFAULT 0, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_bill_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to create vendor bills';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_vendor_bill requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'vendor_id', p_vendor_id,
    'purchase_order_id', p_purchase_order_id,
    'bill_number', p_bill_number,
    'bill_date', p_bill_date,
    'due_date', p_due_date,
    'payment_terms', p_payment_terms,
    'subtotal_cents', p_subtotal_cents,
    'adjustment_cents', p_adjustment_cents,
    'notes', p_notes
  )::text, 'UTF8'), 'sha256'), 'hex');

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'create_vendor_bill', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN (v_replay -> 'result' ->> 'bill_id')::uuid;
  END IF;

  PERFORM set_config('crx.section9_idempotency_intent', jsonb_build_object(
    'operation', 'create_vendor_bill', 'idempotency_key', p_idempotency_key,
    'actor_id', v_actor, 'fingerprint', v_fingerprint
  )::text, true);

  v_bill_id := public._section9_create_vendor_bill_intent_impl_20260826(
    p_vendor_id, p_purchase_order_id, p_bill_number, p_bill_date, p_due_date,
    p_payment_terms, p_subtotal_cents, p_adjustment_cents, p_notes, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor,
         request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'create_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_bill_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public._section9_receive_po_items_intent_impl_20260831(p_items jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text, p_allow_over_receive boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_allow_over_receive boolean := COALESCE(p_allow_over_receive, false);
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only admin or sales_rep can receive PO items';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: receive_po_items requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'items', p_items,
    'allow_over_receive', v_allow_over_receive
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'receive_po_items', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  PERFORM set_config('crx.section9_idempotency_intent', jsonb_build_object(
    'operation', 'receive_po_items', 'idempotency_key', p_idempotency_key,
    'actor_id', v_actor, 'fingerprint', v_fingerprint
  )::text, true);

  v_result := public._section9_receive_po_items_intent_impl_20260826(
    p_items, p_performed_by, p_idempotency_key, v_allow_over_receive
  );
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key AND operation = 'receive_po_items';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._section9_record_vendor_payment_intent_impl_20260831(p_vendor_bill_id uuid, p_amount_cents bigint, p_payment_date date DEFAULT CURRENT_DATE, p_payment_method text DEFAULT NULL::text, p_reference_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_payment_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to record vendor payments';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: record_vendor_payment requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'vendor_bill_id', p_vendor_bill_id,
    'amount_cents', p_amount_cents,
    'payment_date', p_payment_date,
    'payment_method', p_payment_method,
    'reference_number', p_reference_number,
    'notes', p_notes
  )::text, 'UTF8'), 'sha256'), 'hex');

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'record_vendor_payment', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN (v_replay -> 'result' ->> 'payment_id')::uuid;
  END IF;

  PERFORM set_config('crx.section9_idempotency_intent', jsonb_build_object(
    'operation', 'record_vendor_payment', 'idempotency_key', p_idempotency_key,
    'actor_id', v_actor, 'fingerprint', v_fingerprint
  )::text, true);

  v_payment_id := public._section9_record_vendor_payment_intent_impl_20260826(
    p_vendor_bill_id, p_amount_cents, p_payment_date, p_payment_method,
    p_reference_number, p_notes, p_idempotency_key
  );
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key AND operation = 'record_vendor_payment';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_payment_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public._section9_update_vendor_bill_intent_impl_20260831(p_bill_id uuid, p_subtotal_cents bigint, p_adjustment_cents bigint, p_bill_date date, p_due_date date, p_notes text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can edit vendor bills';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: update_vendor_bill requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'bill_id', p_bill_id,
    'subtotal_cents', p_subtotal_cents,
    'adjustment_cents', p_adjustment_cents,
    'bill_date', p_bill_date,
    'due_date', p_due_date,
    'notes', p_notes
  )::text, 'UTF8'), 'sha256'), 'hex');

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'update_vendor_bill', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  PERFORM set_config('crx.section9_idempotency_intent', jsonb_build_object(
    'operation', 'update_vendor_bill', 'idempotency_key', p_idempotency_key,
    'actor_id', v_actor, 'fingerprint', v_fingerprint
  )::text, true);

  v_result := public._section9_update_vendor_bill_intent_impl_20260826(
    p_bill_id, p_subtotal_cents, p_adjustment_cents, p_bill_date,
    p_due_date, p_notes, p_idempotency_key
  );
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key AND operation = 'update_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._section9_void_vendor_bill_intent_impl_20260831(p_vendor_bill_id uuid, p_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to void vendor bills';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_vendor_bill requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'vendor_bill_id', p_vendor_bill_id, 'reason', p_reason
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'void_vendor_bill', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN;
  END IF;

  PERFORM set_config('crx.section9_idempotency_intent', jsonb_build_object(
    'operation', 'void_vendor_bill', 'idempotency_key', p_idempotency_key,
    'actor_id', v_actor, 'fingerprint', v_fingerprint
  )::text, true);

  PERFORM public._section9_void_vendor_bill_intent_impl_20260826(
    p_vendor_bill_id, p_reason, p_idempotency_key
  );
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key AND operation = 'void_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_return(p_return_id uuid, p_approved_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_fingerprint text; v_replay jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_approved_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: approve_return requires p_idempotency_key'; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object('actor_id', v_actor, 'return_id', p_return_id)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'approve_return', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;
  v_result := public._approve_return_intent_impl_20260812(p_return_id, p_approved_by, p_idempotency_key);
  UPDATE public.idempotency_keys SET request_actor_id = v_actor, request_fingerprint = v_fingerprint WHERE idempotency_key = p_idempotency_key AND operation = 'approve_return';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_return(p_return_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_fingerprint text; v_replay jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'Reason is required to cancel a return'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: cancel_return requires p_idempotency_key'; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object('actor_id', v_actor, 'return_id', p_return_id, 'reason', p_reason)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'cancel_return', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;
  v_result := public._cancel_return_intent_impl_20260812(p_return_id, p_reason, p_performed_by, p_idempotency_key);
  UPDATE public.idempotency_keys SET request_actor_id = v_actor, request_fingerprint = v_fingerprint WHERE idempotency_key = p_idempotency_key AND operation = 'cancel_return';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_commission_payment(p_commission_ids uuid[], p_payment_method text, p_reference text, p_payment_date date, p_notes text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_payment_id uuid;
  -- Normalize ONCE, then use these same values for both the fingerprint and the
  -- implementation call. Fingerprinting a trimmed value while storing the raw
  -- one would let ' REF-1 ' replay REF-1's receipt while claiming to persist
  -- different metadata, so the two must never diverge.
  v_payment_method text := NULLIF(btrim(COALESCE(p_payment_method, '')), '');
  v_reference      text := NULLIF(btrim(COALESCE(p_reference, '')), '');
  v_notes          text := NULLIF(btrim(COALESCE(p_notes, '')), '');
BEGIN
  -- Same guards, same messages, same order as the implementation, so no
  -- legitimate caller sees a behaviour change.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to create a commission payment';
  END IF;

  -- A key is REQUIRED. It used to be optional, and omitting it ran the payout
  -- with no receipt and therefore no intent binding at all — an authenticated
  -- admin calling the RPC directly (PostgREST lets a defaulted argument be
  -- omitted) reached the money path unbound, which is the exact hole this
  -- migration exists to close. Every application caller already sends one, and
  -- the one checked-in smoke script that passed NULL
  -- (scripts/smoke/smoke-commission_payment_for_update_fix.sql) was fixed in the
  -- same change, so refusing here leaves no unbound door.
  -- Two predicates, deliberately. The first is the house rule already live in
  -- 20260721145936 across every money/lifecycle RPC, kept so this path does not
  -- drift from the rest. The second demands one printable ASCII character:
  -- [[:space:]] follows the database collation, so whether NBSP or an em-space
  -- counts as blank is not the same answer on every cluster, and a key made
  -- only of those would be accepted somewhere. Every key this application
  -- generates is ASCII, so this costs no real caller anything.
  --
  -- COLLATE "C" is what makes the second predicate locale-independent, and it
  -- is not decoration: Postgres resolves a bracket RANGE like [!-~] through the
  -- active collating sequence, so under a non-C collation a non-ASCII character
  -- can sort inside the range and satisfy it. Both predicates would then be
  -- locale-dependent and a key with no printable ASCII could be accepted after
  -- all. "C" is built in and always present, so pinning it here has no
  -- deployment cost.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_commission_payment requires p_idempotency_key';
  END IF;

  -- Intent = the actor plus the sorted, de-duplicated commission selection and
  -- every payment field the admin can edit. p_payment_date is fingerprinted
  -- raw: substituting CURRENT_DATE here would make an otherwise identical
  -- retry across midnight look like a changed intent.
  --
  -- p_performed_by is deliberately NOT fingerprinted, and that omission depends
  -- on the guard above constraining it to {NULL, v_actor} — it therefore carries
  -- no information beyond actor_id. If that guard is ever relaxed, p_performed_by
  -- MUST be added here.
  --
  -- The DISTINCT below matches the implementation, which also de-duplicates the
  -- selection (SELECT DISTINCT id FROM unnest(p_commission_ids)) before locking
  -- and paying, so [A, A] and [A] are the same request in both layers.
  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'commission_ids', (
          SELECT COALESCE(jsonb_agg(to_jsonb(cid) ORDER BY cid), '[]'::jsonb)
            FROM (
              SELECT DISTINCT unnest(COALESCE(p_commission_ids, ARRAY[]::uuid[])) AS cid
            ) s
        ),
        'payment_method', v_payment_method,
        'reference', v_reference,
        'payment_date', p_payment_date,
        'notes', v_notes
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'create_commission_payment', v_actor, v_fingerprint
  );

  IF v_replay IS NOT NULL THEN
    -- Return the committed receipt here rather than delegating: the
    -- implementation's own check_idempotency reads a NULL stored result as
    -- "no receipt" and would re-execute the payout. idempotency_keys.result
    -- is nullable, so fail closed instead.
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN ((v_replay -> 'result') #>> '{}')::uuid;
  END IF;

  v_payment_id := public._create_commission_payment_intent_impl_20260809(
    p_commission_ids, v_payment_method, v_reference,
    p_payment_date, v_notes, p_performed_by, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'create_commission_payment';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_payment_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_inventory_hold(p_product_id uuid, p_customer_id uuid, p_quantity numeric, p_hold_type text, p_expires_at date, p_notes text, p_performed_by uuid, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  -- Normalize the force flag ONCE, here, and use v_force for BOTH the
  -- fingerprint and the delegated call. The wrapped body tests p_force with
  -- bare `IF p_force` and `AND NOT p_force`, and a SQL/JSON NULL makes both
  -- three-valued: `IF NULL` takes the ELSE path, so FORCE_REQUIRES_ADMIN and
  -- FORCE_REQUIRES_REASON never fire, and `over_capacity AND NOT NULL` is NULL
  -- rather than true, so INSUFFICIENT_HOLD_INVENTORY never raises. A sales rep
  -- posting p_force: null could therefore book an unlimited over-capacity hold
  -- with no admin authorization, no force reason, and no 'WARNING: ... admin
  -- override' activity row. This wrapper is the only entrypoint `authenticated`
  -- can reach (the impl is postgres-only since the 20260908130000 rename), so
  -- normalizing here closes it without editing the wrapped body.
  v_force boolean := COALESCE(p_force, false);
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  -- Same rule as the wrapped body: the caller may name itself or nothing.
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- NULL-safe and active-only. A missing or deactivated profile is refused
  -- here; the wrapped body's own gate runs again afterwards and can only be
  -- stricter than a pass.
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- To-Do 0.14 (20261025090000): this path takes no quote or job, so a
  -- 'crop_program' or 'job' hold made here would have no source_id and nothing
  -- could ever release it. Quote and job holds are written only by
  -- _sync_planned_holds / _sync_quote_job_reservations / _sync_job_holds.
  IF p_hold_type IS DISTINCT FROM 'manual' THEN
    RAISE EXCEPTION 'HOLD_TYPE_NOT_ALLOWED: create_inventory_hold creates manual holds only (got %)', COALESCE(p_hold_type, 'NULL');
  END IF;

  -- A key is required so every hold is a receipt that a retry can find. Blank,
  -- whitespace-only, or non-printable keys are refused before any work.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_inventory_hold requires p_idempotency_key';
  END IF;

  -- Everything that shapes the hold. p_performed_by is not included: the
  -- guard above constrains it to {NULL, actor} and the wrapped body stamps
  -- created_by from auth.uid(), so it cannot change the outcome. That omission
  -- DEPENDS on the ACTOR_MISMATCH guard; if that guard is ever relaxed,
  -- p_performed_by must join the fingerprint (same warning as 20260811130000).
  -- trim_scale makes 5 and 5.0 the same request.
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'product_id', p_product_id,
    'customer_id', p_customer_id,
    'quantity', trim_scale(p_quantity),
    'hold_type', p_hold_type,
    'expires_at', p_expires_at,
    'notes', p_notes,
    'force', v_force,
    'force_reason', p_force_reason
  )::text, 'UTF8'), 'sha256'), 'hex');

  -- Publish the binding context BEFORE any receipt can be written. The
  -- BEFORE INSERT trigger installed by 20260908130000 rejects any
  -- create_inventory_hold receipt that arrives without it, which is what stops
  -- an old-body call that was already in flight at cutover from landing an
  -- unbound receipt. `true` = transaction-local, so it disappears on COMMIT or
  -- ROLLBACK and cannot leak into the connection's next transaction.
  PERFORM set_config('crx.create_inventory_hold_intent', jsonb_build_object(
    'operation', 'create_inventory_hold',
    'idempotency_key', p_idempotency_key,
    'actor_id', v_actor,
    'fingerprint', v_fingerprint
  )::text, true);

  -- Takes pg_advisory_xact_lock on the key for the rest of this transaction.
  -- A racing same-key call waits here until this one commits, then replays.
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'create_inventory_hold', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- Stock check under FOR UPDATE, hold insert, activity row, receipt insert —
  -- unchanged from the live body.
  v_result := public._create_inventory_hold_intent_impl_20260905(
    p_product_id, p_customer_id, p_quantity, p_hold_type, p_expires_at,
    p_notes, p_performed_by, v_force, p_force_reason, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'create_inventory_hold';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_return(p_return jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_return requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'return', p_return,
    'items', p_items
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_return', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  v_result := public._create_return_intent_impl_20260812(p_return, p_items, p_idempotency_key);
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key AND operation = 'create_return';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_vendor_bill(p_vendor_id uuid, p_purchase_order_id uuid DEFAULT NULL::uuid, p_bill_number text DEFAULT ''::text, p_bill_date date DEFAULT ((now() AT TIME ZONE 'America/Chicago'::text))::date, p_due_date date DEFAULT NULL::date, p_payment_terms text DEFAULT NULL::text, p_subtotal_cents bigint DEFAULT 0, p_adjustment_cents bigint DEFAULT 0, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_confirm_po_overage boolean DEFAULT false, p_po_overage_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_fingerprint text;
  v_replay jsonb;
  v_bill_id uuid;
  v_candidate_total bigint;
  v_po_total bigint;
  v_active_billed_total bigint;
  v_cumulative_total bigint;
  v_overage_confirmed boolean := false;
  v_reason text := btrim(COALESCE(p_po_overage_reason, ''));
  v_received_cents bigint;
  v_limit_cents bigint;
  v_any_received boolean;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to create vendor bills';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_vendor_bill requires p_idempotency_key';
  END IF;
  IF p_due_date IS NOT NULL AND p_due_date < p_bill_date THEN
    RAISE EXCEPTION 'INVALID_DUE_DATE: due date cannot precede bill date';
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'vendor_id', p_vendor_id,
        'purchase_order_id', p_purchase_order_id,
        -- These nullable text inputs are passed to the mature implementation
        -- unchanged. Keep their exact SQL values in the fingerprint too:
        -- notably, NULL payment terms invoke vendor defaults while '' means an
        -- explicit empty term with the implementation's fallback due interval.
        'bill_number', p_bill_number,
        'bill_date', p_bill_date,
        'due_date', p_due_date,
        'payment_terms', p_payment_terms,
        'subtotal_cents', p_subtotal_cents,
        'adjustment_cents', COALESCE(p_adjustment_cents, 0),
        'notes', p_notes,
        'confirm_po_overage', COALESCE(p_confirm_po_overage, false),
        'po_overage_reason', v_reason
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'create_vendor_bill', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null'
       OR NULLIF(v_replay #>> '{result,bill_id}', '') IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN (v_replay #>> '{result,bill_id}')::uuid;
  END IF;

  v_candidate_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);

  -- Preserve the established financial lock order used by the delegated bill
  -- implementation and supplier-cost application: vendor before optional PO.
  -- Taking the PO first here would deadlock with vendor -> PO writers.
  PERFORM 1
  FROM public.vendors v
  WHERE v.id = p_vendor_id
    AND v.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND: vendor % does not exist or is soft-deleted', p_vendor_id;
  END IF;

  IF p_purchase_order_id IS NOT NULL THEN
    SELECT po.total_cost_cents
    INTO v_po_total
    FROM public.purchase_orders po
    WHERE po.id = p_purchase_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO_NOT_FOUND: purchase order % does not exist', p_purchase_order_id;
    END IF;
    -- KI-143: compare billing with what arrived (received x unit cost, rounded per line as the PO total is),
    -- read under the PO lock that receiving also takes.
    SELECT COALESCE(SUM(round(poi.quantity_received * poi.unit_cost * 100)), 0)::bigint,
           COALESCE(bool_or(poi.quantity_received > 0), false)
    INTO v_received_cents, v_any_received
    FROM public.purchase_order_items poi
    WHERE poi.purchase_order_id = p_purchase_order_id;
    -- Mason 2026-11-10: once any quantity has arrived (even a $0-cost line) the limit is what arrived, never above
    -- the ordered total; before that, the ordered total.
    v_limit_cents := CASE WHEN v_any_received THEN LEAST(v_received_cents, v_po_total) ELSE v_po_total END;

    SELECT COALESCE(SUM(vb.total_cents), 0)::bigint
    INTO v_active_billed_total
    FROM public.vendor_bills vb
    WHERE vb.purchase_order_id = p_purchase_order_id
      AND vb.deleted_at IS NULL
      AND vb.status <> 'voided';

    v_cumulative_total := v_active_billed_total + v_candidate_total;
    IF v_cumulative_total > 0
       AND (v_limit_cents <= 0 OR v_cumulative_total * 100 > v_limit_cents * 105) THEN
      IF COALESCE(p_confirm_po_overage, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED'
          USING ERRCODE = '22023',
                DETAIL = jsonb_build_object(
                  'po_total_cents', v_po_total,
                  'received_value_cents', v_received_cents,
                  'limit_cents', v_limit_cents,
                  'active_billed_cents', v_active_billed_total,
                  'candidate_bill_cents', v_candidate_total,
                  'cumulative_bill_cents', v_cumulative_total
                )::text;
      END IF;
      IF v_reason = '' THEN
        RAISE EXCEPTION 'PO_CUMULATIVE_BILLING_REASON_REQUIRED';
      END IF;
      v_overage_confirmed := true;
    END IF;
  END IF;

  v_bill_id := public._section9_create_vendor_bill_cumulative_impl(
    p_vendor_id,
    p_purchase_order_id,
    p_bill_number,
    p_bill_date,
    p_due_date,
    p_payment_terms,
    p_subtotal_cents,
    p_adjustment_cents,
    p_notes,
    p_idempotency_key
  );

  UPDATE public.idempotency_keys
  SET request_fingerprint = v_fingerprint,
      request_actor_id = v_actor
  WHERE idempotency_key = p_idempotency_key
    AND operation = 'create_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;

  IF v_overage_confirmed THEN
    INSERT INTO public.activity_feed (
      event_type, description, performed_by, related_entity_type, related_entity_id
    ) VALUES (
      'po_cumulative_billing_overage_confirmed',
      'Vendor bill ' || v_bill_id::text || ' exceeded the cumulative PO billing threshold: ' || v_reason,
      v_actor,
      'purchase_order',
      p_purchase_order_id
    );
  END IF;

  RETURN v_bill_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.issue_return_credit(p_return_id uuid, p_actor_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_fingerprint text; v_replay jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_actor_id IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: issue_return_credit requires p_idempotency_key'; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object('actor_id', v_actor, 'return_id', p_return_id)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'issue_return_credit', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;
  v_result := public._issue_return_credit_intent_impl_20260812(p_return_id, p_actor_id, p_idempotency_key);
  UPDATE public.idempotency_keys SET request_actor_id = v_actor, request_fingerprint = v_fingerprint WHERE idempotency_key = p_idempotency_key AND operation = 'issue_return_credit';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_commission_payment(p_payment_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to post a commission payment';
  END IF;

  -- See create: a key is REQUIRED, so no caller reaches the money path unbound.
  -- Two predicates, deliberately. The first is the house rule already live in
  -- 20260721145936 across every money/lifecycle RPC, kept so this path does not
  -- drift from the rest. The second demands one printable ASCII character:
  -- [[:space:]] follows the database collation, so whether NBSP or an em-space
  -- counts as blank is not the same answer on every cluster, and a key made
  -- only of those would be accepted somewhere. Every key this application
  -- generates is ASCII, so this costs no real caller anything.
  --
  -- COLLATE "C" is what makes the second predicate locale-independent, and it
  -- is not decoration: Postgres resolves a bracket RANGE like [!-~] through the
  -- active collating sequence, so under a non-C collation a non-ASCII character
  -- can sort inside the range and satisfy it. Both predicates would then be
  -- locale-dependent and a key with no printable ASCII could be accepted after
  -- all. "C" is built in and always present, so pinning it here has no
  -- deployment cost.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: post_commission_payment requires p_idempotency_key';
  END IF;

  -- Intent = the actor plus which payment is being posted.
  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'payment_id', p_payment_id
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'post_commission_payment', v_actor, v_fingerprint
  );

  IF v_replay IS NOT NULL THEN
    -- See create_commission_payment: return the committed receipt directly so a
    -- NULL stored result can never be mistaken for "not yet performed".
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  v_result := public._post_commission_payment_intent_impl_20260809(
    p_payment_id, p_performed_by, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'post_commission_payment';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.receive_return(p_return_id uuid, p_received_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_fingerprint text; v_replay jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_received_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: receive_return requires p_idempotency_key'; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object('actor_id', v_actor, 'return_id', p_return_id)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'receive_return', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;
  v_result := public._receive_return_intent_impl_20260812(p_return_id, p_received_by, p_idempotency_key);
  UPDATE public.idempotency_keys SET request_actor_id = v_actor, request_fingerprint = v_fingerprint WHERE idempotency_key = p_idempotency_key AND operation = 'receive_return';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reject_return(p_return_id uuid, p_rejected_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_fingerprint text; v_replay jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_rejected_by IS NOT NULL AND p_rejected_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: reject_return requires p_idempotency_key'; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object('actor_id', v_actor, 'return_id', p_return_id)::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'reject_return', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID'; END IF;
    RETURN v_replay -> 'result';
  END IF;
  v_result := public._reject_return_intent_impl_20260812(p_return_id, p_rejected_by, p_idempotency_key);
  UPDATE public.idempotency_keys SET request_actor_id = v_actor, request_fingerprint = v_fingerprint WHERE idempotency_key = p_idempotency_key AND operation = 'reject_return';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_receiving_record(p_record_id uuid, p_reason text DEFAULT 'Manually reversed'::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_reason text;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
  v_purchase_order_id uuid;
  v_po_item_id uuid;
  v_receiving_date date;
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);

  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REQUIRED: reverse_receiving_record requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'record_id', p_record_id,
        'reason', v_reason
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'reverse_receiving_record', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  SELECT rr.purchase_order_id,
         rr.po_item_id,
         (rr.received_at AT TIME ZONE 'America/Chicago')::date
    INTO v_purchase_order_id, v_po_item_id, v_receiving_date
    FROM public.receiving_records rr
   WHERE rr.id = p_record_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receiving record not found: %', p_record_id; END IF;

  -- Canonical supplier-cost/receiving lock order: PO item, then PO. The
  -- delegated reversal later updates both rows, so acquiring them here in the
  -- shared order serializes with supplier-cost application without deadlocks.
  PERFORM 1
    FROM public.purchase_order_items poi
   WHERE poi.id = v_po_item_id
     AND poi.purchase_order_id = v_purchase_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURCHASE_ORDER_ITEM_NOT_FOUND: %', v_po_item_id;
  END IF;

  PERFORM 1
    FROM public.purchase_orders po
   WHERE po.id = v_purchase_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURCHASE_ORDER_NOT_FOUND: %', v_purchase_order_id;
  END IF;

  PERFORM public._lock_accounting_months(ARRAY[v_receiving_date], false);
  PERFORM public.check_period_open(v_receiving_date);

  v_result := public._section9_reverse_receiving_record_serialized(
    p_record_id, v_reason, p_performed_by, p_idempotency_key
  );

  UPDATE public.idempotency_keys
  SET request_fingerprint = v_fingerprint,
      request_actor_id = v_actor
  WHERE idempotency_key = p_idempotency_key
    AND operation = 'reverse_receiving_record';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.soft_delete_customer_document(p_document_id uuid, p_customer_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_is_admin boolean;
  v_fingerprint text;
  v_replay jsonb;
  v_customer_id uuid;
  v_deleted_at timestamptz;
  v_result jsonb;
  v_helper_detail text;
BEGIN
  -- Who is calling. All of this runs BEFORE any receipt is looked at.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: Authentication required';
  END IF;

  -- Same predicates as is_admin() / is_sales_rep(): active profiles only.
  -- FOR SHARE holds off a concurrent deactivation or role change until this
  -- (permanent) removal has committed or rolled back.
  SELECT p.role = 'admin'
    INTO v_is_admin
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.role IN ('admin', 'sales_rep')
     AND p.is_active = true
     FOR SHARE;
  IF v_is_admin IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: Only active admins and sales reps can remove customer documents';
  END IF;

  IF p_idempotency_key IS NULL
     OR length(p_idempotency_key) > 255
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: soft_delete_customer_document requires a p_idempotency_key of at most 255 characters';
  END IF;

  IF p_document_id IS NULL OR p_customer_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  -- The actor, the document AND its customer are the whole request. The
  -- customer is in the fingerprint as well as the WHERE clause, so the same
  -- key cannot be replayed against a different customer.
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'customer_id', p_customer_id,
    'document_id', p_document_id
  )::text, 'UTF8'), 'sha256'), 'hex');

  -- Takes pg_advisory_xact_lock on the key for the rest of this transaction
  -- and replays only a receipt bound to THIS actor and THIS document.
  -- The helper's IDEMPOTENCY_INTENT_MISMATCH carries the committed receipt in
  -- DETAIL. Here that receipt names an earlier document and customer the
  -- caller may no longer be allowed to see (a key reused on another document
  -- after a reassignment), so it is re-raised with the same message and
  -- SQLSTATE but no DETAIL. The page keys per document and never hits this.
  --
  -- The scrub is STRUCTURAL: no path below re-raises the helper's exception, so
  -- the DETAIL can never reach a client, and leak safety does NOT depend on the
  -- helper's message text. That is deliberate. An earlier revision of this
  -- round classified by message and called bare RAISE for the non-mismatch
  -- case; a later re-emit of the helper that renamed or prefixed its 22023
  -- message would then have leaked the receipt (rls-security-reviewer M1,
  -- 2026-09-23). The message is now used ONLY to pick which token to answer
  -- with, so a drifted message mislabels a fault and leaks nothing.
  --
  -- starts_with(), NOT LIKE: `_` is a LIKE single-character wildcard, so
  -- 'IDEMPOTENCY_INTENT_MISMATCH%' also matches 'IDEMPOTENCYxINTENTyMISMATCH'
  -- (measured on live 2026-09-23, both operators, same round).
  --
  -- Read from the live installed definition 2026-09-23: the helper's only 22023
  -- raises are its two IDEMPOTENCY_INTENT_MISMATCH branches, and
  -- IDEMPOTENCY_ACTOR_MISMATCH and IDEMPOTENCY_CROSS_OP_KEY_REUSE carry no
  -- ERRCODE (P0001), so the FAULT branch is unreachable today. The prover
  -- drives it anyway with a shadow helper, because a security branch no test
  -- can reach is a branch whose first execution is its first test.
  BEGIN
    v_replay := public.check_idempotency_intent(
      p_idempotency_key, 'soft_delete_customer_document', v_actor, v_fingerprint
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    -- Keep the diagnostic on the SERVER side of the boundary, where it is not
    -- an oracle. Without this a real key collision leaves no record anywhere.
    GET STACKED DIAGNOSTICS v_helper_detail = PG_EXCEPTION_DETAIL;
    RAISE LOG 'soft_delete_customer_document: idempotency helper raised 22023 (%); detail: %',
      SQLERRM, coalesce(v_helper_detail, '(none)');
    IF starts_with(SQLERRM, 'IDEMPOTENCY_INTENT_MISMATCH') THEN
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH: This idempotency key was already used for a different request'
        USING ERRCODE = '22023';
    END IF;
    -- Any OTHER 22023 is an internal fault, not a client replay problem. A
    -- distinct token keeps the page from showing "we do not know whether your
    -- removal happened" for a failure that provably happened before the UPDATE.
    RAISE EXCEPTION 'IDEMPOTENCY_HELPER_FAULT: The idempotency check failed before anything was removed'
      USING ERRCODE = '22023';
  END;
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object'
       OR v_replay -> 'result' ->> 'customer_id' IS NULL
       OR v_replay -> 'result' ->> 'document_id' IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID: The stored receipt for this request is unusable';
    END IF;
    -- The fingerprint already binds BOTH ids, so these can only fail for a
    -- receipt written by an older version of this function or inserted by hand
    -- as postgres. Both are checked, not just the customer: a receipt naming
    -- another document would otherwise return a success envelope claiming that
    -- OTHER document was removed (migration-drift-reviewer L1, 2026-09-23).
    IF (v_replay -> 'result' ->> 'customer_id')::uuid IS DISTINCT FROM p_customer_id
       OR (v_replay -> 'result' ->> 'document_id')::uuid IS DISTINCT FROM p_document_id THEN
      RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
    END IF;
    -- Reps remove documents of ANY customer (Mason, 2026-10-13); the replay's
    -- assigned-rep re-check is removed by 20261013220000.
    -- KI-07 (20261222100000): an admin may have restored the document after this removal
    -- committed. Replaying the old receipt would tell the caller it is removed while it is live.
    IF NOT EXISTS (SELECT 1 FROM public.customer_documents d
                    WHERE d.id = p_document_id AND d.deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'CUSTOMER_DOCUMENT_RESTORED: An admin restored this document after your removal; it is still on file';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- One statement: find the active document and lock it (document FOR UPDATE,
  -- customer FOR SHARE). Reps remove documents of ANY customer (Mason,
  -- 2026-10-13; 20261013220000 removed the assignment test). Missing and
  -- removed are one error.
  SELECT d.customer_id
    INTO v_customer_id
    FROM public.customer_documents d
    JOIN public.customers c ON c.id = d.customer_id
   WHERE d.id = p_document_id
     AND d.customer_id = p_customer_id
     AND d.deleted_at IS NULL
     FOR UPDATE OF d
     FOR SHARE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  -- guard_customer_document_update still fires and requires deleted_by to be
  -- auth.uid(), which v_actor is.
  UPDATE public.customer_documents
     SET deleted_at = now(),
         deleted_by = v_actor
   WHERE id = p_document_id
     AND deleted_at IS NULL
  RETURNING deleted_at INTO v_deleted_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'document_id', p_document_id,
    'customer_id', v_customer_id,
    'deleted_at', v_deleted_at
  );

  -- The receipt, bound to the actor and the request. No row can exist for this
  -- key here: check_idempotency_intent returned NULL under the advisory lock.
  INSERT INTO public.idempotency_keys (
    idempotency_key, operation, result, request_actor_id, request_fingerprint
  ) VALUES (
    p_idempotency_key, 'soft_delete_customer_document', v_result, v_actor, v_fingerprint
  );

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_commission_payment(p_payment_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
  -- See create_commission_payment: fingerprint and implementation must receive
  -- the identical normalized value, never trimmed here and raw there.
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  -- REASON_REQUIRED is checked before the receipt lookup in the implementation;
  -- keep that ordering so the error surface is unchanged.
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  -- See create: a key is REQUIRED, so no caller reaches the money path unbound.
  -- Two predicates, deliberately. The first is the house rule already live in
  -- 20260721145936 across every money/lifecycle RPC, kept so this path does not
  -- drift from the rest. The second demands one printable ASCII character:
  -- [[:space:]] follows the database collation, so whether NBSP or an em-space
  -- counts as blank is not the same answer on every cluster, and a key made
  -- only of those would be accepted somewhere. Every key this application
  -- generates is ASCII, so this costs no real caller anything.
  --
  -- COLLATE "C" is what makes the second predicate locale-independent, and it
  -- is not decoration: Postgres resolves a bracket RANGE like [!-~] through the
  -- active collating sequence, so under a non-C collation a non-ASCII character
  -- can sort inside the range and satisfy it. Both predicates would then be
  -- locale-dependent and a key with no printable ASCII could be accepted after
  -- all. "C" is built in and always present, so pinning it here has no
  -- deployment cost.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_commission_payment requires p_idempotency_key';
  END IF;

  -- Intent = the actor, which payment is being voided, and the reason text
  -- (normalized only for surrounding whitespace, which the UI already trims).
  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'payment_id', p_payment_id,
        'reason', v_reason
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'void_commission_payment', v_actor, v_fingerprint
  );

  IF v_replay IS NOT NULL THEN
    -- See create_commission_payment: return the committed receipt directly so a
    -- NULL stored result can never be mistaken for "not yet performed".
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  v_result := public._void_commission_payment_intent_impl_20260809(
    p_payment_id, v_reason, p_performed_by, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'void_commission_payment';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_vendor_payment(p_payment_id uuid, p_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can void vendor payments';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_vendor_payment requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'payment_id', p_payment_id, 'reason', p_reason
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'void_vendor_payment', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  PERFORM set_config('crx.section9_idempotency_intent', jsonb_build_object(
    'operation', 'void_vendor_payment', 'idempotency_key', p_idempotency_key,
    'actor_id', v_actor, 'fingerprint', v_fingerprint
  )::text, true);

  v_result := public._section9_void_vendor_payment_intent_impl_20260826(
    p_payment_id, p_reason, p_idempotency_key
  );
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key AND operation = 'void_vendor_payment';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

DO $postflight$
DECLARE
  v_expected constant jsonb := jsonb_build_object(
    '_section9_create_vendor_bill_cumulative_impl(uuid,uuid,text,date,date,text,bigint,bigint,text,text)', 'a44fbfa7d38711b124d753dc4edff452',
    '_section9_receive_po_items_intent_impl_20260831(jsonb,uuid,text,boolean)', 'c7a4305c894d68733dd3a97fb5eb3688',
    '_section9_record_vendor_payment_intent_impl_20260831(uuid,bigint,date,text,text,text,text)', '1ca764945dbcb74bdb9c63bd6fec5f98',
    '_section9_update_vendor_bill_intent_impl_20260831(uuid,bigint,bigint,date,date,text,text)', '9a11744beb9541635eb854c9e9599a5c',
    '_section9_void_vendor_bill_intent_impl_20260831(uuid,text,text)', 'a3e562b702d061376f8b47919e486037',
    'approve_return(uuid,uuid,text)', '9121e958c3e4439130455911685b5eab',
    'cancel_return(uuid,text,uuid,text)', 'b1564de6d4ccc4e2306e11e611b304a1',
    'create_commission_payment(uuid[],text,text,date,text,uuid,text)', '41ef85f28f8168e2a7330a66828a6b10',
    'create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)', 'c9beb63cfd687bd5e0fc8ef5f7307696',
    'create_return(jsonb,jsonb,text)', 'cb6aad06aeb9d5e7f8ddbc5199f72505',
    'create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)', '320554829a13633e61f763e9aa251824',
    'issue_return_credit(uuid,uuid,text)', 'b75cc885151bd853a15e14b206311814',
    'post_commission_payment(uuid,uuid,text)', 'bb01e87a4675fc11ba86deb4636e5640',
    'receive_return(uuid,uuid,text)', 'a708a5e337fdbdead4cbe8cd7fc74972',
    'reject_return(uuid,uuid,text)', 'fed29efd917225d1cca2da0ed1eb744d',
    'reverse_receiving_record(uuid,text,uuid,text)', 'c63024b1c36e72c1b1e99fa9d916331c',
    'soft_delete_customer_document(uuid,uuid,text)', '1f0cb967e24b642b323dd4e4cc92d4ac',
    'void_commission_payment(uuid,text,uuid,text)', '36efe2f2f8c314cffa03ef6417f5da91',
    'void_vendor_payment(uuid,text,text)', '59c50b510d79929a5f4855c8a1a0e21d');
  v_fn record;
  v_seen integer := 0;
BEGIN
  FOR v_fn IN
    SELECT a.sig, md5(replace(p.prosrc, chr(13), '')) AS body_md5, pg_get_userbyid(p.proowner) AS owner,
           p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
           pg_get_function_arguments(p.oid) AS args, a.args AS was_args,
           a.owner AS was_owner, a.acl AS was_acl, a.proconfig AS was_config, a.prorettype AS was_rettype,
           a.provolatile AS was_volatile, a.prosecdef AS was_secdef, a.transaction_id
      FROM pg_temp.idem_key_printable_1912_attrs a JOIN pg_proc p ON p.oid = a.fn_oid
  LOOP
    v_seen := v_seen + 1;
    IF v_fn.transaction_id IS DISTINCT FROM pg_current_xact_id()::text THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
    END IF;
    IF v_fn.body_md5 IS DISTINCT FROM v_expected ->> v_fn.sig
       OR v_fn.owner IS DISTINCT FROM v_fn.was_owner
       OR v_fn.acl IS DISTINCT FROM v_fn.was_acl
       OR v_fn.proconfig IS DISTINCT FROM v_fn.was_config
       OR v_fn.prorettype IS DISTINCT FROM v_fn.was_rettype
       OR v_fn.provolatile IS DISTINCT FROM v_fn.was_volatile
       OR v_fn.prosecdef IS DISTINCT FROM v_fn.was_secdef
       OR v_fn.args IS DISTINCT FROM v_fn.was_args THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % is not the expected body/attributes (md5 %)', v_fn.sig, v_fn.body_md5;
    END IF;
  END LOOP;
  IF v_seen <> 19 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: expected 19 functions, saw %', v_seen;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosrc LIKE '%COLLATE "C" !~ ''[!-~]''%'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a public function still accepts keys with non-printable characters';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: 19 functions refuse an idempotency key with any non-printable character';
END;
$postflight$;
