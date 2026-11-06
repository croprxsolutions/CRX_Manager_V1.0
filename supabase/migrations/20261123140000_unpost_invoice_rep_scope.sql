-- Written 2026-11-06. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261123140000_unpost_invoice_rep_scope.md.
-- Re-read the live ledger before applying.
--
-- WHAT (Mason, 2026-11-06, #crx-work): unposting follows the same rule as posting. Admins can unpost any
--   invoice, reps only their own: they are its salesperson, or it has none and they created it. A group needs
--   every member under the rep's name. Refused with INVOICE_SCOPE_DENIED, nothing written. Both public entries
--   are re-emitted with that one check; since 20261013220000 only the post side had it.
--
-- NOT CHANGED: the inner unpost functions and their status, money and closed-month checks. What an admin can do.
--   One member of a group still needs the group call (GROUP_UNPOST_REQUIRED). No table, policy, grant or row.
--
-- ROLLBACK (its own reviewed migration): re-emit unpost_invoice and unpost_invoice_group from their previous
--   bodies (20261118130000 and 20261102180000).
--
-- ORDERING: apply after 20261118130000_chem_sale_bill_split_invoices. The preflight pins that body.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE unpost_invoice_rep_scope_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  r record;
BEGIN
  IF to_regclass('pg_temp.unpost_invoice_rep_scope_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.unpost_invoice_rep_scope_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'UNPOST_REP_SCOPE_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('public.unpost_invoice(uuid,uuid,text)', '98cc147e5deab1cd0c7d4cd6d9e3deae'),
    ('public.unpost_invoice_group(uuid,uuid,text)', 'c083ceee935fe05ad40531f2473aae62')
  ) AS v(sig, body_md5)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure(r.sig)
         AND md5(replace(p.prosrc, chr(13), '')) = r.body_md5
         AND p.proowner = 'postgres'::regrole
         AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND p.proacl = ARRAY['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::aclitem[]
    ) THEN
      RAISE EXCEPTION 'UNPOST_REP_SCOPE_PREFLIGHT: % drifted', r.sig;
    END IF;
  END LOOP;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.unpost_invoice(
  p_invoice_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: unpost_invoice requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  -- A rep only under their own name, as for posting (Mason, 2026-11-06).
  IF EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND role = 'sales_rep')
     AND EXISTS (
       SELECT 1 FROM invoices i
        WHERE i.id = p_invoice_id
          AND NOT (i.salesman_id IS NOT DISTINCT FROM v_actor
             OR (i.salesman_id IS NULL AND i.created_by IS NOT DISTINCT FROM v_actor))
     ) THEN
    RAISE EXCEPTION 'INVOICE_SCOPE_DENIED';
  END IF;
  IF EXISTS (SELECT 1 FROM invoices WHERE id = p_invoice_id AND invoice_group_id IS NOT NULL) THEN
    RAISE EXCEPTION 'GROUP_UNPOST_REQUIRED';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'invoice_id', p_invoice_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'unpost_invoice', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._unpost_invoice_replay_impl_20261015(p_invoice_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'unpost_invoice', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unpost_invoice_group(
  p_invoice_group_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: unpost_invoice_group requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to unpost invoice groups';
  END IF;
  -- A rep only when every member is under their own name, as for posting (Mason, 2026-11-06).
  IF EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND role = 'sales_rep')
     AND EXISTS (
       SELECT 1 FROM invoices i
        WHERE i.invoice_group_id = p_invoice_group_id
          AND i.deleted_at IS NULL
          AND NOT (i.salesman_id IS NOT DISTINCT FROM v_actor
             OR (i.salesman_id IS NULL AND i.created_by IS NOT DISTINCT FROM v_actor))
     ) THEN
    RAISE EXCEPTION 'INVOICE_SCOPE_DENIED';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'invoice_group_id', p_invoice_group_id));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'unpost_invoice_group', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._unpost_invoice_group_replay_impl_20261015(p_invoice_group_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'unpost_invoice_group', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

DO $postflight$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY['public.unpost_invoice(uuid,uuid,text)', 'public.unpost_invoice_group(uuid,uuid,text)']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure(v_sig)
         AND position('INVOICE_SCOPE_DENIED' IN p.prosrc) > 0
         AND p.proowner = 'postgres'::regrole
         AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND p.proacl = ARRAY['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::aclitem[]
    ) THEN
      RAISE EXCEPTION 'UNPOST_REP_SCOPE_POSTFLIGHT: % lost its check, owner, mode or grants', v_sig;
    END IF;
  END LOOP;
END
$postflight$;
