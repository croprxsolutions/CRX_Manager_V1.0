-- Written 2026-11-09. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261221110000_bill_split_payers_read.md.
-- Re-read the live ledger before applying.
--
-- WHAT (billing plan M2 screens, #1534; Sol HIGH on a6aaa21f2; Mason 2026-11-09, option A):
--   get_bill_split_payers(p_invoice_id): every payer of the Bill Split sale an invoice belongs to (its
--   invoice_group_id's live invoices: id, number, total, customer name), for anyone who may read that
--   invoice. Mason chose that each payer's invoice shows every payer's name, number and amount. The
--   screens read the group with the caller's row security, so a rep who can see only some payers' invoices
--   (an admin reassigned one payer's draft to another rep) got a partial table that looked complete.
--   Who may call: the invoice's read rule, mirrored exactly (invoices_select: an admin, its creator or its
--   sales rep; pinned below, so drift stops the apply), or the service role (the email sender).
--   A caller who may not read the invoice gets INVOICE_NOT_VISIBLE, never another invoice's payers.
--   A test that comes out NULL (no sales rep, no claims) refuses.
--   Read only. SECURITY DEFINER, owner postgres, search_path public, pg_temp, EXECUTE for authenticated
--   and service_role only.
--
-- NOT CHANGED: every table, policy, trigger and writer.
--
-- ROLLBACK (its own reviewed migration): DROP FUNCTION public.get_bill_split_payers(uuid); the screens
--   then fall back to their old direct read (a partial table for a rep in the reassigned case).
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE bill_split_payers_read_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.bill_split_payers_read_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.bill_split_payers_read_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'BILL_SPLIT_PAYERS_READ_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  IF to_regprocedure('public.get_bill_split_payers(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'BILL_SPLIT_PAYERS_READ_PREFLIGHT: get_bill_split_payers already exists';
  END IF;
  -- The read rule this function mirrors. If it changed, re-mirror it before applying. (Printed as uid()
  -- or auth.uid() depending on the session's search_path, so both read the same.)
  IF (SELECT regexp_replace(pg_get_expr(polqual, polrelid), '(auth\.)?uid\(\)', 'auth.uid()', 'g') FROM pg_policy
       WHERE polrelid = 'public.invoices'::regclass AND polname = 'invoices_select' AND polcmd = 'r')
     IS DISTINCT FROM '(is_admin() OR (created_by = ( SELECT auth.uid() AS uid)) OR (salesman_id = ( SELECT auth.uid() AS uid)))'
     OR (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.invoices'::regclass AND polcmd IN ('r', '*')) <> 1 THEN
    RAISE EXCEPTION 'BILL_SPLIT_PAYERS_READ_PREFLIGHT: the invoices read policy drifted from invoices_select';
  END IF;
END
$preflight$;

CREATE FUNCTION public.get_bill_split_payers(p_invoice_id uuid)
 RETURNS TABLE (id uuid, invoice_number text, total_amount_cents bigint, farm_name text)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv invoices%ROWTYPE;
  v_uid uuid := auth.uid();
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE invoices.id = p_invoice_id;
  -- invoices_select, mirrored: the service role (no user) reads every invoice, as it does today.
  -- IS NOT TRUE, not NOT: an invoice with no sales rep, or a call with no claims, makes the test NULL,
  -- and NULL must refuse (independent review, 2026-11-09).
  IF NOT FOUND
     OR (auth.role() = 'service_role'
         OR (v_uid IS NOT NULL AND (public.is_admin() OR v_inv.created_by = v_uid OR v_inv.salesman_id = v_uid))) IS NOT TRUE THEN
    RAISE EXCEPTION 'INVOICE_NOT_VISIBLE: this invoice can''t be read by this user' USING ERRCODE = '42501';
  END IF;
  IF v_inv.invoice_group_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT i.id, i.invoice_number, i.total_amount_cents, c.farm_name
      FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.invoice_group_id = v_inv.invoice_group_id
       AND i.deleted_at IS NULL
       AND i.status NOT IN ('voided', 'cancelled')
     ORDER BY i.invoice_number, i.id;
END
$function$;

REVOKE ALL ON FUNCTION public.get_bill_split_payers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_bill_split_payers(uuid) TO authenticated, service_role;
