-- Written 2026-11-05. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261108140000_rup_records_require_posted_invoice.md.
-- Re-read the live ledger before applying.
--
-- WHAT (KI-05): generate_rup_sales_records checked the caller's role (active admin or sales_rep) but not
--   that the invoice was posted, so a signed-in sales rep could call it directly and write
--   restricted-use-pesticide register rows for a draft invoice. It now refuses any invoice that is not
--   posted (status posted, paid or overdue, and not deleted) with RUP_INVOICE_NOT_POSTED, naming the
--   invoice number and its status. Nothing is written for a refused call (no register row, no idempotency
--   receipt). The invoice row is read FOR SHARE so its status cannot change while the rows are written.
--
-- CALLERS (live read-only 2026-11-05): only _post_invoice_impl_20260714 and
--   _post_deleted_delivery_recovery_invoice_20260719 call it, and both set status = 'posted' before the
--   call in the same transaction, so every posting path still writes its rows. No src/ caller (generated
--   types and tests only).
--
-- NOT CHANGED: the role gate, the idempotency replay, every other line of the body, the return value,
--   SECURITY DEFINER, search_path = public, pg_temp and the grants (CREATE OR REPLACE keeps the ACL:
--   authenticated, postgres, service_role; no PUBLIC or anon). No table, column, row or permission changes.
--
-- ROLLBACK (its own reviewed migration): re-emit generate_rup_sales_records from
--   20260707040000_generate_rup_sales_records_role_gate.sql.
--
-- ORDERING: apply after 20260707040000 (the live body this file pins).

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_count integer;
  v_md5 text;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'generate_rup_sales_records';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'RUP_POSTED_PREFLIGHT: expected one generate_rup_sales_records overload, found %', v_count;
  END IF;

  SELECT md5(replace(p.prosrc, chr(13), '')) INTO STRICT v_md5
  FROM pg_proc p
  WHERE p.oid = 'public.generate_rup_sales_records(uuid,text)'::regprocedure;
  -- The body applied by 20260707040000 (read live 2026-11-05), or this file's own body (a re-run).
  IF v_md5 NOT IN ('18802cbdbbd8a91334dcad11e5303e70', '346ee47158c1f1ac0dde6a5e2d73806d') THEN
    RAISE EXCEPTION 'RUP_POSTED_PREFLIGHT: live body changed (md5 %); re-read it before applying', v_md5;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.generate_rup_sales_records(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer := 0;
  v_invoice record;
  v_item record;
  v_license record;
  v_compliance_status text;
  v_compliance_notes text;
  v_season integer;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  -- N2-4 role gate (matches the sole caller post_invoice): block applicators/drivers.
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to generate RUP sales records';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'generate_rup_sales_records');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'count')::integer;
    END IF;
  END IF;

  SELECT i.id, i.order_id, o.customer_id, c.farm_name, i.created_at,
         i.invoice_number, i.status, i.deleted_at
  INTO v_invoice
  FROM invoices i
  JOIN orders o ON o.id = i.order_id
  JOIN customers c ON c.id = o.customer_id
  WHERE i.id = p_invoice_id
  FOR SHARE OF i;

  IF v_invoice IS NULL THEN RETURN 0; END IF;

  -- KI-05: register rows record a sale, so only a posted invoice may write them.
  IF v_invoice.status IS NULL OR v_invoice.status NOT IN ('posted', 'paid', 'overdue')
     OR v_invoice.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'RUP_INVOICE_NOT_POSTED: invoice % is % and not posted; RUP sales records are written only for a posted invoice',
      v_invoice.invoice_number,
      CASE WHEN v_invoice.deleted_at IS NOT NULL THEN 'deleted' ELSE coalesce(v_invoice.status, 'without a status') END;
  END IF;

  v_season := CASE
    WHEN EXTRACT(MONTH FROM v_invoice.created_at) >= 10
    THEN EXTRACT(YEAR FROM v_invoice.created_at)::integer + 1
    ELSE EXTRACT(YEAR FROM v_invoice.created_at)::integer
  END;

  FOR v_item IN
    SELECT ii.id, ii.product_id, p.product_name, ii.quantity, ii.unit_size,
           ii.unit_price_cents, ii.extended_cents,
           p.epa_registration, p.signal_word
    FROM invoice_items ii
    JOIN products p ON p.id = ii.product_id
    WHERE ii.invoice_id = p_invoice_id
      AND p.is_rup = true
  LOOP
    SELECT al.license_number, al.license_type, al.expiry_date
    INTO v_license
    FROM applicator_licenses al
    WHERE al.customer_id = v_invoice.customer_id
      AND al.is_active = true
    ORDER BY al.expiry_date DESC NULLS LAST
    LIMIT 1;

    IF v_license IS NULL OR v_license.license_number IS NULL THEN
      v_compliance_status := 'non_compliant';
      v_compliance_notes := 'No applicator license on file for this customer';
    ELSIF v_license.expiry_date IS NOT NULL AND v_license.expiry_date < CURRENT_DATE THEN
      v_compliance_status := 'warning';
      v_compliance_notes := 'Applicator license expired on ' || v_license.expiry_date::text;
    ELSE
      v_compliance_status := 'compliant';
      v_compliance_notes := NULL;
    END IF;

    -- PARKED-006: dedup ignores voided rows so a legitimate re-post can record
    -- a fresh active sale even when a prior voided row exists.
    IF NOT EXISTS (
      SELECT 1 FROM rup_sales_records
      WHERE invoice_id = p_invoice_id
        AND product_id = v_item.product_id
        AND voided_at IS NULL
    ) THEN
      INSERT INTO rup_sales_records (
        invoice_id, order_id, customer_id, product_id,
        sale_date, product_name, epa_registration, quantity, unit,
        unit_price_cents, total_cents,
        buyer_name, buyer_certification_number,
        buyer_certification_type, buyer_certification_expiry,
        signal_word, compliance_status, compliance_notes,
        season, created_by
      ) VALUES (
        p_invoice_id, v_invoice.order_id, v_invoice.customer_id, v_item.product_id,
        CURRENT_DATE, v_item.product_name, v_item.epa_registration, v_item.quantity, v_item.unit_size,
        v_item.unit_price_cents, v_item.extended_cents,
        v_invoice.farm_name,
        v_license.license_number,
        v_license.license_type,
        v_license.expiry_date,
        v_item.signal_word, v_compliance_status, v_compliance_notes,
        v_season, auth.uid()
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;

  v_result := jsonb_build_object('count', v_count);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'generate_rup_sales_records', v_result);
  END IF;

  RETURN v_count;
END;
$function$;

DO $postflight$
DECLARE
  v_proc record;
  v_grants text;
BEGIN
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'generate_rup_sales_records') <> 1 THEN
    RAISE EXCEPTION 'RUP_POSTED_VERIFY: generate_rup_sales_records overload count is not 1';
  END IF;

  SELECT p.prosecdef, p.proconfig, p.prosrc INTO STRICT v_proc
  FROM pg_proc p
  WHERE p.oid = 'public.generate_rup_sales_records(uuid,text)'::regprocedure;
  IF NOT v_proc.prosecdef OR v_proc.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'RUP_POSTED_VERIFY: SECURITY DEFINER or search_path changed (%)', v_proc.proconfig;
  END IF;
  IF position('RUP_INVOICE_NOT_POSTED' IN v_proc.prosrc) = 0
     OR position('Not authorized to generate RUP sales records' IN v_proc.prosrc) = 0
     OR position('check_idempotency(p_idempotency_key, ''generate_rup_sales_records'')' IN v_proc.prosrc) = 0 THEN
    RAISE EXCEPTION 'RUP_POSTED_VERIFY: the posted check, role gate or idempotency replay is missing from the body';
  END IF;

  SELECT string_agg(r.grantee || ':' || r.privilege_type, ',' ORDER BY r.grantee) INTO v_grants
  FROM information_schema.routine_privileges r
  JOIN pg_proc p ON r.specific_name = p.proname || '_' || p.oid
  WHERE p.oid = 'public.generate_rup_sales_records(uuid,text)'::regprocedure;
  IF v_grants IS DISTINCT FROM 'authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE' THEN
    RAISE EXCEPTION 'RUP_POSTED_VERIFY: grants changed (%)', v_grants;
  END IF;
END;
$postflight$;
